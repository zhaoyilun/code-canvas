import * as Blockly from 'blockly';
import {
	GET_FIELD_BLOCK,
	SET_FIELD_BLOCK,
	TRANSFORM_ITEM_BLOCK,
	createToolbox,
	loadWorkspaceOrDefault,
	registerN8nBlocks,
} from './blockly';
import {
	compileBlocklyWorkspace,
	parseBlocklyDataPayload,
	serializeBlocklyDataPayload,
} from './payload';

describe('BlocklyEditor configuration', () => {
	it('provides only blocks supported by the data transform grammar', () => {
		const toolbox = createToolbox({
			transform: 'Transform',
			logic: 'Logic',
			math: 'Math',
			text: 'Text',
		});
		expect(toolbox.contents).toMatchObject([
			{
				contents: [
					{ type: TRANSFORM_ITEM_BLOCK },
					{ type: SET_FIELD_BLOCK },
					{ type: GET_FIELD_BLOCK },
				],
			},
			{
				contents: [
					{ type: 'logic_boolean' },
					{ type: 'logic_compare' },
					{ type: 'logic_operation' },
					{ type: 'logic_negate' },
					{ type: 'logic_ternary' },
				],
			},
			{ contents: [{ type: 'math_number' }, { type: 'math_arithmetic' }] },
			{ contents: [{ type: 'text' }, { type: 'text_join' }] },
		]);
		expect(JSON.stringify(toolbox)).not.toContain('VARIABLE');
		expect(JSON.stringify(toolbox)).not.toContain('controls_');
	});
	it('registers the three n8n blocks and loads a transform workspace', () => {
		registerN8nBlocks(Blockly, {
			transformItem: 'Transform item',
			copyInput: 'Copy input',
			emptyOutput: 'Start empty',
			setField: 'Set field',
			to: 'to',
			getField: 'Get field',
			path: 'path',
		});
		const workspace = new Blockly.Workspace();
		try {
			expect(
				loadWorkspaceOrDefault(
					Blockly,
					workspace,
					{
						blocks: {
							languageVersion: 0,
							blocks: [{ type: TRANSFORM_ITEM_BLOCK, fields: { MODE: 'COPY' } }],
						},
					},
					{
						blocks: {
							languageVersion: 0,
							blocks: [{ type: TRANSFORM_ITEM_BLOCK, fields: { MODE: 'COPY' } }],
						},
					},
				),
			).toBe(true);
			expect(workspace.getTopBlocks()).toHaveLength(1);
			expect(workspace.getTopBlocks()[0]?.type).toBe(TRANSFORM_ITEM_BLOCK);
		} finally {
			workspace.dispose();
		}
	});

	it('keeps an incomplete schema 2 workspace with an empty preview', () => {
		registerN8nBlocks(Blockly, {
			transformItem: 'Transform item',
			copyInput: 'Copy input',
			emptyOutput: 'Start empty',
			setField: 'Set field',
			to: 'to',
			getField: 'Get field',
			path: 'path',
		});
		const incompleteWorkspace = {
			blocks: {
				languageVersion: 0,
				blocks: [
					{
						type: TRANSFORM_ITEM_BLOCK,
						fields: { MODE: 'COPY' },
						inputs: {
							STATEMENTS: {
								block: { type: SET_FIELD_BLOCK, fields: { KEY: 'grade' } },
							},
						},
					},
				],
			},
		};

		expect(compileBlocklyWorkspace(incompleteWorkspace).ok).toBe(false);
		const serialized = serializeBlocklyDataPayload(incompleteWorkspace);
		expect(JSON.parse(serialized)).toMatchObject({ schemaVersion: 2, javascript: '' });
		const parsed = parseBlocklyDataPayload(serialized);
		expect(parsed.ok).toBe(true);
		if (!parsed.ok) return;

		const workspace = new Blockly.Workspace();
		try {
			expect(
				loadWorkspaceOrDefault(Blockly, workspace, parsed.payload.workspace, incompleteWorkspace),
			).toBe(true);
			expect(workspace.getAllBlocks().map(({ type }) => type)).toEqual([
				TRANSFORM_ITEM_BLOCK,
				SET_FIELD_BLOCK,
			]);
		} finally {
			workspace.dispose();
		}
	});
});
