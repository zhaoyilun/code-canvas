import { describe, expect, it } from 'vitest';
import { ROBOFRAME_SO101_CATALOG as catalog } from '@codecanvas/capabilities';
import type { CapabilitySpec, Diagnostic, JsonObject, SkillPlan, SkillPlanStep, SkillStep } from '@codecanvas/contracts';
import { intake, makeTaskId, normalizeCommand, runPlan, SAMPLE_PLAN_JSON, type PlanRunner } from './plan';
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
	const runner: PlanRunner = {
		// 只是清取消标记——连续执行时不该动机械臂，这里记一笔好断言
		beginRun: () => {},
		cancel: () => {},
		run: async (capability: CapabilitySpec, params: Record<string, unknown>): Promise<RunOutcome> => {
			ran.push(capability.capabilityRef);
			calls.push({ ref: capability.capabilityRef, params });
			if (capability.capabilityRef === failOn) {
				return { ok: false, steps: [], reason: '设备说这一步没做成' };
			}
			return { ok: true, steps: [] };
		},
	};
	return { runner, ran, calls };
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

	it('声明了参数却没给：契约只提醒（目录没标必填），拦不拦是执行侧的事', () => {
		const result = intake(JSON.stringify({ schemaVersion: 1, robot: 'so101_single_arm', plan: [{ step: 'skill', skill: 'move_relative_ee' }] }), catalog);
		// 契约的口径：catalogParameterSchema 没有 required 一栏，所以缺参数是 warning 不是 error
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(asSkill(result.plan.plan[0]).params).toBeUndefined();
		// 执行侧没有「默认方向」这种可编的东西，缺参数就拒绝执行——这条在 executor.test.ts 里钉着
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

	it('分支步（step: "if"）这一版不执行，但**明说**：不当成技能蒙混，也不静默跳过', async () => {
		const { runner, ran } = fakeRunner();
		const states: string[] = [];
		const branchPlan: SkillPlan = {
			schemaVersion: 1,
			robot: 'so101_single_arm',
			plan: [
				{ step: 'skill', skill: 'inspect_scene' },
				{
					step: 'if',
					condition: { field: 'last.success', op: '==', value: true },
					then: [{ step: 'skill', skill: 'wave_hello' }],
				},
			],
		};

		const outcome = await runPlan(branchPlan, {
			catalog,
			runner,
			onPlanStep: (e) => states.push(`${String(e.index)} ${e.step.step} ${e.state}`),
		});

		expect(outcome.ok).toBe(false);
		expect(outcome.completed).toBe(1); // 前一步的账照记，不吞
		expect(outcome.reason).toContain('分支');
		// 遇到分支就这样停下：第一步照跑，分支那一步报 failed，then 里的技能一步没动
		expect(states).toEqual(['1 skill running', '1 skill done', '2 if running', '2 if failed']);
		expect(ran).toEqual(['inspect_scene']);
	});

	it('task_id 形状符合 bridge 的口径（1~128 字符）', () => {		const id = makeTaskId(3);
		expect(id.length).toBeGreaterThan(0);
		expect(id.length).toBeLessThanOrEqual(128);
		expect(id.startsWith('plan-3-')).toBe(true);
	});
});
