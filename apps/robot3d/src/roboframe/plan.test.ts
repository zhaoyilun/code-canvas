import { describe, expect, it, vi } from 'vitest';
import { ROBOFRAME_GRASP_CATALOG, ROBOFRAME_SO101_CATALOG as catalog } from '@codecanvas/capabilities';
import {
	createStepGate,
	type CapabilitySpec,
	type Diagnostic,
	type JsonObject,
	type SkillPlan,
	type SkillPlanStep,
	type SkillStep,
} from '@codecanvas/contracts';
import {
	intake,
	makeTaskId,
	normalizeCommand,
	planStepLabel,
	runPlan,
	SAMPLE_PLAN_JSON,
	type PlanRunner,
	type PlanSleep,
	type PlanStepEvent,
	type PlanStepReport,
} from './plan';
import type { RunOutcome } from './executor';

const codes = (diagnostics: readonly Diagnostic[]): string[] => diagnostics.map((d) => d.code);

/**
 * 把计划步收窄成技能步。
 *
 * 计划步现在是一个联合（技能步 | 分支步），`skill` / `params` 只在技能步上有。
 * 这张测试里要读的每一步都是技能步（分支步另有专门的用例），所以收窄放在这一个地方，
 * 断言处照旧写 `step.skill`——而不是到处写 `as`（那会把"是不是技能步"这件事藏起来）。
 */
const asSkill = (step: SkillPlanStep | undefined): SkillStep => {
	if (step === undefined || step.step !== 'skill') {
		throw new Error(`这一步不是技能步：${JSON.stringify(step)}`);
	}
	return step;
};

function fakeRunner(failOn?: string) {
	/** 设备**真的收到**的那些调用：技能名与原语名混在一张表里（两者都是「叫了一个东西」）。 */
	const ran: string[] = [];
	const calls: { ref: string; params: Record<string, unknown> }[] = [];
	/**
	 * 取消的订阅者。真身（`RoboFrameExecutor`）也是这个口径：等待步靠订阅被打断，
	 * 所以这张假替身必须能通知——不然「取消能打断等待」那条测试测的就是一张不会取消的替身。
	 */
	const cancelListeners = new Set<() => void>();
	const outcome = (ref: string, params: Record<string, unknown>): RunOutcome => {
		ran.push(ref);
		calls.push({ ref, params });
		if (ref === failOn) return { ok: false, steps: [], reason: '设备说这一步没做成' };
		return { ok: true, steps: [] };
	};
	const runner: PlanRunner = {
		// 只是清取消标记——连续执行时不该动机械臂，这里记一笔好断言
		beginRun: () => {},
		cancel: () => {
			for (const listener of cancelListeners) listener();
		},
		onCancel: (listener) => {
			cancelListeners.add(listener);
			return () => {
				cancelListeners.delete(listener);
			};
		},
		run: async (capability: CapabilitySpec, params: Record<string, unknown>): Promise<RunOutcome> =>
			outcome(capability.capabilityRef, params),
		runPrimitiveCommand: async (primitiveRef: string, params: Record<string, unknown>): Promise<RunOutcome> =>
			outcome(primitiveRef, params),
	};
	return { runner, ran, calls, cancel: () => runner.cancel() };
}

describe('intake', () => {
	it('吃下示例计划：机器人名与目录对得上，三步都在目录里', () => {
		const result = intake(SAMPLE_PLAN_JSON, catalog);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.plan.robot).toBe('so101_single_arm');
		expect(result.plan.plan.map((s) => asSkill(s).skill)).toEqual(['inspect_scene', 'move_relative_ee', 'wave_hello']);
		expect(asSkill(result.plan.plan[1]).params).toEqual({ motion_direction: 'forward', motion_distance: 0.03 });
	});

	it('机器人名对不上就报出来（判据是目录自己的名字）', () => {
		const result = intake(JSON.stringify({ schemaVersion: 1, robot: 'some_other_arm', plan: [{ step: 'skill', skill: 'inspect_scene' }] }), catalog);
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(codes(result.diagnostics)).toContain('plan.robot.mismatch');
	});

	it('技能不在目录里：诊断里带上目录名与可选技能', () => {
		const result = intake(JSON.stringify({ schemaVersion: 1, robot: 'so101_single_arm', plan: [{ step: 'skill', skill: 'make_coffee' }] }), catalog);
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(codes(result.diagnostics)).toContain('plan.step.skill.unknown');
		expect(JSON.stringify(result.diagnostics)).toContain('so101');
	});

	it('声明了必填参数却没给：契约当场拒（判据是上游的 required）', () => {
		const result = intake(JSON.stringify({ schemaVersion: 1, robot: 'so101_single_arm', plan: [{ step: 'skill', skill: 'move_relative_ee' }] }), catalog);
		/*
		 * 口径在 `packages/contracts` 的校验器里：上游技能的 JSON Schema 标了 `required`，
		 * 所以缺必填参数是 error，不再是「执行侧看着办」的提醒——目录既然说了必填，
		 * 校验器放行就等于让执行侧去兑现一件没人承诺过的事。
		 * （这条断言随上游 required 一起改；工作期间 `9bf0e8f` 落了这份口径。）
		 */
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(codes(result.diagnostics)).toContain('plan.step.param.required');
		// 执行侧那边同样拒绝执行缺参数的技能——那条在 executor.test.ts 里钉着
	});

	it('不是 JSON 文本：一条人能看懂的诊断，不抛异常', () => {
		const result = intake('这不是 JSON', catalog);
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(codes(result.diagnostics)).toContain('plan.json.invalid');
	});

	it('认 bridge 的单条指令形状：{skill, params} 包成一步计划', () => {
		const result = intake(
			JSON.stringify({ task_id: 'abc-123', skill: 'move_relative_ee', params: { motion_direction: 'up', motion_distance: 0.02 } }),
			catalog,
		);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.plan.plan).toHaveLength(1);
		expect(result.plan.description).toContain('abc-123');
		expect(asSkill(result.plan.plan[0]).params).toEqual({ motion_direction: 'up', motion_distance: 0.02 });
	});

	it('已经是计划就不改写', () => {
		const plan = { schemaVersion: 1, robot: 'so101_single_arm', plan: [{ step: 'skill', skill: 'open_gripper_skill' }] };
		expect(normalizeCommand(plan, catalog)).toBe(plan);
	});
});

describe('runPlan', () => {
	const plan = (skills: string[], params: JsonObject = {}): SkillPlan => ({
		schemaVersion: 1,
		robot: 'so101_single_arm',
		plan: skills.map((skill) => ({ step: 'skill' as const, skill, params })),
	});

	it('开始跑计划只清取消标记，不复位机械臂（上一条指令停哪就从哪走）', async () => {
		const events: string[] = [];
		const runner: PlanRunner = {
			beginRun: () => events.push('beginRun'),
			cancel: () => {},
			onCancel: () => () => {},
			run: async () => ({ ok: true, steps: [] }),
			runPrimitiveCommand: async () => ({ ok: true, steps: [] }),
		};
		await runPlan({ schemaVersion: 1, robot: 'so101_single_arm', plan: [{ step: 'skill', skill: 'inspect_scene' }] }, { catalog, runner });
		expect(events).toEqual(['beginRun']);
	});

	it('按顺序逐步执行，事件里有计划进度与 task_id', async () => {
		const { runner, ran } = fakeRunner();
		const headers: string[] = [];
		const outcome = await runPlan(plan(['inspect_scene', 'open_gripper_skill']), {
			catalog,
			runner,
			onPlanStep: (e) => headers.push(`${String(e.index)}/${String(e.total)} ${asSkill(e.step).skill} ${e.state}`),
		});
		expect(outcome.ok).toBe(true);
		expect(outcome.completed).toBe(2);
		expect(ran).toEqual(['inspect_scene', 'open_gripper_skill']);
		expect(headers).toEqual([
			'1/2 inspect_scene running',
			'1/2 inspect_scene done',
			'2/2 open_gripper_skill running',
			'2/2 open_gripper_skill done',
		]);
	});

	it('参数原样交给执行器（不在这一层翻译）', async () => {
		const { runner, calls } = fakeRunner();
		await runPlan(plan(['move_relative_ee'], { motion_direction: 'left', motion_distance: 0.05 }), { catalog, runner });
		expect(calls[0]?.params).toEqual({ motion_direction: 'left', motion_distance: 0.05 });
	});

	it('某一步失败就停在那里：不自动重试后面的', async () => {
		const { runner, ran } = fakeRunner('open_gripper_skill');
		const outcome = await runPlan(plan(['inspect_scene', 'open_gripper_skill', 'wave_hello']), { catalog, runner });
		expect(outcome.ok).toBe(false);
		expect(outcome.completed).toBe(1);
		expect(outcome.reason).toContain('设备说这一步没做成');
		expect(ran).toEqual(['inspect_scene', 'open_gripper_skill']);
	});

	/*
	 * 分支：条件只认 `last.success`（最近一次**真正执行过的技能步**成没成），
	 * 计划第一步之前没有上一步——那时算 `true`。下面这几条把那件事逐条钉住。
	 */

	/** 一条技能步。 */
	const call = (skill: string): SkillPlanStep => ({ step: 'skill', skill });

	/** 一棵分支：条件照契约的口径写（field 只有 last.success，op 只有 == / !=，value 只有布尔）。 */
	const branch = (
		value: boolean,
		then: readonly SkillPlanStep[],
		other?: readonly SkillPlanStep[],
		op: '==' | '!=' = '==',
	): SkillPlanStep => ({
		step: 'if',
		condition: { field: 'last.success', op, value },
		then,
		...(other === undefined ? {} : { else: other }),
	});

	/**
	 * 计划步事件压成一行：`所属顶层步@路径 臂 状态 步型`。
	 * 这四件事是分支功能的全部对外口径（顶层步号、树里的哪一格、走了哪条臂、这一步是什么），
	 * 压在一行里断言，比拆成四个数组更容易看出「哪一条事件说的是哪一步」。
	 */
	const traceOf = (e: Extract<PlanStepEvent, { kind: 'plan-step' }>): string =>
		`${String(e.index)}@${e.path} ${e.arm ?? '-'} ${e.state} ${e.step.step}`;

	const branchPlan = (steps: readonly SkillPlanStep[]): SkillPlan => ({
		schemaVersion: 1,
		robot: 'so101_single_arm',
		plan: steps,
	});

	it('走到 if 且条件成立：跑 then 臂，else 臂一步没跑', async () => {
		const { runner, ran } = fakeRunner();
		const trace: string[] = [];
		const plan = branchPlan([
			call('inspect_scene'),
			branch(true, [call('wave_hello')], [call('recover_safe_pose')]),
		]);

		const outcome = await runPlan(plan, { catalog, runner, onPlanStep: (e) => trace.push(traceOf(e)) });

		expect(outcome.ok).toBe(true);
		expect(outcome.completed).toBe(2);
		// `ran` 是设备那边真收到的技能调用：走了 then，else 一步没动
		expect(ran).toEqual(['inspect_scene', 'wave_hello']);
		expect(trace).toEqual([
			'1@0 - running skill',
			'1@0 - done skill',
			// 条件在这一步开头就判定了，所以 running 时就写着走哪条臂
			'2@1 then running if',
			// 臂里的步：顶层步号仍是 2（「第 2 步」这条主语成立），路径说清是 then 里的第 0 格
			'2@1.then.0 - running skill',
			'2@1.then.0 - done skill',
			'2@1 then done if',
		]);
	});

	it('条件不成立且有 else：跑 else 臂，then 臂一步没跑', async () => {
		const { runner, ran } = fakeRunner();
		const trace: string[] = [];
		const plan = branchPlan([
			call('inspect_scene'),
			branch(false, [call('wave_hello')], [call('recover_safe_pose')]),
		]);

		const outcome = await runPlan(plan, { catalog, runner, onPlanStep: (e) => trace.push(traceOf(e)) });

		expect(outcome.ok).toBe(true);
		expect(outcome.completed).toBe(2);
		expect(ran).toEqual(['inspect_scene', 'recover_safe_pose']);
		expect(trace.filter((line) => line.includes(' if'))).toEqual([
			'2@1 else running if',
			'2@1 else done if',
		]);
		expect(trace.some((line) => line.includes('1.then'))).toBe(false);

		// `!=` 是同一个条件的反面：上一步成功、条件是「不等于 false」→ 成立，走 then
		const negated = fakeRunner();
		const other = await runPlan(
			branchPlan([call('inspect_scene'), branch(false, [call('wave_hello')], undefined, '!=')]),
			{ catalog, runner: negated.runner },
		);
		expect(other.ok).toBe(true);
		expect(negated.ran).toEqual(['inspect_scene', 'wave_hello']);
	});

	it('条件不成立又没有 else：什么都不跑，这一步照样报 done（arm 为 null）', async () => {
		const { runner, ran } = fakeRunner();
		const trace: string[] = [];
		const plan = branchPlan([call('inspect_scene'), branch(false, [call('wave_hello')])]);

		const outcome = await runPlan(plan, { catalog, runner, onPlanStep: (e) => trace.push(traceOf(e)) });

		// 计划是走完了的：这一步什么都没做，但它确实走完了（`arm: null` 说的就是这件事）
		expect(outcome.ok).toBe(true);
		expect(outcome.completed).toBe(2);
		expect(ran).toEqual(['inspect_scene']);
		expect(trace).toEqual([
			'1@0 - running skill',
			'1@0 - done skill',
			'2@1 - running if',
			'2@1 - done if',
		]);
	});

	it('嵌套：臂里的 if 照常执行，走到第二层', async () => {
		const { runner, ran } = fakeRunner();
		const trace: string[] = [];
		// 第一个顶层步就是分支：那时还没有上一步，`last.success` 的初值 true 让它走 then
		const plan = branchPlan([
			branch(true, [call('wave_hello'), branch(true, [call('open_gripper_skill')])]),
		]);

		const outcome = await runPlan(plan, { catalog, runner, onPlanStep: (e) => trace.push(traceOf(e)) });

		expect(outcome.ok).toBe(true);
		expect(outcome.completed).toBe(1); // 顶层就一步，臂里那几步算进它
		expect(ran).toEqual(['wave_hello', 'open_gripper_skill']);
		// 第二层真的走下去了：`0.then.1` 是 then 臂里的那个 if，`0.then.1.then.0` 是它臂里的技能
		expect(trace).toEqual([
			'1@0 then running if',
			'1@0.then.0 - running skill',
			'1@0.then.0 - done skill',
			'1@0.then.1 then running if',
			'1@0.then.1.then.0 - running skill',
			'1@0.then.1.then.0 - done skill',
			'1@0.then.1 then done if',
			'1@0 then done if',
		]);
	});

	it('臂里某一步失败：整条计划失败，completed 只数真正走完的顶层步，reason 点名是哪一步', async () => {
		const { runner, ran } = fakeRunner('wave_hello');
		const trace: string[] = [];
		const plan = branchPlan([
			call('inspect_scene'),
			branch(true, [call('wave_hello'), call('open_gripper_skill')]),
		]);

		const outcome = await runPlan(plan, { catalog, runner, onPlanStep: (e) => trace.push(traceOf(e)) });

		expect(outcome.ok).toBe(false);
		// 顶层第一步走完了，第二步（分支）没走完——臂里的步不单独计数
		expect(outcome.completed).toBe(1);
		expect(outcome.total).toBe(2);
		// reason 要点名是哪一步：臂里的步不属于任何单独的「第 N 步」，靠路径 + 技能名说清
		expect(outcome.reason).toContain('1.then.0');
		expect(outcome.reason).toContain('wave_hello');
		expect(outcome.reason).toContain('设备说这一步没做成');
		// 失败即停：臂里后面的那一步一步没动
		expect(ran).toEqual(['inspect_scene', 'wave_hello']);
		expect(trace.at(-1)).toBe('2@1 then failed if');
	});

	it('last.success 的初值是 true：计划第一步之前没有任何上一步', async () => {
		// 第一步就是分支、条件写「上一步成功」→ 成立（初值 true，不是什么都没发生过就判失败）
		const hit = fakeRunner();
		const then = await runPlan(branchPlan([branch(true, [call('wave_hello')])]), { catalog, runner: hit.runner });
		expect(then.ok).toBe(true);
		expect(hit.ran).toEqual(['wave_hello']);

		// 反过来说：条件是「上一步没成功」时它**不**成立——初值不是 false
		const miss = fakeRunner();
		const none = await runPlan(branchPlan([branch(false, [call('wave_hello')])]), { catalog, runner: miss.runner });
		expect(none.ok).toBe(true);
		expect(miss.ran).toEqual([]);
	});

	it('task_id 形状符合 bridge 的口径（1~128 字符）', () => {		const id = makeTaskId(3);
		expect(id.length).toBeGreaterThan(0);
		expect(id.length).toBeLessThanOrEqual(128);
		expect(id.startsWith('plan-3-')).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// 等待步（`wait`）：真的等、能被打断、不改「上一步成没成」
// ---------------------------------------------------------------------------

describe('runPlan · 等待步', () => {
	/** 一条等待步。 */
	const wait = (seconds: number): SkillPlanStep => ({ step: 'wait', seconds });

	/** 一条技能步（与上面那一组同一个写法：这两个辅助在各组里各来一份，省得跨组共享夹具）。 */
	const call = (skill: string): SkillPlanStep => ({ step: 'skill', skill });

	/** 一棵分支：条件照契约的口径写。 */
	const branch = (
		value: boolean,
		then: readonly SkillPlanStep[],
		other?: readonly SkillPlanStep[],
	): SkillPlanStep => ({
		step: 'if',
		condition: { field: 'last.success', op: '==', value },
		then,
		...(other === undefined ? {} : { else: other }),
	});

	const branchPlan = (steps: readonly SkillPlanStep[]): SkillPlan => ({
		schemaVersion: 1,
		robot: 'so101_single_arm',
		plan: steps,
	});

	/** 不等的那条 sleep：与「等多久」无关的用例用它，别让单测真的等两秒。 */
	const instantSleep: PlanSleep = async () => {};

	const traceOfEvent = (e: Extract<PlanStepEvent, { kind: 'plan-step' }>): string =>
		`${String(e.index)}@${e.path} ${e.arm ?? '-'} ${e.state} ${e.step.step}`;

	it('真的等了：差一毫秒都还没往下走（假时钟，不真等）', async () => {
		vi.useFakeTimers();
		try {
			const { runner, ran } = fakeRunner();
			const trace: string[] = [];
			const promise = runPlan(
				{ schemaVersion: 1, robot: 'so101_single_arm', plan: [call('inspect_scene'), wait(2), call('wave_hello')] },
				{ catalog, runner, onPlanStep: (e) => trace.push(traceOfEvent(e)) },
			);

			// 走到等待步了：等这一步的 `running` 报出来（技能步已经做完）
			await vi.advanceTimersByTimeAsync(0);
			expect(trace).toEqual(['1@0 - running skill', '1@0 - done skill', '2@1 - running wait']);
			expect(ran).toEqual(['inspect_scene']);

			// 差 1 毫秒：这一步还没有结论，后面那一步也没开始
			await vi.advanceTimersByTimeAsync(1999);
			expect(trace.at(-1)).toBe('2@1 - running wait');
			expect(ran).toEqual(['inspect_scene']);

			// 等够了才结束，然后才轮到下一步
			await vi.advanceTimersByTimeAsync(1);
			const outcome = await promise;
			expect(outcome.ok).toBe(true);
			expect(outcome.completed).toBe(3);
			expect(ran).toEqual(['inspect_scene', 'wave_hello']);
			expect(trace).toEqual([
				'1@0 - running skill',
				'1@0 - done skill',
				'2@1 - running wait',
				'2@1 - done wait',
				'3@2 - running skill',
				'3@2 - done skill',
			]);
		} finally {
			vi.useRealTimers();
		}
	});

	it('取消能**真打断**等待：cancel() 之后当场结束，不等到点', async () => {
		vi.useFakeTimers();
		try {
			const { runner, ran, cancel } = fakeRunner();
			const trace: string[] = [];
			// 600 秒：要是没被打断，下面那个 await 会一直挂到测试超时（那就是红）
			const promise = runPlan(
				{ schemaVersion: 1, robot: 'so101_single_arm', plan: [call('inspect_scene'), wait(600), call('wave_hello')] },
				{ catalog, runner, onPlanStep: (e) => trace.push(traceOfEvent(e)) },
			);

			await vi.advanceTimersByTimeAsync(0);
			expect(trace.at(-1)).toBe('2@1 - running wait');

			cancel();
			// 一点都不推进时钟：等待是被信号打断的，不是等完再检查
			const outcome = await promise;
			expect(outcome.ok).toBe(false);
			// 只有第一步走完了；被取消的那一步没走完，后面的也没跑
			expect(outcome.completed).toBe(1);
			expect(outcome.reason).toContain('已取消');
			expect(trace.at(-1)).toBe('2@1 - failed wait');
			expect(ran).toEqual(['inspect_scene']);
		} finally {
			vi.useRealTimers();
		}
	});

	it('等待步不改 last.success：后面的 if 看的是它**前面**那个技能步的结果', async () => {
		const { runner, ran } = fakeRunner();
		const trace: string[] = [];
		// 「看一眼（成了）→ 停一下 → 上一步成没成？」：若等待步把 last.success 改掉，条件就会翻面
		const outcome = await runPlan(
			{
				schemaVersion: 1,
				robot: 'so101_single_arm',
				plan: [call('inspect_scene'), wait(1), branch(true, [call('wave_hello')], [call('recover_safe_pose')])],
			},
			{ catalog, runner, sleep: instantSleep, onPlanStep: (e) => trace.push(traceOfEvent(e)) },
		);

		expect(outcome.ok).toBe(true);
		expect(ran).toEqual(['inspect_scene', 'wave_hello']);
		expect(trace).toEqual([
			'1@0 - running skill',
			'1@0 - done skill',
			'2@1 - running wait',
			'2@1 - done wait',
			// 条件照第一步的「成了」判：走 then
			'3@2 then running if',
			'3@2.then.0 - running skill',
			'3@2.then.0 - done skill',
			'3@2 then done if',
		]);
	});

	it('臂里的等待步：照报一步、路径说清它在哪一格、臂照样往下走', async () => {
		const { runner, ran } = fakeRunner();
		const trace: string[] = [];
		const outcome = await runPlan(branchPlan([branch(true, [wait(1), call('wave_hello')])]), {
			catalog,
			runner,
			sleep: instantSleep,
			onPlanStep: (e) => trace.push(traceOfEvent(e)),
		});

		expect(outcome.ok).toBe(true);
		expect(ran).toEqual(['wave_hello']);
		expect(trace).toEqual([
			'1@0 then running if',
			'1@0.then.0 - running wait',
			'1@0.then.0 - done wait',
			'1@0.then.1 - running skill',
			'1@0.then.1 - done skill',
			'1@0 then done if',
		]);
	});

	it('面板上那行写的是「等待 N 秒」，不是技能名（一行字一个说法）', () => {
		expect(planStepLabel({ step: 'wait', seconds: 2 })).toBe('等待 2 秒');
		expect(planStepLabel({ step: 'skill', skill: 'wave_hello' })).toBe('wave_hello');
		expect(planStepLabel({ step: 'if', condition: { field: 'last.success', op: '==', value: true }, then: [] })).toBe('分支');
	});
});

// ---------------------------------------------------------------------------
// 失败处置（`onFailure`）：`continue` 让「上一步没成」那条臂真的可达
// ---------------------------------------------------------------------------

/**
 * 这一组钉住的是**语义**，不是视图：在这一版之前，任何技能步失败都会结束整条计划，
 * 所以 `if (last.success == false)` 在求值时 `last.success` 恒为 `true`——那一半分支是死的。
 * `onFailure: 'continue'` 之后：计划接着走、`last.success` 记 `false`、那一步照报 `failed`
 * 且不算进 `completed`；缺省（与显式 `'stop'`）一个字不变，还是失败即停。
 */
describe('runPlan · 失败处置', () => {
	/** 一条技能步；`onFailure` 只在这一栏有值时才写（缺省不补键，与计划层同一个口径）。 */
	const call = (skill: string, onFailure?: 'stop' | 'continue'): SkillPlanStep => ({
		step: 'skill',
		skill,
		...(onFailure === undefined ? {} : { onFailure }),
	});

	const wait = (seconds: number): SkillPlanStep => ({ step: 'wait', seconds });

	/** 一棵分支：条件照契约的口径写（只有 `last.success`，只有 `==`）。 */
	const branch = (value: boolean, then: readonly SkillPlanStep[], other?: readonly SkillPlanStep[]): SkillPlanStep => ({
		step: 'if',
		condition: { field: 'last.success', op: '==', value },
		then,
		...(other === undefined ? {} : { else: other }),
	});

	const planOf = (steps: readonly SkillPlanStep[]): SkillPlan => ({
		schemaVersion: 1,
		robot: 'so101_single_arm',
		plan: steps,
	});

	/** 计划步事件压成一行：`所属顶层步@路径 臂 状态 步型`（与上面那张表同一个写法）。 */
	const traceOf = (e: Extract<PlanStepEvent, { kind: 'plan-step' }>): string =>
		`${String(e.index)}@${e.path} ${e.arm ?? '-'} ${e.state} ${e.step.step}`;

	/** 不等的那条 sleep：这一组不测「等多久」，别让单测真的等一秒。 */
	const instantSleep: PlanSleep = async () => {};

	it('① continue 失败之后计划继续跑完后面的步：每一步的状态都在这儿', async () => {
		const { runner, ran } = fakeRunner('move_relative_ee');
		const trace: string[] = [];
		const outcome = await runPlan(
			planOf([call('inspect_scene'), call('move_relative_ee', 'continue'), call('wave_hello')]),
			{ catalog, runner, onPlanStep: (e) => trace.push(traceOf(e)) },
		);

		// 三步全跑了：失败那一步没有把计划拦下来
		expect(ran).toEqual(['inspect_scene', 'move_relative_ee', 'wave_hello']);
		expect(outcome.ok).toBe(true);
		expect(outcome.total).toBe(3);
		// 那一步照报 `failed`（不粉饰成 done），后面那一步照报 done
		expect(trace).toEqual([
			'1@0 - running skill',
			'1@0 - done skill',
			'2@1 - running skill',
			'2@1 - failed skill',
			'3@2 - running skill',
			'3@2 - done skill',
		]);
	});

	it('② 失败之后 if (last.success == false) 真的走 then：false 那条臂这一次可达', async () => {
		const { runner, ran } = fakeRunner('move_relative_ee');
		const trace: string[] = [];
		// 挪一点（会失败，但失败也往下走）→ 上一步没成？→ 是：回原位；否：庆祝
		const outcome = await runPlan(
			planOf([
				call('move_relative_ee', 'continue'),
				branch(false, [call('recover_safe_pose')], [call('celebrate')]),
			]),
			{ catalog, runner, onPlanStep: (e) => trace.push(traceOf(e)) },
		);

		expect(outcome.ok).toBe(true);
		// 走了 then：设备真的收到了「回原位」，而 else 那一臂一步没动
		expect(ran).toEqual(['move_relative_ee', 'recover_safe_pose']);
		expect(trace.filter((line) => line.includes(' if'))).toEqual(['2@1 then running if', '2@1 then done if']);
		expect(trace.some((line) => line.includes('1.else'))).toBe(false);
	});

	it('③ 去掉 onFailure（或写显式 stop）：计划在那一步就停，后面的步一步没跑', async () => {
		// 同一份计划，只把那一步的失败处置拿掉——行为必须与改动前一个字不差
		for (const steps of [
			[call('move_relative_ee'), branch(false, [call('recover_safe_pose')], [call('celebrate')])],
			[call('move_relative_ee', 'stop'), branch(false, [call('recover_safe_pose')], [call('celebrate')])],
		]) {
			const { runner, ran } = fakeRunner('move_relative_ee');
			const trace: string[] = [];
			const outcome = await runPlan(planOf(steps), { catalog, runner, onPlanStep: (e) => trace.push(traceOf(e)) });

			expect(outcome.ok).toBe(false);
			expect(outcome.completed).toBe(0);
			expect(outcome.reason).toContain('设备说这一步没做成');
			// 失败那一步之后一步都没跑：连那个 if 都没求值
			expect(ran).toEqual(['move_relative_ee']);
			expect(trace).toEqual(['1@0 - running skill', '1@0 - failed skill']);
			expect(trace.some((line) => line.includes('if'))).toBe(false);
		}
	});

	it('④ completed 的口径：被容忍的那一步不算完成（走完了也不记它）', async () => {
		const { runner } = fakeRunner('move_relative_ee');
		// 三步：成功的一步、被容忍失败的一步、成功的一步 → 只记两分
		const outcome = await runPlan(
			planOf([call('inspect_scene'), call('move_relative_ee', 'continue'), call('wave_hello')]),
			{ catalog, runner },
		);
		expect(outcome.completed).toBe(2);
		expect(outcome.total).toBe(3);

		// 整条计划只有那一步：一步都没完成（`ok` 仍是 true——计划走完了，只是那一步没成）
		const only = await runPlan(planOf([call('move_relative_ee', 'continue')]), { catalog, runner: fakeRunner('move_relative_ee').runner });
		expect(only.ok).toBe(true);
		expect(only.completed).toBe(0);
		expect(only.total).toBe(1);

		// 反证：同样三步、同样的失败，但不带这一栏 → 停在那儿，completed 只数前面那一步
		const stopped = await runPlan(
			planOf([call('inspect_scene'), call('move_relative_ee'), call('wave_hello')]),
			{ catalog, runner: fakeRunner('move_relative_ee').runner },
		);
		expect(stopped.ok).toBe(false);
		expect(stopped.completed).toBe(1);
	});

	it('⑤ wait 与 if 都不改 last.success：失败那一步记下的 false 一路传到后面的分叉', async () => {
		const { runner, ran } = fakeRunner('move_relative_ee');
		/*
		 * 没成（但往下走）→ 停一下 → 上一步没成？→ 再问一次同样的问题。
		 * 两次分叉的臂里都**不放技能步**（只放等待）：技能步会照自己的结局改写 `last.success`
		 * （那是对的，见下面那一条），这一条要单独量的是「`wait` 与 `if` 不改它」。
		 * 若 `wait` 或第一个 `if` 把它改成 true，两次分叉都会翻到 else 那一臂。
		 */
		const outcome = await runPlan(
			planOf([
				call('move_relative_ee', 'continue'),
				wait(1),
				branch(false, [wait(2)], [call('celebrate')]),
				branch(false, [call('nod_yes')], [call('shake_no')]),
			]),
			{ catalog, runner, sleep: instantSleep },
		);

		expect(outcome.ok).toBe(true);
		expect(ran).toEqual(['move_relative_ee', 'nod_yes']);
		// 那一步等待与两个 if 都走完了（3 分）；被容忍失败的那一步不算完成
		expect(outcome.completed).toBe(3);
		expect(outcome.total).toBe(4);

		// 反过来说：成功的技能步照记 true —— 条件翻到 else 那一臂
		const other = fakeRunner();
		const flipped = await runPlan(
			planOf([call('inspect_scene'), wait(1), branch(false, [call('recover_safe_pose')], [call('celebrate')])]),
			{ catalog, runner: other.runner, sleep: instantSleep },
		);
		expect(flipped.ok).toBe(true);
		expect(other.ran).toEqual(['inspect_scene', 'celebrate']);
	});

	it('臂里的技能步照旧改写 last.success（「最近一次真正执行过的技能步」不分在不在臂里）', async () => {
		const { runner, ran } = fakeRunner('move_relative_ee');
		// 第 1 步没成（往下走）→ 走 then（上一步没成）→ 那一步**成了** → 再问同一个问题时答案翻了
		const outcome = await runPlan(
			planOf([
				call('move_relative_ee', 'continue'),
				branch(false, [call('recover_safe_pose')], [call('celebrate')]),
				branch(false, [call('nod_yes')], [call('shake_no')]),
			]),
			{ catalog, runner },
		);

		expect(outcome.ok).toBe(true);
		// 第一次走 then（回原位成了），第二次因此走 else（摇头）——臂里的技能步不是「不算数的一步」
		expect(ran).toEqual(['move_relative_ee', 'recover_safe_pose', 'shake_no']);
		expect(outcome.completed).toBe(2);
	});

	it('臂里的失败也能被容忍：外层分支照走完，那一步自己报 failed', async () => {
		const { runner, ran } = fakeRunner('wave_hello');
		const trace: string[] = [];
		const outcome = await runPlan(
			planOf([branch(true, [call('wave_hello', 'continue'), call('open_gripper_skill')], [call('shake_no')])]),
			{ catalog, runner, onPlanStep: (e) => trace.push(traceOf(e)) },
		);

		expect(outcome.ok).toBe(true);
		expect(ran).toEqual(['wave_hello', 'open_gripper_skill']);
		// 顶层就一步（那个分支）：它走完了，所以算完成——失败的是臂里那一步，由它自己的事件说
		expect(outcome.completed).toBe(1);
		expect(trace).toEqual([
			'1@0 then running if',
			'1@0.then.0 - running skill',
			'1@0.then.0 - failed skill',
			'1@0.then.1 - running skill',
			'1@0.then.1 - done skill',
			'1@0 then done if',
		]);
	});
});

// ---------------------------------------------------------------------------
// 单步（`stepGate`）：走完一步就停住，放行一次才走下一步
// ---------------------------------------------------------------------------

/**
 * 这一组钉住「单步」这件事的**全部判据**：
 * ① 走完一个顶层步就真的停住——下一步不下发（设备那边一次调用都没多收）、事件也不再往下走；
 * ② 放行一次走一步，跑到尾就结束（`ok` / `completed` 与整趟跑同一套账）；
 * ③ **一步 = 顶层的一格**：臂里的步不各停一次（一个分支步连同它的臂一次走完）；
 * ④ 停着的时候取消要能把它叫醒——闸收信号。
 *
 * 闸本身（预放行、waiting 通知、abort）的用例在 `packages/contracts/test/step-gate.test.ts`；
 * 这里钉的是**计划层怎么用它**。
 */
describe('runPlan · 单步', () => {
	/** 一条技能步。 */
	const call = (skill: string): SkillPlanStep => ({ step: 'skill', skill });

	/** 一棵分支：条件照契约的口径写。 */
	const branch = (value: boolean, then: readonly SkillPlanStep[], other?: readonly SkillPlanStep[]): SkillPlanStep => ({
		step: 'if',
		condition: { field: 'last.success', op: '==', value },
		then,
		...(other === undefined ? {} : { else: other }),
	});

	const planOf = (steps: readonly SkillPlanStep[]): SkillPlan => ({ schemaVersion: 1, robot: 'so101_single_arm', plan: steps });

	/** 计划步事件压成一行：`所属顶层步@路径 臂 状态 步型`（与上面几张表同一个写法）。 */
	const traceOf = (e: Extract<PlanStepEvent, { kind: 'plan-step' }>): string =>
		`${String(e.index)}@${e.path} ${e.arm ?? '-'} ${e.state} ${e.step.step}`;

	/** 让微任务跑完：这一组测的是「谁先谁后」，一毫秒都不等。 */
	const flush = async (): Promise<void> => {
		for (let i = 0; i < 30; i += 1) await Promise.resolve();
	};

	it('走完第一步就停住：第二步一次都没下发，闸上真的停着', async () => {
		const { runner, ran } = fakeRunner();
		const trace: string[] = [];
		const gate = createStepGate();
		let settled = false;
		const running = runPlan(planOf([call('inspect_scene'), call('wave_hello'), call('nod_yes')]), {
			catalog,
			runner,
			stepGate: gate,
			onPlanStep: (e) => trace.push(traceOf(e)),
		}).then((outcome) => {
			settled = true;
			return outcome;
		});

		await flush();
		// 设备只收到第一步；屏幕上那一行是 `done`（不是 `running`——它确实走完了才停的）
		expect(ran).toEqual(['inspect_scene']);
		expect(trace).toEqual(['1@0 - running skill', '1@0 - done skill']);
		expect(gate.waiting).toBe(true);
		// 停住＝这一趟还没结束：再等多久都不会自己往下走
		expect(settled).toBe(false);
		await flush();
		expect(ran).toEqual(['inspect_scene']);

		// 放行一次 → 走第二步，然后**又停住**
		gate.release();
		await flush();
		expect(ran).toEqual(['inspect_scene', 'wave_hello']);
		expect(trace).toEqual([
			'1@0 - running skill',
			'1@0 - done skill',
			'2@1 - running skill',
			'2@1 - done skill',
		]);
		expect(gate.waiting).toBe(true);
		expect(settled).toBe(false);

		// 最后一步放行之后就收摊：账与整趟跑同一套（3 步都走通）
		gate.release();
		const outcome = await running;
		expect(outcome.ok).toBe(true);
		expect(outcome.completed).toBe(3);
		expect(outcome.total).toBe(3);
		expect(ran).toEqual(['inspect_scene', 'wave_hello', 'nod_yes']);
		expect(gate.waiting).toBe(false);
	});

	it('一步 = 顶层的一格：一个分支步里的整条臂一次走完，不停在臂里', async () => {
		const { runner, ran } = fakeRunner();
		const gate = createStepGate();
		const running = runPlan(planOf([call('inspect_scene'), branch(true, [call('wave_hello'), call('nod_yes')])]), {
			catalog,
			runner,
			stepGate: gate,
		});

		await flush();
		expect(ran).toEqual(['inspect_scene']);
		expect(gate.waiting).toBe(true);

		// 放行一次：顶层第二步（那个分支）连同它 then 臂里的两步一次走完——闸没有再停
		gate.release();
		const outcome = await running;
		expect(ran).toEqual(['inspect_scene', 'wave_hello', 'nod_yes']);
		expect(gate.waiting).toBe(false);
		expect(outcome.ok).toBe(true);
		expect(outcome.completed).toBe(2);
	});

	it('停在闸上按取消：当场收摊，下一步不会走（闸收信号）', async () => {
		const { runner, ran, cancel } = fakeRunner();
		const gate = createStepGate();
		const running = runPlan(planOf([call('inspect_scene'), call('wave_hello')]), { catalog, runner, stepGate: gate });

		await flush();
		expect(gate.waiting).toBe(true);
		expect(ran).toEqual(['inspect_scene']);

		cancel();
		const outcome = await running;
		expect(outcome.ok).toBe(false);
		expect(outcome.reason).toContain('已取消');
		// 只有第一步走完了：停在闸上的那一步没走，也不算完成
		expect(outcome.completed).toBe(1);
		expect(ran).toEqual(['inspect_scene']);
		expect(gate.waiting).toBe(false);
	});

	it('上一步还在跑时连按：每一次放行都算数（按几次走几步），不丢按', async () => {
		const { runner, ran } = fakeRunner();
		const gate = createStepGate();
		const running = runPlan(planOf([call('inspect_scene'), call('wave_hello'), call('nod_yes')]), {
			catalog,
			runner,
			stepGate: gate,
		});

		// 第一步还没走完就先按两下：它们记在闸上，后两步因此一路走完（不多走、也不少走）
		gate.release();
		gate.release();
		const outcome = await running;
		expect(ran).toEqual(['inspect_scene', 'wave_hello', 'nod_yes']);
		expect(outcome.completed).toBe(3);
	});

	it('不给闸就一口气跑完：单步是加的一个模式，默认行为一个字没变', async () => {
		const { runner, ran } = fakeRunner();
		const outcome = await runPlan(planOf([call('inspect_scene'), call('wave_hello'), call('nod_yes')]), { catalog, runner });
		expect(ran).toEqual(['inspect_scene', 'wave_hello', 'nod_yes']);
		expect(outcome.ok).toBe(true);
		expect(outcome.completed).toBe(3);
	});
});

// ---------------------------------------------------------------------------
// 原语步（`primitive`）：真的叫那一个原语，成败照记 `last.success`
// ---------------------------------------------------------------------------

/**
 * 这一组钉住四件事：
 * 1. `primitive` 步**真的跑那一个原语**（设备收到的就是它，不是某个技能）；
 * 2. 事件口径与技能步完全一样（plan-step 的 `running` → `done`/`failed`，带 `path` 与步型）；
 * 3. 失败处置（`onFailure`）与技能步**同一条路**：缺省停、`'continue'` 往下走且不算完成；
 * 4. 它**参与 `last.success`**——后面那个 `if` 真的能按它的成败分叉。
 */
describe('runPlan · 原语步', () => {
	/** 一条技能步。 */
	const call = (skill: string, onFailure?: 'stop' | 'continue'): SkillPlanStep => ({
		step: 'skill',
		skill,
		...(onFailure === undefined ? {} : { onFailure }),
	});

	/** 一条原语步。 */
	const primitive = (
		ref: string,
		params?: JsonObject,
		onFailure?: 'stop' | 'continue',
	): SkillPlanStep => ({
		step: 'primitive',
		primitive: ref,
		...(params === undefined ? {} : { params }),
		...(onFailure === undefined ? {} : { onFailure }),
	});

	/** 一棵分支：条件照契约的口径写。 */
	const branch = (value: boolean, then: readonly SkillPlanStep[], other?: readonly SkillPlanStep[]): SkillPlanStep => ({
		step: 'if',
		condition: { field: 'last.success', op: '==', value },
		then,
		...(other === undefined ? {} : { else: other }),
	});

	const planOf = (steps: readonly SkillPlanStep[]): SkillPlan => ({ schemaVersion: 1, robot: 'so101_single_arm', plan: steps });

	/** 计划步事件压成一行：`所属顶层步@路径 臂 状态 步型`（与上面几张表同一个写法）。 */
	const traceOf = (e: Extract<PlanStepEvent, { kind: 'plan-step' }>): string =>
		`${String(e.index)}@${e.path} ${e.arm ?? '-'} ${e.state} ${e.step.step}`;

	it('真的叫了那一个原语：设备收到的是原语，报的是计划步事件（带 path 与步型）', async () => {
		const { runner, ran, calls } = fakeRunner();
		const trace: string[] = [];
		const outcome = await runPlan(planOf([primitive('open_gripper'), call('wave_hello')]), {
			catalog,
			runner,
			onPlanStep: (e) => trace.push(traceOf(e)),
		});

		expect(outcome.ok).toBe(true);
		expect(outcome.completed).toBe(2);
		// 设备那侧收到的第一个调用就是原语本身（没有经过任何技能）
		expect(ran).toEqual(['open_gripper', 'wave_hello']);
		expect(calls[0]).toEqual({ ref: 'open_gripper', params: {} });
		expect(trace).toEqual([
			'1@0 - running primitive',
			'1@0 - done primitive',
			'2@1 - running skill',
			'2@1 - done skill',
		]);
	});

	it('参数原样交给执行器（不在计划层翻译），事件里的步就是那一步', async () => {
		const { runner, calls } = fakeRunner();
		await runPlan(planOf([primitive('move_to_named_pose', { pose_name: 'home' })]), { catalog, runner });
		expect(calls[0]?.params).toEqual({ pose_name: 'home' });
	});

	it('失败且缺省（或显式 stop）：计划停在那一步，后面的步一步没跑', async () => {
		for (const step of [primitive('open_gripper'), primitive('open_gripper', undefined, 'stop')]) {
			const { runner, ran } = fakeRunner('open_gripper');
			const trace: string[] = [];
			const outcome = await runPlan(planOf([step, call('wave_hello')]), {
				catalog,
				runner,
				onPlanStep: (e) => trace.push(traceOf(e)),
			});

			expect(outcome.ok).toBe(false);
			expect(outcome.completed).toBe(0);
			expect(outcome.reason).toContain('设备说这一步没做成');
			expect(ran).toEqual(['open_gripper']);
			expect(trace).toEqual(['1@0 - running primitive', '1@0 - failed primitive']);
		}
	});

	it('失败但写了 continue：计划继续往下走，那一步照报 failed 且不算完成（与技能步同一套账）', async () => {
		const { runner, ran } = fakeRunner('open_gripper');
		const trace: string[] = [];
		const outcome = await runPlan(planOf([primitive('open_gripper', undefined, 'continue'), call('wave_hello')]), {
			catalog,
			runner,
			onPlanStep: (e) => trace.push(traceOf(e)),
		});

		expect(outcome.ok).toBe(true);
		expect(outcome.total).toBe(2);
		expect(outcome.completed).toBe(1); // 被容忍的那一步不算完成
		expect(ran).toEqual(['open_gripper', 'wave_hello']);
		expect(trace).toEqual([
			'1@0 - running primitive',
			'1@0 - failed primitive',
			'2@1 - running skill',
			'2@1 - done skill',
		]);
	});

	it('参与 last.success：后面的 if 按**原语的成败**分叉（成 → 另一条臂）', async () => {
		// 成功：条件「上一步成功」成立 → 走 then
		const hit = fakeRunner();
		const then = await runPlan(planOf([primitive('open_gripper'), branch(true, [call('wave_hello')], [call('nod_yes')])]), {
			catalog,
			runner: hit.runner,
		});
		expect(then.ok).toBe(true);
		expect(hit.ran).toEqual(['open_gripper', 'wave_hello']);

		// 失败（但往下走）：`last.success` 记成 false —— 「上一步没成」那条臂这一次真的可达
		const miss = fakeRunner('open_gripper');
		const trace: string[] = [];
		const outcome = await runPlan(
			planOf([
				primitive('open_gripper', undefined, 'continue'),
				branch(false, [call('recover_safe_pose')], [call('celebrate')]),
			]),
			{ catalog, runner: miss.runner, onPlanStep: (e) => trace.push(traceOf(e)) },
		);
		expect(outcome.ok).toBe(true);
		expect(miss.ran).toEqual(['open_gripper', 'recover_safe_pose']);
		expect(trace.filter((line) => line.includes(' if'))).toEqual(['2@1 then running if', '2@1 then done if']);
		expect(trace.some((line) => line.includes('1.else'))).toBe(false);
	});

	it('臂里的原语步照报路径与所属顶层步（与技能步同一个口径）', async () => {
		const { runner, ran } = fakeRunner();
		const trace: string[] = [];
		const outcome = await runPlan(planOf([branch(true, [primitive('open_gripper'), call('wave_hello')])]), {
			catalog,
			runner,
			onPlanStep: (e) => trace.push(traceOf(e)),
		});

		expect(outcome.ok).toBe(true);
		expect(outcome.completed).toBe(1); // 顶层就一步（那个分支）
		expect(ran).toEqual(['open_gripper', 'wave_hello']);
		expect(trace).toEqual([
			'1@0 then running if',
			'1@0.then.0 - running primitive',
			'1@0.then.0 - done primitive',
			'1@0.then.1 - running skill',
			'1@0.then.1 - done skill',
			'1@0 then done if',
		]);
	});

	it('面板上那行写的是原语的标签（目录里那个），没给目录就退回原语名', () => {
		expect(planStepLabel({ step: 'primitive', primitive: 'open_gripper' }, catalog)).toBe('张开夹爪');
		expect(planStepLabel({ step: 'primitive', primitive: 'move_to_named_pose' })).toBe('move_to_named_pose');
		// 目录里查不到也退回原名——那是设备真收到的东西，不编一个中文名
		expect(planStepLabel({ step: 'primitive', primitive: 'not_in_catalog' }, catalog)).toBe('not_in_catalog');
	});
});

/*
 * 委托步（实现在执行侧）：本机仿真演不了它。
 *
 * 三件事必须钉住，否则「计划完成：N 步都走通了」会盖住一件从没发生过的事：
 * ① 报 `unreachable`，既不报 `done`（那是假账）也不报 `failed`（它不是故障）；
 * ② 计划**接着往下走**，`completed` 不把它数进去；
 * ③ `last.success` **一个字都不动**（与等待步同一个口径）。
 *
 * 用抓取那份目录：`pick_object` 只在那儿，而且它的实现就是一条委托。
 */
describe('委托步：本机仿真演不了，但这不是失败', () => {
	const grasp = ROBOFRAME_GRASP_CATALOG;
	const ROBOT = 'so101_handeye_realsense_grasp';

	/** 一台把某个技能报成「演不了」的替身；其余照常。 */
	const runnerWithUnrunnable = (skill: string) => {
		const ran: string[] = [];
		const runner: PlanRunner = {
			beginRun: () => {},
			cancel: () => {},
			onCancel: () => () => {},
			run: async (capability): Promise<RunOutcome> => {
				ran.push(capability.capabilityRef);
				return capability.capabilityRef === skill
					? { ok: true, steps: [], unrunnable: ['/manipulation/execute_pick'] }
					: { ok: true, steps: [] };
			},
			runPrimitiveCommand: async (): Promise<RunOutcome> => ({ ok: true, steps: [] }),
		};
		return { runner, ran };
	};

	it('报 unreachable 并带上「哪儿在执行侧」；导演没演，所以不算完成', async () => {
		const { runner } = runnerWithUnrunnable('pick_object');
		const reports: PlanStepReport[] = [];
		const outcome = await runPlan(
			{ schemaVersion: 1, robot: ROBOT, plan: [{ step: 'skill', skill: 'pick_object', params: { target_name: '方块' } }] },
			{ catalog: grasp, runner, onPlanStep: (event) => reports.push(event) },
		);
		expect(outcome.ok).toBe(true);
		expect(outcome.completed).toBe(0);
		expect(reports.map((e) => e.state)).toEqual(['running', 'unreachable']);
		expect(reports[1]?.detail).toContain('/manipulation/execute_pick');
		// 报的是 unreachable 而不是 failed：它是边界，不是故障。
		expect(reports.some((e) => e.state === 'failed')).toBe(false);
	});

	it('计划接着往下走：后面的步骤照跑，completed 只数真走完的', async () => {
		const { runner, ran } = runnerWithUnrunnable('pick_object');
		const outcome = await runPlan(
			{
				schemaVersion: 1,
				robot: ROBOT,
				plan: [
					{ step: 'skill', skill: 'pick_object', params: { target_name: '方块' } },
					{ step: 'skill', skill: 'recover_safe_pose' },
				],
			},
			{ catalog: grasp, runner },
		);
		expect(outcome.ok).toBe(true);
		expect(ran).toEqual(['pick_object', 'recover_safe_pose']);
		expect(outcome.completed).toBe(1);
	});

	it('不动 last.success：后面那条臂看到的仍是最近一次**真演过**的那一步', async () => {
		const { runner } = runnerWithUnrunnable('pick_object');
		/*
		 * 第一步真跑成了（`open_gripper_skill` → success=true），第二步演不了。
		 * 第三步的分支读 `last.success == true`：它必须**仍然成立**——
		 * 委托步没演，凭什么把上一步的结论改成「没成」。
		 * 两条臂各放一个目录里真有的技能，走哪条由事件里的路径说。
		 */
		const reports: PlanStepReport[] = [];
		const outcome = await runPlan(
			{
				schemaVersion: 1,
				robot: ROBOT,
				plan: [
					{ step: 'skill', skill: 'open_gripper_skill' },
					{ step: 'skill', skill: 'pick_object', params: { target_name: '方块' } },
					{
						step: 'if',
						condition: { field: 'last.success', op: '==', value: true },
						then: [{ step: 'skill', skill: 'recover_safe_pose' }],
						else: [{ step: 'skill', skill: 'recover_zero_pose' }],
					},
				],
			},
			{ catalog: grasp, runner, onPlanStep: (event) => reports.push(event) },
		);
		expect(outcome.ok).toBe(true);
		// `last.success` 仍是 true，所以走的是 then——路径说得很清楚。
		const ranPaths = reports.filter((e) => e.state === 'done').map((e) => e.path);
		expect(ranPaths).toContain('2.then.0');
		expect(ranPaths.some((path) => path.includes('.else.'))).toBe(false);
	});

	it('目录里没有这个技能时照旧是失败——「演不了」与「查不到」不是一回事', async () => {
		const { runner } = runnerWithUnrunnable('pick_object');
		const outcome = await runPlan(
			{ schemaVersion: 1, robot: ROBOT, plan: [{ step: 'skill', skill: 'not_in_catalog' }] },
			{ catalog: grasp, runner },
		);
		expect(outcome.ok).toBe(false);
		expect(outcome.reason).toContain('目录里没有技能');
	});
});
