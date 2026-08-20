import type * as Blockly from 'blockly';
import type { JavascriptGenerator } from 'blockly/javascript';

import { createDefaultWorkspace, type BlocklyWorkspaceState } from './payload';

export const RETURN_OUTPUT_BLOCK = 'n8n_return_output';

type BlocklyRuntime = Pick<typeof Blockly, 'Blocks' | 'serialization'>;

type ToolboxLabels = {
	logic: string;
	math: string;
	text: string;
	variables: string;
	output: string;
};

export function createToolbox(labels: ToolboxLabels): Blockly.utils.toolbox.ToolboxInfo {
	return {
		kind: 'categoryToolbox',
		contents: [
			{
				kind: 'category',
				name: labels.logic,
				categorystyle: 'logic_category',
				contents: [
					{ kind: 'block', type: 'logic_compare' },
					{ kind: 'block', type: 'logic_boolean' },
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
				name: labels.variables,
				categorystyle: 'variable_category',
				custom: 'VARIABLE',
			},
			{
				kind: 'category',
				name: labels.output,
				colour: '230',
				contents: [{ kind: 'block', type: RETURN_OUTPUT_BLOCK }],
			},
		],
	};
}

export function registerReturnOutputBlock(
	blockly: BlocklyRuntime,
	javascriptGenerator: JavascriptGenerator,
	orderNone: number,
	label: string,
) {
	blockly.Blocks[RETURN_OUTPUT_BLOCK] = {
		init(this: Blockly.Block) {
			this.appendValueInput('VALUE').setCheck(null).appendField(label);
			this.setPreviousStatement(true);
			this.setColour(230);
		},
	};

	javascriptGenerator.forBlock[RETURN_OUTPUT_BLOCK] = (block, generator) => {
		const value = generator.valueToCode(block, 'VALUE', orderNone) || 'null';
		return `return [{ json: { result: ${value} } }];\n`;
	};
}

export function loadWorkspaceOrDefault(
	blockly: BlocklyRuntime,
	workspace: Blockly.Workspace,
	state: BlocklyWorkspaceState,
): boolean {
	try {
		blockly.serialization.workspaces.load(state, workspace);
		return true;
	} catch {
		blockly.serialization.workspaces.load(createDefaultWorkspace(), workspace);
		return false;
	}
}
