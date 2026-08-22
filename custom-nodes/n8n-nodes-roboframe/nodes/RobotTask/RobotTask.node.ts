import type {
	IDataObject,
	IExecuteFunctions,
	INodeExecutionData,
	INodeType,
	INodeTypeDescription,
} from 'n8n-workflow';
import { NodeConnectionTypes, UserError } from 'n8n-workflow';
import { extractPlan, type RobotTaskPlan } from '@n8n/blockly-robot-skills';
import { toDataObject } from '../shared/bridge';
import { catalogDigestJson, checkCatalogDigest } from '../shared/catalogDigest';
import { clientFromCredentials } from '../shared/context';
import { wrapError } from '../shared/errors';
import { computePlanDigest } from '../shared/planDigest';
import {
	executePlan,
	stepName,
	type ActionClient,
	type EngineOptions,
	type StepOutcome,
} from '../shared/engine';

export class RobotTask implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'Robot Task',
		name: 'robotTask',
		icon: { light: 'file:roboframe.svg', dark: 'file:roboframe.dark.svg' },
		group: ['transform'],
		version: 1,
		description: 'Execute a structured RoboFrame task plan step by step',
		subtitle: 'Runs a structured task plan',
		defaults: { name: 'Robot Task' },
		inputs: [NodeConnectionTypes.Main],
		outputs: [NodeConnectionTypes.Main],
		credentials: [{ name: 'robframeBridgeApi', required: true }],
		properties: [],
	};

	async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
		const items = this.getInputData(0);
		try {
			const client = await clientFromCredentials(this);
			const output: INodeExecutionData[] = [];
			for (let index = 0; index < items.length; index++) {
				const item = items[index];
				const extracted = extractPlan(item.json.plan ?? item.json);
				if (typeof extracted === 'string') {
					throw new UserError(`item ${index}: ${extracted}`);
				}
				requirePlanValidation(item.json.validation, extracted, index);
				const digest = await checkCatalogDigest(client, extracted);
				if (!digest.valid) throw new UserError(digest.message);
				const result = await runPlan(client, extracted, {});
				result.catalogDigest = catalogDigestJson(digest);
				output.push({ json: result, pairedItem: { item: index } });
			}
			return [output];
		} catch (error) {
			throw wrapError(this, error);
		}
	}
}

/** Enforce the plan-validation handoff before any live action can be submitted. */
export function requirePlanValidation(
	value: unknown,
	plan: RobotTaskPlan,
	itemIndex: number,
): void {
	const validation = toDataObject(value);
	if (validation === null || validation.mode !== 'plan') {
		throw new UserError(`item ${itemIndex}: Robot Validate plan verdict is required`);
	}
	if (validation.valid !== true) {
		throw new UserError(`item ${itemIndex}: Robot Validate rejected the plan`);
	}
	const catalogDigest = toDataObject(validation.catalogDigest);
	if (catalogDigest?.valid !== true) {
		throw new UserError(`item ${itemIndex}: Robot Validate catalog digest verdict is required`);
	}
	if (typeof validation.planDigest !== 'string' || validation.planDigest === '') {
		throw new UserError(`item ${itemIndex}: Robot Validate plan digest verdict is required`);
	}
	if (validation.planDigest !== computePlanDigest(plan)) {
		throw new UserError(`item ${itemIndex}: plan changed after Robot Validate`);
	}
}

/** Execute a plan and preserve the complete terminal summary for n8n branching. */
export async function runPlan(
	client: ActionClient,
	plan: RobotTaskPlan,
	options: EngineOptions,
): Promise<IDataObject> {
	const { outcomes, success, failedAt } = await executePlan(client, plan, options);
	const steps: IDataObject[] = outcomes.map(outcomeSummary);
	const json: IDataObject = {
		robot: plan.robot,
		configDigest: plan.configDigest,
		success,
		finalStatus: success ? 'completed' : finalStatus(failedAt),
		taskIds: outcomes.flatMap((outcome) =>
			outcome.taskId === undefined ? [] : [outcome.taskId],
		),
		steps,
	};
	if (failedAt !== undefined) {
		const completed = outcomes.filter((outcome) => outcome.status === 'completed').length;
		const failedName = stepName(failedAt.step);
		const failedState = failedAt.state ?? failedAt.status;
		json.error = {
			step: failedName,
			index: failedAt.index,
			taskId: failedAt.taskId ?? '',
			state: failedState,
			errorCode: failedAt.errorCode ?? '',
			message: failedAt.message ?? '',
			completedSteps: completed,
		};
	}
	return json;
}

function outcomeSummary(outcome: StepOutcome): IDataObject {
	const summary: IDataObject = {
		index: outcome.index,
		status: outcome.status,
	};
	if (outcome.step.step === 'wait') {
		summary.type = 'wait';
		summary.seconds = outcome.step.seconds;
	} else {
		summary.action = {
			kind: outcome.step.step,
			name: stepName(outcome.step),
		};
	}
	if (outcome.taskId !== undefined) summary.taskId = outcome.taskId;
	if (outcome.step.blockId !== undefined) summary.blockId = outcome.step.blockId;
	if (outcome.step.planStepId !== undefined) summary.planStepId = outcome.step.planStepId;
	if (outcome.state !== undefined) summary.state = outcome.state;
	if (outcome.success !== undefined) summary.success = outcome.success;
	if (outcome.errorCode !== undefined) summary.errorCode = outcome.errorCode;
	if (outcome.message !== undefined) summary.message = outcome.message;
	if (outcome.executedPrimitives !== undefined) {
		summary.executedPrimitives = outcome.executedPrimitives;
	}
	if (outcome.cancelRequested !== undefined) summary.cancelRequested = outcome.cancelRequested;
	if (outcome.cancelConfirmed !== undefined) summary.cancelConfirmed = outcome.cancelConfirmed;
	return summary;
}

function finalStatus(failedAt: StepOutcome | undefined): 'failed' | 'canceled' | 'unknown' {
	if (failedAt?.status === 'canceled') return 'canceled';
	if (failedAt?.status === 'unknown') return 'unknown';
	return 'failed';
}
