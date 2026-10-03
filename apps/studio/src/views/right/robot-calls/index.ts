/**
 * 「发给机器人」视图（右栏下半块的第三个 tab）：**这份声明编译成 bridge 会收到的请求序列**。
 *
 * 它和另外两个 tab 是同一件事的三种看法：代码面板看「选中模块内部怎么做」，
 * 任务 JSON 看「整份任务对外是什么」，这里看「这一句话真的发出去会变成哪些请求」。
 *
 * 数据一侧（还原 + 编译 + 摊平）在 `robot-calls.ts` 里，是纯函数，可以单独测：
 * 目录、设备、声明都由外面给，它不碰 store，也不发任何请求。
 */
export { default as RobotCallsPanel } from './RobotCallsPanel.vue';
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
