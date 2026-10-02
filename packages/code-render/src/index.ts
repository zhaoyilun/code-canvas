/**
 * 代码面板的内容：**一个模块的实现**（编译产物，只读）。
 *
 * 工作流上的一个模块 = 一个函数；`node.parameters.action` 是能力引用，渲染出来的就是
 * 目录里那个能力的 `implementation`——原语调用序列。参数名与顺序全部来自 `catalog.primitives`，
 * 这里不手写任何参数名。见 docs/spec.md §4.1 与 `@codecanvas/contracts` 的 `capability.ts`。
 *
 * 安全限值一并在结果里给出：它属于整个任务，不随选中模块变。
 */
export {
	callLines,
	lineOfStep,
	lineText,
	renderImplementation,
	stepIndexAtLine,
	type ImplementationRenderInput,
	type RenderedImplementation,
	type RenderedLine,
	type RenderedStepSpan,
} from './render';
export { describeLimits, EMPTY_LIMITS, type RenderedLimit, type RenderedLimits } from './limits';
export {
	formatNumberLiteral,
	formatSensorArrayLiteral,
	renderArgument,
	REFERENCE_PREFIX,
	type ArgumentContext,
	type RenderedArgument,
} from './values';
