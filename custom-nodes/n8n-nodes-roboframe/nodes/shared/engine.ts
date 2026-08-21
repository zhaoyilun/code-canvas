/** Sequential plan execution over the bridge.
 *
 * Semantics (design §6.1/§7.5): one gateway lease per step, no auto-retry,
 * stop at the first failed step, guards are step-level skipIf checks against
 * the previous action outcome.
 */

import type { IDataObject } from 'n8n-workflow';
import type { PlanStep, RobotTaskPlan, SkipIfGuard } from '@n8n/blockly-robot-skills';
import { DEFAULT_SKILL_TIMEOUT_SEC } from '@n8n/blockly-robot-skills';
import { randomUUID } from 'node:crypto';
import { sleep as workflowSleep } from 'n8n-workflow';
import { toDataObject } from './bridge';

/** The bridge surface the engine and plan runner need; BridgeClient satisfies this. */
export interface ActionClient {
	catalog(): Promise<IDataObject>;
	execute(taskId: string, skill: string, params: IDataObject, timeoutSec?: number): Promise<IDataObject>;
	validate(skill: string, params: IDataObject): Promise<IDataObject>;
	task(taskId: string): Promise<{ body: IDataObject; terminal: boolean }>;
}

export type StepOutcome = {
	index: number;
	step: PlanStep;
	status: 'completed' | 'failed' | 'skipped' | 'submitted';
	taskId?: string;
	success?: boolean | null;
	state?: string;
	errorCode?: string;
	message?: string;
	executedPrimitives?: string[];
};

export type EngineOptions = {
	pollIntervalMs?: number;
	pollMarginSec?: number;
	sleep?: (ms: number) => Promise<void>;
};

const DEFAULT_POLL_INTERVAL_MS = 500;
const DEFAULT_POLL_MARGIN_SEC = 30;

export function generateTaskId(prefix = 'n8n'): string {
	return `${prefix}-${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`;
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
		if (outcome.status === 'failed') {
			return { outcomes, success: false, failedAt: outcome };
		}
		lastAction = outcome;
	}

	return { outcomes, success: true };
}

export async function runAction(
	client: ActionClient,
	step: Extract<PlanStep, { skill: string } | { primitive: string }>,
	index: number,
	options: EngineOptions = {},
): Promise<StepOutcome> {
	const taskId = generateTaskId();
	const skill = step.step === 'skill' ? step.skill : step.primitive;
	const timeoutSec = step.timeoutSec ?? DEFAULT_SKILL_TIMEOUT_SEC;

	await client.execute(taskId, skill, paramsOf(step), step.timeoutSec);

	const pollDeadline = Date.now() + (timeoutSec + (options.pollMarginSec ?? DEFAULT_POLL_MARGIN_SEC)) * 1000;
	for (;;) {
		const { body, terminal } = await client.task(taskId);
		if (terminal) {
			const state = typeof body.state === 'string' ? body.state : 'unknown';
			const success = typeof body.success === 'boolean' ? body.success : state === 'completed';
			return {
				index,
				step,
				status: success && state === 'completed' ? 'completed' : 'failed',
				taskId,
				success,
				state,
				errorCode: typeof body.error_code === 'string' ? body.error_code : undefined,
				message: typeof body.message === 'string' ? body.message : undefined,
				executedPrimitives: Array.isArray(body.executed_primitives)
					? body.executed_primitives.map(String)
					: undefined,
			};
		}
		if (Date.now() >= pollDeadline) {
			return {
				index,
				step,
				status: 'failed',
				taskId,
				success: false,
				state: 'timeout',
				message: `step "${skill}" did not reach a terminal state within ${timeoutSec}s (+margin)`,
			};
		}
		await (options.sleep ?? defaultSleep)(options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS);
	}
}

function paramsOf(step: { params?: Record<string, unknown> }): IDataObject {
	const data: IDataObject = {};
	for (const [key, value] of Object.entries(step.params ?? {})) {
		if (value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
			data[key] = value;
		} else {
			const nested = toDataObject(value);
			if (nested !== null) data[key] = nested;
		}
	}
	return data;
}

function shouldSkip(guard: SkipIfGuard, last: StepOutcome | undefined): boolean {
	if (last === undefined) return true; // guard cannot be evaluated → skip (conservative)
	let actual: string | boolean | number | undefined;
	if (guard.field === 'last.success') {
		actual = last.success === true;
	} else {
		actual = last.state ?? '';
	}
	const matches = actual === guard.value;
	// skipIf means "skip when the condition holds".
	return guard.op === '==' ? matches : !matches;
}

async function defaultSleep(ms: number): Promise<void> {
	await workflowSleep(ms);
}
