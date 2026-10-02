/**
 * 技能计划的校验器：**判据是目录**，不是写死的动作表。
 *
 * 这份测试要钉住的三件事：
 * 1. 合法计划原样通过，参数按目录里的类型判；
 * 2. 不合法的每一类都有**自己的码**（技能查不到 / 参数名不认 / 类型不对 / 步种类不支持），
 *    界面能据此指出是哪一步的哪个字段；
 * 3. 缺参数只**提醒**（目录没有必填这一栏，执行侧有默认值），不许因此拦下整份计划。
 */
import { describe, expect, it } from 'vitest';
import { capabilityCatalogSchema, type CapabilityCatalog } from '../src/capability';
import { validateSkillPlan, SKILL_PLAN_SCHEMA_VERSION } from '../src/skill-plan';

const CATALOG: CapabilityCatalog = capabilityCatalogSchema.parse({
	catalogRef: 'roboframe_so101_single_arm',
	displayName: 'SO-101 单臂（RoboFrame 技能库）',
	robotName: 'so101_single_arm',
	revisionRef: 'roboframe-so101-v1',
	namedPoses: ['home', 'observe_table', 'zero'],
	primitives: [
		{ primitiveRef: 'move_to_named_pose', label: '移动到命名位姿', parameters: [{ name: 'pose_name', label: '命名位姿', type: 'pose' }] },
	],
	capabilities: [
		{
			capabilityRef: 'wave_hello',
			label: '打招呼',
			kind: 'skill',
			parameters: [],
			implementation: [{ kind: 'call', primitiveRef: 'move_to_named_pose', arguments: { pose_name: { kind: 'literal', value: 'home' } } }],
		},
		{
			capabilityRef: 'move_relative_ee',
			label: '相对移动',
			kind: 'skill',
			parameters: [
				{ name: 'motion_direction', label: '移动方向', type: 'string' },
				{ name: 'motion_distance', label: '移动距离（米）', type: 'number' },
			],
			implementation: [{ kind: 'call', primitiveRef: 'move_to_named_pose', arguments: { pose_name: { kind: 'literal', value: 'home' } } }],
		},
		{
			capabilityRef: 'tune_joints',
			label: '调关节',
			kind: 'skill',
			parameters: [{ name: 'joint_positions', label: '关节目标位置', type: 'json' }],
			implementation: [{ kind: 'call', primitiveRef: 'move_to_named_pose', arguments: { pose_name: { kind: 'literal', value: 'home' } } }],
		},
	],
});

const step = (body: Record<string, unknown>) => ({ schemaVersion: SKILL_PLAN_SCHEMA_VERSION, robot: 'so101_single_arm', plan: [body] });

const codes = (result: ReturnType<typeof validateSkillPlan>): string[] =>
	result.diagnostics.map((diagnostic) => diagnostic.code);

describe('技能计划的校验', () => {
	it('合法计划通过，参数原样带进结果', () => {
		const result = validateSkillPlan(
			step({ step: 'skill', skill: 'move_relative_ee', params: { motion_direction: 'forward', motion_distance: 0.03 } }),
			{ catalog: CATALOG, expectedRobot: 'so101_single_arm' },
		);
		expect(codes(result)).toEqual([]);
		if (!result.ok) throw new Error('应当通过');
		expect(result.plan.plan).toEqual([
			{ step: 'skill', skill: 'move_relative_ee', params: { motion_direction: 'forward', motion_distance: 0.03 } },
		]);
	});

	it('不是对象 / 版本不对 / 机器人对不上', () => {
		expect(codes(validateSkillPlan('nope', { catalog: CATALOG }))).toEqual(['plan.not_object']);
		expect(codes(validateSkillPlan({ schemaVersion: 2, robot: 'r', plan: [{}] }, { catalog: CATALOG }))).toEqual([
			'plan.schema_version.unsupported',
			'plan.step.kind_unsupported',
		]);
		expect(
			codes(validateSkillPlan(step({ step: 'skill', skill: 'wave_hello' }), { catalog: CATALOG, expectedRobot: 'lekiwi' })),
		).toEqual(['plan.robot.mismatch']);
	});

	it('空计划拦下，且不再往下报逐步的问题', () => {
		const result = validateSkillPlan({ schemaVersion: SKILL_PLAN_SCHEMA_VERSION, robot: 'so101_single_arm', plan: [] }, { catalog: CATALOG });
		expect(codes(result)).toEqual(['plan.steps.missing']);
		expect(result.ok).toBe(false);
	});

	it('技能不在目录里：报出来，并把目录里有什么一并给上', () => {
		const result = validateSkillPlan(step({ step: 'skill', skill: 'fly' }), { catalog: CATALOG });
		expect(codes(result)).toEqual(['plan.step.skill.unknown']);
		const [first] = result.diagnostics;
		expect(first?.path).toBe('plan[0].skill');
		expect(first?.details?.['allowed']).toEqual(['wave_hello', 'move_relative_ee', 'tune_joints']);
	});

	it('参数名不是这个技能声明的：报出来，并列出它能收哪些', () => {
		const result = validateSkillPlan(step({ step: 'skill', skill: 'wave_hello', params: { motion_distance: 1 } }), { catalog: CATALOG });
		expect(codes(result)).toEqual(['plan.step.param.unknown']);
		expect(result.diagnostics[0]?.path).toBe('plan[0].params.motion_distance');
	});

	it('参数类型不对：报出来，并写清要哪一种', () => {
		const result = validateSkillPlan(step({ step: 'skill', skill: 'move_relative_ee', params: { motion_direction: 3, motion_distance: 'far' } }), {
			catalog: CATALOG,
		});
		expect(codes(result)).toEqual(['plan.step.param.type', 'plan.step.param.type']);
		expect(result.diagnostics.map((diagnostic) => diagnostic.details?.['expected'])).toEqual(['string', 'number']);
	});

	it('`json` 参数收对象（关节位置映射这种）——结构化载荷不许被当成类型不符', () => {
		const result = validateSkillPlan(step({ step: 'skill', skill: 'tune_joints', params: { joint_positions: { '1': 0.02, '2': 0.54 } } }), {
			catalog: CATALOG,
		});
		expect(codes(result)).toEqual([]);
		expect(result.ok).toBe(true);
	});

	it('缺参数只提醒，不拦——目录里没有必填这一栏，执行侧有默认值', () => {
		const result = validateSkillPlan(step({ step: 'skill', skill: 'move_relative_ee', params: { motion_direction: 'forward' } }), {
			catalog: CATALOG,
		});
		expect(codes(result)).toEqual(['plan.step.param.missing']);
		expect(result.ok).toBe(true);
	});

	it('别的步种类明说不做，不静默当成技能', () => {
		const result = validateSkillPlan(step({ step: 'wait', seconds: 2 }), { catalog: CATALOG });
		expect(codes(result)).toEqual(['plan.step.kind_unsupported']);
		expect(result.diagnostics[0]?.message).toContain('primitive / wait / skipIf 还没做');
	});

	it('超时必须正数', () => {
		const result = validateSkillPlan(step({ step: 'skill', skill: 'wave_hello', timeoutSec: 0 }), { catalog: CATALOG });
		expect(codes(result)).toEqual(['plan.step.timeout.invalid']);
	});
});
