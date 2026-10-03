/**
 * 技能计划 → **bridge 的调用序列**（声明式）。这一版不发请求：产出的是一份可以被对账的东西。
 *
 * 为什么要有这一层：这个工作台跑的一直是**我们自己的执行器**（`apps/robot3d`），
 * 产物从来没送到真机器人那边去过。把计划编成 bridge 的请求序列，是这条链的第一步；
 * 形状的判据是 bridge 自己的 pydantic 模型（`docs/reference/bridge_models.py`），
 * 见 `test/model-parity.test.ts`。
 *
 * 四类步各去哪儿（判据与措辞都在 `limits.ts` 那份清单里，这里不另写一套）：
 * `skill` → bridge（`POST /v1/skills/execute` + **客户端轮询** `GET /v1/tasks/{task_id}`）；
 * `if` / `wait` → 客户端自己做；`primitive` → **送不了**（执行侧没有原语端点），出诊断。
 *
 * 两条从执行侧抄来的口径（**轮询那一侧**，不是这一层拍的）：
 *
 * 1. **`execute` 是异步的**：bridge 立刻回 202，成败**从不**进请求的响应，只通过任务注册表暴露。
 *    所以「这一步成没成」只能在客户端轮询读到终态——轮询的两个默认值（500ms 间隔、30 秒余量）
 *    与终态判据（`success && state === 'completed'`）来自旧 n8n 引擎
 *    `custom-nodes/n8n-nodes-roboframe/nodes/shared/engine.ts`，那是已经跑过的实现，
 *    不是这里拍的（见 `PollSpec` 与 `stepCompleted`）。
 * 2. **分支读的就是那个 `success`**：`if` 步的条件只有 `last.success` 一个字段，
 *    它指的是**上一步轮询回来的 `success`**。所以分支在客户端判，而它读的量来自 bridge 的响应
 *    ——「轮询在哪一侧」这件事因此必须写清：**请求在客户端发、轮询也在客户端做**。
 */
import {
	DiagnosticCollector,
	canonicalJsonString,
	findCapability,
	sha256Hex,
	type BranchCondition,
	type CapabilityCatalog,
	type Diagnostic,
	type JsonObject,
	type SkillPlan,
	type SkillPlanOnFailure,
	type SkillPlanStep,
} from '@codecanvas/contracts';
// `TaskResult` / `ExecuteRequest` 是 **bridge 的形状**（`./models` 照 pydantic 镜像过来的），
// 不是我们契约里的类型——名字撞不上，但两个出处分清楚，别把 bridge 的字段当我们的契约用。
import { TERMINAL_TASK_STATES, type ExecuteRequest, type TaskResult } from './models';

/** task_id 的前缀缺省值。它只是让 id 认得出是从这儿来的。 */
export const DEFAULT_TASK_ID_PREFIX = 'plan';

/** `task_id` 的长度上限。出处是 bridge 的 `models.py`：`Field(min_length=1, max_length=128)`。 */
export const BRIDGE_TASK_ID_MAX_LENGTH = 128;

/** task_id 里摘要取多少位。够区分不同计划，又不至于把 id 撑长。 */
const TASK_ID_DIGEST_CHARS = 12;

/** 技能的端点。原语**没有**对应的端点——那是这一步送不出去的原因，不是漏写。 */
export const BRIDGE_EXECUTE_PATH = '/v1/skills/execute';

/** 任务查询路径。轮询与取消都走它（取消是 `{pollPath}/cancel`，这一版不编译取消）。 */
export const taskPath = (taskId: string): string => `/v1/tasks/${encodeURIComponent(taskId)}`;

/**
 * 轮询规格：**客户端**拿着它去问「这一步成没成」。
 *
 * 两个缺省值（500 / 30）与 `defaultTimeoutSec`（30）来自
 * `custom-nodes/n8n-nodes-roboframe/nodes/shared/engine.ts`（`DEFAULT_POLL_INTERVAL_MS` /
 * `DEFAULT_POLL_MARGIN_SEC` / `DEFAULT_SKILL_TIMEOUT_SEC`）——那是已经跑过的实现，
 * 这里照抄口径，不自己拍一个数。
 */
export interface PollSpec {
	/** 两次 `GET` 之间等多久。 */
	readonly intervalMs: number;
	/** 截止时间的余量：`deadline = (timeoutSec ?? defaultTimeoutSec) + marginSec`。 */
	readonly marginSec: number;
	/** 计划这一步没写 `timeoutSec` 时按多少秒算等待——引擎的口径，写在这儿让「等多久」只有一个答案。 */
	readonly defaultTimeoutSec: number;
}

export const DEFAULT_POLL_SPEC: PollSpec = Object.freeze({
	intervalMs: 500,
	marginSec: 30,
	defaultTimeoutSec: 30,
});

/**
 * 一条编译出来的调用。
 *
 * 三种 `kind` 说的是「这一步由谁做」，不是「这一步有多重要」：
 * - `execute`：**发到 bridge**。`request` 就是 `POST /v1/skills/execute` 的请求体（逐字对得上
 *   `ExecuteRequest`）；`pollPath` 是随后要轮询的那条路径；`poll` 是轮询规格（见 `PollSpec`）。
 * - `wait`：**客户端**等。bridge 不参与，所以没有请求、没有轮询——秒数原样带过来。
 * - `branch`：**客户端**判。bridge 没有分支端点，两条臂的调用照编（各自带自己的 `stepPath`），
 *   走哪条等运行时读到上一步的 `success` 才知道。条件原样带过来。
 *
 * `stepPath` 的口径与执行侧、studio 是同一份（`apps/robot3d/src/roboframe/plan.ts`）：
 * 第一段是**顶层下标（0 基）**，之后 `then` / `else` 各带一个臂内下标往下接，
 * 例如 `'1'` / `'1.then.0'` / `'1.then.1.else.0'`。
 */
export type PlanCall =
	| {
			readonly kind: 'execute';
			readonly request: ExecuteRequest;
			readonly pollPath: string;
			readonly stepPath: string;
			readonly poll: PollSpec;
			/**
			 * 这一步失败之后停不停——**给执行器读的**，不是给 bridge 的（`ExecuteRequest` 里没有这一栏，
			 * 这一栏也不进请求体）。缺省（不带这个键）＝ `'stop'`：失败即停。
			 *
			 * 为什么必须跟着编译产物走：计划里写了 `onFailure: 'continue'`，而编译把计划压成了调用列
			 * ——执行器手上只有这一列。不带这一栏，执行器就只能对每一步都按「停」来（`'continue'` 那半
			 * 边计划永远走不到），或者反过来去猜。它是**加的一栏**：老读者不看它就还是老行为。
			 */
			readonly onFailure?: SkillPlanOnFailure;
	  }
	| { readonly kind: 'wait'; readonly seconds: number; readonly stepPath: string }
	| { readonly kind: 'branch'; readonly condition: BranchCondition; readonly stepPath: string };

export interface CompiledPlan {
	/**
	 * 编译出来的调用，**按计划的深度优先顺序**：分支那一步自己先出一条 `branch`，
	 * 然后是 `then` 臂、再是 `else` 臂。顺序稳定，所以两份产物可以直接逐条对账。
	 */
	readonly calls: readonly PlanCall[];
	/**
	 * 编译期说出来的问题。**有诊断不等于整批作废**：能送的那些照编（`calls` 里还在），
	 * 要不要因此拒绝整批由调用方定（严的执行器会拒）。
	 */
	readonly diagnostics: readonly Diagnostic[];
}

export interface CompilePlanOptions {
	/** 设备报上来的目录。技能在不在里面，是**发不发**的判据（不在就不发，别拿 404 当校验）。 */
	readonly catalog: CapabilityCatalog;
	/**
	 * 这批调用是给哪台设备编的。它进 `task_id` 的摘要，于是**同一份计划发给两台设备是两串 id**
	 * （bridge 那边靠 task_id 认任务）。
	 */
	readonly deviceRef: string;
	/**
	 * `task_id` 的前缀。缺省 `'plan'`，所以**同一份计划两次编译得到同一串 id**（测试能逐字对账）。
	 * 真要下发第二次时，调用方传一个带时间戳的前缀——注册表拿 task_id 认任务，重号就是把两次执行记成一次。
	 */
	readonly taskIdPrefix?: string;
}

/** 编译期的诊断码。稳定词法：机器判断读码，不要去匹配 message。 */
export const BRIDGE_PLAN_DIAGNOSTIC_CODES = {
	/** 原语步：执行侧没有这个端点（见 `limits.ts` 里 `primitive` 那条）。 */
	primitiveUnsupported: 'bridge.plan.primitive_unsupported',
	/** 技能步：目录里没这个技能——不发出去换 404。 */
	skillUnknown: 'bridge.plan.skill_unknown',
} as const;

/**
 * 前缀的净化：只留 `[A-Za-z0-9_-]`（task_id 会进 URL 路径、命令行参数与注册表键，别的字符只是麻烦），
 * 去掉两头的横线；**一个可认的字符都没有就当没给**（退回缺省前缀）。
 * 最后这条是必要的：一串 `!!!` 净化完是一串 `--`，那是个认不出谁是谁的前缀——
 * 与其让它进 id，不如退回缺省（`'!!'` 与「没传」说的是同一件事）。
 */
const sanitizePrefix = (value: string): string => value.replace(/[^A-Za-z0-9_-]/g, '-').replace(/^-+|-+$/g, '');

/**
 * 一个 `task_id`：`<前缀>-<计划摘要>-<那一步的路径>`。
 *
 * **确定性**是硬要求（任务书 + 测试对账）：id 里一个随机数、一个时钟都不许有——
 * 同一份计划编译两次必须逐字相同。三条性质：
 * - 摘要覆盖 **计划 + 设备**（`canonicalJsonString` 排过键序，所以键序不影响结果）；
 * - 路径进 id，所以同一条计划里的每一步、每条臂各有各的 id；
 * - 前缀可以换（`taskIdPrefix`），**换前缀只换前缀**，后面那段仍然是同一串。
 *
 * 长度按 bridge 的上限（128）来：**从前缀那头截**——后面那段（摘要 + 路径）是唯一性的来源，
 * 截它会让两条臂撞号。理论上够不到（契约把分支深度限在 8 层），真到了就换一段短的稳定标识，
 * 不截断。
 */
const taskIdFor = (prefix: string, digest: string, stepPath: string): string => {
	const shortDigest = digest.slice(0, TASK_ID_DIGEST_CHARS);
	const slug = stepPath.split('.').join('-');
	const body = `${shortDigest}-${slug}`;
	const bounded = body.length <= BRIDGE_TASK_ID_MAX_LENGTH - 2 ? body : `${shortDigest}-${sha256Hex(stepPath).slice(0, 8)}`;
	const head = prefix.slice(0, Math.max(1, BRIDGE_TASK_ID_MAX_LENGTH - 1 - bounded.length));
	return `${head}-${bounded}`;
};

/** 这一步的超时（秒）。**计划没写就不给这一栏**（bridge 的 `timeout_sec` 缺省是 None，由它自己定）。 */
const timeoutOf = (step: { readonly timeoutSec?: number }): { readonly timeout_sec?: number } =>
	step.timeoutSec === undefined ? {} : { timeout_sec: step.timeoutSec };

/** 参数照原样（浅拷一份，免得调用方之后改了计划把编好的请求一起改掉）。 */
const paramsOf = (step: { readonly params?: JsonObject }): JsonObject => ({ ...(step.params ?? {}) });

/**
 * 计划 → 调用序列。**递归**走完整棵树（两条臂都要编出来——哪条真走要等运行时），
 * 对每一步按 `limits.ts` 那份清单分流。
 *
 * 三种「不发」的情况都要说清为什么，一条都不静默：
 * - **原语步**：执行侧没有原语端点（`POST /v1/skills/execute` 只认技能名，
 *   把原语名发过去换来的是 404）。诊断里就写这一句。
 * - **目录里没有的技能**：同样是 404，但不该拿去当校验——判据在这儿，不在对面。
 * - （`if` / `wait` 不是「不发」，是**本来就不该发**：它们在客户端做，照编成 call。）
 *
 * 校验参数值（类型、必填）**不在这里做**：那是 `@codecanvas/contracts` 的 `validateSkillPlan`
 * 的活，判据是同一份目录，重写一遍就是两份判据。这里只回答「送不送得出去」。
 */
export const compilePlanToCalls = (plan: SkillPlan, options: CompilePlanOptions): CompiledPlan => {
	const { catalog, deviceRef } = options;
	const collector = new DiagnosticCollector();
	const calls: PlanCall[] = [];

	// 摘要覆盖计划与设备：换一台设备就是另一串 id（bridge 靠 task_id 认任务）
	const digest = sha256Hex(canonicalJsonString({ device: deviceRef, plan }));
	const rawPrefix = sanitizePrefix(options.taskIdPrefix ?? DEFAULT_TASK_ID_PREFIX);
	const prefix = rawPrefix === '' ? DEFAULT_TASK_ID_PREFIX : rawPrefix;

	const walk = (steps: readonly SkillPlanStep[], basePath: string): void => {
		for (const [index, step] of steps.entries()) {
			// 路径第一段是顶层下标（0 基）；臂里的步在父路径后面接 `.then.0` / `.else.1`
			const stepPath = basePath === '' ? String(index) : `${basePath}.${String(index)}`;

			switch (step.step) {
				case 'skill': {
					if (findCapability(catalog, step.skill) === undefined) {
						collector.error({
							code: BRIDGE_PLAN_DIAGNOSTIC_CODES.skillUnknown,
							message: `目录「${catalog.displayName}」里没有技能「${step.skill}」——不发出去换 404（bridge 对不在目录里的技能回 404）`,
							path: `${stepPath}.skill`,
							ref: step.skill,
							details: {
								stepPath,
								skill: step.skill,
								catalog: catalog.catalogRef,
								revision: catalog.revisionRef,
								allowed: catalog.capabilities.map((item) => item.capabilityRef),
							},
						});
						break;
					}

					const taskId = taskIdFor(prefix, digest, stepPath);
					calls.push({
						kind: 'execute',
						// 请求体逐字对得上 bridge 的 ExecuteRequest（字段名照 python 那边写）
						request: {
							task_id: taskId,
							skill: step.skill,
							params: paramsOf(step),
							...timeoutOf(step),
						},
						pollPath: taskPath(taskId),
						stepPath,
						poll: DEFAULT_POLL_SPEC,
						// `onFailure` 刻意不进 `request`：bridge 的 ExecuteRequest 里没有这一栏，
						// 「失败之后停不停」是客户端看着轮询结果拿的主意，不是发给设备的命令。
						// 但它得进这条 call：执行器手上只有这一列调用（见 `PlanCall` 那一栏的说明）。
						...(step.onFailure === undefined ? {} : { onFailure: step.onFailure }),
					});
					break;
				}
				case 'primitive': {
					collector.error({
						code: BRIDGE_PLAN_DIAGNOSTIC_CODES.primitiveUnsupported,
						message: `原语步「${step.primitive}」送不到 bridge：bridge 只接技能（它的技能目录由 CLI 的 skill_templates 建出来，没有原语），把原语名当技能发进 ${BRIDGE_EXECUTE_PATH} 只会换来 404。这一步没有请求可发——要送得先给 bridge（或 CLI）加一条原语通路`,
						path: `${stepPath}.primitive`,
						ref: step.primitive,
						details: { stepPath, primitive: step.primitive, executePath: BRIDGE_EXECUTE_PATH },
					});
					break;
				}
				case 'wait': {
					// bridge 不参与等待：秒数原样带过来，客户端真的等（可被取消打断）
					calls.push({ kind: 'wait', seconds: step.seconds, stepPath });
					break;
				}
				case 'if': {
					calls.push({
						kind: 'branch',
						condition: { field: step.condition.field, op: step.condition.op, value: step.condition.value },
						stepPath,
					});
					// 两条臂都编出来：走哪条要等运行时读到上一步的 `success`，编译期猜不得。
					// 没有 `else`（条件不成立就什么也不做）时就没有那半边的调用。
					walk(step.then, `${stepPath}.then`);
					if (step.else !== undefined) walk(step.else, `${stepPath}.else`);
					break;
				}
			}
		}
	};

	walk(plan.plan, '');
	return { calls, diagnostics: collector.diagnostics };
};

/** 这个 state 是终态吗。口径与 bridge 的 `app.py`（`TERMINAL_STATES`）一致。 */
export const isTerminalTaskState = (state: string): boolean => TERMINAL_TASK_STATES.has(state);

/**
 * 轮询回来的 `success`——**分支读的就是这个量**。
 *
 * 口径照旧 n8n 引擎（`engine.ts`）：「bridge 报了布尔就用它，没报就拿 `state === 'completed'` 当结论」。
 * 分开成两个函数是有意的：`success` 是**设备对这一次执行的说法**，
 * 而「这一步算不算走完」还要看 state（见 `stepCompleted`）——两个问题不是同一个。
 */
export const reportedSuccess = (result: TaskResult): boolean =>
	typeof result.success === 'boolean' ? result.success : result.state === 'completed';

/**
 * 这一步算不算走完：**只有「成功且 state 是 completed」才算**（口径照 `engine.ts`：
 * `success && state === 'completed' ? 'completed' : 'failed'`）。
 *
 * 为什么不是只看 `success`：设备说「成」而状态停在 `canceled` / `unknown` 时，那就是没走完——
 * 把取消说成成功，计划会照着「上一步成了」往下走，而机器其实没动。
 */
export const stepCompleted = (result: TaskResult): boolean =>
	reportedSuccess(result) && result.state === 'completed';

/**
 * 轮询的截止时间（毫秒）：`(timeoutSec ?? defaultTimeoutSec) + marginSec`。
 *
 * 写成函数而不是散在执行器里：这个算式是「客户端等多久」的唯一答案，
 * 而它依赖两个来源（计划的 `timeoutSec`、引擎的缺省与余量），分开写迟早对不上。
 */
export const pollDeadlineMs = (timeoutSec: number | undefined, poll: PollSpec = DEFAULT_POLL_SPEC): number =>
	((timeoutSec ?? poll.defaultTimeoutSec) + poll.marginSec) * 1000;
