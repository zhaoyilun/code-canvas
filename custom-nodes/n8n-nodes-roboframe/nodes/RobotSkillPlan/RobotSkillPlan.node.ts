import {
	SO101_CATALOG_SNAPSHOT,
	compileRobotWorkspace,
	createDefaultRobotWorkspace,
	parseRobotPlanPayload,
	serializeRobotPlanPayload,
} from '@n8n/blockly-robot-skills';
import type {
	IExecuteFunctions,
	INodeExecutionData,
	INodeType,
	INodeTypeDescription,
} from 'n8n-workflow';
import { NodeConnectionTypes, UserError } from 'n8n-workflow';
import { clientFromCredentials } from '../shared/context';
import { wrapError } from '../shared/errors';
import { booleanParam, stringParam } from '../shared/params';
import { runPlan, verifyDigest } from '../RobotTask/RobotTask.node';

const DEFAULT_ROBOT_PAYLOAD = serializeRobotPlanPayload(createDefaultRobotWorkspace(), undefined);

export class RobotSkillPlan implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'Robot Skill Plan',
		name: 'robotSkillPlan',
		icon: { light: 'file:roboframe.svg', dark: 'file:roboframe.dark.svg' },
		group: ['transform'],
		version: 1,
		description: 'Compose a robot task plan with Blockly',
		subtitle: 'Blockly → structured task plan',
		defaults: { name: 'Robot Skill Plan' },
		inputs: [NodeConnectionTypes.Main],
		outputs: [NodeConnectionTypes.Main],
		parameterPane: 'wide',
		credentials: [{ name: 'robframeBridgeApi', required: false }],
		properties: [
			{
				displayName: 'Blockly Payload',
				name: 'blocklyPayload',
				type: 'string',
				default: DEFAULT_ROBOT_PAYLOAD,
				noDataExpression: true,
				typeOptions: {
					editor: 'robotSkillEditor',
					rows: 8,
				},
				description: 'Blockly workspace composing the robot task plan',
			},
			{
				displayName: 'Mode',
				name: 'mode',
				type: 'options',
				options: [
					{ name: 'Compile (Output Plan JSON)', value: 'compile' },
					{ name: 'Execute (Run Plan via Bridge)', value: 'execute' },
				],
				default: 'compile',
				description:
					'Compile emits the plan for a downstream Robot Task node; Execute runs it directly',
			},
			{
				displayName: 'Verify Catalog Digest',
				name: 'verifyCatalog',
				type: 'boolean',
				displayOptions: { show: { mode: ['execute'] } },
				default: true,
				description: 'Whether to fail when the live catalog digest differs from the compiled plan',
			},
		],
	};

	async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
		const items = this.getInputData(0);
		try {
			const payloadRaw = stringParam(this, 'blocklyPayload', 0, DEFAULT_ROBOT_PAYLOAD);
			const mode = stringParam(this, 'mode', 0, 'compile');
			const parsed = parseRobotPlanPayload(payloadRaw);
			if (!parsed.ok) {
				throw new UserError(`invalid Blockly payload: ${parsed.error}`);
			}
			const compiled = compileRobotWorkspace(parsed.payload.workspace, SO101_CATALOG_SNAPSHOT);
			if (!compiled.ok) {
				throw new UserError(`workspace does not compile: ${compiled.error}`);
			}

			const output: INodeExecutionData[] = [];
			if (mode === 'compile') {
				for (let index = 0; index < items.length; index++) {
					output.push({ json: { plan: compiled.plan }, pairedItem: { item: index } });
				}
				if (output.length === 0) output.push({ json: { plan: compiled.plan }, pairedItem: { item: 0 } });
				return [output];
			}

			const client = await clientFromCredentials(this);
			for (let index = 0; index < items.length; index++) {
				const verifyCatalog = booleanParam(this, 'verifyCatalog', index, true);
				if (verifyCatalog) {
					const error = await verifyDigest(client, compiled.plan);
					if (error !== null) throw new UserError(error);
				}
				const result = await runPlan(client, compiled.plan, {});
				output.push({ json: result, pairedItem: { item: index } });
			}
			return [output];
		} catch (error) {
			throw wrapError(this, error);
		}
	}
}
