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
	createOperationBlockDescriptorV1,
	createOperationModuleCatalogV1,
	finalizeOperationModuleSpecV1,
	parseBlocklyDataPayload,
	serializeBlocklyDataPayload,
} from './payload';

const EMPTY_OPERATION_CATALOG = createOperationModuleCatalogV1({ apiVersion: 1, modules: [] });

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
		const toolbox = createToolbox(
			{
				transform: 'Transform',
				logic: 'Logic',
				math: 'Math',
				text: 'Text',
				arrays: 'Arrays',
				objects: 'Objects',
				types: 'Types',
				operations: 'Function modules',
			},
			EMPTY_OPERATION_CATALOG,
		);
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
					{ type: 'logic_null' },
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
			{ contents: [] },
		]);
		expect(JSON.stringify(toolbox)).not.toContain('VARIABLE');
		expect(JSON.stringify(toolbox)).not.toContain('controls_');
	});
	it('registers the n8n logic blocks with real Blockly connection shapes', () => {
		registerN8nBlocks(Blockly, blockLabels, EMPTY_OPERATION_CATALOG);
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
			expect(conditional.getInput('THEN')?.connection?.getCheck()).toEqual(['N8nLogicStatement']);
			const objectProperty = workspace.newBlock(OBJECT_PROPERTY_BLOCK);
			expect(objectProperty.previousConnection?.getCheck()).toEqual(['N8nObjectProperty']);
		} finally {
			workspace.dispose();
		}
	});

	it('keeps an incomplete schema 3 workspace with an empty preview', () => {
		registerN8nBlocks(Blockly, blockLabels, EMPTY_OPERATION_CATALOG);
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

		expect(compileBlocklyWorkspace(incompleteWorkspace, EMPTY_OPERATION_CATALOG).ok).toBe(false);
		const serialized = serializeBlocklyDataPayload(incompleteWorkspace, EMPTY_OPERATION_CATALOG);
		expect(JSON.parse(serialized)).toMatchObject({
			schemaVersion: 3,
			operationCatalog: EMPTY_OPERATION_CATALOG,
			javascript: '',
		});
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
		registerN8nBlocks(Blockly, blockLabels, EMPTY_OPERATION_CATALOG);
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
			const compiled = compileBlocklyWorkspace(saved, EMPTY_OPERATION_CATALOG);
			expect(compiled.ok).toBe(true);
			if (compiled.ok) expect(compiled.javascript).toContain('["AI", "Blockly"]');
		} finally {
			workspace.dispose();
		}
	});

	it('registers one catalog operation and preserves it through real Blockly save and reload', () => {
		const catalog = createOperationModuleCatalogV1({ apiVersion: 1, modules: [clampScoreModule] });
		const descriptor = createOperationBlockDescriptorV1(clampScoreModule);
		registerN8nBlocks(Blockly, blockLabels, catalog);
		const toolbox = createToolbox(
			{
				transform: 'Transform',
				logic: 'Logic',
				math: 'Math',
				text: 'Text',
				arrays: 'Arrays',
				objects: 'Objects',
				types: 'Types',
				operations: 'Function modules',
			},
			catalog,
		);
		expect(toolbox.contents.at(-1)).toMatchObject({
			name: 'Function modules',
			contents: [{ type: descriptor.blockType }],
		});

		const state = clampWorkspace(descriptor);
		const firstWorkspace = new Blockly.Workspace();
		const secondWorkspace = new Blockly.Workspace();
		try {
			Blockly.serialization.workspaces.load(state, firstWorkspace);
			const operationBlock = firstWorkspace.getBlocksByType(descriptor.blockType)[0];
			expect(operationBlock?.getField('VERSION')?.isVisible()).toBe(true);
			expect(operationBlock?.getField('OPERATION_REF')?.isVisible()).toBe(false);
			expect(operationBlock?.getField('IMPLEMENTATION_REF')?.isVisible()).toBe(false);
			expect(operationBlock?.getField('QUALIFIED_NAME')?.isVisible()).toBe(false);
			const saved = Blockly.serialization.workspaces.save(firstWorkspace);
			expect(JSON.stringify(saved)).toContain(descriptor.implementationRef);
			const serialized = serializeBlocklyDataPayload(saved, catalog);
			const parsed = parseBlocklyDataPayload(serialized);
			expect(parsed.ok).toBe(true);
			if (!parsed.ok) return;
			expect(parsed.payload.operationCatalog).toEqual(catalog);

			Blockly.serialization.workspaces.load(parsed.payload.workspace, secondWorkspace);
			const reloaded = Blockly.serialization.workspaces.save(secondWorkspace);
			const compiled = compileBlocklyWorkspace(reloaded, parsed.payload.operationCatalog);
			if (!compiled.ok) throw new Error(compiled.error);
			expect(compiled.javascript).toContain('operationArg0');
		} finally {
			firstWorkspace.dispose();
			secondWorkspace.dispose();
		}
	});

	it('keeps changed implementations distinct when catalogs register into one Blockly runtime', () => {
		const originalDescriptor = createOperationBlockDescriptorV1(clampScoreModule);
		const changedDescriptor = createOperationBlockDescriptorV1(fixedScoreModule);
		const originalCatalog = createOperationModuleCatalogV1({
			apiVersion: 1,
			modules: [clampScoreModule],
		});
		const changedCatalog = createOperationModuleCatalogV1({
			apiVersion: 1,
			modules: [fixedScoreModule],
		});

		registerN8nBlocks(Blockly, blockLabels, originalCatalog);
		registerN8nBlocks(Blockly, blockLabels, changedCatalog);

		expect(changedDescriptor.operationRef).toBe(originalDescriptor.operationRef);
		expect(changedDescriptor.version).toBe(originalDescriptor.version);
		expect(changedDescriptor.implementationRef).not.toBe(originalDescriptor.implementationRef);
		expect(changedDescriptor.blockType).not.toBe(originalDescriptor.blockType);
		expect(Blockly.Blocks[originalDescriptor.blockType]).toBeDefined();
		expect(Blockly.Blocks[changedDescriptor.blockType]).toBeDefined();

		const workspace = new Blockly.Workspace();
		try {
			const original = workspace.newBlock(originalDescriptor.blockType);
			const changed = workspace.newBlock(changedDescriptor.blockType);
			expect(original.getFieldValue('IMPLEMENTATION_REF')).toBe(
				originalDescriptor.implementationRef,
			);
			expect(changed.getFieldValue('IMPLEMENTATION_REF')).toBe(changedDescriptor.implementationRef);
		} finally {
			workspace.dispose();
		}
	});
});

const clampScoreModule = finalizeOperationModuleSpecV1({
	apiVersion: 1,
	requestRef: 'request.clamp-score',
	operationRef: 'operation.clamp-score',
	implementationRef: null,
	qualifiedName: 'clampScore',
	arity: 3,
	version: '1.0.0',
	behaviorSummary: 'Keep a score inside a numeric range.',
	execution: 'synchronous',
	determinism: 'deterministic',
	effects: 'none',
	dataFlow: 'json-to-json',
	parameters: [
		{ parameterRef: 'arg.value', name: 'value', type: 'number', nullPolicy: 'allow' },
		{ parameterRef: 'arg.minimum', name: 'minimum', type: 'number', nullPolicy: 'reject' },
		{ parameterRef: 'arg.maximum', name: 'maximum', type: 'number', nullPolicy: 'reject' },
	],
	output: { type: 'number', nullPolicy: 'allow' },
	expression: {
		kind: 'conditional',
		condition: {
			kind: 'binary',
			operator: 'lt',
			left: { kind: 'parameter', parameterRef: 'arg.value' },
			right: { kind: 'parameter', parameterRef: 'arg.minimum' },
		},
		whenTrue: { kind: 'parameter', parameterRef: 'arg.minimum' },
		whenFalse: {
			kind: 'conditional',
			condition: {
				kind: 'binary',
				operator: 'gt',
				left: { kind: 'parameter', parameterRef: 'arg.value' },
				right: { kind: 'parameter', parameterRef: 'arg.maximum' },
			},
			whenTrue: { kind: 'parameter', parameterRef: 'arg.maximum' },
			whenFalse: { kind: 'parameter', parameterRef: 'arg.value' },
		},
	},
	testVectors: [
		{ name: 'below', arguments: [-1, 0, 100], expected: 0 },
		{ name: 'inside', arguments: [50, 0, 100], expected: 50 },
		{ name: 'above', arguments: [101, 0, 100], expected: 100 },
	],
});

const fixedScoreModule = finalizeOperationModuleSpecV1({
	...clampScoreModule,
	requestRef: 'request.clamp-score.fixed',
	implementationRef: null,
	behaviorSummary: 'Return the admitted fixed score implementation.',
	expression: { kind: 'literal', value: 50 },
	testVectors: [
		{ name: 'below', arguments: [-1, 0, 100], expected: 50 },
		{ name: 'inside', arguments: [50, 0, 100], expected: 50 },
		{ name: 'above', arguments: [101, 0, 100], expected: 50 },
	],
});

function clampWorkspace(
	descriptor: ReturnType<typeof createOperationBlockDescriptorV1>,
): Record<string, unknown> {
	return {
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
								fields: { KEY: 'score' },
								inputs: {
									VALUE: {
										block: {
											type: descriptor.blockType,
											fields: {
												OPERATION_REF: descriptor.operationRef,
												IMPLEMENTATION_REF: descriptor.implementationRef,
												VERSION: descriptor.version,
												QUALIFIED_NAME: descriptor.qualifiedName,
											},
											inputs: {
												ARG0: {
													block: { type: GET_FIELD_BLOCK, fields: { PATH: 'score' } },
												},
												ARG1: {
													block: { type: 'math_number', fields: { NUM: 0 } },
												},
												ARG2: {
													block: { type: 'math_number', fields: { NUM: 100 } },
												},
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
}
