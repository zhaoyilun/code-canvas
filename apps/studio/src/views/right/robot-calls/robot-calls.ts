/**
 * 「发给机器人」视图的**数据**一侧：把「声明 + 目录 + 设备」算成一列**要发出去的请求**。
 *
 * 这一层只做三件事，一行判据都不自己写：
 *
 * 1. **还原**：`findTaskFormat(出生格式).fromDeclaration(declaration)` → `validateSkillPlan`。
 *    与右栏「虚拟设备」按下运行、任务 JSON 视图、写回的第二道闸走的是**同一个函数**
 *    （`buildPlanFromDeclaration`）——视图自己拼一份计划，迟早与真发出去的那份对不上。
 * 2. **编译**：`compilePlanToCalls(plan, { catalog, deviceRef })`。编出来的 `calls` 就是
 *    `POST /v1/skills/execute` 的请求体与随后要轮询的那条路径，一个字都不在这里改写。
 * 3. **摊平**：按**计划本身的顺序**把 `calls` 与 `diagnostics` 排成一行行。
 *
 * 为什么摊平要按计划走一遍、而不是把 `calls` 直接铺开：**诊断没有自己的行**。
 * 「原语送不了」那一步在 `calls` 里根本不存在——直接铺 `calls` 的话，屏幕上就是**少了一行**，
 * 看起来像计划里没有这一步。那是最坏的一种错：计划里明明有，界面装作没有。
 * 所以这里的顺序是「计划里第几步」的顺序，而每一步要么是一条请求（`execute`）、
 * 要么是一条本地动作（`wait` / `branch`）、要么是一条**送不出去**的诊断（`blocked`）。
 *
 * 顺序的骨架取自 `planStructureOf`（`views/shared/plan-structure.ts`）：链的次序、臂的次序
 * 与执行侧是同一份判据（`connections`），不是把 `calls` 猜着排一下。臂里的步按 `step` 的
 * 声明顺序下递归——与 `compilePlanToCalls` 同一个走法，于是两边的 `stepPath` 逐字对得上。
 */
import {
	validateSkillPlan,
	type CapabilityCatalog,
	type Diagnostic,
	type JsonValue,
	type SkillPlan,
	type SkillPlanStep,
	type WorkflowDeclaration,
	type WorkflowNode,
} from '@codecanvas/contracts';
import {
	BRIDGE_EXECUTE_PATH,
	BRIDGE_PLAN_DIAGNOSTIC_CODES,
	STEP_ROUTING,
	compilePlanToCalls,
	type CompiledPlan,
	type ExecuteRequest,
	type PlanCall,
	type StepRouting,
} from '@codecanvas/robot-bridge';
import {
	TASK_BRANCH_NODE_TYPE,
	TASK_PRIMITIVE_NODE_TYPE,
	TASK_WAIT_NODE_TYPE,
	findTaskFormat,
	type TaskFormatRef,
} from '@codecanvas/task-import';
import {
	conditionViewOf,
	planStructureOf,
	type PlanStep,
} from '../../shared/plan-structure';

/** 请求体里那几栏的顺序，照 bridge 的 `ExecuteRequest`（`task_id` / `skill` / `params` / `timeout_sec`）。 */
export interface RobotCallBodyField {
	/** 请求体里的字段名，**逐字照 bridge 的 python 那边写**（`timeout_sec`，不是 `timeoutSec`）。 */
	readonly field: string;
	/** 已经渲染成一行字的取值。 */
	readonly value: string;
}

/** 轮询那一行：请求在客户端发，**轮询也在客户端做**，所以间隔与余量都得摆出来。 */
export interface RobotCallPoll {
	/** `GET` 的路径。 */
	readonly path: string;
	/** 两次 `GET` 之间等多久（毫秒）。 */
	readonly intervalMs: number;
	/** 截止时间的余量（秒）：`(timeoutSec ?? defaultTimeoutSec) + marginSec`。 */
	readonly marginSec: number;
	/** 计划没写 `timeoutSec` 时按多少秒算等待。 */
	readonly defaultTimeoutSec: number;
	/** 这一步实际的截止秒数：`timeoutSec ?? defaultTimeoutSec` 再加余量。 */
	readonly deadlineSec: number;
}

/** 一行是什么。四档与「这一步会发什么」一一对应，不是重要程度。 */
export type RobotCallKind = 'execute' | 'wait' | 'branch' | 'blocked';

interface RobotCallRowBase {
	/** 行号，1 基：屏幕上第几行。 */
	readonly line: number;
	/** 这一步在计划树里的位置（`1.then.0`），与执行侧、studio 另几处同一个口径。 */
	readonly stepPath: string;
	/**
	 * 这一步在**声明里的次序**（1 基，`planStructureOf` 给的那个数）。
	 *
	 * 为什么不叫「第几步」：它不是顶层步的序号——臂里的每一步也有自己的号。流程卡上那句
	 * 「第 N 步」说的是顶层那一步（`VirtualDevicePanel` 的用法）；在这一屏里，一个序号配一条路径
	 * 才说得清「它在哪」，折成顶层编号会让臂里三行都写「第 2 步」。
	 */
	readonly nodeOrdinal: number;
	/** 这一步的去向——**从 `@codecanvas/robot-bridge` 的 `STEP_ROUTING` 读**，这里不写第二份。 */
	readonly routing: StepRouting;
}

/** 发到 bridge 的一步：请求 + 随后要轮询的那一行。 */
export interface RobotCallExecuteRow extends RobotCallRowBase {
	readonly kind: 'execute';
	/** `POST`。出处是 bridge 上挂 `ExecuteRequest` 的那个端点（`BRIDGE_EXECUTE_PATH`）。 */
	readonly method: string;
	readonly path: string;
	readonly body: readonly RobotCallBodyField[];
	readonly poll: RobotCallPoll;
}

/** 本地等：**不发请求**。 */
export interface RobotCallWaitRow extends RobotCallRowBase {
	readonly kind: 'wait';
	readonly seconds: number;
}

/** 本地判断：**不发请求**。 */
export interface RobotCallBranchRow extends RobotCallRowBase {
	readonly kind: 'branch';
	/** 条件的人话（`上一步成功 == 真`），与流程卡片上那句同一份判据。 */
	readonly conditionText: string;
}

/** 送不出去的一步：诊断**在它本来的位置上**，不是被省掉的那一行。 */
export interface RobotCallBlockedRow extends RobotCallRowBase {
	readonly kind: 'blocked';
	readonly code: string;
	readonly message: string;
}

export type RobotCallRow = RobotCallExecuteRow | RobotCallWaitRow | RobotCallBranchRow | RobotCallBlockedRow;

/**
 * 去掉一个键，**逐个成员去**。
 *
 * 直接用 `Omit<RobotCallRow, 'line'>` 是错的：`Omit` 不分配在联合上，它会把四个成员先并成一个
 * 「有几栏是可选的」的大对象，判别字段也就跟着松掉——那时传一条 `seconds` 给技能行也能过。
 * 这里让每一档各自 `Omit`，于是「哪一档有哪些栏」仍然是编译期钉住的。
 */
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

/** 顶部那一行摘要的三个数——**从实际编译结果数出来**，没有一个是写死的。 */
export interface RobotCallSummary {
	/** 会发出去的请求条数（就是 `execute` 的条数）。 */
	readonly requests: number;
	/** 在本地做的步数（`wait` + `branch`）。 */
	readonly local: number;
	/** 送不出去的步数（诊断条数）。 */
	readonly blocked: number;
}

export interface RobotCallsView {
	/** 编译出来的调用，一条不多一条不少——行是从它推的，不是另算的。 */
	readonly calls: readonly PlanCall[];
	readonly diagnostics: readonly Diagnostic[];
	readonly rows: readonly RobotCallRow[];
	readonly summary: RobotCallSummary;
	/**
	 * 没有位置的诊断。正常情况下是空的：编译期说的问题都带着它的 `stepPath`。
	 * 真有的时候**不许悄悄丢掉**——摆不出来位置，就摆到面板底部，并说明它不属于哪一步。
	 */
	readonly floatingDiagnostics: readonly Diagnostic[];
	/**
	 * 零条请求时的那句话。`null`＝有请求可发（这句话没有对象）。
	 * 出处是编译结果的三个数，不是「猜一份为什么」。
	 */
	readonly emptyReason: string | null;
}

/** 生成视图需要的一切。目录与设备都从外面给，这个模块不碰任何 store。 */
export interface RobotCallsInput {
	readonly declaration: WorkflowDeclaration;
	/** 拿哪把尺子还原 + 哪份目录判「技能在不在」。 */
	readonly formatRef: TaskFormatRef;
	readonly catalog: CapabilityCatalog;
	/** 这批调用是给哪台设备编的。它进 `task_id` 的摘要——同一份计划发给两台设备是两串 id。 */
	readonly deviceRef: string;
}

// ---------------------------------------------------------------------------
// 声明 → 技能计划
// ---------------------------------------------------------------------------

/**
 * 声明 → 能送出去的技能计划。**两种「不行」分得开**：
 *
 * - `format_mismatch`：这份声明不是技能计划格式产出的（一期设备那份）。它不是这台设备产出的东西，
 *   拿它硬套一份计划出来就是编——与右栏「虚拟设备」按下运行时的拒接**同一句话**；
 * - `plan_invalid`：格式对，但还原出来的计划过不了校验（诊断原样带出来，不吞）。
 *
 * 诊断码是本视图自己的：它说的是「这一屏为什么没有内容」，不是 bridge 的诊断
 * （`bridge.plan.*` 说的是「这一步送不出去」，两者不是一回事）。
 */
export type RobotPlanBuild =
	| { readonly ok: true; readonly plan: SkillPlan; readonly diagnostics: readonly Diagnostic[] }
	| { readonly ok: false; readonly reason: 'format_mismatch' | 'plan_invalid'; readonly diagnostics: readonly Diagnostic[] };

export const buildPlanFromDeclaration = (input: RobotCallsInput): RobotPlanBuild => {
	if (input.formatRef !== 'skill_plan') {
		return { ok: false, reason: 'format_mismatch', diagnostics: [] };
	}
	// 还原这一步归格式管：与写回的第二道闸、任务 JSON 视图是同一个函数。
	const document = findTaskFormat(input.formatRef).fromDeclaration(input.declaration);
	const result = validateSkillPlan(document, {
		catalog: input.catalog,
		...(input.catalog.robotName === undefined ? {} : { expectedRobot: input.catalog.robotName }),
	});
	if (!result.ok) return { ok: false, reason: 'plan_invalid', diagnostics: result.diagnostics };
	return { ok: true, plan: result.plan, diagnostics: result.diagnostics };
};

// ---------------------------------------------------------------------------
// 渲染小件
// ---------------------------------------------------------------------------

/** 一行的值：JSON 的字面写法（字符串带引号）。与任务 JSON 视图同一个口径。 */
const literal = (value: JsonValue): string => JSON.stringify(value) ?? 'null';

/**
 * 编译出来的 `request`（**逐字对得上 bridge 的 `ExecuteRequest`**）→ 要显示的那几行。
 *
 * 四栏的顺序照 bridge 的 `models.py` 写（`task_id` / `skill` / `params` / `timeout_sec`）：
 * 键名逐字照 python 那边，所以这里不 camelCase 化。**哪些栏存在仍由 `request` 说了算**：
 * `timeout_sec` 在 bridge 那边缺省是 None，计划没写就**不显示这一行**——
 * 显示成 0 就是把「没写」说成了「写了 0 秒」，而 0 秒的超时不是一个超时。
 */
const bodyOfRequest = (request: ExecuteRequest): readonly RobotCallBodyField[] => {
	const fields: RobotCallBodyField[] = [
		{ field: 'task_id', value: literal(request.task_id) },
		{ field: 'skill', value: literal(request.skill) },
		{ field: 'params', value: literal(request.params) },
	];
	if (request.timeout_sec !== undefined && request.timeout_sec !== null) {
		fields.push({ field: 'timeout_sec', value: String(request.timeout_sec) });
	}
	return fields;
};

/** 一条 `execute` 的轮询那一行：间隔/余量来自编译期带的 `PollSpec`，截止秒数是它算出来的。 */
const pollOf = (call: Extract<PlanCall, { kind: 'execute' }>): RobotCallPoll => {
	const timeoutSec = call.request.timeout_sec ?? undefined;
	return {
		path: call.pollPath,
		intervalMs: call.poll.intervalMs,
		marginSec: call.poll.marginSec,
		defaultTimeoutSec: call.poll.defaultTimeoutSec,
		deadlineSec: (timeoutSec ?? call.poll.defaultTimeoutSec) + call.poll.marginSec,
	};
};

/**
 * 条件的人话。**从声明里那一步读**（节点的 `condition` 参数），用 `plan-structure` 的
 * `conditionViewOf` 渲染——流程卡上那句「如果 上一步成功 == 假」就是它，不另写一套说法。
 * 节点丢了或条件被改坏了，`conditionViewOf` 自己会说「条件缺失」，这里不编一个条件。
 */
const conditionTextOf = (node: WorkflowNode | null): string =>
	node === null ? '条件缺失' : conditionViewOf(node).text;

/** 这一步的去向。清单在 `@codecanvas/robot-bridge` 的 `limits.ts` 里，这里只查表。 */
const routingOfStep = (kind: SkillPlanStep['step']): StepRouting =>
	STEP_ROUTING.find((entry) => entry.step === kind) ?? {
		// `STEP_ROUTING` 认不出这种步时**不编一格**：把「不知道去哪儿」如实说出来。
		step: kind,
		where: 'nowhere',
		note: `limits.ts 的清单里没有「${kind}」这一类步：不知道它去哪儿，也就谈不上发不发`,
	};

// ---------------------------------------------------------------------------
// 摊成一行行
// ---------------------------------------------------------------------------

/**
 * 一种 call 对应哪一种计划步。写成查表而不是靠 `if` 猜：加了新的 call 形状时，
 * 类型上就漏不过去（`PlanCall['kind']` 多一个成员，这张表就少一个键，编译期报错）。
 * 这也是**唯一的判据**——别处不许再假设「wait 一定是计划里的 wait 步」。
 */
const STEP_KIND_OF: Readonly<Record<PlanCall['kind'], SkillPlanStep['step']>> = {
	execute: 'skill',
	wait: 'wait',
	branch: 'if',
};

/**
 * 这一步的调用，**且这一步与那条调用说的是同一种步**。
 *
 * 为什么要比这一步：`calls` 与声明是两条路（一条从计划编译，一条从 `connections` 走），
 * 正常时逐字对得上，但声明被改坏时可能对不上。对不上就**当这一步没有调用**——
 * 于是它落到下面那条「没有请求就给诊断」的路上（诊断没有时说一句「编译器本该二选一」），
 * 而不是把一条 `wait` 调用挂到一个技能步上画出来。
 */
const callForStep = (
	call: PlanCall | undefined,
	stepKind: SkillPlanStep['step'],
): PlanCall | undefined =>
	call !== undefined && STEP_KIND_OF[call.kind] === stepKind ? call : undefined;

/** 每一步在 `calls` 里的那一条（没有就是这一步没编译出调用），按 `stepPath` 认。 */
const callIndex = (calls: readonly PlanCall[]): ReadonlyMap<string, PlanCall> =>
	new Map(calls.map((call) => [call.stepPath, call]));

/** 每条诊断属于哪一步。`details.stepPath` 是编译期写下的（见 `compile.ts`），不是这里猜的。 */
const diagnosticsByPath = (diagnostics: readonly Diagnostic[]): ReadonlyMap<string, Diagnostic[]> => {
	const map = new Map<string, Diagnostic[]>();
	for (const diagnostic of diagnostics) {
		const path = diagnostic.details?.['stepPath'];
		if (typeof path !== 'string') continue;
		map.set(path, [...(map.get(path) ?? []), diagnostic]);
	}
	return map;
};

/**
 * 一层步骤 + 它所属的路径 → 一行行。
 *
 * `steps` 是 `planStructureOf` 走出来的那一层（链的次序已定），臂里的步照它各臂自己的次序下递归——
 * 与 `compilePlanToCalls` 同一个结果，所以两边的 `stepPath` 逐字对得上，`calls`/`diagnostics`
 * 按路径取得到。
 */
const walkLayer = (
	steps: readonly PlanStep[],
	basePath: string,
	callAt: ReadonlyMap<string, PlanCall>,
	diagnosticsAt: ReadonlyMap<string, Diagnostic[]>,
	rows: RobotCallRow[],
): void => {
	for (const [index, step] of steps.entries()) {
		const stepPath = basePath === '' ? String(index) : `${basePath}.${index}`;
		const node = step.node;
		const stepKind = stepKindOfNode(node);
		const routing = routingOfStep(stepKind);

		/** 这一行共有的那几栏。行号在推入时才算——它说的是「屏幕上第几行」。 */
		const base = { stepPath, nodeOrdinal: step.index + 1, routing };

		const push = (row: DistributiveOmit<RobotCallRow, 'line'>): void => {
			// 行号最后补：它是行在**这一列里**的位置，跟着行一起长，不在别处维护一份计数。
			rows.push({ ...row, line: rows.length + 1 });
		};

		const call = callForStep(callAt.get(stepPath), stepKind);
		if (call !== undefined) {
			switch (call.kind) {
				case 'execute':
					push({
						...base,
						kind: 'execute',
						method: 'POST',
						path: BRIDGE_EXECUTE_PATH,
						body: bodyOfRequest(call.request),
						poll: pollOf(call),
					});
					break;
				case 'wait':
					push({ ...base, kind: 'wait', seconds: call.seconds });
					break;
				case 'branch':
					push({ ...base, kind: 'branch', conditionText: conditionTextOf(node) });
					break;
			}
		} else {
			// 这一步没有调用。正常只有一种来路：它**送不出去**，编译期给了诊断。
			// 诊断一条不落地摆在这儿——少一行是最坏的（看起来像计划里没有这一步）。
			const causes = diagnosticsAt.get(stepPath) ?? [];
			if (causes.length > 0) {
				for (const cause of causes) {
					push({ ...base, kind: 'blocked', code: cause.code, message: cause.message });
				}
			} else {
				// 既没有调用、也没有诊断：编译器的接口是「每一步要么给调用、要么给诊断」，
				// 走到这儿说明那份前提不成立了。如实说一句，不编一条请求出来。
				push({
					...base,
					kind: 'blocked',
					code: 'robot_calls.step_unaccounted',
					message: `这一步（${stepPath}）既没有编出请求，也没有诊断说明为什么——编译器本该二选一，这里如实标出来，不当它不存在`,
				});
			}
		}

		// 臂里的步接着走：路径按 `.then.0` / `.else.1` 接下去（与执行侧同一个口径）。
		for (const arm of step.arms) {
			walkLayer(arm.steps, `${stepPath}.${arm.kind}`, callAt, diagnosticsAt, rows);
		}
	}
};

/** 计划层节点 → 它那种计划步。节点类型是**声明侧**的事实，四种各归各的。 */
const stepKindOfNode = (node: WorkflowNode): SkillPlanStep['step'] => {
	if (node.type === TASK_BRANCH_NODE_TYPE) return 'if';
	if (node.type === TASK_WAIT_NODE_TYPE) return 'wait';
	if (node.type === TASK_PRIMITIVE_NODE_TYPE) return 'primitive';
	return 'skill';
};

/** 零条请求时那句话。三句都说得出「为什么」，因为它们是三个不同的数推出来的。 */
const emptyReasonOf = (summary: RobotCallSummary, rows: readonly RobotCallRow[]): string | null => {
	if (summary.requests > 0) return null;
	if (summary.blocked > 0) {
		return `这份计划一条请求都发不出去：${String(summary.blocked)} 步卡在上面那几条诊断上（每一条都在它本来的位置上）`;
	}
	if (rows.length > 0) {
		return `这份计划没有一条请求：${String(summary.local)} 步都在本地做（等与判断），bridge 一个字节都收不到`;
	}
	return '这份计划里没有步：还原出来是一份空计划（校验本该拦住它，这里如实说没有内容可发）';
};

/**
 * 「声明 + 目录 + 设备」→ 这一屏要显示的每一行。
 *
 * `compiled` 由调用方给（它已经拿同一份计划编过一次）：这里不重编——重编一次就是两次编译，
 * 而这一屏的意义正是「**这一次**编出来的东西长什么样」。声明只用来取**顺序**与**条件的人话**
 * （`planStructureOf` / `conditionViewOf`），一格判据都不从这里再算一遍。
 */
export const robotCallsView = (input: {
	readonly declaration: WorkflowDeclaration;
	readonly compiled: CompiledPlan;
}): RobotCallsView => {
	const { calls, diagnostics } = input.compiled;
	const rows: RobotCallRow[] = [];

	walkLayer(
		planStructureOf(input.declaration).steps,
		'',
		callIndex(calls),
		diagnosticsByPath(diagnostics),
		rows,
	);

	// 摆不出位置的诊断：不丢，摆到面板底部（那里会说清它不属于具体哪一步）。
	const placed = new Set(rows.filter((row) => row.kind === 'blocked').map((row) => row.code));
	const floatingDiagnostics = diagnostics.filter((diagnostic) => !placed.has(diagnostic.code));

	const summary: RobotCallSummary = {
		// 三个数都从**编译结果**数出来：请求看 `calls`，本地步看行，送不出去的看诊断。
		requests: calls.filter((call) => call.kind === 'execute').length,
		local: rows.filter((row) => row.kind === 'wait' || row.kind === 'branch').length,
		blocked: diagnostics.length,
	};

	return { calls, diagnostics, rows, summary, floatingDiagnostics, emptyReason: emptyReasonOf(summary, rows) };
};

// ---------------------------------------------------------------------------
// 一屏 = 还原 + 编译 + 摊平
// ---------------------------------------------------------------------------

/** 编译不了的那两种情形：面板据此说「这份声明不是这台设备产出的」或「计划过不了校验」。 */
export type RobotCallsBlocked = {
	readonly ok: false;
	readonly reason: 'format_mismatch' | 'plan_invalid';
	readonly diagnostics: readonly Diagnostic[];
};

export type RobotCallsResult = { readonly ok: true; readonly view: RobotCallsView } | RobotCallsBlocked;

/**
 * 一屏的全过程：声明 → 计划 → 调用 → 行。接口是纯的（目录、设备、声明都由外面给），
 * 组件只负责把 store 里的三样东西喂进来。
 */
export const compileDeclarationToCalls = (input: RobotCallsInput): RobotCallsResult => {
	const built = buildPlanFromDeclaration(input);
	if (!built.ok) return { ok: false, reason: built.reason, diagnostics: built.diagnostics };

	const compiled = compilePlanToCalls(built.plan, {
		catalog: input.catalog,
		deviceRef: input.deviceRef,
	});
	return { ok: true, view: robotCallsView({ declaration: input.declaration, compiled }) };
};

/** 一句话说清「这一步会发到哪儿」——面板把路由清单里那句 note 原样展示。 */
/**
 * 这份计划里有几步**编译期就编不出请求**（现在只有一种：`primitive` 步——bridge 只接技能）。
 *
 * 为什么要单独数它：这种步**不产生运行事件**，所以步骤账本里根本没有它那一行 ——
 * 只看行的话它会整个消失，屏幕上于是写着「3 步都走通了」，而真发出去的只有 2 条请求。
 * 实测撞到过：模型把「张开夹爪」生成成原语步，同一屏上「2 条请求 · 1 步送不出去」
 * 与「3 步都走通了」当场打架。判据取自编译器的诊断码，不是自己再数一遍计划。
 */
export const blockedStepCountOf = (
	plan: SkillPlan,
	context: { readonly catalog: CapabilityCatalog; readonly deviceRef: string },
): number =>
	compilePlanToCalls(plan, context).diagnostics.filter(
		(diagnostic) => diagnostic.code === BRIDGE_PLAN_DIAGNOSTIC_CODES.primitiveUnsupported,
	).length;

export const routingNoteOf = (step: SkillPlanStep['step']): string => routingOfStep(step).note;

/**
 * 三类去向在界面上的**读法**（徽标上那几个字）。
 *
 * 为什么放在这儿而不是模板里：`where` 是 `@codecanvas/robot-bridge` 定的三个取值，
 * 界面只是给它配一个中文写法。写在模板里就成了第二份「有哪几档」的清单——
 * 加一档时模板不会报错，只会安静地少显示一种。
 */
export const ROUTING_FACE: Readonly<Record<StepRouting['where'], string>> = {
	bridge: '发给 bridge',
	client: '本地',
	nowhere: '送不出去',
};
