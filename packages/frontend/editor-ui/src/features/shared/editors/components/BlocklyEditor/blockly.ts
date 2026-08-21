import type * as Blockly from 'blockly';

export const TRANSFORM_ITEM_BLOCK = 'n8n_transform_item';
export const SET_FIELD_BLOCK = 'n8n_set_field';
export const GET_FIELD_BLOCK = 'n8n_get_field';

type BlocklyRuntime = Pick<
	typeof Blockly,
	'Blocks' | 'FieldDropdown' | 'FieldTextInput' | 'serialization'
>;

export type ToolboxLabels = {
	transform: string;
	logic: string;
	math: string;
	text: string;
};

export type BlockLabels = {
	transformItem: string;
	copyInput: string;
	emptyOutput: string;
	setField: string;
	to: string;
	getField: string;
	path: string;
};

export function createToolbox(labels: ToolboxLabels): Blockly.utils.toolbox.ToolboxInfo {
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
					{ kind: 'block', type: GET_FIELD_BLOCK },
				],
			},
			{
				kind: 'category',
				name: labels.logic,
				categorystyle: 'logic_category',
				contents: [
					{ kind: 'block', type: 'logic_boolean' },
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
		],
	};
}

export function registerN8nBlocks(blockly: BlocklyRuntime, labels: BlockLabels) {
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
			this.appendStatementInput('STATEMENTS');
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
			this.setPreviousStatement(true);
			this.setNextStatement(true);
			this.setColour(230);
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
