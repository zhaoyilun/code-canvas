import { extractPlan, type RobotTaskPlan } from '@n8n/blockly-robot-skills';
import type {
	IDataObject,
	IExecuteFunctions,
	INodeExecutionData,
	INodeType,
	INodeTypeDescription,
} from 'n8n-workflow';
import { NodeConnectionTypes, UserError } from 'n8n-workflow';
import type { RobotAction } from '../shared/bridge';
import { catalogDigestJson, checkCatalogDigest } from '../shared/catalogDigest';
import { clientFromCredentials } from '../shared/context';
import { actionOf, paramsOf, type ActionClient } from '../shared/engine';
import { wrapError } from '../shared/errors';
import { jsonParam, stringParam } from '../shared/params';
import { computePlanDigest } from '../shared/planDigest';
import { collectSkillParams } from '../shared/skillParams';

export class RobotValidate implements INodeType {
	description: INodeTypeDescription = {
		displayName: '机器人计划校验',
		name: 'robotValidate',
		icon: { light: 'file:roboframe.svg', dark: 'file:roboframe.dark.svg' },
		group: ['transform'],
		version: 1,
		description: '通过 RoboFrame 网关校验已编译的机器人计划或单个动作',
		subtitle: '在机器人任务执行前校验计划',
		defaults: { name: '机器人计划校验' },
		inputs: [NodeConnectionTypes.Main],
		outputs: [NodeConnectionTypes.Main],
		credentials: [{ name: 'robframeBridgeApi', required: true }],
		properties: [
			{
				displayName: '校验对象',
				name: 'operation',
				type: 'options',
				noDataExpression: true,
				options: [
					{ name: '计划', value: 'plan' },
					{ name: '单个动作（调试）', value: 'action' },
				],
				default: 'plan',
				description: '计划模式会校验上游机器人计划输出中的每一个动作',
			},
			{
				displayName: '动作类别',
				name: 'actionKind',
				type: 'options',
				options: [
					{ name: '技能', value: 'skill' },
					{ name: '基础动作', value: 'primitive' },
				],
				default: 'skill',
				displayOptions: { show: { operation: ['action'] } },
			},
			{
				displayName: '动作名称',
				name: 'actionName',
				type: 'string',
				default: '',
				required: true,
				displayOptions: { show: { operation: ['action'] } },
				description: '从实时 RoboFrame 能力目录中选择技能或基础动作名称',
			},
			{
				displayName: '参数 JSON',
				name: 'parametersJson',
				type: 'json',
				default: '{}',
				displayOptions: { show: { operation: ['action'] } },
				description: '由所选动作校验器检查的参数',
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
				const operation = stringParam(this, 'operation', index, 'plan');
				if (operation === 'action') {
					const kind = actionKindParam(this, index);
					const name = stringParam(this, 'actionName', index, '').trim();
					if (name === '') throw new UserError(`item ${index}: action name is required`);
					const { params } = collectSkillParams({
						parametersJson: jsonParam(this, 'parametersJson', index),
					});
					const action = { kind, name };
					const verdict = await validateAction(client, action, params);
					output.push({
						json: { ...item.json, validation: { mode: 'action', ...verdict } },
						pairedItem: { item: index },
					});
					continue;
				}
				if (operation !== 'plan') {
					throw new UserError(`item ${index}: unsupported validation operation "${operation}"`);
				}

				const extracted = extractPlan(item.json.plan ?? item.json);
				if (typeof extracted === 'string') {
					throw new UserError(`item ${index}: ${extracted}`);
				}
				const validation = await validatePlan(client, extracted);
				output.push({
					json: { ...item.json, plan: extracted, validation },
					pairedItem: { item: index },
				});
			}
			return [output];
		} catch (error) {
			throw wrapError(this, error);
		}
	}
}

export async function validatePlan(client: ActionClient, plan: RobotTaskPlan): Promise<IDataObject> {
	const digest = await checkCatalogDigest(client, plan);
	const steps: IDataObject[] = [];
	for (const [index, step] of plan.plan.entries()) {
		const identity: IDataObject = {};
		if (step.blockId !== undefined) identity.blockId = step.blockId;
		if (step.planStepId !== undefined) identity.planStepId = step.planStepId;
		if (step.step === 'wait') {
			steps.push({ index, ...identity, type: 'wait', valid: true, seconds: step.seconds });
			continue;
		}
		const action = actionOf(step);
		const verdict = await validateAction(client, action, paramsOf(step));
		steps.push({ index, ...identity, ...verdict });
	}
	const valid = digest.valid && steps.every((step) => step.valid === true);
	return {
		mode: 'plan',
		valid,
		planDigest: computePlanDigest(plan),
		catalogDigest: catalogDigestJson(digest),
		checkedActionCount: steps.filter((step) => step.type === 'action').length,
		steps,
	};
}

async function validateAction(
	client: ActionClient,
	action: RobotAction,
	params: IDataObject,
): Promise<IDataObject> {
	const verdict = await client.validate(action, params);
	return {
		type: 'action',
		action: { kind: action.kind, name: action.name },
		valid: verdict.valid === true,
		errorCode: typeof verdict.error_code === 'string' ? verdict.error_code : '',
		message: typeof verdict.message === 'string' ? verdict.message : '',
	};
}

function actionKindParam(context: IExecuteFunctions, index: number): RobotAction['kind'] {
	return stringParam(context, 'actionKind', index, 'skill') === 'primitive' ? 'primitive' : 'skill';
}
