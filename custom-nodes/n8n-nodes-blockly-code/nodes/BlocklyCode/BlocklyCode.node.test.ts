import type { IExecuteFunctions, INode, INodeExecutionData } from 'n8n-workflow';
import { describe, expect, it, vi } from 'vitest';

import { BlocklyCode } from './BlocklyCode.node';

const validPayload = JSON.stringify({
	schemaVersion: 1,
	workspace: {
		blocks: {
			languageVersion: 0,
			blocks: [
				{
					type: 'n8n_return_output',
					inputs: {
						VALUE: { block: { type: 'math_number', fields: { NUM: 42 } } },
					},
				},
			],
		},
	},
	javascript: 'return [{ json: { result: 42 } }];',
});

function createContext(
	payload: unknown,
	runnerResult: unknown = { ok: true, result: [{ json: { ok: true } }] },
) {
	const node = { name: 'Blockly Code' } as INode;
	const startJob = vi.fn().mockResolvedValue(runnerResult);

	return {
		context: {
			getNode: vi.fn().mockReturnValue(node),
			getNodeParameter: vi.fn().mockReturnValue(payload),
			getMode: vi.fn().mockReturnValue('manual'),
			continueOnFail: vi.fn().mockReturnValue(false),
			startJob,
		} as unknown as IExecuteFunctions,
		startJob,
	};
}

describe('BlocklyCode', () => {
	it('declares the Blockly editor with a matching default workspace and JavaScript', () => {
		const node = new BlocklyCode();
		const parameter = node.description.properties.find(({ name }) => name === 'blocklyPayload');

		expect(parameter?.typeOptions?.editor).toBe('blocklyEditor');
		const payload = JSON.parse(String(parameter?.default));
		expect(payload).toEqual({
			schemaVersion: 1,
			workspace: {
				blocks: {
					languageVersion: 0,
					blocks: [
						{
							type: 'n8n_return_output',
							x: 24,
							y: 24,
							inputs: {
								VALUE: {
									block: { type: 'math_number', fields: { NUM: 42 } },
								},
							},
						},
					],
				},
			},
			javascript: 'return [{ json: { result: 42 } }];',
		});
	});

	it('runs generated JavaScript through the task runner', async () => {
		const { context, startJob } = createContext(validPayload);
		const node = new BlocklyCode();

		const result = await node.execute.call(context);

		expect(startJob).toHaveBeenCalledWith(
			'javascript',
			{
				code: 'return [{ json: { result: 42 } }];',
				nodeMode: 'runOnceForAllItems',
				workflowMode: 'manual',
				continueOnFail: false,
				additionalProperties: {},
			},
			0,
		);
		expect(result).toEqual([[{ json: { ok: true } } satisfies INodeExecutionData]]);
	});

	it('preserves the task runner error message', async () => {
		const { context } = createContext(validPayload, {
			ok: false,
			error: { message: 'Runner rejected generated JavaScript' },
		});
		const node = new BlocklyCode();

		await expect(node.execute.call(context)).rejects.toThrow(
			'Runner rejected generated JavaScript',
		);
	});

	it.each([
		null,
		{},
		[null],
		[{ json: null }],
		[{ json: [] }],
		[{ json: 'invalid' }],
	])('rejects an invalid task runner result', async (result) => {
		const { context } = createContext(validPayload, { ok: true, result });
		const node = new BlocklyCode();

		await expect(node.execute.call(context)).rejects.toThrow(
			'JavaScript task runner returned invalid output',
		);
	});

	it.each([
		42,
		'not json',
		JSON.stringify({ schemaVersion: 2, workspace: {}, javascript: 'return [];' }),
		JSON.stringify({ schemaVersion: 1, workspace: [], javascript: 'return [];' }),
		JSON.stringify({ schemaVersion: 1, workspace: {}, javascript: '' }),
	])('rejects an invalid Blockly payload', async (payload) => {
		const { context, startJob } = createContext(payload);
		const node = new BlocklyCode();

		await expect(node.execute.call(context)).rejects.toThrow();
		expect(startJob).not.toHaveBeenCalled();
	});
});
