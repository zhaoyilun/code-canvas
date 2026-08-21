import * as Blockly from 'blockly';
import {
	ROBOT_CONDITION_BLOCK,
	ROBOT_EXECUTE_PRIMITIVE_BLOCK,
	ROBOT_EXECUTE_SKILL_BLOCK,
	ROBOT_GRIPPER_BLOCK,
	ROBOT_TASK_PLAN_BLOCK,
	ROBOT_WAIT_BLOCK,
	compileRobotWorkspace,
	createDefaultRobotWorkspace,
	createRobotToolbox,
	parseRobotPlanPayload,
	registerRobotBlocks,
	serializeRobotPlanPayload,
	SO101_CATALOG_SNAPSHOT,
} from './robotSkills';

const labels = {
	taskPlan: 'Robot task plan',
	executeSkill: 'Execute skill',
	skill: 'skill',
	executePrimitive: 'Execute primitive',
	primitive: 'primitive',
	wait: 'Wait',
	seconds: 'seconds',
	gripper: 'Gripper',
	gripperOpen: 'open',
	gripperClose: 'close',
	gripperRotateCw: 'rotate clockwise',
	gripperRotateCcw: 'rotate counter-clockwise',
	condition: 'Skip next when',
	conditionField: 'field',
	conditionOp: 'value',
	target: 'target',
	place: 'place',
	direction: 'direction',
	directionNone: 'none',
	distance: 'distance (m)',
	timeout: 'timeout (s)',
	extraParams: 'extra params JSON',
};

describe('robotSkills editor configuration', () => {
	it('provides only blocks supported by the robot grammar', () => {
		const toolbox = createRobotToolbox({
			robot: 'Robot',
			primitives: 'Primitives',
			math: 'Math',
			text: 'Text',
		});
		expect(toolbox.contents).toMatchObject([
			{
				contents: [
					{ type: ROBOT_TASK_PLAN_BLOCK },
					{ type: ROBOT_EXECUTE_SKILL_BLOCK },
					{ type: ROBOT_GRIPPER_BLOCK },
					{ type: ROBOT_WAIT_BLOCK },
					{ type: ROBOT_CONDITION_BLOCK },
				],
			},
			{ contents: [{ type: ROBOT_EXECUTE_PRIMITIVE_BLOCK }] },
			{ contents: [{ type: 'math_number' }] },
			{ contents: [{ type: 'text' }] },
		]);
		const serialized = JSON.stringify(toolbox);
		expect(serialized).not.toContain('VARIABLE');
		expect(serialized).not.toContain('controls_');
	});

	it('registers the robot blocks and loads the default workspace', () => {
		registerRobotBlocks(Blockly, labels);
		const workspace = new Blockly.Workspace();
		try {
			const parsed = parseRobotPlanPayload(
				serializeRobotPlanPayload(createDefaultRobotWorkspace(), undefined),
			);
			expect(parsed.ok).toBe(true);
			if (!parsed.ok) return;
			Blockly.serialization.workspaces.load(parsed.payload.workspace, workspace);
			expect(workspace.getTopBlocks()).toHaveLength(1);
			expect(workspace.getTopBlocks()[0]?.type).toBe(ROBOT_TASK_PLAN_BLOCK);
			expect(workspace.getAllBlocks().map(({ type }) => type)).toEqual([
				ROBOT_TASK_PLAN_BLOCK,
				ROBOT_EXECUTE_SKILL_BLOCK,
				ROBOT_EXECUTE_SKILL_BLOCK,
			]);

			const compiled = compileRobotWorkspace(
				Blockly.serialization.workspaces.save(workspace),
				SO101_CATALOG_SNAPSHOT,
			);
			expect(compiled.ok).toBe(true);
			if (!compiled.ok) return;
			expect(compiled.plan.plan).toEqual([
				{ step: 'skill', skill: 'inspect_scene', timeoutSec: 30 },
				{ step: 'skill', skill: 'recover_safe_pose', timeoutSec: 30 },
			]);
		} finally {
			workspace.dispose();
		}
	});

	it('serializes a skill block with direction and distance that compiles', () => {
		registerRobotBlocks(Blockly, labels);
		const workspace = new Blockly.Workspace();
		try {
			Blockly.serialization.workspaces.load(
				{
					blocks: {
						languageVersion: 0,
						blocks: [
							{
								type: ROBOT_TASK_PLAN_BLOCK,
								inputs: {
									DO: {
										block: {
											type: ROBOT_EXECUTE_SKILL_BLOCK,
											fields: { SKILL: 'move_relative_ee', DIRECTION: 'forward' },
											inputs: {
												DISTANCE: {
													block: { type: 'math_number', fields: { NUM: 0.03 } },
												},
											},
										},
									},
								},
							},
						],
					},
				},
				workspace,
			);
			const compiled = compileRobotWorkspace(
				Blockly.serialization.workspaces.save(workspace),
				SO101_CATALOG_SNAPSHOT,
			);
			expect(compiled.ok).toBe(true);
			if (!compiled.ok) return;
			expect(compiled.plan.plan[0]).toMatchObject({
				step: 'skill',
				skill: 'move_relative_ee',
				params: { motion_direction: 'forward', motion_distance: 0.03 },
			});
		} finally {
			workspace.dispose();
		}
	});

	it('keeps an invalid workspace saved with an empty plan preview', () => {
		const invalid = {
			blocks: {
				languageVersion: 0,
				blocks: [{ type: ROBOT_EXECUTE_SKILL_BLOCK, fields: { SKILL: 'nope' } }],
			},
		};
		expect(compileRobotWorkspace(invalid, SO101_CATALOG_SNAPSHOT).ok).toBe(false);
		const serialized = serializeRobotPlanPayload(invalid, undefined);
		const parsed = parseRobotPlanPayload(serialized);
		expect(parsed.ok).toBe(true);
	});
});
