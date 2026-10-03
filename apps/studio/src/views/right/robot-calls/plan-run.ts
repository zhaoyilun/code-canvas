/**
 * 「发给机器人」视图的**下发**那一侧：把 `runCompiledPlan` 吐出来的事件对回它自己那一行。
 *
 * 这一层与 `robot-calls.ts` 分工明确，别混：
 * - `robot-calls.ts` 说「**会发出去的是什么**」——编译期的事实，一个字节都不改（那是契约）；
 * - 这里说「**真发出去之后发生了什么**」——运行时的事实，一步步落在它自己那一行上。
 *
 * 三件事在这里定死，因为它们是这一屏最容易被读错的地方：
 *
 * 1. **事件按 `stepPath` 对号**：`running` / 终态都带 `stepPath`，与编译产物、执行侧、studio
 *    是同一份口径，所以「这一步的结果」不需要另开一个列表——它落在这一步那一行上。
 *    同一个路径可能来两条（`execute` 先 `running` 再终态），**后到的那条说了算**：界面看的是
 *    「此刻这一步是什么状态」，不是流水账（流水账在事件的完整列表里，不在行上）。
 * 2. **`unreachable` 与 `failed` 是两件事**，各有一句话、各有一种观感（见 `RUN_STATE_MEANING`
 *    与 `RUN_STATE_TONE`）。混起来的代价很具体：接上真机器人之后，「发不出去」会被当成
 *    「这一步跑过、没成」，于是后面的计划照着一个编造的成败往下走——那是编。
 * 3. **送不出去的那一步不参与下发**（`BLOCKED_ROW_RUN_NOTE`）。它在编译期就没有请求可编
 *    （`limits.ts` 的 `where: 'nowhere'`），所以执行器的事件流里根本没有它。这一行上要说得出来
 *    ——不说，看起来就像「下发漏了一步」。
 *
 * 诊断原文**照原样**摆（`RowRun.detail` 就是 `PlanRunEvent.detail`，一个字不改）：那是设备
 * 那一侧说的话，改写了就不是证据了。
 */
import type { CompiledPlan, PlanRunEvent, PlanRunResult } from '@codecanvas/robot-bridge';
import type { RobotCallsResult } from './robot-calls';

/** 这一步现在的状态。取值**从执行器那里推**（`PlanRunEvent['state']`），界面不另立一套。 */
export type PlanRunState = PlanRunEvent['state'];

/** 一行上的运行态。 */
export interface RowRun {
	readonly state: PlanRunState;
	/** 诊断/说明原文，**照抄**执行器给的那句（`detail` 可能没有，那就是空串）。 */
	readonly detail: string;
	/** 这一步的 `task_id`（只有 `execute` 有；等待与分支没有任务）。 */
	readonly taskId: string | null;
}

/**
 * 事件流 → 「哪一行现在是什么样」。
 *
 * 同一个路径上后到的覆盖先到的：`execute` 先报 `running`（请求已经在设备那边了），
 * 随后报它那一条终态——行上该显示的是终态。中途取消时只留下 `running`，那正是「停在当下」。
 */
export const runStatesByStepPath = (events: readonly PlanRunEvent[]): ReadonlyMap<string, RowRun> => {
	const map = new Map<string, RowRun>();
	for (const event of events) {
		map.set(event.stepPath, {
			state: event.state,
			detail: event.detail ?? '',
			taskId: event.taskId ?? null,
		});
	}
	return map;
};

/**
 * 事件里那些**对不上任何一行**的 `stepPath`。
 *
 * 正常是空的：事件与行都由**同一次编译**产生，`stepPath` 逐字一样。真出现只有一种来路——
 * 下发途中上面换了一份声明（入口带能生成新任务），行重画了，而事件还是旧那一份的。
 * 那时**不许把它们咽掉**：屏幕上会显得「那几步没发生过」，而它们确实发生过。
 * 与 `floatingDiagnostics` 同一条纪律：摆不出位置的，就说它摆不出位置。
 */
export const orphanRunPaths = (events: readonly PlanRunEvent[], stepPaths: readonly string[]): readonly string[] => {
	const known = new Set(stepPaths);
	const orphans: string[] = [];
	for (const event of events) {
		if (known.has(event.stepPath)) continue;
		if (orphans.includes(event.stepPath)) continue;
		orphans.push(event.stepPath);
	}
	return orphans;
};

/**
 * 一档状态在界面上的**读法**（徽标上那几个字）。
 *
 * 为什么不写在模板里：`state` 是执行器定的五个取值，界面只是给它配一个中文写法。
 * 写在模板里就成了第二份「有哪几档」的清单——加一档时模板不会报错，只会安静地少显示一种
 * （与 `ROUTING_FACE` 同一条理由）。
 *
 * `unreachable` 那三个字刻意**不用**「失败」二字：它不是失败，是没到（见下面那句说明）。
 */
export const RUN_STATE_FACE: Readonly<Record<PlanRunState, string>> = {
	running: '下发中',
	completed: '已完成',
	failed: '跑了没成',
	unreachable: '发不出去',
	skipped: '跳过',
};

/**
 * 一档状态的**观感**。同档同色，不同档不同色——尤其 `unreachable` 与 `failed`：
 *
 * - `failed` 是**业务失败**：请求发出去了、机器动了、结果是没成。它该报警（危险色、实边）。
 * - `unreachable` 是**没到**：连不上，或者这台设备不认这个技能（404）。机器可能一步都没动，
 *   所以它**不染危险色**——染成红的就会被读成「这一步试过了、没成」，而那正是要防止的误读。
 *   它用安静色 + 虚线：显眼，但不像失败那样报警。
 */
export type RunTone = 'live' | 'ok' | 'failed' | 'unreachable' | 'skipped';

export const RUN_STATE_TONE: Readonly<Record<PlanRunState, RunTone>> = {
	running: 'live',
	completed: 'ok',
	failed: 'failed',
	unreachable: 'unreachable',
	skipped: 'skipped',
};

/**
 * 一档状态**说的是一件什么事**。这五句是这一屏的分辨率所在：
 * 「发了没成」与「根本没发出去」差着一台机器动没动，句子必须分得开。
 */
export const RUN_STATE_MEANING: Readonly<Record<PlanRunState, string>> = {
	running: '请求已经在设备那边了（bridge 收了 202），成败还没读到——轮询里',
	completed: '发出去了、机器跑了、走完了：轮询读到终态，且这一步算走完',
	failed:
		'发出去了、机器真的跑了，而结果是没成（轮询读到的终态不算走完，或在预算里没读到终态）——这是业务失败',
	unreachable:
		'发不出去：请求没到设备（连不上，或这台设备不认这个技能）——机器可能一步都没动。这不是业务失败，不许按「这一步试过了、没成」往下走',
	skipped: '跳过：这一步没做，也不是因为失败（前面还没有可读的成败，条件判不出来就不猜一条臂走）',
};

/** 送不出去那一行上那句话：它在编译期就编不出请求，所以下发时它不在事件流里。 */
export const BLOCKED_ROW_RUN_NOTE =
	'不参与下发：编译期它就编不出请求，所以事件流里没有它——是它本来就没有可发的东西，不是下发漏了一步。';

/** 顶部那句「两条路各是什么」的**全句**。挂在按钮的 `title` 上——问它才说。 */
export const DISPATCH_PATH_NOTE =
	'这里的「下发」是真的 HTTP 发给 bridge 的基地址（请求一个字节都不改）；选虚拟设备那台时右栏上的「运行」跑的是本机仿真执行器，一个网络请求都不发；选真机时右栏那个「运行」与这里的「下发」是同一条路（同一个基地址）。';

/**
 * 同一件事的**一行版**（面板上摆的是它，全句在 `title` 里）。
 *
 * 为什么要有两版：这一块面板在 800px 高的窗口里只有 227px（3D 占大头），
 * 而全句在 435px 宽里要两行——那两行就是 35px，占掉行列表的四成（量过）。
 * 一行版仍然把两件事各说清一句（真下发 / 本机仿真），只是不再展开为什么。
 */
export const DISPATCH_PATH_SHORT = '这里是真下发（HTTP 给 bridge）；选虚拟设备那台时「运行」是本机仿真，不发请求。';

// ---------------------------------------------------------------------------
// 基地址：照 `shell/TaskInputBand.vue` 里那个 LLM 地址输入的做法（同一个骨架）
// ---------------------------------------------------------------------------

/** 存哪一格。与 `codecanvas.task-endpoint` 同一族——联调时那两个地址一起改。 */
export const BRIDGE_BASE_URL_STORAGE_KEY = 'codecanvas.bridge-base-url';

/** bridge 的缺省地址。`tools/fake-bridge/` 起的那个替身就在这个端口上。 */
export const DEFAULT_BRIDGE_BASE_URL = 'http://127.0.0.1:8788';

/** 读基地址。存不下/读不出都退到缺省——地址记不住是小事，不该把整块面板弄挂。 */
export const readBridgeBaseUrl = (): string => {
	try {
		const stored = window.localStorage.getItem(BRIDGE_BASE_URL_STORAGE_KEY);
		return stored === null || stored.trim() === '' ? DEFAULT_BRIDGE_BASE_URL : stored;
	} catch {
		// 隐私模式下 localStorage 会直接抛。与入口带那个 LLM 地址同一处兜底。
		return DEFAULT_BRIDGE_BASE_URL;
	}
};

/** 记基地址。存不下就存不下：这一次下发照样发得出去。 */
export const writeBridgeBaseUrl = (value: string): void => {
	try {
		window.localStorage.setItem(BRIDGE_BASE_URL_STORAGE_KEY, value);
	} catch {
		// 同上：地址留不住不影响这一次下发。
	}
};

// ---------------------------------------------------------------------------
// 「能不能按下去」与「按下去之后怎么了」
// ---------------------------------------------------------------------------

/**
 * 下发要发的那一份**就是这一屏摊开的那一份**——从编译结果里原样取出 `calls` 与 `diagnostics`，
 * 不重编一次。
 *
 * 为什么强调这一条：重编一次就是两次编译，而这一屏的意义正是「**这一次**编出来的东西长什么样」。
 * 屏幕上摆的请求与真发出去的请求必须是同一列调用，否则「所见即所发」这句话就不成立了。
 */
export const compiledOf = (result: RobotCallsResult | null): CompiledPlan | null => {
	if (result === null || !result.ok) return null;
	return { calls: result.view.calls, diagnostics: result.view.diagnostics };
};

/** 「下发」按不按得动，以及按不动时的原因。灰按钮自己不解释，所以那句原因必须有。 */
export interface DispatchGate {
	readonly allowed: boolean;
	readonly reason: string | null;
}

/**
 * 按不按得动。四种按不动的情形各说各的话——它们要用户做的事完全不同：
 * 没有声明（先生成一份）、出生格式不对（换台设备再生成）、计划过不了校验（去改计划）、
 * 一份请求都没有（这份计划全在本地做）。
 */
export const dispatchGateOf = (input: {
	readonly hasDeclaration: boolean;
	readonly result: RobotCallsResult | null;
	readonly baseUrl: string;
}): DispatchGate => {
	if (!input.hasDeclaration) {
		return { allowed: false, reason: '还没有声明：先在上面写一句话生成任务（或直接粘贴一份计划），才有东西可发。' };
	}
	const result = input.result;
	if (result === null) {
		return { allowed: false, reason: '这份声明还编不出调用（没有可用设备或目录）——没有东西可发。' };
	}
	if (!result.ok) {
		if (result.reason === 'format_mismatch') {
			return {
				allowed: false,
				reason: '这份声明的出生格式不是技能计划：它不是这台设备产出的，编译不出请求，也就没有东西可发。',
			};
		}
		return {
			allowed: false,
			reason: `计划过不了校验（${String(result.diagnostics.length)} 条诊断）：没有请求可编，先按上面那几条改计划。`,
		};
	}
	if (result.view.summary.requests === 0) {
		return {
			allowed: false,
			reason: `这份计划一条请求都没有（${String(result.view.summary.local)} 步在本地做、${String(result.view.summary.blocked)} 步送不出去）：bridge 一个字节都收不到。`,
		};
	}
	if (input.baseUrl.trim() === '') {
		return { allowed: false, reason: '先填 bridge 的基地址——不知道发给谁，就没有「下发」这件事。' };
	}
	return { allowed: true, reason: null };
};

/** 整份计划跑完之后的结论。 */
export interface RunVerdict {
	/** 「走完了」/「已请求取消」/「停在当下」。 */
	readonly face: string;
	/** 那句话说清停在哪、为什么——`reason` 来自执行器，**原文照抄**，这里不重写。 */
	readonly detail: string;
}

/**
 * 一次下发的结论。
 *
 * 「用户按过取消」与「执行器说自己被取消了」是两件事，但对不对得上是可判的：取消是按了之后
 * 才成立的，所以只有 `cancelRequested` 为真时才说「已请求取消」。此时执行器那句 `reason`
 * （「第 X 步的请求已经发出去了，设备那边可能还在跑——我们不替它下结论」）原样摆出来——
 * 取消**不是失败**，所以这里不判成败，只说停在哪。
 */
export const runVerdictOf = (input: {
	readonly outcome: PlanRunResult;
	readonly cancelRequested: boolean;
}): RunVerdict => {
	if (!input.outcome.ok && input.cancelRequested) {
		return {
			face: '已请求取消',
			detail: input.outcome.reason ?? '已请求取消：整份计划停在当下（执行器没给停在哪，这里不替它编一句）',
		};
	}
	if (input.outcome.ok) {
		return {
			face: '走完了',
			detail: '整份计划走完了——被容忍的失败不拦（那一步照报失败，计划继续往下走）',
		};
	}
	return {
		face: '停在当下',
		detail: input.outcome.reason ?? '整份计划没走完，而执行器没给原因——这里如实说不知道停在哪',
	};
};

// ---------------------------------------------------------------------------
// 对面是谁
// ---------------------------------------------------------------------------

/**
 * 那句「这是它自己报的」的**全句**，挂在探针那一行的 `title` 上。
 *
 * 为什么必须写出来：202 与终态只说明**有人接了这件活**。开发替身（`tools/fake-bridge`）
 * 没有机器人也没有夹爪，收到什么都会按时回一个 `success=true`——那份「走完了」是真 HTTP
 * 换回来的，却**不是一次真的动作**。所以这一行报的是对面**自报的**服务名与版本，
 * 不加一个字：`fake-bridge-0` 摆在那儿，看的人自己就知道那是替身。
 */
export const BRIDGE_IDENTITY_NOTE =
	'这一行是 bridge 自报的服务名与版本（`GET /v1/health`，原样照抄）。它说自己是替身还是真身，由它自己说——我们不替它下结论。要留意：202 与终态只说明有人接了这件活，不说明接活的那位真的动过。';

/** 探不到时那一行的前缀。探不到**不是失败**（有些部署不给 health），所以照实说，不拦下发。 */
export const BRIDGE_IDENTITY_UNKNOWN = '对面探不到';
