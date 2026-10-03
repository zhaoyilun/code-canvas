/**
 * 编译的行为：四类步各编出什么、`task_id` 能不能对账、清单与实现是不是同一句话。
 *
 * 形状的判据在 `model-parity.test.ts`（交给 bridge 自己的 pydantic 跑）；这里只钉行为。
 * 目录用**真的那一份**（`ROBOFRAME_SO101_CATALOG`）：技能名与参数名都是设备那边真收得到的名字，
 * 用假名字测「编得对不对」等于什么都没测——真实目录里有 `open_gripper` 这种**没有技能包装**的原语，
 * 那正是这个包要说清的那件事。
 */
import { describe, expect, it } from 'vitest';
import {
	SKILL_PLAN_SCHEMA_VERSION,
	SKILL_PLAN_STEP_KINDS,
	type SkillPlan,
	type SkillPlanStep,
} from '@codecanvas/contracts';
import { ROBOFRAME_SO101_CATALOG } from '@codecanvas/capabilities';
import {
	BRIDGE_PLAN_DIAGNOSTIC_CODES,
	BRIDGE_TASK_ID_MAX_LENGTH,
	compilePlanToCalls,
	DEFAULT_POLL_SPEC,
	executeRequestSchema,
	isTerminalTaskState,
	pollDeadlineMs,
	reportedSuccess,
	routingOf,
	stepCompleted,
	STEP_ROUTING,
	TASK_STATES,
	taskResultSchema,
	type CompiledPlan,
	type PlanCall,
	type TaskResult,
} from '../src/index';

const CATALOG = ROBOFRAME_SO101_CATALOG;
const DEVICE = 'so101_single_arm';

const planOf = (steps: readonly SkillPlanStep[]): SkillPlan => ({
	schemaVersion: SKILL_PLAN_SCHEMA_VERSION,
	robot: DEVICE,
	plan: steps,
});

const compile = (plan: SkillPlan, taskIdPrefix?: string): CompiledPlan =>
	compilePlanToCalls(plan, {
		catalog: CATALOG,
		deviceRef: DEVICE,
		...(taskIdPrefix === undefined ? {} : { taskIdPrefix }),
	});

/** 每一步「是什么 + 在哪一格」，用来断言顺序与路径（两份产物因此能逐条对账）。 */
const shapeOf = (plan: CompiledPlan): string[] => plan.calls.map((call) => `${call.kind}@${call.stepPath}`);

const callsAt = (plan: CompiledPlan, stepPath: string): readonly PlanCall[] =>
	plan.calls.filter((call) => call.stepPath === stepPath);

/** 一条轮询结果：只给关心的两栏，别的走 schema 自己的缺省（顺带把 schema 用起来）。 */
const resultOf = (input: { readonly state: string; readonly success?: boolean | null }): TaskResult =>
	taskResultSchema.parse({
		task_id: 'task-1',
		skill: 'wave_hello',
		state: input.state,
		...(input.success === undefined ? {} : { success: input.success }),
	});

describe('技能步 → bridge 的 execute 请求', () => {
	const plan = planOf([
		{ step: 'skill', skill: 'inspect_scene' },
		{
			step: 'skill',
			skill: 'move_relative_ee',
			params: { motion_direction: 'forward', motion_distance: 0.03 },
			timeoutSec: 10,
		},
	]);

	it('一条技能步编出一条 execute，参数与超时照计划', () => {
		const compiled = compile(plan);
		expect(compiled.diagnostics).toEqual([]);
		expect(shapeOf(compiled)).toEqual(['execute@0', 'execute@1']);

		const [first, second] = compiled.calls;
		if (first?.kind !== 'execute' || second?.kind !== 'execute') throw new Error('预期两条 execute');

		expect(first.request.skill).toBe('inspect_scene');
		// 没给参数就是空对象（bridge 的 `params` 缺省也是空 dict，两边同一种说法）
		expect(first.request.params).toEqual({});
		// 计划没写超时就不带这一栏：bridge 那边 `timeout_sec` 缺省是 None，由它自己定
		expect('timeout_sec' in first.request).toBe(false);

		expect(second.request.params).toEqual({ motion_direction: 'forward', motion_distance: 0.03 });
		expect(second.request.timeout_sec).toBe(10);
	});

	it('pollPath 指向这一条的 task_id，轮询规格是引擎那两个缺省值', () => {
		const compiled = compile(plan);
		for (const call of compiled.calls) {
			if (call.kind !== 'execute') throw new Error('预期 execute');
			expect(call.pollPath).toBe(`/v1/tasks/${call.request.task_id}`);
			// 这两个数是旧引擎（`nodes/shared/engine.ts`）的既有口径，不是这里拍的：
			// 500ms 一次、截止时间 = 超时 + 30 秒余量、没写超时按 30 秒算。
			expect(call.poll).toEqual({ intervalMs: 500, marginSec: 30, defaultTimeoutSec: 30 });
			expect(call.poll).toBe(DEFAULT_POLL_SPEC);
		}
	});

	it('参数是拷出来的：改计划不会改已经编好的请求', () => {
		const params = { motion_direction: 'forward', motion_distance: 0.03 };
		const mutable = planOf([{ step: 'skill', skill: 'move_relative_ee', params }]);
		const compiled = compile(mutable);
		const call = compiled.calls[0];
		if (call?.kind !== 'execute') throw new Error('预期 execute');
		expect(call.request.params).not.toBe(params);
		params.motion_distance = 9;
		expect(call.request.params).toEqual({ motion_direction: 'forward', motion_distance: 0.03 });
	});
});

describe('分支：两条臂都编出来', () => {
	const plan = planOf([
		{ step: 'skill', skill: 'inspect_scene' },
		{
			step: 'if',
			condition: { field: 'last.success', op: '==', value: false },
			then: [{ step: 'skill', skill: 'wave_hello' }],
			else: [{ step: 'skill', skill: 'nod_yes' }, { step: 'wait', seconds: 2 }],
		},
	]);

	it('分支自己出一条 branch，随后是 then 臂、再是 else 臂', () => {
		const compiled = compile(plan);
		expect(compiled.diagnostics).toEqual([]);
		expect(shapeOf(compiled)).toEqual(['execute@0', 'branch@1', 'execute@1.then.0', 'execute@1.else.0', 'wait@1.else.1']);
	});

	it('条件原样带过来（且是拷的）', () => {
		const compiled = compile(plan);
		const branch = compiled.calls.find((call) => call.kind === 'branch');
		if (branch?.kind !== 'branch') throw new Error('预期一条 branch');
		expect(branch.condition).toEqual({ field: 'last.success', op: '==', value: false });
		const original = plan.plan[1];
		if (original?.step !== 'if') throw new Error('预期 if');
		expect(branch.condition).not.toBe(original.condition);
	});

	it('没有 else 就不编那半边：条件不成立时这一步什么也不做', () => {
		const compiled = compile(
			planOf([
				{
					step: 'if',
					condition: { field: 'last.success', op: '!=', value: true },
					then: [{ step: 'skill', skill: 'celebrate' }],
				},
			]),
		);
		expect(shapeOf(compiled)).toEqual(['branch@0', 'execute@0.then.0']);
	});

	it('臂里还能再分支，路径接着往下长', () => {
		const compiled = compile(
			planOf([
				{
					step: 'if',
					condition: { field: 'last.success', op: '==', value: true },
					then: [
						{ step: 'wait', seconds: 1 },
						{
							step: 'if',
							condition: { field: 'last.success', op: '==', value: false },
							then: [{ step: 'skill', skill: 'recover_safe_pose' }],
							else: [{ step: 'skill', skill: 'recover_zero_pose' }],
						},
					],
				},
			]),
		);
		expect(shapeOf(compiled)).toEqual([
			'branch@0',
			'wait@0.then.0',
			'branch@0.then.1',
			'execute@0.then.1.then.0',
			'execute@0.then.1.else.0',
		]);
	});
});

describe('等待步：客户端等，bridge 不参与', () => {
	it('秒数原样，没有请求也没有轮询', () => {
		const compiled = compile(planOf([{ step: 'wait', seconds: 2.5 }]));
		expect(compiled.diagnostics).toEqual([]);
		expect(compiled.calls).toEqual([{ kind: 'wait', seconds: 2.5, stepPath: '0' }]);
	});
});

describe('原语步：送不了，如实报出来', () => {
	// `open_gripper` 是目录里**有原语、没技能包装**的那个（技能库里只有 `open_gripper_skill`），
	// 所以它是这一步最好的例子：它确实存在于这台设备上，只是 bridge 那条路接不了。
	const plan = planOf([
		{ step: 'primitive', primitive: 'open_gripper' },
		{ step: 'skill', skill: 'wave_hello' },
	]);

	it('不产出任何 call（一条也没有，不是「换一种发法」）', () => {
		const compiled = compile(plan);
		expect(callsAt(compiled, '0')).toEqual([]);
		// 同一条计划里送得出去的照编：诊断不作废整批（要不要因此拒绝整批由调用方定）
		expect(shapeOf(compiled)).toEqual(['execute@1']);
	});

	it('诊断说清「bridge 只接技能、发过去是 404」，并带上 stepPath', () => {
		const compiled = compile(plan);
		const diagnostic = compiled.diagnostics.find(
			(item) => item.code === BRIDGE_PLAN_DIAGNOSTIC_CODES.primitiveUnsupported,
		);
		expect(diagnostic).toBeDefined();
		expect(diagnostic?.severity).toBe('error');
		expect(diagnostic?.ref).toBe('open_gripper');
		expect(diagnostic?.path).toBe('0.primitive');
		expect(diagnostic?.details?.['stepPath']).toBe('0');
		expect(diagnostic?.message).toContain('bridge 只接技能');
		expect(diagnostic?.message).toContain('404');
		// 计划里的原语名**没有**出现在任何请求里（出现了就是把原语当技能发了）
		for (const call of compiled.calls) {
			if (call.kind === 'execute') expect(call.request.skill).not.toBe('open_gripper');
		}
	});
});

describe('目录里没有的技能：不发出去换 404', () => {
	it('不产出 call，诊断把目录里有什么一并给上', () => {
		const compiled = compile(planOf([{ step: 'skill', skill: 'not_a_skill' }]));
		expect(compiled.calls).toEqual([]);
		const diagnostic = compiled.diagnostics.find((item) => item.code === BRIDGE_PLAN_DIAGNOSTIC_CODES.skillUnknown);
		expect(diagnostic?.details?.['stepPath']).toBe('0');
		expect(diagnostic?.details?.['allowed']).toContain('wave_hello');
		expect(diagnostic?.message).toContain('404');
	});
});

describe('task_id：确定、可对账、装得进 bridge 的上限', () => {
	const plan = planOf([
		{ step: 'skill', skill: 'inspect_scene' },
		{
			step: 'if',
			condition: { field: 'last.success', op: '==', value: false },
			then: [{ step: 'skill', skill: 'wave_hello' }],
			else: [{ step: 'skill', skill: 'nod_yes' }],
		},
	]);

	const idsOf = (compiled: CompiledPlan): string[] =>
		compiled.calls.flatMap((call) => (call.kind === 'execute' ? [call.request.task_id] : []));

	it('同一份计划两次编译得到同一串 id', () => {
		expect(idsOf(compile(plan))).toEqual(idsOf(compile(plan)));
	});

	it('每一步各有各的 id（不是一条计划一个）', () => {
		const ids = idsOf(compile(plan));
		expect(ids).toHaveLength(3);
		expect(new Set(ids).size).toBe(3);
	});

	it('换前缀只换前缀，后面那段（摘要 + 路径）不变——所以测试能逐字对账', () => {
		const plain = idsOf(compile(plan));
		const prefixed = idsOf(compile(plan, 'run1'));
		expect(prefixed).toEqual(plain.map((id) => `run1-${id.slice('plan-'.length)}`));
	});

	it('参数键序不影响 id（摘要走稳定键序）', () => {
		const one = planOf([
			{ step: 'skill', skill: 'move_relative_ee', params: { motion_direction: 'forward', motion_distance: 0.03 } },
		]);
		const other = planOf([
			{ step: 'skill', skill: 'move_relative_ee', params: { motion_distance: 0.03, motion_direction: 'forward' } },
		]);
		expect(idsOf(compile(one))).toEqual(idsOf(compile(other)));
	});

	it('前缀不合词法（或空）时退回缺省前缀', () => {
		expect(idsOf(compile(plan, '!!'))[0]?.startsWith('plan-')).toBe(true);
		expect(idsOf(compile(plan, ''))[0]?.startsWith('plan-')).toBe(true);
	});

	it('嵌套再深、前缀再长也不超 128（上限那头截前缀，不截路径）', () => {
		let nested: SkillPlanStep = { step: 'skill', skill: 'wave_hello' };
		for (let depth = 0; depth < 8; depth += 1) {
			nested = {
				step: 'if',
				condition: { field: 'last.success', op: '==', value: true },
				then: [nested],
			};
		}
		const deep = compilePlanToCalls(planOf([nested]), {
			catalog: CATALOG,
			deviceRef: DEVICE,
			taskIdPrefix: 'x'.repeat(200),
		});
		const ids = idsOf(deep);
		expect(ids.length).toBeGreaterThan(0);
		for (const id of ids) {
			expect(id.length).toBeLessThanOrEqual(BRIDGE_TASK_ID_MAX_LENGTH);
			expect(id.length).toBeGreaterThanOrEqual(1);
			// 上限是 bridge 那边定的（`models.py`：Field(min_length=1, max_length=128)），
			// 所以拿镜像 schema 复核一遍：编出来的东西必须是对方收得下的
			expect(executeRequestSchema.safeParse({ task_id: id, skill: 'wave_hello', params: {} }).success).toBe(true);
		}
	});
});

describe('清单（limits.ts）与编译的实际行为一致', () => {
	/** 每条去向配一份最小计划：只有这一步，别的什么都不带。 */
	const sampleOf = (step: SkillPlanStep['step']): SkillPlanStep => {
		switch (step) {
			case 'skill':
				return { step: 'skill', skill: 'wave_hello' };
			case 'primitive':
				return { step: 'primitive', primitive: 'open_gripper' };
			case 'wait':
				return { step: 'wait', seconds: 1 };
			case 'if':
				return {
					step: 'if',
					condition: { field: 'last.success', op: '==', value: true },
					then: [{ step: 'skill', skill: 'wave_hello' }],
				};
		}
	};

	it('清单覆盖了契约里的四种步，一种不多一种不少', () => {
		expect(STEP_ROUTING.map((entry) => entry.step).sort()).toEqual([...SKILL_PLAN_STEP_KINDS].sort());
	});

	it('清单说 nowhere 的步型，编译出来一条 call 都没有（在那个 stepPath 上）', () => {
		const nowhere = STEP_ROUTING.filter((entry) => entry.where === 'nowhere');
		expect(nowhere.map((entry) => entry.step)).toEqual(['primitive']);
		for (const entry of nowhere) {
			const compiled = compile(planOf([sampleOf(entry.step)]));
			expect(callsAt(compiled, '0'), entry.step).toEqual([]);
			// 而且不是静默丢掉：得有诊断说到那一格上
			expect(
				compiled.diagnostics.some((item) => item.details?.['stepPath'] === '0' || item.path === '0.primitive'),
				entry.step,
			).toBe(true);
		}
	});

	it('清单说 client 的步型，编出来的是客户端自己做的那种 call（不是 execute）', () => {
		for (const entry of STEP_ROUTING.filter((item) => item.where === 'client')) {
			const compiled = compile(planOf([sampleOf(entry.step)]));
			const at = callsAt(compiled, '0');
			expect(at, entry.step).toHaveLength(1);
			expect(at[0]?.kind, entry.step).not.toBe('execute');
		}
	});

	it('清单说 bridge 的步型，编出来的正好是一条 execute', () => {
		for (const entry of STEP_ROUTING.filter((item) => item.where === 'bridge')) {
			const compiled = compile(planOf([sampleOf(entry.step)]));
			const at = callsAt(compiled, '0');
			expect(at, entry.step).toHaveLength(1);
			expect(at[0]?.kind, entry.step).toBe('execute');
		}
	});

	it('每条去向都写了为什么（note 不是空话）', () => {
		for (const entry of STEP_ROUTING) expect(entry.note.length, entry.step).toBeGreaterThan(10);
	});

	it('问一个清单里没有的步型：当场抛，不悄悄给个缺省', () => {
		expect(() => routingOf('loop' as SkillPlanStep['step'])).toThrow();
	});
});

describe('轮询结果怎么读（口径照旧引擎 engine.ts）', () => {
	it('终态集合与 bridge 的 app.py 一致', () => {
		for (const state of TASK_STATES) {
			expect(isTerminalTaskState(state), state).toBe(
				state === 'completed' || state === 'failed' || state === 'canceled' || state === 'unknown',
			);
		}
	});

	it('分支读的那个 success：bridge 报了就用它，没报就拿 completed 当结论', () => {
		expect(reportedSuccess(resultOf({ state: 'completed', success: true }))).toBe(true);
		expect(reportedSuccess(resultOf({ state: 'completed' }))).toBe(true);
		expect(reportedSuccess(resultOf({ state: 'failed', success: false }))).toBe(false);
		expect(reportedSuccess(resultOf({ state: 'failed' }))).toBe(false);
	});

	it('「这一步算不算走完」还要看 state：只有成功**且** completed 才算', () => {
		expect(stepCompleted(resultOf({ state: 'completed', success: true }))).toBe(true);
		expect(stepCompleted(resultOf({ state: 'completed' }))).toBe(true);
		// 设备说成了，但状态是被取消：没走完（把取消说成成功，计划会照着「上一步成了」往下走）
		expect(stepCompleted(resultOf({ state: 'canceled', success: true }))).toBe(false);
		expect(stepCompleted(resultOf({ state: 'unknown', success: true }))).toBe(false);
		// 状态说 completed，设备说没成：以设备的说法为准
		expect(stepCompleted(resultOf({ state: 'completed', success: false }))).toBe(false);
	});

	it('轮询截止时间 = (计划超时 ?? 30) + 30 秒', () => {
		expect(pollDeadlineMs(undefined)).toBe(60_000);
		expect(pollDeadlineMs(10)).toBe(40_000);
		expect(pollDeadlineMs(10, { intervalMs: 100, marginSec: 5, defaultTimeoutSec: 1 })).toBe(15_000);
	});
});
