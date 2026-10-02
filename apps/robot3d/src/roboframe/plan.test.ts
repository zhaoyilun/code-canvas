import { describe, expect, it, vi } from 'vitest';
import { ROBOFRAME_SO101_CATALOG as catalog } from '@codecanvas/capabilities';
import type { CapabilitySpec, Diagnostic, JsonObject, SkillPlan, SkillPlanStep, SkillStep } from '@codecanvas/contracts';
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
	const ran: string[] = [];
	const calls: { ref: string; params: Record<string, unknown> }[] = [];
	/**
	 * 取消的订阅者。真身（`RoboFrameExecutor`）也是这个口径：等待步靠订阅被打断，
	 * 所以这张假替身必须能通知——不然「取消能打断等待」那条测试测的就是一张不会取消的替身。
	 */
	const cancelListeners = new Set<() => void>();
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
		run: async (capability: CapabilitySpec, params: Record<string, unknown>): Promise<RunOutcome> => {
			ran.push(capability.capabilityRef);
			calls.push({ ref: capability.capabilityRef, params });
			if (capability.capabilityRef === failOn) {
				return { ok: false, steps: [], reason: '设备说这一步没做成' };
			}
			return { ok: true, steps: [] };
		},
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
