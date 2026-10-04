<script setup lang="ts">
/**
 * 流程图本体：**一条条画出来**的 SVG。
 *
 * 为什么是 SVG 而不是 DOM 卡片：导演嫌原来那种竖排卡片「很木讷」，而这里要的是
 * 「一笔一笔画出来」——连线要能做 dash 动画，就得是 `<path>`。
 * 也因此**不引第三方动画库**：GSAP 的 DrawSVG 是付费插件；Vivus 的模型是「一次画完整张 SVG」，
 * 与「按节拍一笔笔来」不是一回事。这里要的东西只有两行 CSS：
 *
 * - 连线：`pathLength="1"` 把每条路径的长度归一化，于是 `stroke-dasharray: 1` +
 *   `stroke-dashoffset` 从 1 到 0 就是「从无到有画出来」，**与这条线实际多长无关**。
 *   （不写死一个「够大」的 dash 长度：那样短线的动画只发生在最后几帧，看着像突然出现。）
 * - 节点：从下方一点点浮上来 + 轻微缩放，收在 identity（不留残留变换，见 `entrance-motion.test.ts`）。
 *
 * 谁放出来哪一格由 `state/teaching.ts` 的播放队列说了算：这里只画 `revealed` 里有的
 * （节点按 id、边按 `flowEdgeKey`）。于是「第几笔」只有一个数，三张画布说的是同一件事。
 *
 * 布局在 `layout.ts`（dagre），**整张图一次算完**：铺开时框不挪——每一笔画在它最终待着的地方，
 * 只是还没出现而已。框的宽度是估的（SVG 文字不换行），估的只是框，不是图上任何一个字。
 */
import { computed } from 'vue';
import type { FlowGraph } from '@codecanvas/contracts';
import { flowNodeKey } from '../../state/teaching';
import { edgeLabelText, fitText, layoutFlowGraph, pathOf } from './layout';

const props = defineProps<{
	readonly graph: FlowGraph;
	/** 已经画出来的那些格子（键与 `flowDrawOrder` 同一套）。 */
	readonly revealed: ReadonlySet<string>;
	/**
	 * 设备此刻走到的那一步，对应图上哪个节点（`state/teaching.ts` 算好的）。
	 * 空串 = 没有当前步（没在跑、也没有选中），或者这一步在这张图上没有对应的框
	 * ——两种都是「没有」，所以都不亮，**不拿别的框顶上**。
	 */
	readonly currentNodeId: string;
	/**
	 * 这一趟**走过**的那些节点 id（`shell/device-run.ts` 的 `runTrace.trail` 转成集合）。
	 *
	 * 与 `currentNodeId` 分工：那个是"此刻在哪"（亮着、会呼吸），这个是"走过哪儿"（一条安静的痕）。
	 * 光标只有一个，痕可以有很多——所以两者不是同一个视觉档，别拿同一个颜色糊。
	 */
	readonly visitedNodeIds: ReadonlySet<string>;
	/** 走过的那几条**边**的键（两端都走过才算走过；键与 `layout.edges[].key` 同一套）。 */
	readonly visitedEdgeKeys: ReadonlySet<string>;
	/**
	 * 这一张图的**入场延迟**（毫秒，`PHASE_DELAY_MS.flow`）。
	 *
	 * 三张画布错峰开场：图先起、积木跟上、代码最后落。这个数必须与铺开队列读同一个常量，
	 * 否则会出现"框已经落好了、内容还在往外冒"这种错位。
	 */
	readonly entranceDelayMs: number;
}>();

const layout = computed(() => layoutFlowGraph(props.graph));

const isRevealed = (key: string): boolean => props.revealed.has(key);

/**
 * 这个节点是不是**设备此刻走到的那一步**。
 *
 * 判据只有一条：`currentNodeId` 就是它。空串（没在跑、或者这一步图上没有对应的框）
 * 谁都不匹配——「没有」不许靠「随便挑一个亮着」糊过去。
 */
const isCurrent = (id: string): boolean => props.currentNodeId !== '' && props.currentNodeId === id;

/** 这个框**走过**（不含正在走的那个——正在走的另有更亮的一档）。 */
const isVisited = (id: string): boolean => !isCurrent(id) && props.visitedNodeIds.has(id);

/** 这条线走过。 */
const isVisitedEdge = (key: string): boolean => props.visitedEdgeKeys.has(key);

/** 节点里那两行字的截断宽度（框宽减去左右内边距；估宽口径见 `layout.ts`）。 */
const titleOf = (title: string, width: number): string => fitText(title, 13, width - 32);
const detailOf = (detail: string, width: number): string => fitText(detail, 11, width - 32);
</script>

<template>
	<svg
		class="flow-chart"
		data-testid="flow-chart"
		:width="layout.width"
		:height="layout.height"
		:viewBox="`0 0 ${layout.width} ${layout.height}`"
		role="img"
		aria-label="教学流程图"
	>
		<defs>
			<!-- 箭头：`auto-start-reverse` 让 marker 跟着路径方向转，两条臂因此不用各画一套。 -->
			<marker
				id="cc-flow-arrowhead"
				viewBox="0 0 10 10"
				refX="9"
				refY="5"
				markerWidth="7"
				markerHeight="7"
				orient="auto-start-reverse"
			>
				<path class="flow-arrow-head" d="M 0 0 L 10 5 L 0 10 z" />
			</marker>
		</defs>

		<!-- 先画线、再画框：框压在线头上，箭头才不会插进框里。 -->
		<g class="flow-edges">
			<g
				v-for="item in layout.edges"
				v-show="isRevealed(item.key)"
				:key="item.key"
				class="flow-edge"
				:class="{ 'flow-edge-visited': isVisitedEdge(item.key) }"
				data-testid="flow-edge"
				:data-from="item.edge.from"
				:data-to="item.edge.to"
				:data-arm="item.edge.arm ?? 'main'"
			>
				<path class="flow-edge-line" :d="pathOf(item.points)" pathLength="1" marker-end="url(#cc-flow-arrowhead)" />
				<text
					v-if="edgeLabelText(item.edge) !== ''"
					class="flow-edge-label"
					:x="item.labelAt.x"
					:y="item.labelAt.y"
				>
					{{ edgeLabelText(item.edge) }}
				</text>
			</g>
		</g>

		<g class="flow-nodes">
			<g
				v-for="item in layout.nodes"
				v-show="isRevealed(flowNodeKey(item.id))"
				:key="item.id"
				class="flow-node"
				:style="{ animationDelay: `${String(props.entranceDelayMs)}ms` }"
				:class="[
					`flow-node-${item.node.kind}`,
					{ 'flow-node-current': isCurrent(item.id), 'flow-node-visited': isVisited(item.id) },
				]"
				data-testid="flow-node"
				:data-node-id="item.id"
				:data-kind="item.node.kind"
				:data-cc-current-step="isCurrent(item.id) ? item.id : undefined"
			>
				<rect class="flow-node-box" :x="item.x" :y="item.y" :width="item.width" :height="item.height" rx="8" />
				<text class="flow-node-title" :x="item.x + 16" :y="item.y + 22">
					{{ titleOf(item.node.title, item.width) }}
				</text>
				<text v-if="item.node.detail !== undefined" class="flow-node-detail" :x="item.x + 16" :y="item.y + 40">
					{{ detailOf(item.node.detail, item.width) }}
				</text>
				<!-- 完整的字在这里：截断只影响显示，悬停能看到原文。 -->
				<title>{{ item.node.detail === undefined ? item.node.title : `${item.node.title} · ${item.node.detail}` }}</title>
			</g>
		</g>
	</svg>
</template>

<style scoped>
.flow-chart {
	display: block;
	/* 图比栏宽时横向滚，不缩：缩了字号就跟着小，图上那些数字会读不清。 */
	min-width: 100%;
	height: auto;
}

/*
 * 一个节点出场：从下方一点浮上来 + 轻微缩放，**收在 identity**。
 * 与积木那边同一个口径（`entrance-motion.test.ts` 会核这一段字），只是这里是「画出来」而不是「拖进来」。
 */
.flow-node {
	animation: cc-flow-node-in 220ms ease-out 1 both;
}

@keyframes cc-flow-node-in {
	from {
		opacity: 0;
		transform: translateY(6px) scale(0.97);
	}

	to {
		opacity: 1;
		transform: none;
	}
}

/*
 * 一条线画出来：`pathLength="1"` 把长度归一化，所以这两个 1 与线实际多长无关。
 * 动画收在 `stroke-dashoffset: 0`，也就是完整的线——不留半截。
 */
.flow-edge-line {
	fill: none;
	stroke: var(--cc-line-strong);
	stroke-width: 1.4;
	stroke-dasharray: 1;
	animation: cc-flow-draw 280ms ease-out 1 both;
}

@keyframes cc-flow-draw {
	from {
		stroke-dashoffset: 1;
	}

	to {
		stroke-dashoffset: 0;
	}
}

.flow-arrow-head {
	fill: var(--cc-line-strong);
}

.flow-edge-label {
	fill: var(--cc-text-dim);
	font-family: var(--cc-font-mono);
	font-size: var(--cc-fs-sm);
	text-anchor: middle;
}

.flow-node-box {
	fill: var(--cc-surface);
	stroke: var(--cc-line-strong);
	stroke-width: 1.2;
}

/* 三种节点的形状语言：开始 / 结束是端点，条件是菱形语义（用描边色与底色分），动作是实心面。 */
.flow-node-start .flow-node-box,
.flow-node-end .flow-node-box {
	fill: var(--cc-surface-sunken);
	stroke-dasharray: none;
}

.flow-node-decision .flow-node-box {
	fill: var(--cc-accent-glow);
	stroke: var(--cc-accent);
}

.flow-node-wait .flow-node-box {
	stroke-dasharray: 4 3;
}

.flow-node-title {
	fill: var(--cc-text);
	font-size: var(--cc-fs-md);
	font-weight: 600;
}

.flow-node-detail {
	fill: var(--cc-text-dim);
	font-family: var(--cc-font-mono);
	font-size: var(--cc-fs-sm);
}

/*
 * 设备跑到的那一步：**与别处同一条强调色**（`--cc-highlight` = `--cc-accent`，
 * 描边粗细也是同一个变量），不是这里另配的一套色。
 *
 * 为什么动 `stroke` / `stroke-width` / `filter`：这是 SVG，节点本来就会动
 * `transform`（入场那一段），而 `filter: drop-shadow` 不吃布局、不碰坐标——
 * 框的位置与命中区一个像素都不挪。加粗 1.2 → 2 用的是与别处同一个 `--cc-highlight-border-width`。
 */
.flow-node-current .flow-node-box {
	stroke: var(--cc-highlight);
	stroke-width: var(--cc-highlight-border-width);
	filter: drop-shadow(0 0 6px var(--cc-accent-glow));
}

.flow-node-current .flow-node-title {
	fill: var(--cc-highlight);
}

/*
 * 走过的路：**一条安静的痕**。
 *
 * 与「当前步」刻意分成两档：当前步是强调色描边 + 呼吸的辉光（那盏灯），
 * 走过的只是描边换成强调色的**弱化版**（`--cc-accent-dim`）+ 线实起来。
 * 不发光、不呼吸——痕的活是"让你看见这条路"，不是"喊你来看它"。
 * 两个都亮成一样，等于把"现在在哪"这件事淹掉。
 */
.flow-node-visited .flow-node-box {
	stroke: var(--cc-accent-dim);
}

.flow-edge-visited .flow-edge-line {
	stroke: var(--cc-accent-dim);
	stroke-width: 1.6;
}

.flow-edge-visited .flow-arrow-head {
	fill: var(--cc-accent-dim);
}

/* 当前步的呼吸：只动那圈辉光，节点的位置与大小一动不动（截图里也读得出是哪一帧）。 */
@media (prefers-reduced-motion: no-preference) {
	.flow-node-current .flow-node-box {
		animation: cc-flow-current 1.2s ease-in-out infinite alternate;
	}
}

@keyframes cc-flow-current {
	from {
		filter: drop-shadow(0 0 3px var(--cc-accent-glow));
	}

	to {
		filter: drop-shadow(0 0 9px var(--cc-accent-glow));
	}
}

@media (prefers-reduced-motion: reduce) {
	.flow-node,
	.flow-edge-line {
		animation: none;
	}

	.flow-node-current .flow-node-box {
		animation: none;
	}
}
</style>
