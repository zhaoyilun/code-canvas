import { describe, expect, it } from 'vitest';

import { SO101_CATALOG_SNAPSHOT } from './catalog';
import { compileRobotWorkspace, planBudgetError } from './compiler';
import { createDefaultRobotWorkspace } from './payload';

function skillBlock(skill: string, extra: Record<string, unknown> = {}) {
	return { type: 'robot_execute_skill', fields: { SKILL: skill }, ...extra };
}

function guardBlock(field = 'last.success', value = 'true') {
	return {
		type: 'robot_condition',
		fields: { FIELD: field, OP: '==' },
		inputs: { VALUE: { block: { type: 'text', fields: { TEXT: value } } } },
	};
}

function planRoot(...chain: Array<Record<string, unknown>>) {
	let head: Record<string, unknown> | undefined;
	for (const block of [...chain].reverse()) {
		head = head === undefined ? { ...block } : { ...block, next: { block: head } };
	}
	return { blocks: { blocks: [{ type: 'robot_task_plan', inputs: { DO: { block: head } } }] } };
}

describe('compileRobotWorkspace', () => {
	it('compiles the default workspace deterministically', () => {
		const result = compileRobotWorkspace(createDefaultRobotWorkspace(), SO101_CATALOG_SNAPSHOT);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.plan.plan).toEqual([
			{ step: 'skill', skill: 'inspect_scene', timeoutSec: 30 },
			{ step: 'skill', skill: 'recover_safe_pose', timeoutSec: 30 },
		]);
		expect(result.plan.robot).toBe('so101_single_arm');
		expect(result.plan.configDigest).toBe(SO101_CATALOG_SNAPSHOT.configDigest);
		expect(result.blockCount).toBe(3);
	});

	it('preserves stable Blockly IDs on compiled plan steps', () => {
		const result = compileRobotWorkspace(
			planRoot({ ...skillBlock('inspect_scene'), id: 'robot-action-1' }),
			SO101_CATALOG_SNAPSHOT,
		);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.plan.plan[0]).toMatchObject({
			blockId: 'robot-action-1',
			planStepId: 'step:robot-action-1',
		});
	});

	it('compiles skills with parameters from connected value blocks', () => {
		const workspace = planRoot({
			type: 'robot_execute_skill',
			fields: { SKILL: 'move_relative_ee', DIRECTION: 'forward' },
			inputs: { DISTANCE: { block: { type: 'math_number', fields: { NUM: 0.03 } } } },
		});
		const result = compileRobotWorkspace(workspace, SO101_CATALOG_SNAPSHOT);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.plan.plan[0]).toEqual({
			step: 'skill',
			skill: 'move_relative_ee',
			params: { motion_direction: 'forward', motion_distance: 0.03 },
			timeoutSec: 30,
		});
	});

	it('rejects missing required parameters', () => {
		const workspace = planRoot(skillBlock('move_relative_ee'));
		const result = compileRobotWorkspace(workspace, SO101_CATALOG_SNAPSHOT);
		expect(result).toEqual({ ok: false, error: 'missing required parameter "motion_direction"' });
	});

	it('rejects additional parameters for closed schemas', () => {
		const workspace = planRoot({
			type: 'robot_execute_skill',
			fields: { SKILL: 'inspect_scene', PARAMS_JSON: '{"extra":1}' },
		});
		const result = compileRobotWorkspace(workspace, SO101_CATALOG_SNAPSHOT);
		expect(result).toEqual({ ok: false, error: 'parameter "extra" is not defined for this skill' });
	});

	it('rejects unknown skills and primitives', () => {
		expect(compileRobotWorkspace(planRoot(skillBlock('nope')), SO101_CATALOG_SNAPSHOT)).toEqual({
			ok: false,
			error: 'unknown skill "nope"',
		});
		const primitive = { type: 'robot_execute_primitive', fields: { PRIMITIVE: 'fly' } };
		expect(compileRobotWorkspace(planRoot(primitive), SO101_CATALOG_SNAPSHOT)).toEqual({
			ok: false,
			error: 'unknown primitive "fly"',
		});
	});

	it('compiles a valid primitive step', () => {
		const workspace = planRoot({
			type: 'robot_execute_primitive',
			fields: { PRIMITIVE: 'move_to_named_pose' },
			inputs: { TARGET: { block: { type: 'text', fields: { TEXT: 'home' } } } },
		});
		const result = compileRobotWorkspace(workspace, SO101_CATALOG_SNAPSHOT);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.plan.plan[0]).toEqual({
			step: 'primitive',
			primitive: 'move_to_named_pose',
			params: { target_name: 'home' },
		});
	});

	it('compiles gripper sugar to the equivalent skill', () => {
		const workspace = planRoot({ type: 'robot_gripper', fields: { ACTION: 'open' } });
		const result = compileRobotWorkspace(workspace, SO101_CATALOG_SNAPSHOT);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.plan.plan[0]).toEqual({ step: 'skill', skill: 'open_gripper_skill' });
	});

	it('compiles rotate gripper sugar to the equivalent primitive', () => {
		const workspace = planRoot({ type: 'robot_gripper', fields: { ACTION: 'rotate_cw' } });
		const result = compileRobotWorkspace(workspace, SO101_CATALOG_SNAPSHOT);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.plan.plan[0]).toEqual({ step: 'primitive', primitive: 'rotate_gripper_cw' });
	});

	it('attaches robot_condition as a step-level skipIf guard', () => {
		const workspace = planRoot(
			{
				type: 'robot_condition',
				fields: { FIELD: 'last.success', OP: '==' },
				inputs: { VALUE: { block: { type: 'text', fields: { TEXT: 'false' } } } },
			},
			skillBlock('inspect_scene'),
		);
		const result = compileRobotWorkspace(workspace, SO101_CATALOG_SNAPSHOT);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.plan.plan[0]).toMatchObject({
			step: 'skill',
			skill: 'inspect_scene',
			skipIf: { field: 'last.success', op: '==', value: false },
		});
	});

	it('rejects a trailing guard without a following action', () => {
		const workspace = planRoot(guardBlock());
		expect(compileRobotWorkspace(workspace, SO101_CATALOG_SNAPSHOT)).toEqual({
			ok: false,
			error: 'robot_condition must guard a following action block',
		});
	});

	it('rejects consecutive guards', () => {
		const workspace = planRoot(guardBlock(), guardBlock(), skillBlock('inspect_scene'));
		expect(compileRobotWorkspace(workspace, SO101_CATALOG_SNAPSHOT)).toEqual({
			ok: false,
			error: 'robot_condition must guard a following action block',
		});
	});

	it('rejects guards on wait steps', () => {
		const workspace = planRoot(
			{
				type: 'robot_condition',
				fields: { FIELD: 'last.state', OP: '==' },
				inputs: { VALUE: { block: { type: 'text', fields: { TEXT: 'failed' } } } },
			},
			{
				type: 'robot_wait',
				inputs: { SECONDS: { block: { type: 'math_number', fields: { NUM: 2 } } } },
			},
		);
		expect(compileRobotWorkspace(workspace, SO101_CATALOG_SNAPSHOT)).toEqual({
			ok: false,
			error: 'robot_condition cannot guard a wait step',
		});
	});

	it('compiles wait steps with bounds', () => {
		const wait = (seconds: number) => ({
			type: 'robot_wait',
			inputs: { SECONDS: { block: { type: 'math_number', fields: { NUM: seconds } } } },
		});
		const okResult = compileRobotWorkspace(planRoot(wait(2)), SO101_CATALOG_SNAPSHOT);
		expect(okResult.ok).toBe(true);
		expect(compileRobotWorkspace(planRoot(wait(61)), SO101_CATALOG_SNAPSHOT)).toEqual({
			ok: false,
			error: 'robot_wait exceeds 60s',
		});
		expect(compileRobotWorkspace(planRoot(wait(0)), SO101_CATALOG_SNAPSHOT)).toMatchObject({
			ok: false,
			error: 'robot_wait needs a positive number of seconds',
		});
	});

	it('rejects malformed roots, duplicate roots, and unsupported blocks', () => {
		expect(compileRobotWorkspace({}, SO101_CATALOG_SNAPSHOT)).toEqual({
			ok: false,
			error: 'workspace is malformed',
		});
		expect(compileRobotWorkspace({ blocks: { blocks: [] } }, SO101_CATALOG_SNAPSHOT)).toEqual({
			ok: false,
			error: 'workspace has no root block',
		});
		const doubleRoot = {
			blocks: { blocks: [{ type: 'robot_task_plan' }, { type: 'robot_task_plan' }] },
		};
		expect(compileRobotWorkspace(doubleRoot, SO101_CATALOG_SNAPSHOT)).toEqual({
			ok: false,
			error: 'workspace must contain exactly one root block',
		});
		expect(
			compileRobotWorkspace({ blocks: { blocks: [{ type: 'text' }] } }, SO101_CATALOG_SNAPSHOT),
		).toEqual({
			ok: false,
			error: 'unexpected root block "text"',
		});
		expect(
			compileRobotWorkspace(planRoot({ type: 'controls_if' }), SO101_CATALOG_SNAPSHOT),
		).toEqual({
			ok: false,
			error: 'unsupported block "controls_if"',
		});
	});

	it('rejects empty plans, unknown inputs, and malformed child inputs', () => {
		expect(
			compileRobotWorkspace(
				{ blocks: { blocks: [{ type: 'robot_task_plan' }] } },
				SO101_CATALOG_SNAPSHOT,
			),
		).toEqual({ ok: false, error: 'robot task plan must contain at least one step' });

		expect(
			compileRobotWorkspace(
				planRoot({
					...skillBlock('inspect_scene'),
					inputs: { SECRET: { block: { type: 'text', fields: { TEXT: 'hidden' } } } },
				}),
				SO101_CATALOG_SNAPSHOT,
			),
		).toEqual({
			ok: false,
			error: 'unknown input "SECRET" on block "robot_execute_skill"',
		});

		expect(
			compileRobotWorkspace(
				planRoot({
					...skillBlock('inspect_scene'),
					inputs: { TARGET: { block: { type: 'math_number', fields: { NUM: 1 } } } },
				}),
				SO101_CATALOG_SNAPSHOT,
			),
		).toEqual({
			ok: false,
			error: 'input "TARGET" on block "robot_execute_skill" does not accept "math_number"',
		});

		expect(
			compileRobotWorkspace(
				planRoot({ ...skillBlock('inspect_scene'), inputs: { TARGET: {} } }),
				SO101_CATALOG_SNAPSHOT,
			),
		).toEqual({
			ok: false,
			error: 'input "TARGET" on block "robot_execute_skill" is malformed',
		});
	});

	it('rejects hidden value chains, malformed next links, and duplicate block IDs', () => {
		const hiddenValueNext = planRoot({
			...skillBlock('inspect_scene'),
			inputs: {
				TARGET: {
					block: {
						type: 'text',
						fields: { TEXT: 'home' },
						next: { block: skillBlock('recover_safe_pose') },
					},
				},
			},
		});
		expect(compileRobotWorkspace(hiddenValueNext, SO101_CATALOG_SNAPSHOT)).toEqual({
			ok: false,
			error: 'value block "text" must not contain a next block',
		});

		expect(
			compileRobotWorkspace(
				planRoot({ ...skillBlock('inspect_scene'), next: {} }),
				SO101_CATALOG_SNAPSHOT,
			),
		).toEqual({
			ok: false,
			error: 'next block after "robot_execute_skill" is malformed',
		});

		const duplicateIds = {
			blocks: {
				blocks: [
					{
						type: 'robot_task_plan',
						id: 'same-id',
						inputs: {
							DO: { block: { ...skillBlock('inspect_scene'), id: 'same-id' } },
						},
					},
				],
			},
		};
		expect(compileRobotWorkspace(duplicateIds, SO101_CATALOG_SNAPSHOT)).toEqual({
			ok: false,
			error: 'workspace contains duplicate block id "same-id"',
		});
	});

	it('applies PARAMS_JSON limits to UTF-8 bytes', () => {
		const catalog: import('./catalog').RobotCatalog = {
			...SO101_CATALOG_SNAPSHOT,
			skills: [
				...SO101_CATALOG_SNAPSHOT.skills,
				{
					name: 'say_note',
					summary: 'Say a note',
					parameters: {
						type: 'object',
						properties: { note: { type: 'string' } },
						required: ['note'],
						additionalProperties: false,
					},
				},
			],
		};
		const workspace = planRoot({
			type: 'robot_execute_skill',
			fields: { SKILL: 'say_note', PARAMS_JSON: JSON.stringify({ note: '课'.repeat(6000) }) },
		});
		expect(compileRobotWorkspace(workspace, catalog)).toEqual({
			ok: false,
			error: 'PARAMS_JSON is too large',
		});
	});

	it('rejects dangerous keys in parameter JSON', () => {
		const workspace = planRoot({
			type: 'robot_execute_skill',
			fields: { SKILL: 'inspect_scene', PARAMS_JSON: '{"__proto__":1}' },
		});
		expect(compileRobotWorkspace(workspace, SO101_CATALOG_SNAPSHOT)).toEqual({
			ok: false,
			error: 'parameter key "__proto__" is not allowed',
		});
	});

	it('rejects invalid direction, timeout, and param JSON', () => {
		const badDirection = planRoot({
			type: 'robot_execute_skill',
			fields: { SKILL: 'move_relative_ee', DIRECTION: 'sideways' },
		});
		expect(compileRobotWorkspace(badDirection, SO101_CATALOG_SNAPSHOT)).toEqual({
			ok: false,
			error: 'invalid motion direction "sideways"',
		});
		const badTimeout = planRoot({
			type: 'robot_execute_skill',
			fields: { SKILL: 'inspect_scene' },
			inputs: { TIMEOUT: { block: { type: 'math_number', fields: { NUM: 700 } } } },
		});
		expect(compileRobotWorkspace(badTimeout, SO101_CATALOG_SNAPSHOT)).toEqual({
			ok: false,
			error: 'timeout exceeds 600s',
		});
		const badJson = planRoot({
			type: 'robot_execute_skill',
			fields: { SKILL: 'inspect_scene', PARAMS_JSON: '{nope' },
		});
		expect(compileRobotWorkspace(badJson, SO101_CATALOG_SNAPSHOT)).toEqual({
			ok: false,
			error: 'PARAMS_JSON is not valid JSON',
		});
	});

	it('enforces the plan budget and step cap', () => {
		const chain = Array.from({ length: 7 }, () => skillBlock('dance_basic')); // 7 × 60s > 180s
		const result = compileRobotWorkspace(planRoot(...chain), SO101_CATALOG_SNAPSHOT);
		expect(result).toEqual({
			ok: false,
			error: 'plan total budget 420s exceeds task_budget_sec 180s',
		});
		expect(planBudgetError([{ step: 'wait', seconds: 1 }])).toBeNull();
	});

	it('rejects chains deeper than the limit', () => {
		const chain = Array.from({ length: 45 }, () => skillBlock('inspect_scene'));
		// 45 inspect_scene steps also exceeds the 180s budget; depth error must win.
		const result = compileRobotWorkspace(planRoot(...chain), SO101_CATALOG_SNAPSHOT);
		expect(result.ok).toBe(false);
	});
});
