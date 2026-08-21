import type {
	IDataObject,
	IExecuteFunctions,
	INodeExecutionData,
	INodeType,
	INodeTypeDescription,
} from 'n8n-workflow';
import { NodeConnectionTypes, UserError } from 'n8n-workflow';
import { extractPlan, type RobotTaskPlan } from '@n8n/blockly-robot-skills';
import { clientFromCredentials } from '../shared/context';
import { wrapError } from '../shared/errors';
import { booleanParam } from '../shared/params';
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
		properties: [
			{
				displayName: 'Verify Catalog Digest',
				name: 'verifyCatalog',
				type: 'boolean',
				default: true,
				description:
					'Whether to fail when the live catalog digest differs from the plan (plan is stale)',
			},
		],
	};

	async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
		const items = this.getInputData(0);
		try {
			const client = await clientFromCredentials(this);
			const output: INodeExecutionData[] = [];
			for (let index = 0; index < items.length; index++) {
				const item = items[index];
				const verifyCatalog = booleanParam(this, 'verifyCatalog', index, true);
				const extracted = extractPlan(item.json.plan ?? item.json);
				if (typeof extracted === 'string') {
					throw new UserError(`item ${index}: ${extracted}`);
				}
				if (verifyCatalog) {
					const error = await verifyDigest(client, extracted);
					if (error !== null) throw new UserError(error);
				}
				const result = await runPlan(client, extracted, {});
				output.push({ json: result, pairedItem: { item: index } });
			}
			return [output];
		} catch (error) {
			throw wrapError(this, error);
		}
	}
}

export async function verifyDigest(client: ActionClient, plan: RobotTaskPlan): Promise<string | null> {
	if (plan.configDigest === '') return null; // plans without a digest skip freshness check
	const catalog = await client.catalog();
	const live = typeof catalog.config_digest === 'string' ? catalog.config_digest : '';
	if (live !== '' && live !== plan.configDigest) {
		return `plan is stale: catalog digest changed (plan ${plan.configDigest}, live ${live})`;
	}
	return null;
}

/** Execute a plan and summarize; throws on the first failed step so the
 * workflow error branch fires (no auto-retry per recovery_policy). */
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
		steps,
	};
	if (failedAt !== undefined) {
		const completed = outcomes.filter((outcome) => outcome.status === 'completed').length;
		const failedName = stepName(failedAt.step);
		const failedState = failedAt.state ?? failedAt.status;
		json.error = {
			step: failedName,
			index: failedAt.index,
			state: failedState,
			message: failedAt.message ?? '',
			completedSteps: completed,
		};
		throw new UserError(
			`plan failed at step ${failedAt.index} "${failedName}" (${failedState}); ${completed} step(s) completed`,
		);
	}
	return json;
}

function outcomeSummary(outcome: StepOutcome): IDataObject {
	const summary: IDataObject = {
		index: outcome.index,
		type: outcome.step.step,
		status: outcome.status,
	};
	if (outcome.step.step === 'skill') summary.skill = outcome.step.skill;
	if (outcome.step.step === 'primitive') summary.primitive = outcome.step.primitive;
	if (outcome.step.step === 'wait') summary.seconds = outcome.step.seconds;
	if (outcome.taskId !== undefined) summary.taskId = outcome.taskId;
	if (outcome.state !== undefined) summary.state = outcome.state;
	if (outcome.message !== undefined) summary.message = outcome.message;
	return summary;
}
