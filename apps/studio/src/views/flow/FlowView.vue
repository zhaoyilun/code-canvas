<script setup lang="ts">
/**
 * 中栏：流程画布（spec §4.1）——**模型画的流程图**。
 *
 * 画的是第二次调用的产出（`state/teaching.ts` 的 `spec.flow`）：节点 + 箭头 + 自动布局，
 * 一笔一笔画出来。从前那种「从声明推出来的竖排卡片」不再是这里的东西——它讲不出
 * 执行侧内部的管线（`inspect_scene` 在目录里只有一条原语），而那正是教学要讲的。
 *
 * 三种状态各有各的字，**一种都不许含糊过去**：
 * - 还没画（`idle`）：说清楚「还没有流程图」，并说明它从哪来；
 * - 正在画（`drawing`）：说「正在画…」并带上已经收到的字数（长文生成时这是唯一的动静）；
 * - 画不出来（`failed`）：照实说模型说了什么、逐条列出形状问题、把已经收到的原文放在折叠里
 *   ——**不退回旧那套渲染顶上**（那套已经不是屏幕上的真相了，拿它顶上等于把这句话藏起来）。
 *
 * 这里没有一条写回路径，也没有任何「这是模型生成的」之类的标签：声明是声明，图是图，
 * 两者对不上不拦、也不标注（导演定的「模型赢」）。
 */
import { computed } from 'vue';
import { useTeaching } from '../../state/teaching';
import FlowChart from './FlowChart.vue';

const teaching = useTeaching();

const spec = teaching.spec;

/** 失败信息摊平成模板好用的一份（`null` = 没失败）；字数也在这一层算好。 */
const failed = computed(() => {
	const failure = teaching.failure.value;
	if (failure === null) return null;
	return {
		message: failure.message,
		issues: failure.issues,
		text: failure.text,
		characters: failure.text === null ? 0 : failure.text.length,
	};
});

const flow = computed(() => spec.value?.flow ?? null);

/** 这一次画的是哪个任务（标题来自规格，规格还没到时空着——不拿声明的名字顶上）。 */
const title = computed(() => spec.value?.title ?? '');

/** 还在画：有格子没放出来。数一数给界面看，也是「它还在动」的证据。 */
const drawnCount = computed(() => teaching.revealedFlowKeys.value.size);
const totalCount = computed(() => {
	const graph = flow.value;
	if (graph === null) return 0;
	// 节点 + 边：与 `flowDrawOrder` 铺开的总格数一致（每个节点一格、每条边一格）。
	return graph.nodes.length + graph.edges.length;
});
</script>

<template>
	<section class="flow-view" data-testid="view-flow">
		<header class="flow-header">
			<span class="flow-title">流程画布</span>
			<span v-if="title !== ''" class="flow-task" data-testid="flow-title">{{ title }}</span>
		</header>

		<div v-if="flow !== null" class="flow-body" data-testid="flow-canvas">
			<p v-if="drawnCount < totalCount" class="flow-progress" data-testid="flow-progress">
				正在画…（{{ drawnCount }} / {{ totalCount }}）
			</p>
			<div class="flow-scroll">
				<FlowChart :graph="flow" :revealed="teaching.revealedFlowKeys.value" />
			</div>
		</div>

		<!-- 画不出来：照实说，并把「哪儿不对」逐条摆出来。 -->
		<div v-else-if="failed !== null" class="flow-failed" data-testid="flow-failed">
			<p class="failed-line" data-testid="flow-failed-message">模型没画出来：{{ failed.message }}</p>
			<ul v-if="failed.issues.length > 0" class="failed-issues" data-testid="flow-failed-issues">
				<li v-for="issue in failed.issues" :key="issue">{{ issue }}</li>
			</ul>
			<details v-if="failed.text !== null" class="failed-raw">
				<summary>已经收到的原文（{{ failed.characters }} 字）</summary>
				<pre>{{ failed.text }}</pre>
			</details>
			<button type="button" class="retry" data-testid="flow-retry" @click="teaching.run()">重画</button>
		</div>

		<div v-else-if="teaching.status.value === 'drawing'" class="flow-empty" data-testid="flow-drawing">
			<p class="empty-text">正在画…（已经收到 {{ teaching.streamedChars.value }} 字）</p>
		</div>

		<div v-else class="flow-empty" data-testid="flow-empty">
			<p class="empty-text">
				流程画布画的是一张真流程图：动作、条件分支、等待、开始与结束，节点之间是带箭头的连线。<br />
				它由「任务 JSON + 这台设备的目录」讲出来——现在还没有这张图。
			</p>
		</div>
	</section>
</template>

<style scoped>
.flow-view {
	display: flex;
	flex-direction: column;
	gap: var(--cc-space-2);
	height: 100%;
	min-height: 0;
	padding: var(--cc-space-4);
}

.flow-header {
	display: flex;
	align-items: baseline;
	gap: var(--cc-space-2);
	flex-wrap: wrap;
	padding-bottom: var(--cc-space-2);
	border-bottom: 1px solid var(--cc-line);
}

.flow-title {
	font-size: var(--cc-fs-lg);
	font-weight: 600;
	color: var(--cc-text);
}

.flow-task {
	margin-left: auto;
	font-family: var(--cc-font-mono);
	font-size: var(--cc-fs-sm);
	color: var(--cc-text-dim);
}

/* 图的容器：图比栏宽就横向滚（缩了字号那些数字就读不清了）。 */
.flow-body {
	display: flex;
	flex-direction: column;
	flex: 1 1 auto;
	min-height: 0;
	overflow: hidden;
	background: var(--cc-surface-sunken);
	border: 1px solid var(--cc-line);
	border-radius: var(--cc-radius);
}

.flow-scroll {
	flex: 1 1 auto;
	min-height: 0;
	overflow: auto;
	padding: var(--cc-space-2);
}

.flow-progress {
	margin: 0;
	padding: var(--cc-space-1) var(--cc-space-3);
	font-family: var(--cc-font-mono);
	font-size: var(--cc-fs-xs);
	color: var(--cc-text-dim);
	border-bottom: 1px solid var(--cc-line);
}

.flow-failed {
	display: flex;
	flex-direction: column;
	gap: var(--cc-space-2);
	flex: 1 1 auto;
	min-height: 0;
	overflow: auto;
	padding: var(--cc-space-3);
	background: var(--cc-danger-veil);
	border: 1px solid var(--cc-danger);
	border-radius: var(--cc-radius);
}

.failed-line {
	margin: 0;
	color: var(--cc-text);
	overflow-wrap: anywhere;
}

.failed-issues {
	margin: 0;
	padding-left: 1.2em;
	color: var(--cc-text);
	font-size: var(--cc-fs-sm);
}

.failed-raw {
	font-size: var(--cc-fs-sm);
	color: var(--cc-text-dim);
}

.failed-raw pre {
	max-height: 200px;
	margin: var(--cc-space-1) 0 0;
	overflow: auto;
	font-size: var(--cc-fs-xs);
	white-space: pre-wrap;
}

.retry {
	align-self: flex-start;
	padding: 2px var(--cc-space-3);
	color: var(--cc-text);
	background: var(--cc-surface);
	border: 1px solid var(--cc-line-strong);
	border-radius: var(--cc-radius-sm);
	cursor: pointer;
}

.flow-empty {
	display: flex;
	align-items: center;
	justify-content: center;
	flex: 1 1 auto;
	min-height: 0;
	padding: var(--cc-space-5);
	text-align: center;
	background: var(--cc-surface-sunken);
	border: 1px dashed var(--cc-line-strong);
	border-radius: var(--cc-radius);
}

.empty-text {
	max-width: 44ch;
	margin: 0;
	color: var(--cc-text-dim);
	line-height: 1.7;
}
</style>
