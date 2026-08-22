import type {
	IDataObject,
	IExecuteFunctions,
	ILoadOptionsFunctions,
	INodeExecutionData,
	INodeType,
	INodeTypeDescription,
} from 'n8n-workflow';
import { NodeConnectionTypes, UserError } from 'n8n-workflow';
import { clientFromCredentials } from '../shared/context';
import { wrapError } from '../shared/errors';
import { booleanParam, jsonParam, numberParam, stringParam } from '../shared/params';
import {
	generateTaskId,
	runAction,
	stepName,
	type ActionClient,
	type StepOutcome,
} from '../shared/engine';
import { collectSkillParams, skillParams } from '../shared/skillParams';

const SKILL_ACTION = 'skill' as const;

export class RobotSkill implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'Robot Skill',
		name: 'robotSkill',
		icon: { light: 'file:roboframe.svg', dark: 'file:roboframe.dark.svg' },
		group: ['transform'],
		version: 1,
		description: 'Execute one high-level robot skill through the RoboFrame bridge',
		subtitle: 'Executes one robot skill',
		defaults: { name: 'Robot Skill' },
		inputs: [NodeConnectionTypes.Main],
		outputs: [NodeConnectionTypes.Main],
		credentials: [{ name: 'robframeBridgeApi', required: true }],
		properties: [
			...skillParams,
			{
				displayName: 'Validate First',
				name: 'validateFirst',
				type: 'boolean',
				default: true,
				description:
					'Whether to run gateway validation before execution (schema + safety check, no motion)',
			},
			{
				displayName: 'Wait For Result',
				name: 'waitForResult',
				type: 'boolean',
				default: true,
				description: 'Whether to wait for the terminal task state instead of returning on submit',
			},
		],
	};

	async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
		const items = this.getInputData(0);
		try {
			const client = await clientFromCredentials(this);
			const output: INodeExecutionData[] = [];
			for (let index = 0; index < items.length; index++) {
				const values: SkillRunValues = {
					skill: stringParam(this, 'skill', index, ''),
					targetName: stringParam(this, 'targetName', index, ''),
					placeName: stringParam(this, 'placeName', index, ''),
					motionDirection: stringParam(this, 'motionDirection', index, ''),
					motionDistance: numberParam(this, 'motionDistance', index, 0),
					timeoutSec: numberParam(this, 'timeoutSec', index, 0),
					parametersJson: jsonParam(this, 'parametersJson', index),
				};
				const options = {
					validateFirst: booleanParam(this, 'validateFirst', index, true),
					waitForResult: booleanParam(this, 'waitForResult', index, true),
				};
				const result = await runSkill(client, values, options);
				output.push({ json: result, pairedItem: { item: index } });
			}
			return [output];
		} catch (error) {
			throw wrapError(this, error);
		}
	}

	methods = {
		loadOptions: {
			async getSkillNames(this: ILoadOptionsFunctions) {
				const client = await clientFromCredentials(this);
				const names = await client.skillNames();
				return names.map((name) => ({ name, value: name }));
			},
		},
	};
}

export type SkillRunOptions = { validateFirst: boolean; waitForResult: boolean };

export type SkillRunValues = {
	skill: string;
	targetName?: string | number;
	placeName?: string | number;
	motionDirection?: string | number;
	motionDistance?: string | number;
	timeoutSec?: string | number;
	parametersJson?: string | IDataObject;
};

/** Single-skill execution used by the node and by tests. */
export async function runSkill(
	client: ActionClient,
	values: SkillRunValues,
	options: SkillRunOptions,
): Promise<IDataObject> {
	if (values.skill === '') {
		throw new UserError('skill is required');
	}
	const { params, timeoutSec } = collectSkillParams(values);

	if (options.validateFirst) {
		const verdict = await client.validate({ kind: SKILL_ACTION, name: values.skill }, params);
		if (verdict.valid !== true) {
			const reason = typeof verdict.message === 'string' ? verdict.message : 'unknown reason';
			throw new UserError(`skill "${values.skill}" rejected by validation: ${reason}`);
		}
	}

	const step =
		timeoutSec === undefined
			? { step: 'skill' as const, skill: values.skill, params }
			: { step: 'skill' as const, skill: values.skill, params, timeoutSec };

	if (!options.waitForResult) {
		const taskId = generateTaskId();
		await client.execute(
			taskId,
			{ kind: SKILL_ACTION, name: step.skill },
			params,
			step.timeoutSec,
		);
		return {
			taskId,
			action: { kind: SKILL_ACTION, name: step.skill },
			state: 'accepted',
			success: null,
		};
	}

	const outcome: StepOutcome = await runAction(client, step, 0);
	return outcomeJson(outcome);
}

export function outcomeJson(outcome: StepOutcome): IDataObject {
	const json: IDataObject = {
		taskId: outcome.taskId ?? '',
		state: outcome.state ?? outcome.status,
		success: outcome.success ?? null,
		action: {
			kind: outcome.step.step,
			name: stepName(outcome.step),
		},
	};
	if (outcome.errorCode !== undefined) json.errorCode = outcome.errorCode;
	if (outcome.message !== undefined) json.message = outcome.message;
	if (outcome.executedPrimitives !== undefined) json.executedPrimitives = outcome.executedPrimitives;
	return json;
}
