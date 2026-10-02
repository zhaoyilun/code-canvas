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
	type BranchCondition,
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
	 * `planIndex` 是这一步所属的**顶层**步（1 基）：臂里的步也报它所属的那个顶层步——
	 * 「第 2 步」这条主语因此仍然成立，是臂里的哪一格由计划步事件自己的 `path` 说。
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

/**
 * 分支走了哪条臂。
 *
 * `null` 有两种场合，都是事实而不是「不知道」：技能步没有臂；分支步条件不成立又没给 `else`
 * ——那时这一步**什么也不做**，而它确实走完了（报 `done`）。
 */
export type BranchArm = 'then' | 'else' | null;

export type PlanStepEvent =
	| {
			readonly kind: 'plan-step';
			/**
			 * 这一步所属的**顶层**步（1 基）。臂里的步报的是它所属的那个顶层步——
			 * 「第 2 步」这条主语因此仍然成立，臂里的哪一格由 `path` 说。
			 */
			readonly index: number;
			/** **顶层**步数（计划最外层那几条）。臂里的步不算进来：臂不一定走，把它算进来是个猜数。 */
			readonly total: number;
			/**
			 * 这一步在计划树里的位置：`'2'` / `'2.then.0'` / `'2.then.0.else.1'`。
			 * 第一段是**顶层下标（0 基）**，与 studio 那边的 `stepPath` 同一套写法
			 * （所以两个界面说的是同一格）。嵌套的层级数就是路径里 `.then` / `.else` 的个数。
			 */
			readonly path: string;
			/** 分支走了哪条臂；技能步一律 `null`（见 `BranchArm`）。 */
			readonly arm: BranchArm;
			readonly step: SkillPlanStep;
			readonly taskId: string;
			readonly state: 'running' | 'done' | 'failed';
	  }
	| { readonly kind: 'primitive'; readonly index: number; readonly total: number; readonly step: SkillPlanStep; readonly event: unknown };

/**
 * `plan-step` 那一支：界面（studio 右栏、机器人应用自己的日志）真正消费的形状——
 * 「第几步、树里哪一格、走了哪条臂、成没成」这四件事都在这一支里。
 */
export type PlanStepReport = Extract<PlanStepEvent, { kind: 'plan-step' }>;

export interface PlanRunOutcome {
	readonly ok: boolean;
	/** 真正走完的**顶层**步数（0 ~ `total`）。臂里的步不单独记——它们算进所属的那一步。 */
	readonly completed: number;
	/** **顶层**步数。与 `completed` 同一个口径：两个数说的是同一件事的两个端，所以「已完成 N / 共 M」不会出现 N > M。 */
	readonly total: number;
	readonly reason?: string;
}

/** 同一毫秒里多次 `makeTaskId` 时用来分开（进程内单调递增，只为了让 id 唯一）。 */
let taskSeq = 0;

/**
 * 计划号：RoboFrame bridge 的 task_id 口径（1~128 字符、唯一）。
 *
 * 「唯一」这一条要自己守：`index` 现在说的是**所属的顶层步**，臂里连着几步的 `index` 会重号，
 * 而同一毫秒里生成的两个 id 只有时间戳可分辨——那正是 `taskSeq` 存在的理由（bridge 那边
 * 拿 task_id 认任务，重号就是把两次执行记成一次）。
 */
export function makeTaskId(index: number): string {
	const stamp = `${Date.now().toString(36)}-${(taskSeq++).toString(36)}`;
	return `plan-${String(index)}-${stamp}`.slice(0, 128);
}

/** 分支条件成立吗。`field` 只有 `last.success`、取值只能是布尔（契约的判据），所以这里就是一次相等比较。 */
const conditionHolds = (condition: BranchCondition, lastSuccess: boolean): boolean =>
	condition.op === '==' ? lastSuccess === condition.value : lastSuccess !== condition.value;

/**
 * 嵌套步的失败原因要点名它是哪一步。
 *
 * 顶层步不加前缀：「第 2 步」本来就说得清，理由原样透出更好读。臂里的步不属于任何单独的
 * 「第 N 步」，路径是唯一说得清位置的东西，所以给它加上 `1.then.0（wave_hello）` 这样一段。
 */
const atPath = (path: string, reason: string, skill: string | null = null): string =>
	path.includes('.') ? `失败在 ${path}${skill === null ? '' : `（${skill}）`}：${reason}` : reason;

/** 一步跑完的结局：成了往下走，没成就把原因带出去（失败即停）。 */
type StepResult = { readonly ok: true } | { readonly ok: false; readonly reason: string };

/**
 * 逐步执行计划。失败即停——不自动重试（与 bridge 的纪律一致：是否重试由技能自己的
 * `recovery_policy` 决定，不由执行器替它拿主意）。
 *
 * **分支真的跑**：走到 `step: 'if'` 就按 `last.success` 判条件、选一条臂、在臂里继续跑
 * （臂里还能再有 `if`，深度由契约挡在 8 层）。分支自己也算一步，照报 `running` → `done`/`failed`，
 * 并在事件里说清走了哪条臂（`arm`）与它在树的哪一格（`path`）。
 *
 * **`last.success` 的语义**：最近一次**真正执行过的技能步**成没成。两个要点：
 * ① 分支步自己不更新它——它不是技能步，没做成的事由臂里的那一步去说；
 * ② **计划第一步之前没有上一步，那时算 `true`**（什么都还没失败），于是「第一步就是
 * `if`」的计划按条件成立那条路走。这个初值在 `plan.test.ts` 里钉着。
 *
 * 顶层一格 → 臂里一格 → 再嵌套，走的是同一个递归（`runStep` / `runSteps`），
 * 所以「怎么算一步、怎么报一步」只有一份。
 */
export async function runPlan(
	plan: SkillPlan,
	options: {
		readonly catalog: CapabilityCatalog;
		readonly runner: PlanRunner;
		readonly onPlanStep?: (event: PlanStepReport) => void;
		readonly onPrimitive?: (event: Extract<PlanStepEvent, { kind: 'primitive' }>) => void;
	},
): Promise<PlanRunOutcome> {
	const { catalog, runner } = options;
	const total = plan.plan.length;
	runner.beginRun();
	/** 见上面「`last.success` 的语义」：初值是 `true`（第一步之前没有任何上一步） */
	let lastSuccess = true;
	let completed = 0;

	/** 跑一串步骤（顶层那一串，或某条臂里那一串）。任何一步没成就把原因原样往上带。 */
	const runSteps = async (steps: readonly SkillPlanStep[], basePath: string, topIndex: number): Promise<StepResult> => {
		for (const [index, step] of steps.entries()) {
			// 路径第一段是顶层下标（0 基）；臂里的步在父路径后面接 `.then.0` / `.else.1`
			const path = basePath === '' ? String(index) : `${basePath}.${String(index)}`;
			const result = await runStep(step, path, topIndex);
			if (!result.ok) return result;
		}
		return { ok: true };
	};

	/** 跑一步：技能步下发一次能力调用，分支步判条件选一条臂再往下递归。 */
	const runStep = async (step: SkillPlanStep, path: string, topIndex: number): Promise<StepResult> => {
		const taskId = makeTaskId(topIndex);
		const header = { kind: 'plan-step', index: topIndex, total, path, step, taskId } as const;

		if (step.step === 'skill') {
			options.onPlanStep?.({ ...header, arm: null, state: 'running' });

			// 判别在前：目录里没有这个技能就不假装调用过
			const capability = catalog.capabilities.find((c) => c.capabilityRef === step.skill);
			if (!capability) {
				options.onPlanStep?.({ ...header, arm: null, state: 'failed' });
				return { ok: false, reason: atPath(path, `目录里没有技能 ${step.skill}`) };
			}
			const params: Record<string, unknown> = step.params ?? {};
			// 换一步就重设上下文：这一步的原语事件因此带上「所属顶层步」与 task_id
			runner.setPlanContext?.({ planIndex: topIndex, taskId });
			const outcome = await runner.run(capability, params);
			lastSuccess = outcome.ok;
			options.onPlanStep?.({ ...header, arm: null, state: outcome.ok ? 'done' : 'failed' });
			if (!outcome.ok) {
				return { ok: false, reason: atPath(path, outcome.reason ?? `${step.skill} 未完成`, step.skill) };
			}
			return { ok: true };
		}

		/*
		 * 分支：条件在这一步**开头**就判定了，所以 `running` 事件里已经带着走哪条臂——
		 * 界面因此能在这一步开始时就把「走 then」写出来，而不是等臂跑完才知道。
		 * 条件不成立又没有 `else` 时 `arm` 是 `null`：这一步什么也不做，但它确实走完了（报 `done`）。
		 */
		const arm: BranchArm = conditionHolds(step.condition, lastSuccess)
			? 'then'
			: step.else === undefined
				? null
				: 'else';
		options.onPlanStep?.({ ...header, arm, state: 'running' });
		if (arm === null) {
			options.onPlanStep?.({ ...header, arm, state: 'done' });
			return { ok: true };
		}

		// 臂里的步照常执行（臂里还能再有 if）：路径接着往下长，顶层步号不变
		const nested = await runSteps(arm === 'then' ? step.then : (step.else ?? []), `${path}.${arm}`, topIndex);
		options.onPlanStep?.({ ...header, arm, state: nested.ok ? 'done' : 'failed' });
		return nested;
	};

	for (const [index, step] of plan.plan.entries()) {
		// 顶层步号就是它自己的下标 + 1；臂里的步由 `runSteps` 把同一个号带下去
		const result = await runStep(step, String(index), index + 1);
		if (!result.ok) return { ok: false, completed, total, reason: result.reason };
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
