/**
 * 「发给机器人」视图（右栏下半块的第三个 tab）：**这份声明编译成 bridge 会收到的请求序列**，
 * 以及**把那一列请求真发一次**（`runCompiledPlan`）之后每一步落在了哪里。
 *
 * 它和另外两个 tab 是同一件事的三种看法：代码面板看「选中模块内部怎么做」，
 * 任务 JSON 看「整份任务对外是什么」，这里看「这一句话真的发出去会变成哪些请求」。
 *
 * 两条路别混：这个 tab 的「下发」是**真的 HTTP** 发给 bridge；
 * 右栏上半块那块 3D 的「在虚拟设备上运行」跑的是**本机的仿真执行器**，一个网络请求都不发。
 *
 * 数据一侧分两份，都是纯函数，可以单独测：
 * - `robot-calls.ts`：还原 + 编译 + 摊平（**编译期的事实**，请求一个字节都不改）；
 * - `plan-run.ts`：事件对回行、`unreachable` 与 `failed` 各说什么、基地址的存取（**运行时的事实**）。
 *   两者都不碰 store，网络只在组件调 `runCompiledPlan` 时真的发生。
 */
export { default as RobotCallsPanel } from './RobotCallsPanel.vue';
export {
	BLOCKED_ROW_RUN_NOTE,
	BRIDGE_BASE_URL_STORAGE_KEY,
	DEFAULT_BRIDGE_BASE_URL,
	DISPATCH_PATH_NOTE,
	DISPATCH_PATH_SHORT,
	RUN_STATE_FACE,
	RUN_STATE_MEANING,
	RUN_STATE_TONE,
	compiledOf,
	dispatchGateOf,
	orphanRunPaths,
	readBridgeBaseUrl,
	runStatesByStepPath,
	runVerdictOf,
	writeBridgeBaseUrl,
	type DispatchGate,
	type PlanRunState,
	type RowRun,
	type RunTone,
	type RunVerdict,
} from './plan-run';
export {
	ROUTING_FACE,
	buildPlanFromDeclaration,
	compileDeclarationToCalls,
	robotCallsView,
	routingNoteOf,
	type RobotCallBlockedRow,
	type RobotCallBodyField,
	type RobotCallBranchRow,
	type RobotCallExecuteRow,
	type RobotCallKind,
	type RobotCallPoll,
	type RobotCallRow,
	type RobotCallSummary,
	type RobotCallWaitRow,
	type RobotCallsBlocked,
	type RobotCallsInput,
	type RobotCallsResult,
	type RobotCallsView,
	type RobotPlanBuild,
} from './robot-calls';
