import {
	createOperationBlockDescriptorV1,
	createOperationModuleCatalogV1,
	type OperationModuleCatalogV1,
} from '@n8n/dual-canvas-operation-runtime';
import type * as Blockly from 'blockly';

export const TRANSFORM_ITEM_BLOCK = 'n8n_transform_item';
export const SET_FIELD_BLOCK = 'n8n_set_field';
export const DELETE_FIELD_BLOCK = 'n8n_delete_field';
export const IF_BLOCK = 'n8n_if';
export const ASSERT_BLOCK = 'n8n_assert';
export const GET_FIELD_BLOCK = 'n8n_get_field';
export const GET_PATH_BLOCK = 'n8n_get_path';
export const CONVERT_BLOCK = 'n8n_convert';
export const ARRAY_AT_BLOCK = 'n8n_array_at';
export const ARRAY_MAP_PATH_BLOCK = 'n8n_array_map_path';
export const ARRAY_FILTER_PATH_BLOCK = 'n8n_array_filter_path';
export const OBJECT_CREATE_BLOCK = 'n8n_object_create';
export const OBJECT_PROPERTY_BLOCK = 'n8n_object_property';

const LOGIC_STATEMENT_CHECK = 'N8nLogicStatement';
const OBJECT_PROPERTY_CHECK = 'N8nObjectProperty';
const OPERATION_IDENTITY_EXTENSION = 'n8n_operation_identity_v1';

type BlocklyRuntime = Pick<
	typeof Blockly,
	| 'Blocks'
	| 'FieldDropdown'
	| 'FieldTextInput'
	| 'serialization'
	| 'defineBlocksWithJsonArray'
	| 'Extensions'
>;

export type ToolboxLabels = {
	transform: string;
	logic: string;
	math: string;
	text: string;
	arrays: string;
	objects: string;
	types: string;
	operations: string;
};

export type BlockLabels = {
	transformItem: string;
	copyInput: string;
	emptyOutput: string;
	setField: string;
	to: string;
	getField: string;
	path: string;
	deleteField: string;
	if: string;
	do: string;
	else: string;
	assert: string;
	message: string;
	getPath: string;
	from: string;
	convert: string;
	as: string;
	convertText: string;
	convertNumber: string;
	convertBoolean: string;
	arrayItemAt: string;
	index: string;
	mapArrayPath: string;
	filterArrayPath: string;
	operatorEqual: string;
	operatorNotEqual: string;
	operatorLess: string;
	operatorLessEqual: string;
	operatorGreater: string;
	operatorGreaterEqual: string;
	objectCreate: string;
	objectProperty: string;
	key: string;
};

export function createToolbox(
	labels: ToolboxLabels,
	operationCatalog: OperationModuleCatalogV1,
): Blockly.utils.toolbox.ToolboxInfo {
	const catalog = createOperationModuleCatalogV1(operationCatalog);
	return {
		kind: 'categoryToolbox',
		contents: [
			{
				kind: 'category',
				name: labels.transform,
				colour: '230',
				contents: [
					{ kind: 'block', type: TRANSFORM_ITEM_BLOCK },
					{ kind: 'block', type: SET_FIELD_BLOCK },
					{ kind: 'block', type: DELETE_FIELD_BLOCK },
					{ kind: 'block', type: GET_FIELD_BLOCK },
				],
			},
			{
				kind: 'category',
				name: labels.logic,
				categorystyle: 'logic_category',
				contents: [
					{ kind: 'block', type: IF_BLOCK },
					{ kind: 'block', type: ASSERT_BLOCK },
					{ kind: 'block', type: 'logic_boolean' },
					{ kind: 'block', type: 'logic_null' },
					{ kind: 'block', type: 'logic_compare' },
					{ kind: 'block', type: 'logic_operation' },
					{ kind: 'block', type: 'logic_negate' },
					{ kind: 'block', type: 'logic_ternary' },
				],
			},
			{
				kind: 'category',
				name: labels.math,
				categorystyle: 'math_category',
				contents: [
					{ kind: 'block', type: 'math_number' },
					{ kind: 'block', type: 'math_arithmetic' },
				],
			},
			{
				kind: 'category',
				name: labels.text,
				categorystyle: 'text_category',
				contents: [
					{ kind: 'block', type: 'text' },
					{ kind: 'block', type: 'text_join' },
				],
			},
			{
				kind: 'category',
				name: labels.arrays,
				categorystyle: 'list_category',
				contents: [
					{ kind: 'block', type: 'lists_create_with' },
					{ kind: 'block', type: 'lists_length' },
					{ kind: 'block', type: ARRAY_AT_BLOCK },
					{ kind: 'block', type: ARRAY_MAP_PATH_BLOCK },
					{ kind: 'block', type: ARRAY_FILTER_PATH_BLOCK },
				],
			},
			{
				kind: 'category',
				name: labels.objects,
				colour: '160',
				contents: [
					{ kind: 'block', type: OBJECT_CREATE_BLOCK },
					{ kind: 'block', type: OBJECT_PROPERTY_BLOCK },
					{ kind: 'block', type: GET_PATH_BLOCK },
				],
			},
			{
				kind: 'category',
				name: labels.types,
				colour: '190',
				contents: [{ kind: 'block', type: CONVERT_BLOCK }],
			},
			{
				kind: 'category',
				name: labels.operations,
				colour: '290',
				contents: catalog.modules.map((module) => {
					const descriptor = createOperationBlockDescriptorV1(module);
					return {
						kind: 'block',
						type: descriptor.blockType,
						fields: {
							OPERATION_REF: descriptor.operationRef,
							IMPLEMENTATION_REF: descriptor.implementationRef,
							VERSION: descriptor.version,
							QUALIFIED_NAME: descriptor.qualifiedName,
						},
					};
				}),
			},
		],
	};
}

export function registerN8nBlocks(
	blockly: BlocklyRuntime,
	labels: BlockLabels,
	operationCatalog: OperationModuleCatalogV1,
) {
	const catalog = createOperationModuleCatalogV1(operationCatalog);
	if (!blockly.Extensions.isRegistered(OPERATION_IDENTITY_EXTENSION)) {
		blockly.Extensions.register(OPERATION_IDENTITY_EXTENSION, function (this: Blockly.Block) {
			this.getField('OPERATION_REF')?.setVisible(false);
			this.getField('IMPLEMENTATION_REF')?.setVisible(false);
			this.getField('QUALIFIED_NAME')?.setVisible(false);
		});
	}
	blockly.Blocks[TRANSFORM_ITEM_BLOCK] = {
		init(this: Blockly.Block) {
			this.appendDummyInput()
				.appendField(labels.transformItem)
				.appendField(
					new blockly.FieldDropdown([
						[labels.copyInput, 'COPY'],
						[labels.emptyOutput, 'EMPTY'],
					]),
					'MODE',
				);
			this.appendStatementInput('STATEMENTS').setCheck(LOGIC_STATEMENT_CHECK);
			this.setColour(230);
		},
	};
	blockly.Blocks[SET_FIELD_BLOCK] = {
		init(this: Blockly.Block) {
			this.appendValueInput('VALUE')
				.setCheck(null)
				.appendField(labels.setField)
				.appendField(new blockly.FieldTextInput(''), 'KEY')
				.appendField(labels.to);
			this.setPreviousStatement(true, LOGIC_STATEMENT_CHECK);
			this.setNextStatement(true, LOGIC_STATEMENT_CHECK);
			this.setColour(230);
		},
	};
	blockly.Blocks[DELETE_FIELD_BLOCK] = {
		init(this: Blockly.Block) {
			this.appendDummyInput()
				.appendField(labels.deleteField)
				.appendField(new blockly.FieldTextInput(''), 'KEY');
			this.setPreviousStatement(true, LOGIC_STATEMENT_CHECK);
			this.setNextStatement(true, LOGIC_STATEMENT_CHECK);
			this.setColour(230);
		},
	};
	blockly.Blocks[IF_BLOCK] = {
		init(this: Blockly.Block) {
			this.appendValueInput('CONDITION').setCheck('Boolean').appendField(labels.if);
			this.appendStatementInput('THEN').setCheck(LOGIC_STATEMENT_CHECK).appendField(labels.do);
			this.appendStatementInput('ELSE').setCheck(LOGIC_STATEMENT_CHECK).appendField(labels.else);
			this.setPreviousStatement(true, LOGIC_STATEMENT_CHECK);
			this.setNextStatement(true, LOGIC_STATEMENT_CHECK);
			this.setColour(210);
		},
	};
	blockly.Blocks[ASSERT_BLOCK] = {
		init(this: Blockly.Block) {
			this.appendValueInput('CONDITION').setCheck('Boolean').appendField(labels.assert);
			this.appendValueInput('MESSAGE').appendField(labels.message);
			this.setPreviousStatement(true, LOGIC_STATEMENT_CHECK);
			this.setNextStatement(true, LOGIC_STATEMENT_CHECK);
			this.setColour(210);
		},
	};
	blockly.Blocks[GET_FIELD_BLOCK] = {
		init(this: Blockly.Block) {
			this.appendDummyInput()
				.appendField(labels.getField)
				.appendField(labels.path)
				.appendField(new blockly.FieldTextInput(''), 'PATH');
			this.setOutput(true);
			this.setColour(230);
		},
	};
	blockly.Blocks[GET_PATH_BLOCK] = {
		init(this: Blockly.Block) {
			this.appendValueInput('VALUE')
				.appendField(labels.getPath)
				.appendField(new blockly.FieldTextInput(''), 'PATH')
				.appendField(labels.from);
			this.setOutput(true);
			this.setColour(160);
		},
	};
	blockly.Blocks[CONVERT_BLOCK] = {
		init(this: Blockly.Block) {
			this.appendValueInput('VALUE').appendField(labels.convert);
			this.appendDummyInput()
				.appendField(labels.as)
				.appendField(
					new blockly.FieldDropdown([
						[labels.convertText, 'TEXT'],
						[labels.convertNumber, 'NUMBER'],
						[labels.convertBoolean, 'BOOLEAN'],
					]),
					'TYPE',
				);
			this.setOutput(true);
			this.setColour(190);
		},
	};
	blockly.Blocks[ARRAY_AT_BLOCK] = {
		init(this: Blockly.Block) {
			this.appendValueInput('ARRAY').setCheck('Array').appendField(labels.arrayItemAt);
			this.appendValueInput('INDEX').setCheck('Number').appendField(labels.index);
			this.setOutput(true);
			this.setColour(260);
		},
	};
	blockly.Blocks[ARRAY_MAP_PATH_BLOCK] = {
		init(this: Blockly.Block) {
			this.appendValueInput('ARRAY').setCheck('Array').appendField(labels.mapArrayPath);
			this.appendDummyInput()
				.appendField(labels.path)
				.appendField(new blockly.FieldTextInput(''), 'PATH');
			this.setOutput(true, 'Array');
			this.setColour(260);
		},
	};
	blockly.Blocks[ARRAY_FILTER_PATH_BLOCK] = {
		init(this: Blockly.Block) {
			this.appendValueInput('ARRAY').setCheck('Array').appendField(labels.filterArrayPath);
			this.appendDummyInput()
				.appendField(labels.path)
				.appendField(new blockly.FieldTextInput(''), 'PATH')
				.appendField(
					new blockly.FieldDropdown([
						[labels.operatorEqual, 'EQ'],
						[labels.operatorNotEqual, 'NEQ'],
						[labels.operatorLess, 'LT'],
						[labels.operatorLessEqual, 'LTE'],
						[labels.operatorGreater, 'GT'],
						[labels.operatorGreaterEqual, 'GTE'],
					]),
					'OP',
				);
			this.appendValueInput('VALUE').appendField(labels.to);
			this.setOutput(true, 'Array');
			this.setColour(260);
		},
	};
	blockly.Blocks[OBJECT_CREATE_BLOCK] = {
		init(this: Blockly.Block) {
			this.appendStatementInput('PROPERTIES')
				.setCheck(OBJECT_PROPERTY_CHECK)
				.appendField(labels.objectCreate);
			this.setOutput(true, 'Object');
			this.setColour(160);
		},
	};
	blockly.Blocks[OBJECT_PROPERTY_BLOCK] = {
		init(this: Blockly.Block) {
			this.appendValueInput('VALUE')
				.appendField(labels.objectProperty)
				.appendField(labels.key)
				.appendField(new blockly.FieldTextInput(''), 'KEY')
				.appendField(labels.to);
			this.setPreviousStatement(true, OBJECT_PROPERTY_CHECK);
			this.setNextStatement(true, OBJECT_PROPERTY_CHECK);
			this.setColour(160);
		},
	};
	blockly.defineBlocksWithJsonArray(
		catalog.modules.map((module) => {
			const descriptor = createOperationBlockDescriptorV1(module);
			const messageParts = [descriptor.label];
			const args = descriptor.inputs.map((input, index) => {
				messageParts.push(`${input.name} %${index + 1}`);
				return {
					type: 'input_value',
					name: input.inputName,
					...(input.check === null ? {} : { check: input.check }),
				};
			});
			return {
				type: descriptor.blockType,
				message0: messageParts.join(' · '),
				...(args.length === 0 ? {} : { args0: args }),
				message1: '版本 %1 %2 %3 %4',
				args1: [
					{
						type: 'field_label_serializable',
						name: 'VERSION',
						text: descriptor.version,
					},
					{
						type: 'field_label_serializable',
						name: 'OPERATION_REF',
						text: descriptor.operationRef,
					},
					{
						type: 'field_label_serializable',
						name: 'IMPLEMENTATION_REF',
						text: descriptor.implementationRef,
					},
					{
						type: 'field_label_serializable',
						name: 'QUALIFIED_NAME',
						text: descriptor.qualifiedName,
					},
				],
				output: descriptor.output.check,
				colour: descriptor.colour,
				tooltip: descriptor.tooltip,
				helpUrl: '',
				extensions: [OPERATION_IDENTITY_EXTENSION],
			};
		}),
	);
}

export function loadWorkspaceOrDefault(
	blockly: BlocklyRuntime,
	workspace: Blockly.Workspace,
	state: Record<string, unknown>,
	defaultWorkspace: Record<string, unknown>,
): boolean {
	try {
		workspace.clear();
		blockly.serialization.workspaces.load(state, workspace);
		return true;
	} catch {
		workspace.clear();
		blockly.serialization.workspaces.load(defaultWorkspace, workspace);
		return false;
	}
}
