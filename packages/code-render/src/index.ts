/**
 * 把一份 workflow 声明渲染成代码面板的文本形态（编译产物，只读）。
 *
 * 渲染规则必须从校验器推导（`describeActionFields`），不许手写一门协议里不存在的语言。
 * 见 docs/spec.md §4.1。
 */
export {
	callLines,
	lineText,
	nodeIdAtLine,
	renderDeclaration,
	spanOfNode,
	type NodeLineSpan,
	type RenderedLine,
	type RenderedProgram,
} from './render';
export { describeLimits, EMPTY_LIMITS, type RenderedLimit, type RenderedLimits } from './limits';
export { formatNumberLiteral, formatSensorArrayLiteral, type FieldValueRender } from './values';
