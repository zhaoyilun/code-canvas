/**
 * 流程图的自动布局：**dagre**（`@dagrejs/dagre`，MIT）。
 *
 * ## 为什么是 dagre，不是 elkjs
 *
 * 两个都是 MIT、都能排 DAG，差别在**这一处用得上什么**：
 *
 * - 图是我们自己的形状——5 种节点、几十条边、一张图几十个节点封顶。要的是「有层次、
 *   不重叠、分支两条臂分得开」，不是工业级的大图优化。
 * - **dagre 是同步的**：`layout(graph)` 一次调用就把坐标算完，视图里 `computed` 一包就完事。
 *   elkjs 的主 API 是异步的（默认还带一个 worker 的选项），为了一张几十节点的图去接
 *   一个 Promise 生命周期，只会在「图变了 → 位置晚一拍才到」上平添一处闪烁。
 * - **体积**：dagre 是纯 JS 的小库；elkjs 是 GWT 编译出来的大块头（兆级）。三栏里的一栏，
 *   不值得为它多背一兆。
 * - 维护状态：`@dagrejs/dagre` 是 dagre 原作者的社区维护分支（3.x，本仓库装的就是它），
 *   不是 2018 年那个停更的 `dagre` 包。
 *
 * 布局本身**不看屏幕上画的是什么**：它只吃节点与边。所以这一层能被单测直接钉住——
 * 「两条臂分得开、节点不重叠、坐标只由这张图决定」都是可断言的，不需要渲染。
 *
 * ## 框的尺寸是估的，这不影响任何事实
 *
 * SVG 里没有文字自动换行，框要多大得先算。这里按**字符宽度估**（CJK 算 1 em、其余算 0.55 em）：
 * 估出来的只是框，不参与任何数字的显示——坐标、到位值、拍数那些字仍然是目录里的原值。
 * 宁可框宽一点窄一点，也不引一个文本测量库（那要先把 SVG 渲染出来再量一遍，图一改就抖）。
 */
import { Graph, layout, type EdgeLabel, type NodeLabel } from '@dagrejs/dagre';
import { flowEdgeKey } from '../../state/teaching';
import type { FlowEdge, FlowGraph, FlowNode } from '@codecanvas/contracts';

/** 标题那一行的字号（与 `FlowChart.vue` 的样式表一致；这里是估宽用的）。 */
const TITLE_FONT_PX = 13;
/** 第二行（detail）的字号。 */
const DETAIL_FONT_PX = 11;
const PADDING_X = 16;
const PADDING_Y = 10;
const MIN_NODE_WIDTH = 150;
const MAX_NODE_WIDTH = 300;
const TITLE_LINE_PX = 19;
const DETAIL_LINE_PX = 16;

export interface FlowPoint {
	readonly x: number;
	readonly y: number;
}

export interface FlowLayoutNode {
	readonly id: string;
	readonly node: FlowNode;
	/** 左上角（dagre 给的是中心点，这里换过）。 */
	readonly x: number;
	readonly y: number;
	readonly width: number;
	readonly height: number;
}

export interface FlowLayoutEdge {
	readonly key: string;
	readonly edge: FlowEdge;
	/** 折线经过的点（含首尾），第一点是出口、最后一点是入口。 */
	readonly points: readonly FlowPoint[];
	/** 线上那句话摆哪儿（中点）；没有 label 时也要一个位置——分支臂默认要写「是 / 否」。 */
	readonly labelAt: FlowPoint;
}

export interface FlowLayout {
	readonly nodes: readonly FlowLayoutNode[];
	readonly edges: readonly FlowLayoutEdge[];
	readonly width: number;
	readonly height: number;
}

/**
 * 一个字符多宽（em 的倍数）。中文字宽 ≈ 1 em，拉丁字母与数字 ≈ 0.55 em。
 * 这是**估**：只用来定框，框宽了窄了都不改变图上任何一个字。
 */
const emWidth = (character: string): number =>
	/[\u3000-\u9fff\uff00-\uffef]/.test(character) ? 1 : 0.55;

const textWidth = (text: string, fontPx: number): number =>
	[...text].reduce((sum, character) => sum + emWidth(character), 0) * fontPx;

/** 一个节点要占多大：标题一行、detail 一行（有的话）。 */
export const flowNodeSize = (node: FlowNode): { width: number; height: number } => {
	const widest = Math.max(
		textWidth(node.title, TITLE_FONT_PX),
		node.detail === undefined ? 0 : textWidth(node.detail, DETAIL_FONT_PX),
	);
	const width = Math.min(MAX_NODE_WIDTH, Math.max(MIN_NODE_WIDTH, Math.ceil(widest) + PADDING_X * 2));
	return { width, height: TITLE_LINE_PX + (node.detail === undefined ? 0 : DETAIL_LINE_PX) + PADDING_Y * 2 };
};

/** 折线的中点：拿来摆线上那句话（点不够时退回首点）。 */
const midpointOf = (points: readonly FlowPoint[]): FlowPoint => {
	if (points.length === 0) return { x: 0, y: 0 };
	if (points.length === 1) return points[0] as FlowPoint;
	const middle = Math.floor((points.length - 1) / 2);
	const first = points[middle] as FlowPoint;
	const second = points[middle + 1] as FlowPoint;
	return { x: (first.x + second.x) / 2, y: (first.y + second.y) / 2 - 7 };
};

/**
 * 一张流程图 → 每块的位置。**同一张图永远给同一份坐标**（dagre 是确定性的），
 * 所以铺开动画里那些框不会自己挪——「画出来」的每一笔都落在它最后待着的地方。
 */
export const layoutFlowGraph = (graph: FlowGraph): FlowLayout => {
	const g = new Graph({ multigraph: true, directed: true })
		.setGraph({ rankdir: 'TB', nodesep: 26, ranksep: 44, marginx: 16, marginy: 16, ranker: 'network-simplex' })
		.setDefaultEdgeLabel(() => ({}));

	for (const node of graph.nodes) {
		const size = flowNodeSize(node);
		g.setNode(node.id, { width: size.width, height: size.height });
	}
	for (const edge of graph.edges) {
		// 多重边（同一个分支的两条臂）：名字用同一个键函数，铺开序与这里认的是同一条边。
		g.setEdge(edge.from, edge.to, {}, flowEdgeKey(edge));
	}

	layout(g);

	const nodes: FlowLayoutNode[] = [];
	for (const id of g.nodes()) {
		const label = g.node(id) as NodeLabel;
		const node = graph.nodes.find((candidate) => candidate.id === id);
		if (node === undefined) continue;
		nodes.push({
			id,
			node,
			// dagre 的类型把 x/y 标成可缺（它自己也用在别的布局上），这里按 0 兜底——
			// 走过 `layout()` 的节点一定有坐标，缺了也只是画在角上，不是编一个位置。
			x: (label.x ?? 0) - label.width / 2,
			y: (label.y ?? 0) - label.height / 2,
			width: label.width,
			height: label.height,
		});
	}

	const edges: FlowLayoutEdge[] = [];
	for (const edge of graph.edges) {
		const key = flowEdgeKey(edge);
		const label = g.edge({ v: edge.from, w: edge.to, name: key }) as EdgeLabel | undefined;
		const points = (label?.points ?? []).map((point) => ({ x: point.x, y: point.y }));
		edges.push({ key, edge, points, labelAt: midpointOf(points) });
	}

	const graphLabel = g.graph();
	return {
		nodes,
		edges,
		width: typeof graphLabel.width === 'number' ? graphLabel.width : 0,
		height: typeof graphLabel.height === 'number' ? graphLabel.height : 0,
	};
};

/** 折线的 `d`：直连每一段。dagre 给的点已经绕开了框，直接连读起来干净。 */
export const pathOf = (points: readonly FlowPoint[]): string => {
	const [first, ...rest] = points;
	if (first === undefined) return '';
	return `M ${first.x} ${first.y}${rest.map((point) => ` L ${point.x} ${point.y}`).join('')}`;
};

/** 一条边线上写什么：模型给了 label 就用它；分支臂没给时写「是 / 否」；其余不写。 */
export const edgeLabelText = (edge: FlowEdge): string =>
	edge.label ?? (edge.arm === undefined ? '' : edge.arm === 'then' ? '是' : '否');

/**
 * 把一行字截到框里（SVG 的文字不换行）。
 *
 * 截断只影响**显示**：完整的字仍然在 `<title>` 里（悬停能看到），
 * 也不是「把长文本悄悄改短」——图上任何一个数字都不会因为这行代码而变。
 */
export const fitText = (text: string, fontPx: number, maxWidth: number): string => {
	if (textWidth(text, fontPx) <= maxWidth) return text;
	const characters = [...text];
	let used = 0;
	let out = '';
	for (const character of characters) {
		const next = used + emWidth(character) * fontPx;
		if (next > maxWidth - fontPx) break;
		out += character;
		used = next;
	}
	return `${out}…`;
};
