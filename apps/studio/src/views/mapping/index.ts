/**
 * `views/mapping` 的对外面（spec §4.2 的跨栏连线层）。
 *
 * 只导出两样东西：挂到外壳里的那个 overlay 组件，以及量锚点的纯函数
 * （验收脚本与测试都要按同一口径量，不能各写一份）。
 *
 * 这一层**只读**：它不选中、不写回、不改真相，甚至连指针事件都不吃。
 */
export { default as LinkOverlay } from './LinkOverlay.vue';
export {
	BLOCK_SELECTOR,
	CARD_SELECTOR,
	CODE_LINE_SELECTOR,
	NODE_ID_ATTRIBUTE,
	measureLinks,
	type LinkMeasurement,
	type LinkRow,
} from './measure';
export { anchorFrom, curveOf, toLocal, type AnchorPoint, type LinkGeometry, type RectLike } from './geometry';
export {
	EMPTY_RUN_TRACE,
	phaseOf,
	traceAfter,
	type RunPhase,
	type RunTrace,
} from './run-trace';
