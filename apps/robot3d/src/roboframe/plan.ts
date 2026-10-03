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
	findPrimitive,
	SKILL_PLAN_SCHEMA_VERSION,
	validateSkillPlan,
	type BranchCondition,
	type CapabilityCatalog,
	type CapabilitySpec,
	type Diagnostic,
	type SkillPlan,
	type SkillPlanOnFailure,
	type SkillPlanStep,
	type StepGate,
} from '@codecanvas/contracts';
import type { RunOutcome } from './executor';

/** 执行侧需要的最小面（真身是 RoboFrameExecutor，测试里换成假的） */
export interface PlanRunner {
	run(capability: CapabilitySpec, params: Record<string, unknown>): Promise<RunOutcome>;
	/**
	 * 跑**一个原语**（`primitive` 步）：RoboFrame 的 `/embodied/execute_primitive` 那条路——
	 * 绕开技能那层包装，直接叫一个原子动作。参数由执行侧照目录声明校验，失败如实返回。
	 */
	runPrimitiveCommand(primitiveRef: string, params: Record<string, unknown>): Promise<RunOutcome>;
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
	/**
	 * 订阅「这次执行被取消了」。**计划层的 `wait` 要能被真打断就靠它**：
	 * 执行器对外只有 `cancel()` 一个动作，而等待是一次 `setTimeout`——订阅到了才收得了摊，
	 * 不是等完再看一眼标记（那还是把执行器挂在那儿傻等）。
	 * 返回退订函数，跑完这一趟就退订（别把上一趟的等待留在集合里）。
	 */
	onCancel(listener: () => void): () => void;
}

/**
 * 计划层的等待：默认那条是**可打断的 `setTimeout`**（见 `interruptibleSleep`）。
 * 测试注入假的，别让单测真的等两秒；真身不需要换。
 */
export type PlanSleep = (ms: number, signal: AbortSignal) => Promise<void>;

/**
 * 单步放行闸。形状与语义在 `@codecanvas/contracts`（本机这条路与 bridge HTTP 那条路**共用一份**，
 * 于是界面上「按一次走一步」在两条路上是同一件事）。
 */
export type PlanStepGate = StepGate;

/**
 * 可打断的等待：`signal` 一 abort，`setTimeout` 当场被清掉、Promise 立刻收摊。
 *
 * 为什么不能「等完再检查 signal」：那样取消按钮按下去要等到这一步自己醒过来才生效，
 * 计划里一个 600 秒的等待就会让「取消」看上去失灵——事情做了没有，是两回事。
 */
const interruptibleSleep: PlanSleep = (ms, signal) =>
	new Promise<void>((resolve) => {
		if (signal.aborted) {
			resolve();
			return;
		}
		function finish(): void {
			signal.removeEventListener('abort', finish);
			clearTimeout(timer);
			resolve();
		}
		const timer = setTimeout(finish, ms);
		signal.addEventListener('abort', finish, { once: true });
	});

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
			/**
			 * 这一步的结局。
			 *
			 * `unreachable` 是第四种，说的是「**本机仿真演不了这一步**」：那一步的实现在执行侧
			 * （委托型技能，例如 `pick_object` → `/manipulation/execute_pick`），本机这套东西
			 * 压根没有它。它**不是失败**（`ok` 照旧是 `true`，计划照常往下走），
			 * 也**不是成功**（什么都没演，报 `done` 就是假账）。
			 *
			 * 它**不动 `last.success`**：与等待步同一个口径（见 `runStep` 里等待那一段）——
			 * 演都没演，凭什么说上一步成没成。
			 */
			readonly state: 'running' | 'done' | 'failed' | 'unreachable';
			/**
			 * 为什么是这个状态（一般没有；`unreachable` 一定有——它得说清是**哪儿**在执行侧）。
			 * 界面直接展示这句话就是实话，不必再编一句。
			 */
			readonly detail?: string;
	  }
	| { readonly kind: 'primitive'; readonly index: number; readonly total: number; readonly step: SkillPlanStep; readonly event: unknown };

/**
 * `plan-step` 那一支：界面（studio 右栏、机器人应用自己的日志）真正消费的形状——
 * 「第几步、树里哪一格、走了哪条臂、成没成」这四件事都在这一支里。
 */
export type PlanStepReport = Extract<PlanStepEvent, { kind: 'plan-step' }>;

export interface PlanRunOutcome {
	/** 计划有没有走完。有步骤被 `onFailure: 'continue'` 容忍失败时，计划走完了，所以仍是 `true`（见 `runPlan`）。 */
	readonly ok: boolean;
	/**
	 * 真正走完的**顶层**步数（0 ~ `total`）。臂里的步不单独记——它们算进所属的那一步。
	 * 被容忍失败的那一步**不算**：它报的是 `failed`，账上也不能记成完成。
	 */
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
 * 一个计划步在界面上叫什么：技能步报技能名（那是设备那边真收到的调用），
 * 分支步说这是个判断，等待步说等了多久，原语步报**目录里那个原语的标签**（「张开夹爪」）。
 *
 * 为什么放在执行侧而不是各界面各写一份：这几种说法说的是**同一件事实**（这一步是什么），
 * 两个界面（机器人应用自己的日志、studio 右栏）不该各有一套叫法。
 * 「等多久」就写声明里那个数——不摆一张「几秒怎么说」的表。
 *
 * 原语的标签只有目录里有，所以目录是可选的：给不出（没传目录 / 目录里查不到这个原语）时
 * 退回原语名——那是设备真收到的东西，照实说，不编一个中文名。
 */
export function planStepLabel(step: SkillPlanStep, catalog?: CapabilityCatalog | null): string {
	if (step.step === 'if') return '分支';
	if (step.step === 'wait') return `等待 ${String(step.seconds)} 秒`;
	if (step.step === 'primitive') {
		return catalog == null ? step.primitive : (findPrimitive(catalog, step.primitive)?.label ?? step.primitive);
	}
	return step.skill;
}

/**
 * 嵌套步的失败原因要点名它是哪一步。
 *
 * 顶层步不加前缀：「第 2 步」本来就说得清，理由原样透出更好读。臂里的步不属于任何单独的
 * 「第 N 步」，路径是唯一说得清位置的东西，所以给它加上 `1.then.0（wave_hello）` 这样一段。
 */
const atPath = (path: string, reason: string, skill: string | null = null): string =>
	path.includes('.') ? `失败在 ${path}${skill === null ? '' : `（${skill}）`}：${reason}` : reason;

/**
 * 一步跑完的结局。
 *
 * - `ok: false`：**失败即停**，`reason` 原样往上带；
 * - `ok: true` 且 `completed: true`：这一步成了，算进 `completed`；
 * - `ok: true` 且 `completed: false`：这一步**失败了但被容忍**
 *   （`onFailure: 'continue'`）——计划往下走，但这一步不算走完（见 `runStep` 里技能步那一段）。
 */
type StepResult = { readonly ok: true; readonly completed: boolean } | { readonly ok: false; readonly reason: string };

/**
 * 逐步执行计划。失败即停——**除非那一步自己写了 `onFailure: 'continue'`**。
 * 两条都不自动重试（与 bridge 的纪律一致：是否重试由技能自己的 `recovery_policy` 决定，
 * 不由执行器替它拿主意）。
 *
 * **失败处置（`onFailure`）**：技能步与原语步缺省（或写 `'stop'`）就是上面那句「失败即停」，
 * 一个字不变；写了 `'continue'` 的那一步失败后，计划**继续往下走**，并且 `last.success` 记成 `false`——
 * 后面那个 `if` 因此真的能走到「上一步没成」那条臂。
 * 为什么缺省是停，见契约里 `SkillStep.onFailure` 那段（安全立场，与 bridge 同一条）。
 * `wait` 与 `if` 不带这一栏（契约那边就报错），所以这里只有技能步与原语步看它——
 * 而这两者走的是**同一段收尾**（`runStep` 里的 `settle`），待遇不许分家。
 *
 * **分支真的跑**：走到 `step: 'if'` 就按 `last.success` 判条件、选一条臂、在臂里继续跑
 * （臂里还能再有 `if`，深度由契约挡在 8 层）。分支自己也算一步，照报 `running` → `done`/`failed`，
 * 并在事件里说清走了哪条臂（`arm`）与它在树的哪一格（`path`）。
 *
 * **原语真的跑**：走到 `step: 'primitive'` 就**只叫那一个原语**（`runPrimitiveCommand`）——
 * 目录里有些原子动作没有技能包装，这一步是它们的直路；它照报计划步事件（`running` → `done`/`failed`，
 * 带 `path`），原语级事件也照常报（带着所属顶层步与 task_id）。
 *
 * **`last.success` 的语义**：最近一次**真正执行过的那一步**（技能步或原语步）成没成。四个要点：
 * ① **成功的记 `true`，被容忍失败的记 `false`**——两种步都写在同一处
 *    （`settle`，就一行 `lastSuccess = ok`），不散在两处各写一遍；
 * ② 分支步自己不更新它——它不是一次执行，没做成的事由臂里的那一步去说
 *    （分支**走完**也不算「成」：`if` 自己不是一次执行）；
 * ③ **`wait` 步也不更新它**——它什么也没「成」也没「败」，所以它后面那个 `if` 看到的
 *    仍是 `wait` **之前**那一步的结果（`plan.test.ts` 里钉着这一条）；
 * ④ **计划第一步之前没有上一步，那时算 `true`**（什么都还没失败），于是「第一步就是
 *    `if`」的计划按条件成立那条路走。这个初值在 `plan.test.ts` 里钉着。
 *
 * **整体的 `ok` 说的是「计划有没有走完」**：有步骤被容忍失败时，计划照样走完了，
 * 所以 `ok` 仍是 `true`——那一步的失败由它自己的事件（`failed`）与 `completed` 不说谎
 * （被容忍的那一步不算完成）说清。这里不把整条计划说成失败：`'continue'` 正是写计划的人
 * 说的「这一步失败我也认」。
 *
 * **`wait` 步真的等**（`setTimeout` 那一层），但**可被打断**：`cancel()` 一订阅到就当场收摊，
 * 那一步照报 `failed`（原因「已取消」）——与「跑到一半被取消的技能步」同一个口径。
 *
 * 顶层一格 → 臂里一格 → 再嵌套，走的是同一个递归（`runStep` / `runSteps`），
 * 所以「怎么算一步、怎么报一步」只有一份。
 *
 * **单步（`stepGate`）**：给了放行闸就是单步模式——每个**顶层步**之间等一次放行
 * （臂里的步不各停一次：「第 N 步」在界面上就是顶层那一格，与流程画布的一张卡同一件事）。
 * 第一个顶层步**不等**：按下「单步运行」那一刻就该走完第一步，等放行的话第一次按什么都没有发生。
 * 等放行时取消照旧生效（闸收信号）：停在闸上的那一趟不许被一个没人再按的按钮挂住。
 */
export async function runPlan(
	plan: SkillPlan,
	options: {
		readonly catalog: CapabilityCatalog;
		readonly runner: PlanRunner;
		readonly onPlanStep?: (event: PlanStepReport) => void;
		readonly onPrimitive?: (event: Extract<PlanStepEvent, { kind: 'primitive' }>) => void;
		/** 计划层的等待怎么等。缺省 `interruptibleSleep`；测试注入假的，别真等两秒。 */
		readonly sleep?: PlanSleep;
		/** 单步放行闸（见文件头那段）。不给就是一口气跑完。 */
		readonly stepGate?: PlanStepGate;
	},
): Promise<PlanRunOutcome> {
	const { catalog, runner, stepGate } = options;
	const sleep = options.sleep ?? interruptibleSleep;
	const total = plan.plan.length;
	runner.beginRun();
	/** 见上面「`last.success` 的语义」：初值是 `true`（第一步之前没有任何上一步） */
	let lastSuccess = true;
	let completed = 0;
	/**
	 * 这一趟的取消信号。`cancel()` 的信息从 runner 那边订阅过来（`onCancel`），
	 * 订阅一次全程共用：等待步收到的就是同一个信号，所以「取消」这件事在计划层只有一份说法。
	 */
	const cancelled = new AbortController();
	const unsubscribe = runner.onCancel(() => {
		cancelled.abort();
	});

	/**
	 * 跑一串步骤（顶层那一串，或某条臂里那一串）。任何一步没成就把原因原样往上带。
	 * 回来那个 `completed` 在这一层**只是占位**（整串的「算不算完成」不是一个数）：
	 * 调用方（分支那一段）只看 `ok`，真正记账的是顶层那一步自己。
	 */
	const runSteps = async (steps: readonly SkillPlanStep[], basePath: string, topIndex: number): Promise<StepResult> => {
		for (const [index, step] of steps.entries()) {
			// 路径第一段是顶层下标（0 基）；臂里的步在父路径后面接 `.then.0` / `.else.1`
			const path = basePath === '' ? String(index) : `${basePath}.${String(index)}`;
			const result = await runStep(step, path, topIndex);
			if (!result.ok) return result;
		}
		return { ok: true, completed: true };
	};

	/** 跑一步：技能步下发一次能力调用，原语步直接叫一个原语，分支步判条件选一条臂再往下递归。 */
	const runStep = async (step: SkillPlanStep, path: string, topIndex: number): Promise<StepResult> => {
		const taskId = makeTaskId(topIndex);
		const header = { kind: 'plan-step', index: topIndex, total, path, step, taskId } as const;

		/*
		 * 「会成会败的一步」的收尾（**技能步与原语步共用这一条路**）。
		 *
		 * 三种结局都从这一处出去：
		 * - 成了：`last.success` 记 `true`，算完成；
		 * - 没成且 `'continue'`：`last.success` 记 **`false`**、计划接着往下走，但**不算完成**
		 *   ——这一步照报 `failed`（不粉饰成 done），`completed` 也不把它数进去；
		 * - 没成且 `'stop'`（含缺省）：把原因带出去，失败即停（现在的行为一个字不变）。
		 *
		 * 判据只有这一份：技能步与原语步都是「叫一个东西去做事」，失败处置的待遇必须一模一样——
		 * 两处各写一遍，早晚会有一处被改松（变异验证里就是这么验的）。
		 * `lastSuccess` 也只在写：两种步的结局是同一个赋值，所以「上一步成没成」永远等于
		 * **最近一次真正执行过的那一步**（技能步或原语步）的结局。
		 */
		const settle = (onFailure: SkillPlanOnFailure | undefined, ok: boolean, reason: string): StepResult => {
			lastSuccess = ok;
			options.onPlanStep?.({ ...header, arm: null, state: ok ? 'done' : 'failed' });
			if (ok) return { ok: true, completed: true };
			if (onFailure === 'continue') return { ok: true, completed: false };
			return { ok: false, reason };
		};

		if (step.step === 'skill' || step.step === 'primitive') {
			options.onPlanStep?.({ ...header, arm: null, state: 'running' });

			if (step.step === 'primitive') {
				/*
				 * 原语步：直接叫那一个原语（参数按目录声明由执行侧校验，事件照常报）。
				 * 它**不经过目录里的能力**——目录里有些原子动作压根没有技能包装
				 * （`open_gripper` / `close_gripper` 这种），这一步就是给它们留的直路。
				 * 失败原因点名的是原语名（那是设备真收到的东西）。
				 */
				// 换一步就重设上下文：这一步的原语事件因此带上「所属顶层步」与 task_id
				runner.setPlanContext?.({ planIndex: topIndex, taskId });
				const outcome = await runner.runPrimitiveCommand(step.primitive, step.params ?? {});
				return settle(step.onFailure, outcome.ok, atPath(path, outcome.reason ?? `${step.primitive} 未完成`, step.primitive));
			}

			// 判别在前：目录里没有这个技能就不假装调用过
			const capability = catalog.capabilities.find((c) => c.capabilityRef === step.skill);
			if (!capability) return settle(step.onFailure, false, atPath(path, `目录里没有技能 ${step.skill}`));

			// 换一步就重设上下文：这一步的原语事件因此带上「所属顶层步」与 task_id
			runner.setPlanContext?.({ planIndex: topIndex, taskId });
			const outcome = await runner.run(capability, step.params ?? {});
			/*
			 * 这一步里有**本机演不了**的委托（实现在执行侧）。
			 *
			 * 报 `unreachable`，不是 `done`——什么都没演就说「走通了」是假账。
			 * 也不是 `failed`：它没坏，是这里压根没有那套东西（与派发面板里
			 * 「原语送不出去」那一条同一个态度：边界不是欠账）。
			 *
			 * 于是 `last.success` **一个字都不动**（不写它）：与等待步同一个口径，
			 * 后面那个 `if` 看到的仍是最近一次**真正演过**的那一步的结果。
			 * `completed` 也不把它数进去——它确实没完成，只是也没失败。
			 */
			if (outcome.ok && outcome.unrunnable !== undefined && outcome.unrunnable.length > 0) {
				const interfaces = outcome.unrunnable.join('、');
				options.onPlanStep?.({
					...header,
					arm: null,
					state: 'unreachable',
					detail: `实现在执行侧（${interfaces}），本机仿真演不了这一步`,
				});
				return { ok: true, completed: false };
			}
			return settle(step.onFailure, outcome.ok, atPath(path, outcome.reason ?? `${step.skill} 未完成`, step.skill));
		}

		/*
		 * 等待步：只是停一下。三件事在这儿说清：
		 * ① 它**照报一步**（`running` → `done`），`arm` 是 `null`——它没有臂（没走哪条一说）；
		 * ② 它**不碰 `last.success`**：这里一个字都不写它，所以后面那个 `if` 看到的仍是
		 *    `wait` 之前那个技能步的结果（契约里也写着这一条，`plan.test.ts` 里钉着）；
		 * ③ 等的是**真时间**，但可被打断：`cancel()` 一到信号就 abort，等待当场收摊
		 *    （见 `interruptibleSleep`），那一步照报 `failed`——与「跑到一半被取消的技能步」同一个口径。
		 */
		if (step.step === 'wait') {
			options.onPlanStep?.({ ...header, arm: null, state: 'running' });
			await sleep(step.seconds * 1000, cancelled.signal);
			if (cancelled.signal.aborted) {
				options.onPlanStep?.({ ...header, arm: null, state: 'failed' });
				return { ok: false, reason: atPath(path, '已取消') };
			}
			options.onPlanStep?.({ ...header, arm: null, state: 'done' });
			return { ok: true, completed: true };
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
			return { ok: true, completed: true };
		}

		// 臂里的步照常执行（臂里还能再有 if）：路径接着往下长，顶层步号不变
		const nested = await runSteps(arm === 'then' ? step.then : (step.else ?? []), `${path}.${arm}`, topIndex);
		options.onPlanStep?.({ ...header, arm, state: nested.ok ? 'done' : 'failed' });
		/*
		 * 臂里那一步被容忍失败时，**分支这一步自己仍算走完了**（它的臂一路走到了尾）：
		 * 「没完成」是臂里那一步的事，由它自己的事件说——把外面这一步也算成没完成，
		 * 会让「第几步没走完」指向一个其实走完了的构造。
		 */
		return nested.ok ? { ok: true, completed: true } : nested;
	};

	try {
		for (const [index, step] of plan.plan.entries()) {
			/*
			 * 单步：进这一步之前先等一次放行。**第一个顶层步不等**（按下那一刻就该走完第一步），
			 * 臂里的步也不各停一次——`runSteps` 里没有闸，一个顶层步里的整条臂一次走完。
			 * 等的时候取消要能叫醒它（`wait` 收信号）：否则这一趟会被一个没人再按的按钮挂住。
			 */
			if (index > 0 && stepGate !== undefined) {
				await stepGate.wait(cancelled.signal);
				if (cancelled.signal.aborted) return { ok: false, completed, total, reason: '已取消' };
			}
			// 顶层步号就是它自己的下标 + 1；臂里的步由 `runSteps` 把同一个号带下去
			const result = await runStep(step, String(index), index + 1);
			if (!result.ok) return { ok: false, completed, total, reason: result.reason };
			// 被容忍失败的那一步不算完成（它报的是 `failed`）——`completed` 因此可以小于 `total`，
			// 而那正是「这一步没成、计划照走」这句话唯一的账目。
			if (result.completed) completed += 1;
		}
		return { ok: true, completed, total };
	} finally {
		// 这一趟跑完就退订：订阅是「这一次执行」的，留着下一次就会有一份没人管的等待
		// （`beginRun()` 之后是另一趟，信号也该是新的——那是下一次 `runPlan` 的事）。
		unsubscribe();
	}
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
