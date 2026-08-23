import type { CompetitionDesignGenerationResult } from '@n8n/competition-designer';
import type {
	IDataObject,
	IExecuteFunctions,
	INodeExecutionData,
	INodeType,
	INodeTypeDescription,
} from 'n8n-workflow';
import { NodeConnectionTypes, UnexpectedError } from 'n8n-workflow';

import { toDataObject } from '../shared/bridge';
import { clientFromCredentials } from '../shared/context';
import { stringParam } from '../shared/params';
import { mapBridgeCatalog } from './catalog';

const TARGET_CREDENTIAL_ID_PLACEHOLDER = 'REPLACE_WITH_ROBOFRAME_CREDENTIAL_ID';
const TARGET_CREDENTIAL_NAME_PLACEHOLDER = 'REPLACE_WITH_ROBOFRAME_CREDENTIAL_NAME';
const DEFAULT_DESIGN_DRAFT = JSON.stringify(
	{
		schemaVersion: '2.0',
		designId: 'lesson.demo',
		revisionId: 'revision-1',
		name: 'AI 可解释机器人课程',
		logicNodes: [
			{
				nodeRef: 'logic.prepare-input',
				label: '准备课程数据',
				outputMode: 'copyInput',
				statements: [
					{
						kind: 'set',
						intentStepId: 'logic.mark-prepared',
						targetField: 'prepared',
						value: { kind: 'boolean', value: true },
						teaching: {
							what: '标记数据已经准备完成',
							why: '让后续机器人节点读取明确的数据状态',
							editable: ['目标字段', '布尔值'],
							expectedEffect: '输出数据包含 prepared=true',
						},
					},
				],
			},
		],
		robotPlan: {
			schemaVersion: 1,
			planRef: 'plan.demo',
			label: '观察并执行动作',
			robotProfileRef: 'REPLACE_WITH_LIVE_ROBOT_NAME',
			catalogDigest: 'REPLACE_WITH_LIVE_CONFIG_DIGEST',
			budgetSec: 90,
			steps: [],
		},
	},
	null,
	2,
);

type DesignStage =
	| 'live-catalog'
	| 'target-credential'
	| 'design-draft'
	| 'blockly-logic'
	| 'robot-plan'
	| 'workflow-policy'
	| 'generation';

export class CompetitionDesign implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'AI 课程设计生成',
		name: 'competitionDesign',
		icon: { light: 'file:roboframe.svg', dark: 'file:roboframe.dark.svg' },
		group: ['transform'],
		version: 1,
		description: '根据 AI 设计草稿生成包含 Blockly 逻辑与机器人计划的 n8n 工作流',
		subtitle: 'AI 设计草稿 → n8n 工作流 + 节点内 Blockly',
		defaults: { name: 'AI 课程设计生成' },
		inputs: [NodeConnectionTypes.Main],
		outputs: [NodeConnectionTypes.Main],
		credentials: [{ name: 'robframeBridgeApi', required: true }],
		parameterPane: 'wide',
		properties: [
			{
				displayName: 'AI 设计草稿',
				name: 'designDraft',
				type: 'json',
				default: DEFAULT_DESIGN_DRAFT,
				description:
					'用于生成 n8n 编排图、节点内 Blockly 逻辑和 Blockly 机器人计划的结构化 AI 草稿；实时机器人能力目录始终作为依据。',
			},
			{
				displayName: '目标凭据 ID',
				name: 'targetCredentialId',
				type: 'string',
				default: TARGET_CREDENTIAL_ID_PLACEHOLDER,
				description: '写入生成的可导入 n8n 工作流中的凭据 ID',
			},
			{
				displayName: '目标凭据名称',
				name: 'targetCredentialName',
				type: 'string',
				default: TARGET_CREDENTIAL_NAME_PLACEHOLDER,
				description: '写入生成的可导入 n8n 工作流中的凭据名称',
			},
		],
	};

	async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
		const items = this.getInputData(0);
		const count = Math.max(items.length, 1);
		let liveCatalog: IDataObject;
		let poseCatalog: IDataObject;
		try {
			const client = await clientFromCredentials(this);
			[liveCatalog, poseCatalog] = await Promise.all([client.catalog(), client.poseCatalog()]);
		} catch (error) {
			return [
				failureItems(
					items,
					count,
					'live-catalog',
					'BRIDGE_CATALOG_FETCH_FAILED',
					errorMessage(error),
					'robframeBridgeApi',
				),
			];
		}

		const mapped = mapBridgeCatalog(liveCatalog, poseCatalog);
		if (!mapped.ok) {
			return [
				failureItems(
					items,
					count,
					'live-catalog',
					mapped.error.code,
					mapped.error.message,
					mapped.error.path,
				),
			];
		}

		const { generateCompetitionDesign } = await import('@n8n/competition-designer');
		const output: INodeExecutionData[] = [];
		for (let index = 0; index < count; index++) {
			const base = items[index]?.json ?? {};
			const targetCredentialId = stringParam(
				this,
				'targetCredentialId',
				index,
				TARGET_CREDENTIAL_ID_PLACEHOLDER,
			).trim();
			const targetCredentialName = stringParam(
				this,
				'targetCredentialName',
				index,
				TARGET_CREDENTIAL_NAME_PLACEHOLDER,
			).trim();
			if (targetCredentialId === '' || targetCredentialName === '') {
				output.push(
					outputItem(
						base,
						failure(
							'target-credential',
							'TARGET_CREDENTIAL_INVALID',
							'Target credential ID and name must both be non-empty',
							'targetCredentialId',
						),
						index,
					),
				);
				continue;
			}

			const draftResult = parseDesignDraft(
				this.getNodeParameter('designDraft', index, DEFAULT_DESIGN_DRAFT),
			);
			if (!draftResult.ok) {
				output.push(outputItem(base, draftResult.output, index));
				continue;
			}

			try {
				const generated = generateCompetitionDesign(draftResult.value, {
					catalog: mapped.catalog,
					robotCredential: { id: targetCredentialId, name: targetCredentialName },
				});
				output.push(outputItem(base, normalizeGenerationResult(generated), index));
			} catch (error) {
				output.push(
					outputItem(
						base,
						failure(
							'generation',
							'DESIGN_GENERATION_FAILED',
							errorMessage(error),
							'designDraft',
						),
						index,
					),
				);
			}
		}
		return [output];
	}
}

function parseDesignDraft(
	value: unknown,
): { ok: true; value: unknown } | { ok: false; output: IDataObject } {
	if (typeof value !== 'string') return { ok: true, value };
	try {
		const parsed: unknown = JSON.parse(value);
		return { ok: true, value: parsed };
	} catch (error) {
		return {
			ok: false,
			output: failure(
				'design-draft',
				'DESIGN_DRAFT_JSON_INVALID',
				errorMessage(error),
				'designDraft',
			),
		};
	}
}

function normalizeGenerationResult(result: CompetitionDesignGenerationResult): IDataObject {
	if (result.ok) {
		return toOutputRecord({
			ok: true,
			stage: 'complete',
			schemaVersion: result.artifact.schemaVersion,
			designId: result.artifact.designId,
			revisionId: result.artifact.revisionId,
			catalogDigest: result.artifact.catalogDigest,
			n8nWorkflow: result.artifact.n8nWorkflow,
			logicNodes: result.artifact.logicNodes,
			blocklyPayload: result.artifact.blocklyPayload,
			blocklyWorkspace: result.artifact.blocklyWorkspace,
			semanticDraft: result.artifact.semanticDraft,
			robotTaskPlan: result.artifact.robotPlan,
			traceMap: result.artifact.traceMap,
		});
	}
	if (result.stage === 'robot-plan') {
		return failure(
			result.stage,
			result.error.code,
			result.error.message,
			result.error.path,
		);
	}
	if (result.stage === 'blockly-logic') {
		return failure(
			result.stage,
			result.error.code,
			result.error.message,
			result.error.path,
		);
	}
	return toOutputRecord({ ok: false, stage: result.stage, diagnostics: result.diagnostics });
}

function failure(
	stage: DesignStage,
	code: string,
	message: string,
	ref?: string,
): IDataObject {
	return toOutputRecord({
		ok: false,
		stage,
		diagnostics: [{ code, severity: 'error', ...(ref === undefined ? {} : { ref }), message }],
	});
}

function failureItems(
	items: INodeExecutionData[],
	count: number,
	stage: DesignStage,
	code: string,
	message: string,
	ref?: string,
): INodeExecutionData[] {
	const failed = failure(stage, code, message, ref);
	return Array.from({ length: count }, (_, index) =>
		outputItem(items[index]?.json ?? {}, failed, index),
	);
}

function outputItem(base: IDataObject, result: IDataObject, index: number): INodeExecutionData {
	return { json: { ...base, ...result }, pairedItem: { item: index } };
}

function toOutputRecord(value: unknown): IDataObject {
	const serialized = JSON.stringify(value);
	if (serialized === undefined) throw new UnexpectedError('generated result is not serializable');
	const parsed: unknown = JSON.parse(serialized);
	const record = toDataObject(parsed);
	if (record === null) throw new UnexpectedError('generated result is not an n8n data object');
	return record;
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : 'unexpected error';
}

export {
	DEFAULT_DESIGN_DRAFT,
	TARGET_CREDENTIAL_ID_PLACEHOLDER,
	TARGET_CREDENTIAL_NAME_PLACEHOLDER,
};
