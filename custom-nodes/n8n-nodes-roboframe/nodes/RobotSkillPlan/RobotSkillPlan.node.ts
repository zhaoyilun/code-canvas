import {
	compileRobotWorkspace,
	createDefaultRobotPlanPayload,
	parseRobotPlanPayload,
} from '@n8n/blockly-robot-skills';
import type {
	IDataObject,
	IExecuteFunctions,
	INodeExecutionData,
	INodeType,
	INodeTypeDescription,
} from 'n8n-workflow';
import { NodeConnectionTypes, UserError } from 'n8n-workflow';
import { wrapError } from '../shared/errors';
import { stringParam } from '../shared/params';

const DEFAULT_ROBOT_PAYLOAD = createDefaultRobotPlanPayload();

export class RobotSkillPlan implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'Robot Plan',
		name: 'robotSkillPlan',
		icon: { light: 'file:roboframe.svg', dark: 'file:roboframe.dark.svg' },
		group: ['transform'],
		version: 1,
		description: 'Compose the detailed robot steps with Blockly inside an n8n node',
		subtitle: 'Blockly details inside the n8n workflow',
		defaults: { name: 'Robot Plan' },
		inputs: [NodeConnectionTypes.Main],
		outputs: [NodeConnectionTypes.Main],
		parameterPane: 'wide',
		properties: [
			{
				displayName: 'Robot Plan',
				name: 'blocklyPayload',
				type: 'string',
				default: DEFAULT_ROBOT_PAYLOAD,
				noDataExpression: true,
				typeOptions: {
					editor: 'robotSkillEditor',
					rows: 8,
				},
				description:
					'Open the Blockly editor inside this node to review or change the detailed robot steps',
			},
		],
	};

	async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
		const items = this.getInputData(0);
		try {
			const payloadRaw = stringParam(this, 'blocklyPayload', 0, DEFAULT_ROBOT_PAYLOAD);
			const parsed = parseRobotPlanPayload(payloadRaw);
			if (!parsed.ok) {
				throw new UserError(`invalid Blockly payload: ${parsed.error}`);
			}
			const compiled = compileRobotWorkspace(parsed.payload.workspace, parsed.payload.catalog);
			if (!compiled.ok) {
				throw new UserError(`workspace does not compile: ${compiled.error}`);
			}

			const output: INodeExecutionData[] = [];
			const compilation: IDataObject = {
				valid: true,
				blockCount: compiled.blockCount,
				catalogDigest: {
					source: 'payloadCatalog',
					value: compiled.plan.configDigest,
				},
			};
			for (let index = 0; index < items.length; index++) {
				output.push({
					json: { ...items[index].json, plan: compiled.plan, compilation },
					pairedItem: { item: index },
				});
			}
			if (output.length === 0) {
				output.push({ json: { plan: compiled.plan, compilation }, pairedItem: { item: 0 } });
			}
			return [output];
		} catch (error) {
			throw wrapError(this, error);
		}
	}
}
