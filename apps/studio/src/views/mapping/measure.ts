/**
 * 锚点怎么量（`geometry.ts` 只管算术，这里只管 DOM）。
 *
 * 三处锚点的**唯一约定**是 `[data-node-id]`：不关心它是积木的 `<g>`、流程卡片还是代码行。
 * 谁挂的属性、挂在哪一层，这一层不知道也不该知道——将来任何一处换了实现，只要还挂这个属性，
 * 连线就不用改。
 *
 * 遍历的主语是**量到的锚点**，不是声明：某一步在声明里，但 DOM 上没找齐锚点，它就少一段线；
 * 反之画布上有个没有 `data-node-id` 的块（刚从工具箱拖出来、还没进声明），
 * 它压根不在这一轮里——不给它编一个 id，也不给它画一段假的。
 */
import type { WorkflowDeclaration } from '@codecanvas/contracts';
import { anchorFrom, curveOf, toLocal, type AnchorPoint, type LinkGeometry, type RectLike } from './geometry';

/** 三处锚点的共同属性名（与 `views/shared/sequence-badge.ts` 的 `NODE_ID_ATTRIBUTE` 同值）。 */
export const NODE_ID_ATTRIBUTE = 'data-node-id';
/** 积木：Blockly 挂在块根节点上的类，选择器就是 `g.blocklyDraggable[data-node-id]`。 */
export const BLOCK_SELECTOR = `g.blocklyDraggable[${NODE_ID_ATTRIBUTE}]`;
/** 流程卡片：中栏那张卡。 */
export const CARD_SELECTOR = `[data-testid="flow-node-card"][${NODE_ID_ATTRIBUTE}]`;
/** 代码行：一个调用占一行；注释行没有 nodeId，选不到，也就不连。 */
export const CODE_LINE_SELECTOR = `li.cp-line[${NODE_ID_ATTRIBUTE}]`;

/** 一段线的渲染材料：几何 + 它属于哪一步 + 箭头落在哪一栏。 */
export interface LinkRow {
	readonly nodeId: string;
	readonly step: number;
	/** 箭头端点在积木那侧（第一段）还是卡片那侧（第二段）。 */
	readonly kind: 'block' | 'card';
	readonly geometry: LinkGeometry;
	/** 悬停提示：这一段说的是哪两处。 */
	readonly title: string;
}

export interface LinkMeasurement {
	readonly links: readonly LinkRow[];
	/**
	 * 这一轮量出来的几何摘要。
	 *
	 * 它同时是两件事的判据：**内容变了没**（一样就不必重新渲染），
	 * 以及「还有没有东西在动」（连续几轮一样就说明画布静下来了，探测可以慢下来）。
	 */
	readonly signature: string;
	/** 声明里有几步。 */
	readonly stepCount: number;
	/** 其中几步三处锚点都齐（会画满两段线的那些）。 */
	readonly linkedCount: number;
}

export interface MeasureInput {
	/** overlay 元素本身：**坐标系的原点**（三处的框都减掉它的框）。 */
	readonly overlay: Element;
	/**
	 * 锚点的查找范围。
	 *
	 * 是 overlay 的**父元素**（工作区），不是 overlay 自己：三栏是 overlay 的兄弟节点，
	 * `overlay.querySelectorAll()` 一个都找不到（只能往下找，找不到旁边）。
	 * 用工作区当范围同时也把范围收在工作区内——`document` 会连 Blockly 工具箱里的样板积木一起捞进来。
	 */
	readonly root: Element;
	readonly declaration: WorkflowDeclaration | null;
}

/**
 * 从**容器**往下找锚点，不是从 `document` 找：左栏里除了画布上的积木，Blockly 的工具箱里
 * 也有一份同样形状的积木（`g.blocklyDraggable`），那是「还没拖出来的样板」，
 * 不是这一份声明的一部分，画线会指错地方。
 *
 * 同一个 nodeId 出现多次时取第一个——锚点是「这一步在哪」，重复的锚点在语义上是同一个位置。
 */
const anchorsOf = (root: Element, selector: string): Map<string, Element> => {
	const table = new Map<string, Element>();
	for (const element of root.querySelectorAll(selector)) {
		const nodeId = element.getAttribute(NODE_ID_ATTRIBUTE);
		if (nodeId === null || nodeId.length === 0 || table.has(nodeId)) continue;
		table.set(nodeId, element);
	}
	return table;
};

/** 这一轮量出来的几何摘要：哪一步、哪一段、两端落在哪。坐标变了它就变。 */
const signatureOf = (links: readonly LinkRow[], stepCount: number): string =>
	`${String(stepCount)}|${links
		.map(
			(link) =>
				`${link.step}:${link.kind}:${link.geometry.start.x},${link.geometry.start.y},${link.geometry.end.x},${link.geometry.end.y}`,
		)
		.join(';')}`;

/**
 * 量一轮：声明 + 三处锚点 → 每步两段线的几何。
 *
 * 找不到的锚点**跳过那一段**（不画半条断头的线）：卡片被滚出可视区时
 * `getBoundingClientRect()` 依然返回数字，但那时线指过去也只是贴着栏外——
 * 宁可少一段，也不画一段指错的。
 */
export const measureLinks = ({ overlay, root, declaration }: MeasureInput): LinkMeasurement => {
	const overlayRect: RectLike = overlay.getBoundingClientRect();
	const nodes = declaration?.nodes ?? [];
	const numbers = new Map<string, number>();
	nodes.forEach((node, position) => numbers.set(node.id, position + 1));

	const blocks = anchorsOf(root, BLOCK_SELECTOR);
	const cards = anchorsOf(root, CARD_SELECTOR);
	const codeLines = anchorsOf(root, CODE_LINE_SELECTOR);

	const links: LinkRow[] = [];
	let linkedCount = 0;
	for (const node of nodes) {
		const step = numbers.get(node.id) ?? 0;
		const card = cards.get(node.id);
		if (card === undefined) continue;
		const cardRect = card.getBoundingClientRect();
		const cardLeft: AnchorPoint = toLocal(anchorFrom(cardRect, 'left'), overlayRect);

		// 第一段：积木 → 卡片。积木没锚点（还没进声明的块）就整段不画。
		const block = blocks.get(node.id);
		if (block !== undefined) {
			const blockRight: AnchorPoint = toLocal(anchorFrom(block.getBoundingClientRect(), 'right'), overlayRect);
			links.push({
				nodeId: node.id,
				step,
				kind: 'block',
				geometry: curveOf(blockRight, cardLeft),
				title: `第 ${String(step)} 步：积木 → 流程`,
			});
		}

		// 第二段：卡片 → 代码行。代码行那侧同样认 `data-node-id`，注释行没有，自然不连。
		const codeLine = codeLines.get(node.id);
		if (codeLine !== undefined) {
			const codeLeft: AnchorPoint = toLocal(anchorFrom(codeLine.getBoundingClientRect(), 'left'), overlayRect);
			const cardRight: AnchorPoint = toLocal(anchorFrom(cardRect, 'right'), overlayRect);
			links.push({
				nodeId: node.id,
				step,
				kind: 'card',
				geometry: curveOf(cardRight, codeLeft),
				title: `第 ${String(step)} 步：流程 → 代码`,
			});
		}

		if (block !== undefined && codeLine !== undefined) linkedCount += 1;
	}

	return { links, signature: signatureOf(links, nodes.length), stepCount: nodes.length, linkedCount };
};
