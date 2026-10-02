/**
 * 接收 JSON 指令：一份任务 JSON 进来，逐步跑在设备上。
 *
 * 认三种形状，都归到 `SkillPlan` 再执行：
 * 1. **技能计划**（`packages/contracts` 的 `SkillPlan`）——本仓库的任务格式，主路径；
 * 2. **单条指令** `{ "skill": "...", "params": { ... } }`——RoboFrame bridge 的
 *    `/v1/skills/execute` 请求体就是这个形状，去掉 task_id 就能直接贴进来；
 * 3. 上面两者的 JSON **字符串**（多一层解析，方便从文件/接口原样粘）。
 *
 * 校验一律交给 `@codecanvas/contracts` 的 `validateSkillPlan`，判据是**目录**：
 * 这里不重复实现一遍规则，也不吞掉诊断——错了就把带 `path`/`code` 的问题原样抛给界面。
 */
import {
	DiagnosticCollector,
	SKILL_PLAN_SCHEMA_VERSION,
	validateSkillPlan,
	type CapabilityCatalog,
	type CapabilitySpec,
	type Diagnostic,
	type SkillPlan,
	type SkillPlanStep,
} from '@codecanvas/contracts';
import type { RunOutcome } from './executor';

/** 执行侧需要的最小面（真身是 RoboFrameExecutor，测试里换成假的） */
export interface PlanRunner {
	run(capability: CapabilitySpec, params: Record<string, unknown>): Promise<RunOutcome>;
	/** 开始跑这条计划：清取消标记，但**不复位机械臂**（上一条指令停在哪就从哪接着走） */
	beginRun(): void;
	/**
	 * 换一步：把「计划第几步 + task_id」盖在这一步的每个事件上。
	 * 界面靠它显示「第 N 步」，不必拿能力内部的**原语**序号去猜计划的进度
	 * （两者会重号：三个各含一条原语的技能连着跑，会显示成三次「第 1 步」）。
	 * 可选：只关心动作的替身（测试里的假 runner）可以不管它。
	 */
	setPlanContext?(context: { readonly planIndex: number; readonly taskId: string }): void;
	cancel(): void;
}

export type IntakeResult =
	| { readonly ok: true; readonly plan: SkillPlan }
	| { readonly ok: false; readonly diagnostics: readonly Diagnostic[] };

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** 把单条指令包成一步计划；已经是计划就原样返回。 */
export function normalizeCommand(value: unknown, catalog: CapabilityCatalog): unknown {
	if (!isRecord(value)) return value;
	if (Array.isArray(value['plan'])) return value;
	// bridge 的 execute 请求体：{ task_id, skill, params, timeout_sec }
	if (typeof value['skill'] === 'string') {
		const step: Record<string, unknown> = { step: 'skill', skill: value['skill'] };
		if (isRecord(value['params'])) step['params'] = value['params'];
		if (typeof value['timeout_sec'] === 'number') step['timeoutSec'] = value['timeout_sec'];
		return {
			schemaVersion: SKILL_PLAN_SCHEMA_VERSION,
			robot: catalog.robotName ?? '',
			description: typeof value['task_id'] === 'string' ? `单条指令 ${value['task_id']}` : '单条指令',
			plan: [step],
		};
	}
	return value;
}

/** 文本 → 计划。JSON 都解析不了时给一条人能看懂的诊断，不抛异常。 */
export function intake(text: string, catalog: CapabilityCatalog): IntakeResult {
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch (error) {
		// 解析失败也走同一种诊断形态（不抛异常），界面只有一条渲染路径
		const collector = new DiagnosticCollector();
		collector.error({
			code: 'plan.json.invalid',
			message: `这段不是合法 JSON：${error instanceof Error ? error.message : String(error)}`,
			path: '$',
		});
		return { ok: false, diagnostics: collector.diagnostics };
	}
	const normalized = normalizeCommand(parsed, catalog);
	const result = validateSkillPlan(normalized, { catalog, ...(catalog.robotName === undefined ? {} : { expectedRobot: catalog.robotName }) });
	return result.ok ? { ok: true, plan: result.plan } : { ok: false, diagnostics: result.diagnostics };
}

export type PlanStepEvent =
	| { readonly kind: 'plan-step'; readonly index: number; readonly total: number; readonly step: SkillPlanStep; readonly taskId: string; readonly state: 'running' | 'done' | 'failed' }
	| { readonly kind: 'primitive'; readonly index: number; readonly total: number; readonly step: SkillPlanStep; readonly event: unknown };

export interface PlanRunOutcome {
	readonly ok: boolean;
	readonly completed: number;
	readonly total: number;
	readonly reason?: string;
}

/** 计划号：RoboFrame bridge 的 task_id 口径（1~128 字符、唯一） */
export function makeTaskId(index: number): string {
	const stamp = Date.now().toString(36);
	return `plan-${String(index)}-${stamp}`.slice(0, 128);
}

/**
 * 逐步执行计划。失败即停——不自动重试（与 bridge 的纪律一致：是否重试由技能自己的
 * `recovery_policy` 决定，不由执行器替它拿主意）。
 *
 * ⚠ **分支步（`step: 'if'`）这一版不执行**：3D 执行器还没有"按上一步的结果选一条臂"这件事
 * （它现在的语义是"照目录逐条下发原语"，加分支要先定清楚"上一步的结果"在 3D 里怎么读）。
 * 但不能静默跳过——跳到这一步就把它当成一次**如实的中断**报出来（`plan.step.branch.unsupported`），
 * 前几步的账照记（`completed` 如实数）。界面与调用方都拿得到这句话，不会以为计划跑完了。
 */
export async function runPlan(
	plan: SkillPlan,
	options: {
		readonly catalog: CapabilityCatalog;
		readonly runner: PlanRunner;
		readonly onPlanStep?: (event: Extract<PlanStepEvent, { kind: 'plan-step' }>) => void;
		readonly onPrimitive?: (event: Extract<PlanStepEvent, { kind: 'primitive' }>) => void;
	},
): Promise<PlanRunOutcome> {
	const { catalog, runner } = options;
	const total = plan.plan.length;
	runner.beginRun();
	let completed = 0;

	for (const [index, step] of plan.plan.entries()) {
		const taskId = makeTaskId(index + 1);
		const header = { kind: 'plan-step', index: index + 1, total, step, taskId, state: 'running' } as const;
		options.onPlanStep?.(header);

		// 判别在前：这一版能执行的只有技能步，别的步型都不许当成技能蒙混过去
		if (step.step !== 'skill') {
			options.onPlanStep?.({ ...header, state: 'failed' });
			return {
				ok: false,
				completed,
				total,
				reason: '计划里有条件分支步（step: "if"），3D 执行器这一版不执行分支——分步执行是下一步的事',
			};
		}

		const capability = catalog.capabilities.find((c) => c.capabilityRef === step.skill);
		if (!capability) {
			options.onPlanStep?.({ ...header, state: 'failed' });
			return { ok: false, completed, total, reason: `目录里没有技能 ${step.skill}` };
		}
		const params = (step.params ?? {}) as Record<string, unknown>;
		// 换一步就重设上下文：这一步的原语事件因此带上「计划第几步」与 task_id
		runner.setPlanContext?.({ planIndex: index + 1, taskId });
		const outcome = await runner.run(capability, params);
		const done = { ...header, state: outcome.ok ? ('done' as const) : ('failed' as const) };
		options.onPlanStep?.(done);
		if (!outcome.ok) {
			return { ok: false, completed, total, reason: outcome.reason ?? `${step.skill} 未完成` };
		}
		completed += 1;
	}
	return { ok: true, completed, total };
}

/** 界面上的示例：技能名与参数名都照目录原名写，开机就是一份能跑通的计划 */
export const SAMPLE_PLAN_JSON = `{
  "schemaVersion": 1,
  "robot": "so101_single_arm",
  "description": "看一眼桌面，往前挪一点，打招呼",
  "plan": [
    { "step": "skill", "skill": "inspect_scene" },
    {
      "step": "skill",
      "skill": "move_relative_ee",
      "params": { "motion_direction": "forward", "motion_distance": 0.03 },
      "timeoutSec": 10
    },
    { "step": "skill", "skill": "wave_hello" }
  ]
}
`;

export type { SkillPlan, SkillPlanStep };
