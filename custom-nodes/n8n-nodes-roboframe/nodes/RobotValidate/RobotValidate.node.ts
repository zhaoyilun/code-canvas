import type {
	IDataObject,
	IExecuteFunctions,
	ILoadOptionsFunctions,
	INodeExecutionData,
	INodeType,
	INodeTypeDescription,
} from 'n8n-workflow';
import { NodeConnectionTypes } from 'n8n-workflow';
import { clientFromCredentials } from '../shared/context';
import { wrapError } from '../shared/errors';
import { jsonParam, numberParam, stringParam } from '../shared/params';
import { collectSkillParams, skillParams } from '../shared/skillParams';

export class RobotValidate implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'Robot Validate',
		name: 'robotValidate',
		icon: { light: 'file:roboframe.svg', dark: 'file:roboframe.dark.svg' },
		group: ['transform'],
		version: 1,
		description: 'Validate skill parameters against the RoboFrame gateway (no motion)',
		subtitle: 'Validates skill parameters (no motion)',
		defaults: { name: 'Robot Validate' },
		inputs: [NodeConnectionTypes.Main],
		outputs: [NodeConnectionTypes.Main],
		credentials: [{ name: 'robframeBridgeApi', required: true }],
		properties: skillParams,
	};

	async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
		const items = this.getInputData(0);
		try {
			const client = await clientFromCredentials(this);
			const output: INodeExecutionData[] = [];
			for (let index = 0; index < items.length; index++) {
				const skill = stringParam(this, 'skill', index, '');
				if (skill === '') {
					output.push({
						json: { valid: false, message: 'skill is required' },
						pairedItem: { item: index },
					});
					continue;
				}
				const { params } = collectSkillParams({
					targetName: stringParam(this, 'targetName', index, ''),
					placeName: stringParam(this, 'placeName', index, ''),
					motionDirection: stringParam(this, 'motionDirection', index, ''),
					motionDistance: numberParam(this, 'motionDistance', index, 0),
					parametersJson: jsonParam(this, 'parametersJson', index),
				});
				const verdict = await client.validate(skill, params);
				const json: IDataObject = {
					valid: verdict.valid === true,
					skill,
					errorCode: verdict.error_code ?? '',
					message: verdict.message ?? '',
				};
				output.push({ json, pairedItem: { item: index } });
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
