import {
	compileBlocklyWorkspace,
	createDefaultWorkspace,
	parseBlocklyDataPayload,
	serializeBlocklyDataPayload,
} from '@n8n/blockly-data-transform';
import type { OperationModuleCatalogV1 } from '@n8n/dual-canvas-operation-runtime';
import type {
	IExecuteFunctions,
	INode,
	INodeExecutionData,
	INodeType,
	INodeTypeDescription,
} from 'n8n-workflow';
import { NodeConnectionTypes, NodeOperationError } from 'n8n-workflow';

const CHUNK_SIZE = 1000;
const EMPTY_OPERATION_CATALOG: OperationModuleCatalogV1 = { apiVersion: 1, modules: [] };
const DEFAULT_BLOCKLY_PAYLOAD = serializeBlocklyDataPayload(
	createDefaultWorkspace(),
	EMPTY_OPERATION_CATALOG,
);

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isExecutionResult(value: unknown): value is INodeExecutionData[] {
	return Array.isArray(value) && value.every(isJsonOnlyItem);
}

function isJsonOnlyItem(value: unknown): value is INodeExecutionData {
	if (!isRecord(value) || !isRecord(value.json) || !isRecord(value.pairedItem)) return false;
	if (
		typeof value.pairedItem.item !== 'number' ||
		!Number.isInteger(value.pairedItem.item) ||
		value.pairedItem.item < 0 ||
		Object.keys(value.pairedItem).length !== 1
	) {
		return false;
	}

	const keys = Object.keys(value);
	return keys.length === 2 && keys.every((key) => key === 'json' || key === 'pairedItem');
}

function getRunnerErrorMessage(error: unknown): string {
	if (isRecord(error) && typeof error.message === 'string' && error.message.trim() !== '') {
		return error.message;
	}

	return 'JavaScript task runner failed';
}

function createNodeError(node: INode, message: string, itemIndex?: number): NodeOperationError {
	return new NodeOperationError(node, message, itemIndex === undefined ? undefined : { itemIndex });
}

export class BlocklyCode implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'Blockly 逻辑',
		name: 'blocklyCode',
		icon: { light: 'file:blockly-code.svg', dark: 'file:blockly-code.dark.svg' },
		group: ['transform'],
		version: [1],
		description: '在此 n8n 节点中用可视化逻辑替代本地 JavaScript',
		subtitle: '可视化逻辑 · 每个输入项输出一条结果',
		defaults: {
			name: 'Blockly 逻辑',
		},
		inputs: [NodeConnectionTypes.Main],
		outputs: [NodeConnectionTypes.Main],
		parameterPane: 'wide',
		properties: [
			{
				displayName: '逻辑',
				name: 'blocklyPayload',
				type: 'string',
				default: DEFAULT_BLOCKLY_PAYLOAD,
				noDataExpression: true,
				typeOptions: {
					editor: 'blocklyEditor',
					editorProfile: 'data-transform',
					rows: 8,
				},
				description: '在此节点中打开 Blockly，以可视化方式转换每个输入项',
			},
		],
	};

	async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
		const node = this.getNode();
		const rawPayload = this.getNodeParameter('blocklyPayload', 0);
		if (typeof rawPayload !== 'string') {
			throw createNodeError(node, 'Blockly payload must be a string');
		}

		const parsedPayload = parseBlocklyDataPayload(rawPayload);
		if (!parsedPayload.ok) {
			throw createNodeError(node, `Invalid Blockly payload: ${parsedPayload.error}`);
		}

		const compiledWorkspace = compileBlocklyWorkspace(
			parsedPayload.payload.workspace,
			parsedPayload.payload.operationCatalog,
		);
		if (!compiledWorkspace.ok) {
			throw createNodeError(node, `Invalid Blockly workspace: ${compiledWorkspace.error}`);
		}

		const inputCount = this.getInputData().length;
		if (inputCount === 0) {
			return [[]];
		}

		const output: INodeExecutionData[] = [];
		for (let startIndex = 0; startIndex < inputCount; startIndex += CHUNK_SIZE) {
			const count = Math.min(CHUNK_SIZE, inputCount - startIndex);
			const executionResult = await this.startJob<unknown>(
				'javascript',
				{
					code: compiledWorkspace.javascript,
					nodeMode: 'runOnceForEachItem',
					workflowMode: this.getMode(),
					continueOnFail: this.continueOnFail(),
					chunk: { startIndex, count },
					additionalProperties: {},
				},
				0,
			);

			if (!executionResult.ok) {
				throw createNodeError(
					node,
					`Transformation failed: ${getRunnerErrorMessage(executionResult.error)}`,
					startIndex,
				);
			}

			if (!isExecutionResult(executionResult.result) || executionResult.result.length !== count) {
				throw createNodeError(node, 'JavaScript task runner returned invalid output', startIndex);
			}

			output.push(...executionResult.result);
		}

		return [output];
	}
}
