import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { IExecuteFunctions, INode, INodeExecutionData } from 'n8n-workflow';

const compiler = vi.hoisted(() => ({
	compileBlocklyWorkspace: vi.fn(),
	createDefaultWorkspace: vi.fn(),
	parseBlocklyDataPayload: vi.fn(),
	serializeBlocklyDataPayload: vi.fn(),
}));

vi.mock('@n8n/blockly-data-transform', () => compiler);

import { BlocklyCode } from './BlocklyCode.node';

const workspace = { blocks: { blocks: [] } };
const compiledCode = 'return { json: { processed: true } };';

function runnerItem(item: number, json: Record<string, unknown> = {}) {
	return { json, pairedItem: { item } };
}

function createContext(inputCount: number, runnerResults: unknown[] = []) {
	const node = { name: 'Blockly Logic' } as INode;
	const startJob = vi.fn();
	for (const runnerResult of runnerResults) {
		startJob.mockResolvedValueOnce(runnerResult);
	}

	return {
		context: {
			getNode: vi.fn().mockReturnValue(node),
			getNodeParameter: vi.fn().mockReturnValue(JSON.stringify({ schemaVersion: 2, workspace })),
			getInputData: vi
				.fn()
				.mockReturnValue(
					Array.from({ length: inputCount }, () => ({ json: {} }) satisfies INodeExecutionData),
				),
			getMode: vi.fn().mockReturnValue('manual'),
			continueOnFail: vi.fn().mockReturnValue(false),
			startJob,
		} as unknown as IExecuteFunctions,
		startJob,
	};
}

beforeEach(() => {
	compiler.createDefaultWorkspace.mockReturnValue(workspace);
	compiler.serializeBlocklyDataPayload.mockReturnValue(
		JSON.stringify({ schemaVersion: 2, workspace }),
	);
	compiler.parseBlocklyDataPayload.mockReturnValue({
		ok: true,
		payload: { schemaVersion: 2, workspace, javascript: 'return { json: { tampered: true } };' },
	});
	compiler.compileBlocklyWorkspace.mockReturnValue({
		ok: true,
		javascript: compiledCode,
		blockCount: 1,
	});
});

describe('BlocklyCode', () => {
	it('declares a Chinese Blockly Logic node with a wide, expression-free embedded editor', () => {
		const node = new BlocklyCode();
		const parameter = node.description.properties.find(({ name }) => name === 'blocklyPayload');

		expect(node.description.displayName).toBe('Blockly 逻辑');
		expect(node.description.description).toBe('在此 n8n 节点中用可视化逻辑替代本地 JavaScript');
		expect(node.description.subtitle).toBe('可视化逻辑 · 每个输入项输出一条结果');
		expect(node.description.defaults.name).toBe('Blockly 逻辑');
		expect(node.description.name).toBe('blocklyCode');
		expect(node.description.version).toEqual([1]);
		expect(node.description.parameterPane).toBe('wide');
		expect(node.description.properties).toHaveLength(1);
		expect(parameter?.name).toBe('blocklyPayload');
		expect(parameter?.displayName).toBe('逻辑');
		expect(parameter?.description).toBe('在此节点中打开 Blockly，以可视化方式转换每个输入项');
		expect(parameter?.noDataExpression).toBe(true);
		expect(parameter?.typeOptions?.editor).toBe('blocklyEditor');
		expect(parameter?.typeOptions?.editorProfile).toBe('data-transform');
	});

	it('ignores tampered payload JavaScript and runs the compiled workspace for three items', async () => {
		const { context, startJob } = createContext(3, [
			{
				ok: true,
				result: [runnerItem(0, { item: 1 }), runnerItem(1, { item: 2 }), runnerItem(2, { item: 3 })],
			},
		]);
		const node = new BlocklyCode();

		const result = await node.execute.call(context);

		expect(compiler.compileBlocklyWorkspace).toHaveBeenCalledWith(workspace);
		expect(startJob).toHaveBeenCalledWith(
			'javascript',
			{
				code: compiledCode,
				nodeMode: 'runOnceForEachItem',
				workflowMode: 'manual',
				continueOnFail: false,
				chunk: { startIndex: 0, count: 3 },
				additionalProperties: {},
			},
			0,
		);
		expect(result).toEqual([
			[runnerItem(0, { item: 1 }), runnerItem(1, { item: 2 }), runnerItem(2, { item: 3 })],
		]);
	});

	it('returns no output without starting the runner for empty input', async () => {
		const { context, startJob } = createContext(0);
		const node = new BlocklyCode();

		await expect(node.execute.call(context)).resolves.toEqual([[]]);
		expect(startJob).not.toHaveBeenCalled();
	});

	it('runs inputs over 1,000 items in separate chunks', async () => {
		const firstChunk = Array.from({ length: 1000 }, (_, item) => runnerItem(item));
		const { context, startJob } = createContext(1001, [
			{ ok: true, result: firstChunk },
			{ ok: true, result: [runnerItem(1000)] },
		]);
		const node = new BlocklyCode();

		await node.execute.call(context);

		expect(startJob.mock.calls.map(([, settings]) => settings)).toEqual([
			expect.objectContaining({ chunk: { startIndex: 0, count: 1000 } }),
			expect.objectContaining({ chunk: { startIndex: 1000, count: 1 } }),
		]);
	});

	it('rejects compiler failures before starting the runner', async () => {
		compiler.compileBlocklyWorkspace.mockReturnValue({ ok: false, error: 'Unsupported block' });
		const { context, startJob } = createContext(1);
		const node = new BlocklyCode();

		await expect(node.execute.call(context)).rejects.toThrow(
			'Invalid Blockly workspace: Unsupported block',
		);
		expect(startJob).not.toHaveBeenCalled();
	});

	it('wraps task runner failures without exposing the compiled code', async () => {
		const { context } = createContext(1, [
			{ ok: false, error: { message: 'Runner timed out' } },
		]);
		const node = new BlocklyCode();

		await expect(node.execute.call(context)).rejects.toThrow(
			'Transformation failed: Runner timed out',
		);
	});

	it.each(['schema version 1 is unsupported', 'payload is malformed', 'payload exceeds 256 KiB'])(
		'rejects invalid payloads before starting the runner: %s',
		async (error) => {
			compiler.parseBlocklyDataPayload.mockReturnValue({ ok: false, error });
			const { context, startJob } = createContext(1);
			const node = new BlocklyCode();

			await expect(node.execute.call(context)).rejects.toThrow(`Invalid Blockly payload: ${error}`);
			expect(startJob).not.toHaveBeenCalled();
		},
	);

	it.each([
		{ ok: true, result: [runnerItem(0, { item: 1 }), runnerItem(1, { item: 2 })] },
		{ ok: true, result: [{ json: null, pairedItem: { item: 0 } }] },
		{ ok: true, result: [{ json: ['multiple outputs'], pairedItem: { item: 0 } }] },
		{ ok: true, result: [{ ...runnerItem(0), binary: {} }] },
		{ ok: true, result: [{ ...runnerItem(0), unexpected: true }] },
		{ ok: true, result: [{ json: {}, pairedItem: { item: -1 } }] },
		{ ok: true, result: [{ json: {}, pairedItem: { item: 0, input: 0 } }] },
		{ ok: true, result: [{ json: {} }] },
		{ ok: true, result: [runnerItem(0, { item: 1 }), null] },
	])(
		'rejects runner output that is not one JSON object for every input item',
		async (runnerResult) => {
			const { context } = createContext(1, [runnerResult]);
			const node = new BlocklyCode();

			await expect(node.execute.call(context)).rejects.toThrow(
				'JavaScript task runner returned invalid output',
			);
		},
	);
});
