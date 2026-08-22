import * as Blockly from 'blockly';
import {
	ARRAY_AT_BLOCK,
	ARRAY_FILTER_PATH_BLOCK,
	ARRAY_MAP_PATH_BLOCK,
	ASSERT_BLOCK,
	CONVERT_BLOCK,
	DELETE_FIELD_BLOCK,
	GET_FIELD_BLOCK,
	GET_PATH_BLOCK,
	IF_BLOCK,
	OBJECT_CREATE_BLOCK,
	OBJECT_PROPERTY_BLOCK,
	SET_FIELD_BLOCK,
	TRANSFORM_ITEM_BLOCK,
	type BlockLabels,
	createToolbox,
	loadWorkspaceOrDefault,
	registerN8nBlocks,
} from './blockly';
import {
	compileBlocklyWorkspace,
	parseBlocklyDataPayload,
	serializeBlocklyDataPayload,
} from './payload';

const blockLabels: BlockLabels = {
	transformItem: 'Transform item',
	copyInput: 'Copy input',
	emptyOutput: 'Start empty',
	setField: 'Set field',
	to: 'to',
	getField: 'Get field',
	path: 'path',
	deleteField: 'Delete field',
	if: 'If',
	do: 'do',
	else: 'else',
	assert: 'Require',
	message: 'otherwise report',
	getPath: 'Get path',
	from: 'from value',
	convert: 'Convert',
	as: 'to',
	convertText: 'text',
	convertNumber: 'number',
	convertBoolean: 'boolean',
	arrayItemAt: 'Get array item',
	index: 'at index',
	mapArrayPath: 'Read path from every item',
	filterArrayPath: 'Keep items where',
	operatorEqual: 'equals',
	operatorNotEqual: 'does not equal',
	operatorLess: 'is less than',
	operatorLessEqual: 'is at most',
	operatorGreater: 'is greater than',
	operatorGreaterEqual: 'is at least',
	objectCreate: 'Create object with',
	objectProperty: 'Object property',
	key: 'key',
};

describe('BlocklyEditor configuration', () => {
	it('provides only blocks supported by the data transform grammar', () => {
		const toolbox = createToolbox({
			transform: 'Transform',
			logic: 'Logic',
			math: 'Math',
			text: 'Text',
			arrays: 'Arrays',
			objects: 'Objects',
			types: 'Types',
		});
		expect(toolbox.contents).toMatchObject([
			{
				contents: [
					{ type: TRANSFORM_ITEM_BLOCK },
					{ type: SET_FIELD_BLOCK },
					{ type: DELETE_FIELD_BLOCK },
					{ type: GET_FIELD_BLOCK },
				],
			},
			{
				contents: [
					{ type: IF_BLOCK },
					{ type: ASSERT_BLOCK },
					{ type: 'logic_boolean' },
					{ type: 'logic_compare' },
					{ type: 'logic_operation' },
					{ type: 'logic_negate' },
					{ type: 'logic_ternary' },
				],
			},
			{ contents: [{ type: 'math_number' }, { type: 'math_arithmetic' }] },
			{ contents: [{ type: 'text' }, { type: 'text_join' }] },
			{
				contents: [
					{ type: 'lists_create_with' },
					{ type: 'lists_length' },
					{ type: ARRAY_AT_BLOCK },
					{ type: ARRAY_MAP_PATH_BLOCK },
					{ type: ARRAY_FILTER_PATH_BLOCK },
				],
			},
			{
				contents: [
					{ type: OBJECT_CREATE_BLOCK },
					{ type: OBJECT_PROPERTY_BLOCK },
					{ type: GET_PATH_BLOCK },
				],
			},
			{ contents: [{ type: CONVERT_BLOCK }] },
		]);
		expect(JSON.stringify(toolbox)).not.toContain('VARIABLE');
		expect(JSON.stringify(toolbox)).not.toContain('controls_');
	});
	it('registers the n8n logic blocks with real Blockly connection shapes', () => {
		registerN8nBlocks(Blockly, blockLabels);
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
				expect(Blockly.Blocks[IF_BLOCK]).toBeDefined();
				expect(Blockly.Blocks[OBJECT_CREATE_BLOCK]).toBeDefined();
				expect(Blockly.Blocks[ARRAY_FILTER_PATH_BLOCK]).toBeDefined();
				const conditional = workspace.newBlock(IF_BLOCK);
				expect(conditional.previousConnection?.getCheck()).toEqual(['N8nLogicStatement']);
				expect(conditional.getInput('THEN')?.connection?.getCheck()).toEqual([
					'N8nLogicStatement',
				]);
				const objectProperty = workspace.newBlock(OBJECT_PROPERTY_BLOCK);
				expect(objectProperty.previousConnection?.getCheck()).toEqual(['N8nObjectProperty']);
			} finally {
			workspace.dispose();
		}
	});

	it('keeps an incomplete schema 2 workspace with an empty preview', () => {
		registerN8nBlocks(Blockly, blockLabels);
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

	it('loads the official Blockly list mutator state and compiles it as node logic', () => {
		registerN8nBlocks(Blockly, blockLabels);
		const state = {
			blocks: {
				languageVersion: 0,
				blocks: [
					{
						type: TRANSFORM_ITEM_BLOCK,
						fields: { MODE: 'COPY' },
						inputs: {
							STATEMENTS: {
								block: {
									type: SET_FIELD_BLOCK,
									fields: { KEY: 'labels' },
									inputs: {
										VALUE: {
											block: {
												type: 'lists_create_with',
												extraState: { itemCount: 2 },
												inputs: {
													ADD0: { block: { type: 'text', fields: { TEXT: 'AI' } } },
													ADD1: { block: { type: 'text', fields: { TEXT: 'Blockly' } } },
												},
											},
										},
									},
								},
							},
						},
					},
				],
			},
		};
		const workspace = new Blockly.Workspace();
		try {
			Blockly.serialization.workspaces.load(state, workspace);
			const saved = Blockly.serialization.workspaces.save(workspace);
			const compiled = compileBlocklyWorkspace(saved);
			expect(compiled.ok).toBe(true);
			if (compiled.ok) expect(compiled.javascript).toContain('["AI", "Blockly"]');
		} finally {
			workspace.dispose();
		}
	});
});
