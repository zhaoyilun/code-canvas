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
		schemaVersion: '1.0',
		designId: 'lesson.demo',
		revisionId: 'revision-1',
		name: 'AI 可解释机器人课程',
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
	| 'robot-plan'
	| 'workflow-policy'
	| 'generation';

export class CompetitionDesign implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'Competition Design',
		name: 'competitionDesign',
		icon: { light: 'file:roboframe.svg', dark: 'file:roboframe.dark.svg' },
		group: ['transform'],
		version: 1,
		description: 'Generate linked n8n and Blockly diagrams from an AI design draft',
		subtitle: 'AI draft → n8n workflow + Blockly plan',
		defaults: { name: 'Competition Design' },
		inputs: [NodeConnectionTypes.Main],
		outputs: [NodeConnectionTypes.Main],
		credentials: [{ name: 'robframeBridgeApi', required: true }],
		parameterPane: 'wide',
		properties: [
			{
				displayName: 'Design Draft',
				name: 'designDraft',
				type: 'json',
				default: DEFAULT_DESIGN_DRAFT,
				description:
					'Structured AI design draft. The live robot catalog remains authoritative during generation.',
			},
			{
				displayName: 'Target Credential ID',
				name: 'targetCredentialId',
				type: 'string',
				default: TARGET_CREDENTIAL_ID_PLACEHOLDER,
				description: 'Credential ID embedded in the generated importable n8n workflow',
			},
			{
				displayName: 'Target Credential Name',
				name: 'targetCredentialName',
				type: 'string',
				default: TARGET_CREDENTIAL_NAME_PLACEHOLDER,
				description: 'Credential name embedded in the generated importable n8n workflow',
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
