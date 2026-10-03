/**
 * `views/mapping` 的对外面（spec §4.2 的跨栏连线层）——**已停用**。
 *
 * 停用日期与原因：三个视图改成「模型画规格」之后，这一层没有依据了。
 *
 * 它画的三条箭头说的是「同一份声明的同一个节点，在三栏里分别长什么样」。那件事成立的前提是
 * 三栏画的东西**都从声明派生**：流程图从前是声明里的链，积木从前是声明节点的实现树，
 * 代码从前是同一棵实现树渲染出来的文本，三处都挂着同一个 `[data-node-id]`。
 * 现在三栏画的是第二次模型调用的产出：流程图的节点 id 是模型起的（与声明节点没有对应关系），
 * 积木是教学块树，代码是模型写的一段文本。再画那三条线，画的是一个**并不存在的对应关系**
 * ——「这个积木块就是声明里那一步」这句话我们没有任何依据说出口。
 * 所以整层关掉（`StudioShell.vue` 里不再挂 `LinkOverlay`），连带它的测试一起下线：
 * 留着一层绿测试去测一个不上屏的东西，比删掉它更坏。
 *
 * 下面的导出**保留**：它们是纯几何与量测函数（`measure.ts` / `geometry.ts` / `run-trace.ts`），
 * 将来若真有一条「规格 ↔ 声明」的对应关系被证实（那得是模型给的、或被校验过的），
 * 这一层可以直接接回来。现在没有任何组件 import 它。
 *
 * 这一层从前就是**只读**的：不选中、不写回、不改真相，连指针事件都不吃。这个性质没有变。
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
