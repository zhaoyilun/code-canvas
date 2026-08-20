import * as Blockly from 'blockly';
import { javascriptGenerator, Order } from 'blockly/javascript';

import { createToolbox, loadWorkspaceOrDefault, registerReturnOutputBlock } from './blockly';
import {
	createDefaultWorkspace,
	parseBlocklyEditorPayload,
	serializeBlocklyEditorPayload,
} from './payload';

describe('BlocklyEditor payload', () => {
	it('parses the supported payload shape', () => {
		const payload = {
			schemaVersion: 1,
			workspace: { blocks: { languageVersion: 0, blocks: [] } },
			javascript: 'return [];',
		};

		expect(parseBlocklyEditorPayload(JSON.stringify(payload))).toEqual(payload);
	});

	it.each(['', 'not json', '{}', '{"schemaVersion":2,"workspace":{},"javascript":""}'])(
		'rejects invalid payloads',
		(value) => {
			expect(parseBlocklyEditorPayload(value)).toBeNull();
		},
	);

	it('creates a workspace with the n8n output block', () => {
		expect(createDefaultWorkspace()).toEqual({
			blocks: {
				languageVersion: 0,
				blocks: [
					{
						type: 'n8n_return_output',
						x: 24,
						y: 24,
						inputs: {
							VALUE: {
								block: {
									type: 'math_number',
									fields: { NUM: 42 },
								},
							},
						},
					},
				],
			},
		});
	});

	it('provides draggable blocks in each static toolbox category', () => {
		const toolbox = createToolbox({
			logic: 'Logic',
			math: 'Math',
			text: 'Text',
			variables: 'Variables',
			output: 'n8n output',
		});

		expect(toolbox.contents).toMatchObject([
			{ contents: [{ type: 'logic_compare' }, { type: 'logic_boolean' }] },
			{ contents: [{ type: 'math_number' }, { type: 'math_arithmetic' }] },
			{ contents: [{ type: 'text' }, { type: 'text_join' }] },
			{ custom: 'VARIABLE' },
			{ contents: [{ type: 'n8n_return_output' }] },
		]);
	});

	it('generates an n8n result containing 42 from the default workspace', () => {
		registerReturnOutputBlock(Blockly, javascriptGenerator, Order.NONE, 'Return n8n output');
		const workspace = new Blockly.Workspace();

		try {
			expect(loadWorkspaceOrDefault(Blockly, workspace, createDefaultWorkspace())).toBe(true);
			expect(javascriptGenerator.workspaceToCode(workspace)).toBe(
				'return [{ json: { result: 42 } }];\n',
			);
		} finally {
			workspace.dispose();
		}
	});

	it('serializes the JavaScript generated from the loaded workspace', () => {
		registerReturnOutputBlock(Blockly, javascriptGenerator, Order.NONE, 'Return n8n output');
		const workspace = new Blockly.Workspace();
		const stalePayload = parseBlocklyEditorPayload(
			serializeBlocklyEditorPayload(createDefaultWorkspace(), 'return [{ json: { result: 7 } }];'),
		);
		if (!stalePayload) throw new Error('Expected a valid stale payload fixture');

		try {
			loadWorkspaceOrDefault(Blockly, workspace, stalePayload.workspace);
			const serialized = serializeBlocklyEditorPayload(
				Blockly.serialization.workspaces.save(workspace),
				javascriptGenerator.workspaceToCode(workspace),
			);

			expect(parseBlocklyEditorPayload(serialized)?.javascript).toBe(
				'return [{ json: { result: 42 } }];',
			);
			expect(serialized).not.toContain('result: 7');
		} finally {
			workspace.dispose();
		}
	});

	it('restores the default workspace when serialized blocks are invalid', () => {
		registerReturnOutputBlock(Blockly, javascriptGenerator, Order.NONE, 'Return n8n output');
		const workspace = new Blockly.Workspace();

		try {
			expect(
				loadWorkspaceOrDefault(Blockly, workspace, {
					blocks: { languageVersion: 0, blocks: [{ type: 'missing_block_type' }] },
				}),
			).toBe(false);
			expect(javascriptGenerator.workspaceToCode(workspace)).toBe(
				'return [{ json: { result: 42 } }];\n',
			);
		} finally {
			workspace.dispose();
		}
	});
});
