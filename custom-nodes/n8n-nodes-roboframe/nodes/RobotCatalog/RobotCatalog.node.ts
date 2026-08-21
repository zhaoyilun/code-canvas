import type {
	IDataObject,
	IExecuteFunctions,
	ILoadOptionsFunctions,
	INodeExecutionData,
	INodeType,
	INodeTypeDescription,
} from 'n8n-workflow';
import { NodeConnectionTypes } from 'n8n-workflow';
import { toDataObject } from '../shared/bridge';
import { clientFromCredentials } from '../shared/context';
import { wrapError } from '../shared/errors';
import { booleanParam } from '../shared/params';

export class RobotCatalog implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'Robot Catalog',
		name: 'robotCatalog',
		icon: { light: 'file:roboframe.svg', dark: 'file:roboframe.dark.svg' },
		group: ['input'],
		version: 1,
		description: 'List robot skills from the RoboFrame bridge catalog',
		subtitle: "Retrieves the robot skill catalog",
		defaults: { name: 'Robot Catalog' },
		inputs: [NodeConnectionTypes.Main],
		outputs: [NodeConnectionTypes.Main],
		credentials: [{ name: 'robframeBridgeApi', required: true }],
		properties: [
			{
				displayName: 'Include Details',
				name: 'includeDetails',
				type: 'boolean',
				default: false,
				description: 'Whether to include parameter schemas and policies in each skill item',
			},
		],
	};

	async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
		const includeDetails = booleanParam(this, 'includeDetails', 0, false);
		const items = this.getInputData(0);
		try {
			const client = await clientFromCredentials(this);
			const catalog = await client.catalog();
			const robotName = typeof catalog.robot_name === 'string' ? catalog.robot_name : '';
			const configDigest = typeof catalog.config_digest === 'string' ? catalog.config_digest : '';
			const skills = Array.isArray(catalog.skills) ? catalog.skills : [];
			const output: INodeExecutionData[] = [];
			for (const [index, skill] of skills.entries()) {
				const entry = toDataObject(skill) ?? {};
				const json: IDataObject = {
					robotName,
					configDigest,
					skill: typeof entry.name === 'string' ? entry.name : '',
				};
				if (includeDetails) {
					json.summary = entry.summary;
					json.domain = entry.domain;
					json.movesRobot = entry.moves_robot;
					json.requiredControlMode = entry.required_control_mode;
					json.parameters = entry.parameters;
					json.recoveryPolicy = entry.recovery_policy;
				}
				output.push({
					json,
					pairedItem: { item: items.length > 0 ? Math.min(index, items.length - 1) : 0 },
				});
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
