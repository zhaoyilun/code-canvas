/** Sequential execution for Blockly robot plans over the action bridge. */

import type { IDataObject } from 'n8n-workflow';
import type { PlanStep, RobotTaskPlan, SkipIfGuard } from '@n8n/blockly-robot-skills';
import { DEFAULT_SKILL_TIMEOUT_SEC } from '@n8n/blockly-robot-skills';
import { randomUUID } from 'node:crypto';
import { sleep as workflowSleep } from 'n8n-workflow';
import type { RobotAction, TaskLookup } from './bridge';
import { toDataObject } from './bridge';

export type ActionStep = Extract<PlanStep, { skill: string } | { primitive: string }>;

/** The bridge surface the plan runner needs; BridgeClient satisfies this. */
export interface ActionClient {
	catalog(): Promise<IDataObject>;
	execute(
		taskId: string,
		action: RobotAction,
		params: IDataObject,
		timeoutSec?: number,
		context?: IDataObject,
	): Promise<IDataObject>;
	validate(action: RobotAction, params: IDataObject): Promise<IDataObject>;
	task(taskId: string): Promise<TaskLookup>;
	cancel(taskId: string): Promise<IDataObject>;
}

export type StepStatus =
	| 'completed'
	| 'failed'
	| 'canceled'
	| 'unknown'
	| 'skipped'
	| 'submitted';

export type StepOutcome = {
	index: number;
	step: PlanStep;
	status: StepStatus;
	taskId?: string;
	success?: boolean | null;
	state?: string;
	errorCode?: string;
	message?: string;
	executedPrimitives?: string[];
	cancelRequested?: boolean;
	cancelConfirmed?: boolean;
};

export type EngineOptions = {
	pollIntervalMs?: number;
	pollMarginSec?: number;
	registrationGraceMs?: number;
	cancelConfirmSec?: number;
	sleep?: (ms: number) => Promise<void>;
	now?: () => number;
};

const DEFAULT_POLL_INTERVAL_MS = 500;
const DEFAULT_POLL_MARGIN_SEC = 30;
const DEFAULT_REGISTRATION_GRACE_MS = 2_000;
const DEFAULT_CANCEL_CONFIRM_SEC = 5;

export function generateTaskId(prefix = 'n8n'): string {
	return `${prefix}-${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`;
}

export function actionOf(step: ActionStep): RobotAction {
	return step.step === 'skill'
		? { kind: 'skill', name: step.skill }
		: { kind: 'primitive', name: step.primitive };
}

export function stepName(step: PlanStep): string {
	if (step.step === 'skill') return step.skill;
	if (step.step === 'primitive') return step.primitive;
	return 'wait';
}

export async function executePlan(
	client: ActionClient,
	plan: RobotTaskPlan,
	options: EngineOptions = {},
): Promise<{ outcomes: StepOutcome[]; success: boolean; failedAt?: StepOutcome }> {
	const sleep = options.sleep ?? defaultSleep;
	const outcomes: StepOutcome[] = [];
	let lastAction: StepOutcome | undefined;

	for (const [index, step] of plan.plan.entries()) {
		if (step.step !== 'wait' && step.skipIf !== undefined) {
			if (shouldSkip(step.skipIf, lastAction)) {
				outcomes.push({ index, step, status: 'skipped' });
				continue;
			}
		}

		if (step.step === 'wait') {
			await sleep(step.seconds * 1000);
			outcomes.push({ index, step, status: 'completed' });
			continue;
		}

		const outcome = await runAction(client, step, index, options);
		outcomes.push(outcome);
		if (outcome.status !== 'completed') {
			return { outcomes, success: false, failedAt: outcome };
		}
		lastAction = outcome;
	}

	return { outcomes, success: true };
}

export async function runAction(
	client: ActionClient,
	step: ActionStep,
	index: number,
	options: EngineOptions = {},
): Promise<StepOutcome> {
	const taskId = generateTaskId();
	const action = actionOf(step);
	const timeoutSec = step.timeoutSec ?? DEFAULT_SKILL_TIMEOUT_SEC;
	const sleep = options.sleep ?? defaultSleep;
	const now = options.now ?? Date.now;

	try {
		await client.execute(taskId, action, paramsOf(step), step.timeoutSec, actionContext(step));
	} catch (error) {
		return {
			index,
			step,
			status: 'failed',
			taskId,
			success: false,
			state: 'failed',
			errorCode: 'ACTION_SUBMIT_FAILED',
			message: errorMessage(error),
		};
	}

	const pollDeadline =
		now() + (timeoutSec + (options.pollMarginSec ?? DEFAULT_POLL_MARGIN_SEC)) * 1000;
	const registrationDeadline = now() + (options.registrationGraceMs ?? DEFAULT_REGISTRATION_GRACE_MS);

	for (;;) {
		let lookup: TaskLookup;
		try {
			lookup = await client.task(taskId);
		} catch (error) {
			return await cancelAndConfirm(client, step, index, taskId, options, {
				errorCode: 'TASK_QUERY_FAILED',
				message: `task query failed: ${errorMessage(error)}`,
			});
		}

		if (lookup !== null && lookup.terminal) {
			return terminalOutcome(step, index, taskId, lookup.body);
		}
		if (lookup === null && now() >= registrationDeadline) {
			return await cancelAndConfirm(client, step, index, taskId, options, {
				errorCode: 'TASK_NOT_REGISTERED',
				message: 'task stayed absent after the submission grace period',
			});
		}
		if (now() >= pollDeadline) {
			return await cancelAndConfirm(client, step, index, taskId, options, {
				errorCode: 'LOCAL_TIMEOUT',
				message: `action "${action.name}" exceeded ${timeoutSec}s plus the polling margin`,
			});
		}
		await sleep(options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS);
	}
}

export function paramsOf(step: { params?: Record<string, unknown> }): IDataObject {
	const data: IDataObject = {};
	for (const [key, value] of Object.entries(step.params ?? {})) {
		if (
			value === null ||
			typeof value === 'string' ||
			typeof value === 'number' ||
			typeof value === 'boolean'
		) {
			data[key] = value;
		} else {
			const wrapped = toDataObject({ value });
			if (wrapped !== null) data[key] = wrapped.value;
		}
	}
	return data;
}

function actionContext(step: ActionStep): IDataObject | undefined {
	const context: IDataObject = {};
	if (step.blockId !== undefined) context.blockId = step.blockId;
	if (step.planStepId !== undefined) context.planStepId = step.planStepId;
	return Object.keys(context).length === 0 ? undefined : context;
}

async function cancelAndConfirm(
	client: ActionClient,
	step: ActionStep,
	index: number,
	taskId: string,
	options: EngineOptions,
	reason: { errorCode: string; message: string },
): Promise<StepOutcome> {
	const sleep = options.sleep ?? defaultSleep;
	const now = options.now ?? Date.now;
	let cancelResult: IDataObject;
	try {
		cancelResult = await client.cancel(taskId);
	} catch (error) {
		return unknownOutcome(step, index, taskId, reason, {
			requested: false,
			confirmed: false,
			message: `cancel request failed: ${errorMessage(error)}`,
		});
	}

	const cancelState = stringField(cancelResult, 'state', '');
	const requested = cancelResult.requested === true;
	const confirmed = cancelResult.confirmed === true;
	if (confirmed && isConfirmedTerminal(cancelState)) {
		return terminalOutcome(step, index, taskId, cancelResult, {
			requested,
			confirmed: true,
			reason,
		});
	}
	if (cancelState === 'unknown') {
		return unknownOutcome(step, index, taskId, reason, {
			requested,
			confirmed: false,
			message: stringField(cancelResult, 'message', ''),
		});
	}

	const confirmDeadline = now() + (options.cancelConfirmSec ?? DEFAULT_CANCEL_CONFIRM_SEC) * 1000;
	while (now() < confirmDeadline) {
		try {
			const lookup = await client.task(taskId);
			if (lookup !== null && lookup.terminal) {
				return terminalOutcome(step, index, taskId, lookup.body, {
					requested,
					confirmed: isConfirmedTerminal(stringField(lookup.body, 'state', '')),
					reason,
				});
			}
		} catch {
			// Keep checking until the bounded confirmation window closes.
		}
		await sleep(options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS);
	}

	return unknownOutcome(step, index, taskId, reason, {
		requested,
		confirmed: false,
		message: stringField(cancelResult, 'message', ''),
	});
}

function terminalOutcome(
	step: ActionStep,
	index: number,
	taskId: string,
	body: IDataObject,
	cancellation?: {
		requested: boolean;
		confirmed: boolean;
		reason: { errorCode: string; message: string };
	},
): StepOutcome {
	const state = stringField(body, 'state', 'unknown');
	const success = typeof body.success === 'boolean' ? body.success : state === 'completed';
	let status: StepStatus;
	if (state === 'completed' && success) status = 'completed';
	else if (state === 'canceled') status = 'canceled';
	else if (state === 'unknown') status = 'unknown';
	else status = 'failed';

	const message = stringField(body, 'message', cancellation?.reason.message ?? '');
	const errorCode = stringField(body, 'error_code', cancellation?.reason.errorCode ?? '');
	return {
		index,
		step,
		status,
		taskId,
		success,
		state,
		...(errorCode === '' ? {} : { errorCode }),
		...(message === '' ? {} : { message }),
		executedPrimitives: Array.isArray(body.executed_primitives)
			? body.executed_primitives.map(String)
			: undefined,
		...(cancellation === undefined
			? {}
			: {
					cancelRequested: cancellation.requested,
					cancelConfirmed: cancellation.confirmed,
				}),
	};
}

function unknownOutcome(
	step: ActionStep,
	index: number,
	taskId: string,
	reason: { errorCode: string; message: string },
	cancellation: { requested: boolean; confirmed: boolean; message: string },
): StepOutcome {
	const detail = cancellation.message.trim();
	return {
		index,
		step,
		status: 'unknown',
		taskId,
		success: null,
		state: 'unknown',
		errorCode: reason.errorCode,
		message: detail === '' ? reason.message : `${reason.message}; ${detail}`,
		cancelRequested: cancellation.requested,
		cancelConfirmed: cancellation.confirmed,
	};
}

function isConfirmedTerminal(state: string): boolean {
	return state === 'completed' || state === 'failed' || state === 'canceled';
}

function stringField(body: IDataObject, key: string, fallback: string): string {
	return typeof body[key] === 'string' ? body[key] : fallback;
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : 'unknown bridge error';
}

function shouldSkip(guard: SkipIfGuard, last: StepOutcome | undefined): boolean {
	if (last === undefined) return true;
	let actual: string | boolean | number | undefined;
	if (guard.field === 'last.success') {
		actual = last.success === true;
	} else {
		actual = last.state ?? '';
	}
	const matches = actual === guard.value;
	return guard.op === '==' ? matches : !matches;
}

async function defaultSleep(ms: number): Promise<void> {
	await workflowSleep(ms);
}
