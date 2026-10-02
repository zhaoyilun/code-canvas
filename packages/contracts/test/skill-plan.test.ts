/**
 * 技能计划的校验器：**判据是目录**，不是写死的动作表。
 *
 * 这份测试要钉住的七件事：
 * 1. 合法计划原样通过，参数按目录里的类型判；
 * 2. 不合法的每一类都有**自己的码**（技能查不到 / 参数名不认 / 类型不对 / 步种类不支持），
 *    界面能据此指出是哪一步的哪个字段；
 * 3. 缺参数只**提醒**（目录没有必填这一栏，执行侧有默认值），不许因此拦下整份计划；
 * 4. 分支（`if` 步）的每一条规矩都是硬规矩：条件只认 `last.success`（字段 / 运算符 / 取值各自有码）、
 *    嵌套有深度上限、`then` 非空、`else` 给了就非空，且诊断的 `path` 要指到嵌套里的那一层；
 * 5. 等待（`wait` 步）的秒数必须是正数、不超十分钟，且**不参与**分支的深度计数——
 *    「等一会儿」不该占掉分支的表达空间；
 * 6. 失败处置（`onFailure`）只有技能步与原语步有：取值只认 `stop` / `continue`，缺省**不补键**
 *    （缺省是停，不许在执行侧看不见的地方把它悄悄写成 `continue`），落在 `wait` / `if` 上报错；
 * 7. 原语步（`primitive`）的判据同样是目录（`catalog.primitives`），且**参数校验与技能步共用同一条路**
 *    ——最后一组用「同一类毛病在两条路上给同一个码、同一个 path 形状」把这件事钉死。
 */
import { describe, expect, it } from 'vitest';
import { capabilityCatalogSchema, type CapabilityCatalog } from '../src/capability';
import { SKILL_PLAN_ON_FAILURE, validateSkillPlan, SKILL_PLAN_SCHEMA_VERSION } from '../src/skill-plan';

const CATALOG: CapabilityCatalog = capabilityCatalogSchema.parse({
	catalogRef: 'roboframe_so101_single_arm',
	displayName: 'SO-101 单臂（RoboFrame 技能库）',
	robotName: 'so101_single_arm',
	revisionRef: 'roboframe-so101-v1',
	namedPoses: ['home', 'observe_table', 'zero'],
	primitives: [
		{ primitiveRef: 'move_to_named_pose', label: '移动到命名位姿', parameters: [{ name: 'pose_name', label: '命名位姿', type: 'pose' }] },
		{ primitiveRef: 'open_gripper', label: '张开夹爪', parameters: [] },
		{
			// 上游说必填的原语参数：缺了是**错误**（与技能那边同一条规矩）。
			primitiveRef: 'rotate_gripper_cw',
			label: '顺时针旋转夹爪',
			parameters: [{ name: 'motion_distance', label: '旋转角度', type: 'number', required: true, unit: 'degrees' }],
		},
		{
			primitiveRef: 'move_to_joint_positions',
			label: '移动到关节位置',
			parameters: [
				{ name: 'joint_positions', label: '关节目标位置', type: 'json' },
				{ name: 'duration_sec', label: '时长', type: 'number' },
			],
		},
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
			// 上游说必填的参数：缺了是**错误**，不是提醒（判据在技能的 JSON Schema 里）。
			capabilityRef: 'grip',
			label: '夹住',
			kind: 'skill',
			parameters: [
				{ name: 'force', label: '力度', type: 'number', required: true, unit: 'newtons' },
				{ name: 'hold', label: '保持', type: 'boolean' },
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
		expect(first?.details?.['allowed']).toEqual(['wave_hello', 'move_relative_ee', 'grip', 'tune_joints']);
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

	it('上游标了必填的参数缺了 → 报错（判据来自目录，不是我们自己定的）', () => {
		const result = validateSkillPlan(step({ step: 'skill', skill: 'grip', params: { hold: true } }), { catalog: CATALOG });
		expect(result.ok).toBe(false);
		expect(codes(result)).toEqual(['plan.step.param.required']);
		expect(result.diagnostics[0]?.details?.['param']).toBe('force');
	});

	it('必填的给了、可选的没给 → 通过，只对没标必填的那个提醒', () => {
		const result = validateSkillPlan(step({ step: 'skill', skill: 'grip', params: { force: 3 } }), { catalog: CATALOG });
		expect(result.ok).toBe(true);
		expect(codes(result)).toEqual(['plan.step.param.missing']);
	});

	it('缺参数只提醒，不拦——目录里没标必填的，执行侧有默认值', () => {
		const result = validateSkillPlan(step({ step: 'skill', skill: 'move_relative_ee', params: { motion_direction: 'forward' } }), {
			catalog: CATALOG,
		});
		expect(codes(result)).toEqual(['plan.step.param.missing']);
		expect(result.ok).toBe(true);
	});

	it('别的步种类明说不做，不静默当成技能', () => {
		// 设计稿的 `skipIf` 这一版不做（守卫挂在**后一步**上，这一版换成这一步自己的 onFailure）——
		// 遇到它要明说，不静默当技能处理。
		const result = validateSkillPlan(step({ step: 'skipIf', skill: 'grab' }), { catalog: CATALOG });
		expect(codes(result)).toEqual(['plan.step.kind_unsupported']);
		const [first] = result.diagnostics;
		expect(first?.message).toContain('skipIf');
		expect(first?.message).toContain('"skill" / "if" / "wait" / "primitive"');
		// 认得的四种一并给上：界面据此把「能写哪几种」说给写计划的人
		expect(first?.details?.['supported']).toEqual(['skill', 'if', 'wait', 'primitive']);
	});

	it('超时必须正数', () => {
		const result = validateSkillPlan(step({ step: 'skill', skill: 'wave_hello', timeoutSec: 0 }), { catalog: CATALOG });
		expect(codes(result)).toEqual(['plan.step.timeout.invalid']);
	});
});

// ---------------------------------------------------------------------------
// 分支（`if` 步）
// ---------------------------------------------------------------------------

/** 一条 `if` 步，按冻结的形状写：条件只认 `last.success`，两条臂装的是同一个联合。 */
const branch = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
	step: 'if',
	condition: { field: 'last.success', op: '==', value: false },
	then: [{ step: 'skill', skill: 'wave_hello' }],
	...overrides,
});

const condition = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
	field: 'last.success',
	op: '==',
	value: true,
	...overrides,
});

/** 把 `levels` 层 `if` 叠起来，最里面是 `innermost`（缺省是一个技能步）——用来量深度上限。 */
const nest = (levels: number, innermost: Record<string, unknown> = { step: 'skill', skill: 'wave_hello' }): Record<string, unknown> => {
	let nested: Record<string, unknown> = innermost;
	for (let level = 0; level < levels; level += 1) nested = branch({ then: [nested] });
	return nested;
};

const planOf = (...steps: Record<string, unknown>[]) => ({
	schemaVersion: SKILL_PLAN_SCHEMA_VERSION,
	robot: 'so101_single_arm',
	plan: steps,
});

describe('技能计划的分支', () => {
	it('嵌套合法：`if` 里还能再放 `if`，两条臂里的步骤照目录判', () => {
		const result = validateSkillPlan(
			step(
				branch({
					then: [
						{ step: 'skill', skill: 'move_relative_ee', params: { motion_direction: 'forward', motion_distance: 0.03 } },
						branch({
							condition: condition({ op: '!=' }),
							then: [{ step: 'skill', skill: 'tune_joints', params: { joint_positions: { '1': 0.1 } } }],
						}),
					],
					else: [{ step: 'skill', skill: 'wave_hello' }],
				}),
			),
			{ catalog: CATALOG, expectedRobot: 'so101_single_arm' },
		);
		expect(codes(result)).toEqual([]);
		if (!result.ok) throw new Error('应当通过');
		expect(result.plan.plan).toStrictEqual([
			{
				step: 'if',
				condition: { field: 'last.success', op: '==', value: false },
				then: [
					{ step: 'skill', skill: 'move_relative_ee', params: { motion_direction: 'forward', motion_distance: 0.03 } },
					{
						step: 'if',
						condition: { field: 'last.success', op: '!=', value: true },
						then: [{ step: 'skill', skill: 'tune_joints', params: { joint_positions: { '1': 0.1 } } }],
					},
				],
				else: [{ step: 'skill', skill: 'wave_hello' }],
			},
		]);
	});

	it('平面步骤与分支混在同一条链上：分支在中间也合法（`if` 执行完接着往下走）', () => {
		const result = validateSkillPlan(
			planOf(
				{ step: 'skill', skill: 'wave_hello' },
				branch(),
				{ step: 'skill', skill: 'tune_joints', params: { joint_positions: { '1': 0.1 } } },
			),
			{ catalog: CATALOG },
		);
		expect(codes(result)).toEqual([]);
		if (!result.ok) throw new Error('应当通过');
		// 三步都在，顺序照写的那样——「分支之后的步骤」在计划层就是普通的一步。
		expect(result.plan.plan.map((item) => item.step)).toEqual(['skill', 'if', 'skill']);
		expect(result.plan.plan[1]).toStrictEqual({
			step: 'if',
			condition: { field: 'last.success', op: '==', value: false },
			then: [{ step: 'skill', skill: 'wave_hello' }],
		});
	});

	it('只有 then 的分支合法：结果里不带 else 键', () => {
		const result = validateSkillPlan(step(branch()), { catalog: CATALOG });
		expect(codes(result)).toEqual([]);
		if (!result.ok) throw new Error('应当通过');
		expect(Object.keys(result.plan.plan[0] ?? {})).toEqual(['step', 'condition', 'then']);
	});

	it('深度 8 通过、9 被拒，且 path 指到超限的那一层', () => {
		expect(codes(validateSkillPlan(step(nest(8)), { catalog: CATALOG }))).toEqual([]);

		const tooDeep = validateSkillPlan(step(nest(9)), { catalog: CATALOG });
		expect(codes(tooDeep)).toEqual(['plan.step.depth_exceeded']);
		expect(tooDeep.diagnostics[0]?.path).toBe(`plan[0]${'.then[0]'.repeat(8)}`);
		expect(tooDeep.diagnostics[0]?.details).toEqual({ depth: 9, limit: 8 });
	});

	it('`then` 至少要有一个步骤', () => {
		const result = validateSkillPlan(step(branch({ then: [] })), { catalog: CATALOG });
		expect(codes(result)).toEqual(['plan.step.if.then_empty']);
		expect(result.diagnostics[0]?.path).toBe('plan[0].then');
	});

	it('`else` 给了就不能为空', () => {
		const result = validateSkillPlan(step(branch({ else: [] })), { catalog: CATALOG });
		expect(codes(result)).toEqual(['plan.step.if.else_empty']);
		expect(result.diagnostics[0]?.path).toBe('plan[0].else');
	});

	it('条件只认 last.success：字段 / 运算符 / 取值 / 形状各自有码', () => {
		const fieldResult = validateSkillPlan(step(branch({ condition: condition({ field: 'last.gripper' }) })), { catalog: CATALOG });
		expect(codes(fieldResult)).toEqual(['plan.step.condition.field.unsupported']);
		expect(fieldResult.diagnostics[0]?.path).toBe('plan[0].condition.field');
		expect(fieldResult.diagnostics[0]?.details?.['allowed']).toEqual(['last.success']);

		const opResult = validateSkillPlan(step(branch({ condition: condition({ op: '>' }) })), { catalog: CATALOG });
		expect(codes(opResult)).toEqual(['plan.step.condition.op.unsupported']);
		expect(opResult.diagnostics[0]?.path).toBe('plan[0].condition.op');
		expect(opResult.diagnostics[0]?.details?.['allowed']).toEqual(['==', '!=']);

		const valueResult = validateSkillPlan(step(branch({ condition: condition({ value: 'yes' }) })), { catalog: CATALOG });
		expect(codes(valueResult)).toEqual(['plan.step.condition.value.invalid']);
		expect(valueResult.diagnostics[0]?.path).toBe('plan[0].condition.value');

		const shapeResult = validateSkillPlan(step(branch({ condition: 'last.success' })), { catalog: CATALOG });
		expect(codes(shapeResult)).toEqual(['plan.step.condition.not_object']);
		expect(shapeResult.diagnostics[0]?.path).toBe('plan[0].condition');
	});

	it('条件不对也接着量两条臂：一次把能报的都报出来', () => {
		const result = validateSkillPlan(step(branch({ condition: condition({ field: 'last.gripper' }), then: [{ step: 'skill', skill: 'fly' }] })), {
			catalog: CATALOG,
		});
		expect(result.diagnostics.map((diagnostic) => `${diagnostic.code}@${diagnostic.path ?? ''}`)).toEqual([
			'plan.step.condition.field.unsupported@plan[0].condition.field',
			'plan.step.skill.unknown@plan[0].then[0].skill',
		]);
	});

	it('path 指到嵌套里那一层：臂里的技能与参数照目录判', () => {
		const result = validateSkillPlan(
			step(
				branch({
					then: [
						branch({
							then: [{ step: 'skill', skill: 'move_relative_ee', params: { motion_distance: 'far' } }],
							else: [{ step: 'skill', skill: 'fly' }],
						}),
					],
				}),
			),
			{ catalog: CATALOG },
		);
		expect(result.diagnostics.map((diagnostic) => `${diagnostic.code}@${diagnostic.path ?? ''}`)).toEqual([
			'plan.step.param.type@plan[0].then[0].then[0].params.motion_distance',
			// 另一个参数压根没给：提醒，不拦。
			'plan.step.param.missing@plan[0].then[0].then[0].params',
			'plan.step.skill.unknown@plan[0].then[0].else[0].skill',
		]);
	});
});

// ---------------------------------------------------------------------------
// 等待（`wait` 步）
// ---------------------------------------------------------------------------

/** 一条 `wait` 步。 */
const wait = (seconds: unknown): Record<string, unknown> => ({ step: 'wait', seconds });

describe('技能计划的等待', () => {
	it('合法通过，秒数原样带进结果（键序照冻结的形状：step / seconds）', () => {
		const result = validateSkillPlan(step(wait(2)), { catalog: CATALOG });
		expect(codes(result)).toEqual([]);
		if (!result.ok) throw new Error('应当通过');
		expect(result.plan.plan).toStrictEqual([{ step: 'wait', seconds: 2 }]);
		expect(Object.keys(result.plan.plan[0] ?? {})).toEqual(['step', 'seconds']);
		// 6 分钟（360）照收：上限是十分钟，不是「不能太久」
		expect(codes(validateSkillPlan(step(wait(360)), { catalog: CATALOG }))).toEqual([]);
	});

	it('秒数不是正数：0 / 负数 / 字符串 / 缺，各自报同一个稳定的码', () => {
		// 判据只有一条「正数」，四种坏形状都说同一件事——界面据此写一句「秒数不对」，
		// 不必按收到什么类型再分四种说法。
		for (const bad of [wait(0), wait(-1), wait('2'), { step: 'wait' }]) {
			const result = validateSkillPlan(step(bad), { catalog: CATALOG });
			expect(codes(result)).toEqual(['plan.step.wait.seconds_invalid']);
			expect(result.ok).toBe(false);
			const [first] = result.diagnostics;
			expect(first?.path).toBe('plan[0].seconds');
			expect(first?.ref).toBe('wait');
		}
		// 整份计划别的问题照报：等待步的秒数不对，不挡着后面的诊断
		expect(
			codes(
				validateSkillPlan(
					{ schemaVersion: SKILL_PLAN_SCHEMA_VERSION, robot: 'so101_single_arm', plan: [wait(0), { step: 'skill', skill: 'fly' }] },
					{ catalog: CATALOG },
				),
			),
		).toEqual(['plan.step.wait.seconds_invalid', 'plan.step.skill.unknown']);
	});

	it('超过十分钟（600 秒）报错：给的是「太大」那个码，400 与 601 说的是两件事', () => {
		expect(codes(validateSkillPlan(step(wait(600)), { catalog: CATALOG }))).toEqual([]);

		const result = validateSkillPlan(step(wait(601)), { catalog: CATALOG });
		expect(codes(result)).toEqual(['plan.step.wait.seconds_out_of_range']);
		expect(result.diagnostics[0]?.path).toBe('plan[0].seconds');
		expect(result.diagnostics[0]?.details).toEqual({ value: 601, limit: 600 });
		// 86400 这种「等一天」不是等待，是把执行器挂在那儿——同一个码拦下
		expect(codes(validateSkillPlan(step(wait(86400)), { catalog: CATALOG }))).toEqual(['plan.step.wait.seconds_out_of_range']);
	});

	it('等待步不参与深度计数：8 层 if 里外都有等待照样通过，9 层照旧被拒', () => {
		// 最里面放等待步：深度还是 8 层（等待不是一层结构）
		expect(codes(validateSkillPlan(step(nest(8, wait(2))), { catalog: CATALOG }))).toEqual([]);

		// 每一层的臂里除了下一层 if 还多放一步等待：深度仍是 8，一个码都不报
		let nested: Record<string, unknown> = wait(1);
		for (let level = 0; level < 8; level += 1) nested = branch({ then: [wait(1), nested] });
		expect(codes(validateSkillPlan(step(nested), { catalog: CATALOG }))).toEqual([]);

		// 9 层 if 照旧被拒，且 path 与没有等待步时一模一样（等待没有多算一层）
		const tooDeep = validateSkillPlan(step(nest(9, wait(2))), { catalog: CATALOG });
		expect(codes(tooDeep)).toEqual(['plan.step.depth_exceeded']);
		expect(tooDeep.diagnostics[0]?.path).toBe(`plan[0]${'.then[0]'.repeat(8)}`);
	});

	it('等待步与技能步、分支混排在同一条链上：顺序照写的那样', () => {
		const result = validateSkillPlan(
			planOf({ step: 'skill', skill: 'wave_hello' }, wait(1), branch(), wait(0.5)),
			{ catalog: CATALOG },
		);
		expect(codes(result)).toEqual([]);
		if (!result.ok) throw new Error('应当通过');
		expect(result.plan.plan.map((item) => item.step)).toEqual(['skill', 'wait', 'if', 'wait']);
	});
});

// ---------------------------------------------------------------------------
// 失败处置（`onFailure`）：只有技能步有，缺省是停
// ---------------------------------------------------------------------------

describe('技能计划的失败处置', () => {
	it('两个取值都合法，原样带进结果（键序照冻结的形状：step / skill / params / timeoutSec / onFailure）', () => {
		for (const value of SKILL_PLAN_ON_FAILURE) {
			const result = validateSkillPlan(
				step({ step: 'skill', skill: 'move_relative_ee', params: { motion_direction: 'forward', motion_distance: 0.03 }, timeoutSec: 10, onFailure: value }),
				{ catalog: CATALOG },
			);
			expect(codes(result)).toEqual([]);
			if (!result.ok) throw new Error('应当通过');
			expect(result.plan.plan).toStrictEqual([
				{
					step: 'skill',
					skill: 'move_relative_ee',
					params: { motion_direction: 'forward', motion_distance: 0.03 },
					timeoutSec: 10,
					onFailure: value,
				},
			]);
			expect(Object.keys(result.plan.plan[0] ?? {})).toEqual(['step', 'skill', 'params', 'timeoutSec', 'onFailure']);
		}
	});

	it('缺省**不补键**：没写这一栏就什么都不写（缺省是停，不替执行侧把 stop 写进计划里）', () => {
		const result = validateSkillPlan(step({ step: 'skill', skill: 'wave_hello' }), { catalog: CATALOG });
		expect(codes(result)).toEqual([]);
		if (!result.ok) throw new Error('应当通过');
		expect(result.plan.plan).toStrictEqual([{ step: 'skill', skill: 'wave_hello' }]);
		expect(result.plan.plan[0]).not.toHaveProperty('onFailure');
	});

	it('取值不认识就报错，且**不退回缺省**：keep_going / true / null / 数字各报同一个码', () => {
		// 想写「往下走」的人写错了词，静默按「停」处理会让他的计划停在一步他以为不会停的地方。
		for (const bad of ['keep_going', 'Stop', true, null, 1, { onFailure: 'continue' }]) {
			const result = validateSkillPlan(step({ step: 'skill', skill: 'wave_hello', onFailure: bad }), { catalog: CATALOG });
			expect(codes(result)).toEqual(['plan.step.onfailure_invalid']);
			expect(result.ok).toBe(false);
			const [first] = result.diagnostics;
			expect(first?.path).toBe('plan[0].onFailure');
			expect(first?.details?.['allowed']).toEqual(['stop', 'continue']);
			expect(first?.details?.['default']).toBe('stop');
		}
	});

	it('落在等待步上报错：`wait` 不会失败，这一栏没有对象', () => {
		const result = validateSkillPlan(step({ step: 'wait', seconds: 2, onFailure: 'continue' }), { catalog: CATALOG });
		expect(codes(result)).toEqual(['plan.step.onfailure_not_applicable']);
		expect(result.ok).toBe(false);
		const [first] = result.diagnostics;
		expect(first?.path).toBe('plan[0].onFailure');
		expect(first?.ref).toBe('wait');
		// 带这一栏的是技能步与原语步（判据那一栏也照实说这两个）
		expect(first?.details?.['applicable']).toEqual(['skill', 'primitive']);
		// 秒数那个毛病照报：这一栏不对，不挡着别的问题
		expect(codes(validateSkillPlan(step({ step: 'wait', seconds: 0, onFailure: 'stop' }), { catalog: CATALOG }))).toEqual([
			'plan.step.onfailure_not_applicable',
			'plan.step.wait.seconds_invalid',
		]);
	});

	it('落在分支步上报错，臂里那一层也照报（走哪条臂由条件决定）', () => {
		const top = validateSkillPlan(step(branch({ onFailure: 'continue' })), { catalog: CATALOG });
		expect(codes(top)).toEqual(['plan.step.onfailure_not_applicable']);
		expect(top.diagnostics[0]?.path).toBe('plan[0].onFailure');
		expect(top.diagnostics[0]?.ref).toBe('if');

		// 臂里的技能步带着它是**对的**（继续往下走是这一步的事），臂里的 `if` 带着才是错的
		const nested = validateSkillPlan(
			step(branch({ then: [{ step: 'skill', skill: 'wave_hello', onFailure: 'continue' }, branch({ onFailure: 'stop' })] })),
			{ catalog: CATALOG },
		);
		expect(codes(nested)).toEqual(['plan.step.onfailure_not_applicable']);
		expect(nested.diagnostics[0]?.path).toBe('plan[0].then[1].onFailure');
	});

	it('与别的毛病一起报：技能查不到归技能查不到，处置写错归处置写错', () => {
		const result = validateSkillPlan(
			planOf({ step: 'skill', skill: 'fly', onFailure: 'continue' }, { step: 'skill', skill: 'wave_hello', onFailure: 'later' }),
			{ catalog: CATALOG },
		);
		expect(codes(result)).toEqual(['plan.step.skill.unknown', 'plan.step.onfailure_invalid']);
		expect(result.diagnostics.map((item) => item.path)).toEqual(['plan[0].skill', 'plan[1].onFailure']);
	});
});

// ---------------------------------------------------------------------------
// 原语步（`primitive`）：直接叫一个原子动作，判据同样是目录
// ---------------------------------------------------------------------------

/** 一条原语步，按冻结的形状写：`{ step:'primitive', primitive, params?, timeoutSec?, onFailure? }`。 */
const primitive = (ref: unknown, rest: Record<string, unknown> = {}): Record<string, unknown> => ({
	step: 'primitive',
	primitive: ref,
	...rest,
});

describe('技能计划的原语步', () => {
	it('合法计划通过，参数原样带进结果（键序照冻结的形状：step / primitive / params / timeoutSec / onFailure）', () => {
		const result = validateSkillPlan(
			step(primitive('move_to_named_pose', { params: { pose_name: 'home' }, timeoutSec: 5, onFailure: 'continue' })),
			{ catalog: CATALOG },
		);
		expect(codes(result)).toEqual([]);
		if (!result.ok) throw new Error('应当通过');
		expect(result.plan.plan).toStrictEqual([
			{ step: 'primitive', primitive: 'move_to_named_pose', params: { pose_name: 'home' }, timeoutSec: 5, onFailure: 'continue' },
		]);
		expect(Object.keys(result.plan.plan[0] ?? {})).toEqual(['step', 'primitive', 'params', 'timeoutSec', 'onFailure']);
	});

	it('没有参数的原语（张开夹爪）：不写 params 也通过，结果里不带 params 键', () => {
		const result = validateSkillPlan(step(primitive('open_gripper')), { catalog: CATALOG });
		expect(codes(result)).toEqual([]);
		if (!result.ok) throw new Error('应当通过');
		expect(result.plan.plan).toStrictEqual([{ step: 'primitive', primitive: 'open_gripper' }]);
	});

	it('原语不在目录里：报出来，并把目录里有什么一并给上（照 skill.unknown 的写法）', () => {
		const result = validateSkillPlan(step(primitive('fly')), { catalog: CATALOG });
		expect(codes(result)).toEqual(['plan.step.primitive.unknown']);
		const [first] = result.diagnostics;
		expect(first?.path).toBe('plan[0].primitive');
		expect(first?.ref).toBe('fly');
		expect(first?.message).toContain('SO-101 单臂');
		expect(first?.details?.['allowed']).toEqual([
			'move_to_named_pose',
			'open_gripper',
			'rotate_gripper_cw',
			'move_to_joint_positions',
		]);
		expect(first?.details?.['catalog']).toBe('roboframe_so101_single_arm');
		// 判据是**目录**，不是写死的表：连 `primitive` 这个键名都不是它认人的依据
		expect(codes(validateSkillPlan(step(primitive('wave_hello')), { catalog: CATALOG }))).toEqual([
			'plan.step.primitive.unknown',
		]);
	});

	it('没写原语名：自己的码，不跟「不在目录里」混成一个', () => {
		for (const raw of [primitive(undefined), primitive(''), primitive(3)]) {
			const result = validateSkillPlan(step(raw), { catalog: CATALOG });
			expect(codes(result)).toEqual(['plan.step.primitive.missing']);
			expect(result.diagnostics[0]?.path).toBe('plan[0].primitive');
		}
	});

	it('参数名不是这个原语声明的：报出来，并列出它能收哪些', () => {
		const result = validateSkillPlan(step(primitive('open_gripper', { params: { motion_distance: 1 } })), { catalog: CATALOG });
		expect(codes(result)).toEqual(['plan.step.param.unknown']);
		expect(result.diagnostics[0]?.path).toBe('plan[0].params.motion_distance');
		expect(result.diagnostics[0]?.details?.['allowed']).toEqual([]);
	});

	it('参数类型不对：报出来，并写清要哪一种；`json` 参数照收结构化载荷', () => {
		const bad = validateSkillPlan(step(primitive('move_to_joint_positions', { params: { joint_positions: {}, duration_sec: 'fast' } })), {
			catalog: CATALOG,
		});
		expect(codes(bad)).toEqual(['plan.step.param.type']);
		expect(bad.diagnostics[0]?.details?.['expected']).toBe('number');
		expect(bad.diagnostics[0]?.path).toBe('plan[0].params.duration_sec');

		// `json` 收一切（关节位置映射这种结构化载荷不许被当成类型不符），所以只提醒没给时长
		const good = validateSkillPlan(step(primitive('move_to_joint_positions', { params: { joint_positions: { '1': 0.02 } } })), {
			catalog: CATALOG,
		});
		expect(codes(good)).toEqual(['plan.step.param.missing']);
		expect(good.ok).toBe(true);
	});

	it('必填的参数缺了 → 报错；没标必填的缺了只提醒', () => {
		const missingRequired = validateSkillPlan(step(primitive('rotate_gripper_cw')), { catalog: CATALOG });
		expect(missingRequired.ok).toBe(false);
		expect(codes(missingRequired)).toEqual(['plan.step.param.required']);
		expect(missingRequired.diagnostics[0]?.details?.['param']).toBe('motion_distance');
		expect(missingRequired.diagnostics[0]?.path).toBe('plan[0].params');

		const optional = validateSkillPlan(step(primitive('move_to_joint_positions', { params: { joint_positions: {} } })), {
			catalog: CATALOG,
		});
		expect(optional.ok).toBe(true);
		expect(codes(optional)).toEqual(['plan.step.param.missing']);
	});

	it('`params` 不是对象：自己的码，且不再往下报逐参数的问题', () => {
		const result = validateSkillPlan(step(primitive('open_gripper', { params: 'nope' })), { catalog: CATALOG });
		expect(codes(result)).toEqual(['plan.step.params.not_object']);
		expect(result.diagnostics[0]?.path).toBe('plan[0].params');
	});

	it('失败处置与技能步同待遇：两个取值都收，写错报同一个码', () => {
		for (const value of SKILL_PLAN_ON_FAILURE) {
			expect(codes(validateSkillPlan(step(primitive('open_gripper', { onFailure: value })), { catalog: CATALOG }))).toEqual([]);
		}
		const bad = validateSkillPlan(step(primitive('open_gripper', { onFailure: 'keep_going' })), { catalog: CATALOG });
		expect(codes(bad)).toEqual(['plan.step.onfailure_invalid']);
		expect(bad.diagnostics[0]?.path).toBe('plan[0].onFailure');
		expect(bad.diagnostics[0]?.ref).toBe('open_gripper');
	});

	it('超时必须正数（与技能步同一个码）', () => {
		expect(codes(validateSkillPlan(step(primitive('open_gripper', { timeoutSec: 0 })), { catalog: CATALOG }))).toEqual([
			'plan.step.timeout.invalid',
		]);
	});

	it('原语步与技能步、分支、等待混排在同一条链上（臂里也放得下）', () => {
		const result = validateSkillPlan(
			planOf(
				primitive('open_gripper'),
				{ step: 'wait', seconds: 1 },
				{ step: 'skill', skill: 'wave_hello' },
				branch({ then: [primitive('move_to_named_pose', { params: { pose_name: 'home' } })] }),
			),
			{ catalog: CATALOG },
		);
		expect(codes(result)).toEqual([]);
		if (!result.ok) throw new Error('应当通过');
		expect(result.plan.plan.map((item) => item.step)).toEqual(['primitive', 'wait', 'skill', 'if']);
	});

	it('诊断的 path 指到嵌套里那一层（原语步在臂里也照判）', () => {
		const result = validateSkillPlan(step(branch({ then: [primitive('move_to_named_pose', { params: { pose_name: 1 } })] })), {
			catalog: CATALOG,
		});
		expect(result.diagnostics.map((item) => `${item.code}@${item.path ?? ''}`)).toEqual([
			'plan.step.param.type@plan[0].then[0].params.pose_name',
		]);
	});
});

// ---------------------------------------------------------------------------
// 「参数校验共用同一条路」的证据：同一类毛病，两条路给同一个码、同一个 path 形状
// ---------------------------------------------------------------------------

describe('技能步与原语步的参数判据是同一条路', () => {
	/** 诊断压成一行：`码@path（参数名归一成 <参数>）`——两条路的 path 只该差在参数名上。 */
	const shape = (result: ReturnType<typeof validateSkillPlan>): string[] =>
		result.diagnostics.map((diagnostic) => `${diagnostic.code}@${(diagnostic.path ?? '').replace(/params\.[^.]+$/, 'params.<参数>')}`);

	/** 措辞：把主语（`技能「x」` / `原语「y」`）换成同一个占位符，两句话该是同一句。 */
	const wording = (result: ReturnType<typeof validateSkillPlan>, subject: string): string[] =>
		result.diagnostics.map((diagnostic) => diagnostic.message.split(subject).join('X'));

	/**
	 * 再把**这件事本身不同的那几处**（参数名、参数中文标签、类型名）换成占位符：
	 * 两条路报的是同一套话，差的只是「说的是哪个参数」。留下的就是模板本身。
	 */
	const template = (line: string): string =>
		line
			.replace(/「[^」]*」/g, '「<参数>」')
			// 标签自己可能带括号（`移动距离（米）`），所以从第一个 `（` 一路吃到最后一个 `）`
			.replace(/（.*）/, '（<标签>）')
			.replace(/要 \S+，/, '要 <类型>，');

	it('名字不认 / 类型不对 / 没标必填的缺了：两条路的码与 path 形状一模一样', () => {
		const skillRun = validateSkillPlan(
			step({ step: 'skill', skill: 'move_relative_ee', params: { nope: 1, motion_direction: 3 } }),
			{ catalog: CATALOG },
		);
		const primitiveRun = validateSkillPlan(
			step(primitive('move_to_joint_positions', { params: { nope: 1, duration_sec: 'fast' } })),
			{ catalog: CATALOG },
		);

		// 三条毛病：参数名不认、类型不对、另一个参数没给（提醒）
		expect(shape(skillRun)).toEqual([
			'plan.step.param.unknown@plan[0].params.<参数>',
			'plan.step.param.type@plan[0].params.<参数>',
			'plan.step.param.missing@plan[0].params',
		]);
		expect(shape(primitiveRun)).toEqual(shape(skillRun));
		// 措辞也只有主语不同——把参数名/标签/类型换成占位符之后，两句是同一句
		expect(wording(primitiveRun, '原语「move_to_joint_positions」').map(template)).toEqual(
			wording(skillRun, '技能「move_relative_ee」').map(template),
		);
	});

	it('必填缺了：两条路给同一个码（技能那份放宽一点，这条就该红）', () => {
		const skillRun = validateSkillPlan(step({ step: 'skill', skill: 'grip', params: {} }), { catalog: CATALOG });
		const primitiveRun = validateSkillPlan(step(primitive('rotate_gripper_cw', { params: {} })), { catalog: CATALOG });

		expect(shape(skillRun)).toEqual([
			'plan.step.param.required@plan[0].params',
			'plan.step.param.missing@plan[0].params',
		]);
		// 必填那一条两边都在；原语的这个没有可选参数，所以只有一条
		expect(shape(primitiveRun)[0]).toBe('plan.step.param.required@plan[0].params');
	});

	it('`params` 不是对象：同一个码、同一句措辞（只差主语）', () => {
		const skillRun = validateSkillPlan(step({ step: 'skill', skill: 'wave_hello', params: [] }), { catalog: CATALOG });
		const primitiveRun = validateSkillPlan(step(primitive('open_gripper', { params: [] })), { catalog: CATALOG });

		expect(shape(skillRun)).toEqual(['plan.step.params.not_object@plan[0].params']);
		expect(shape(primitiveRun)).toEqual(shape(skillRun));
		expect(wording(primitiveRun, '原语「open_gripper」')).toEqual(wording(skillRun, '技能「wave_hello」'));
	});
});
