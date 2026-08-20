import type * as Blockly from 'blockly';
import {
	SO101_CATALOG_SNAPSHOT,
	MOTION_DIRECTIONS,
	compileRobotWorkspace,
	createDefaultRobotWorkspace,
	parseRobotPlanPayload,
	serializeRobotPlanPayload,
} from '@n8n/blockly-robot-skills';

/** Robot skill grammar (design §7.2). Mirrors the compiler whitelist exactly:
 * every block here compiles; anything not here is rejected server-side. */

export const ROBOT_TASK_PLAN_BLOCK = 'robot_task_plan';
export const ROBOT_EXECUTE_SKILL_BLOCK = 'robot_execute_skill';
export const ROBOT_EXECUTE_PRIMITIVE_BLOCK = 'robot_execute_primitive';
export const ROBOT_WAIT_BLOCK = 'robot_wait';
export const ROBOT_GRIPPER_BLOCK = 'robot_gripper';
export const ROBOT_CONDITION_BLOCK = 'robot_condition';

type BlocklyRuntime = Pick<typeof Blockly, 'Blocks' | 'FieldDropdown' | 'serialization'>;

export type RobotToolboxLabels = {
	robot: string;
	primitives: string;
	math: string;
	text: string;
};

export type RobotBlockLabels = {
	taskPlan: string;
	executeSkill: string;
	skill: string;
	executePrimitive: string;
	primitive: string;
	wait: string;
	seconds: string;
	gripper: string;
	gripperOpen: string;
	gripperClose: string;
	gripperRotateCw: string;
	gripperRotateCcw: string;
	condition: string;
	conditionField: string;
	conditionOp: string;
	target: string;
	place: string;
	direction: string;
	directionNone: string;
	distance: string;
	timeout: string;
	extraParams: string;
};

const DIRECTION_NONE = '';
type MenuOption = [string, string];
const GUARD_FIELD_OPTIONS: MenuOption[] = [
	['last.success', 'last.success'],
	['last.state', 'last.state'],
];
const GUARD_OP_OPTIONS: MenuOption[] = [
	['==', '=='],
	['!=', '!='],
];

export function createRobotToolbox(labels: RobotToolboxLabels): Blockly.utils.toolbox.ToolboxInfo {
	return {
		kind: 'categoryToolbox',
		contents: [
			{
				kind: 'category',
				name: labels.robot,
				colour: '30',
				contents: [
					{ kind: 'block', type: ROBOT_TASK_PLAN_BLOCK },
					{ kind: 'block', type: ROBOT_EXECUTE_SKILL_BLOCK },
					{ kind: 'block', type: ROBOT_GRIPPER_BLOCK },
					{ kind: 'block', type: ROBOT_WAIT_BLOCK },
					{ kind: 'block', type: ROBOT_CONDITION_BLOCK },
				],
			},
			{
				kind: 'category',
				name: labels.primitives,
				colour: '60',
				contents: [{ kind: 'block', type: ROBOT_EXECUTE_PRIMITIVE_BLOCK }],
			},
			{
				kind: 'category',
				name: labels.math,
				categorystyle: 'math_category',
				contents: [{ kind: 'block', type: 'math_number' }],
			},
			{
				kind: 'category',
				name: labels.text,
				categorystyle: 'text_category',
				contents: [{ kind: 'block', type: 'text' }],
			},
		],
	};
}

export function registerRobotBlocks(blockly: BlocklyRuntime, labels: RobotBlockLabels) {
	const skillOptions: MenuOption[] = SO101_CATALOG_SNAPSHOT.skills.map(
		(skill): MenuOption => [skill.name, skill.name],
	);
	const primitiveOptions: MenuOption[] = SO101_CATALOG_SNAPSHOT.primitives.map(
		(name): MenuOption => [name, name],
	);
	const directionOptions: MenuOption[] = [
		[labels.directionNone, DIRECTION_NONE],
		...MOTION_DIRECTIONS.map((direction): MenuOption => [direction, direction]),
	];

	blockly.Blocks[ROBOT_TASK_PLAN_BLOCK] = {
		init(this: Blockly.Block) {
			this.appendDummyInput().appendField(labels.taskPlan);
			this.appendStatementInput('DO');
			this.setColour(30);
		},
	};

	blockly.Blocks[ROBOT_EXECUTE_SKILL_BLOCK] = {
		init(this: Blockly.Block) {
			this.appendDummyInput()
				.appendField(labels.executeSkill)
				.appendField(new blockly.FieldDropdown(skillOptions), 'SKILL');
			this.appendValueInput('TARGET').setCheck('String').appendField(labels.target);
			this.appendValueInput('PLACE').setCheck('String').appendField(labels.place);
			this.appendDummyInput()
				.appendField(labels.direction)
				.appendField(new blockly.FieldDropdown(directionOptions), 'DIRECTION');
			this.appendValueInput('DISTANCE').setCheck('Number').appendField(labels.distance);
			this.appendValueInput('TIMEOUT').setCheck('Number').appendField(labels.timeout);
			this.setPreviousStatement(true);
			this.setNextStatement(true);
			this.setColour(30);
		},
	};

	blockly.Blocks[ROBOT_EXECUTE_PRIMITIVE_BLOCK] = {
		init(this: Blockly.Block) {
			this.appendDummyInput()
				.appendField(labels.executePrimitive)
				.appendField(new blockly.FieldDropdown(primitiveOptions), 'PRIMITIVE');
			this.appendValueInput('TARGET').setCheck('String').appendField(labels.target);
			this.appendValueInput('TIMEOUT').setCheck('Number').appendField(labels.timeout);
			this.setPreviousStatement(true);
			this.setNextStatement(true);
			this.setColour(60);
		},
	};

	blockly.Blocks[ROBOT_WAIT_BLOCK] = {
		init(this: Blockly.Block) {
			this.appendValueInput('SECONDS')
				.setCheck('Number')
				.appendField(labels.wait)
				.appendField(labels.seconds);
			this.setPreviousStatement(true);
			this.setNextStatement(true);
			this.setColour(30);
		},
	};

	blockly.Blocks[ROBOT_GRIPPER_BLOCK] = {
		init(this: Blockly.Block) {
			this.appendDummyInput()
				.appendField(labels.gripper)
				.appendField(
					new blockly.FieldDropdown([
						[labels.gripperOpen, 'open'],
						[labels.gripperClose, 'close'],
						[labels.gripperRotateCw, 'rotate_cw'],
						[labels.gripperRotateCcw, 'rotate_ccw'],
					]),
					'ACTION',
				);
			this.setPreviousStatement(true);
			this.setNextStatement(true);
			this.setColour(30);
		},
	};

	blockly.Blocks[ROBOT_CONDITION_BLOCK] = {
		init(this: Blockly.Block) {
			this.appendDummyInput()
				.appendField(labels.condition)
				.appendField(new blockly.FieldDropdown(GUARD_FIELD_OPTIONS), 'FIELD')
				.appendField(new blockly.FieldDropdown(GUARD_OP_OPTIONS), 'OP');
			this.appendValueInput('VALUE').setCheck('String').appendField(labels.conditionOp);
			this.setPreviousStatement(true);
			this.setNextStatement(true);
			this.setColour(30);
		},
	};
}

/** Payload adapter over the shared package so BlocklyEditor stays mode-agnostic. */
export {
	compileRobotWorkspace,
	createDefaultRobotWorkspace,
	parseRobotPlanPayload,
	serializeRobotPlanPayload,
	SO101_CATALOG_SNAPSHOT,
};
