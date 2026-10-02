<script setup lang="ts">
/**
 * 左栏：积木画布（spec §4.1）。三个视图里**只有这块能改**。
 *
 * 画的是**当前选中模块的实现**：一个模块 = 一个能力，一块积木 = 实现里的一步。
 * 改字段 → 编译回同一份 workflow 声明（只改这个节点的 parameters）→ `store.applyDeclaration`；
 * 校验不过就只留诊断。接线全在 `useBlocklyCanvas()` 里，这里只摆放 DOM 与显示状态。
 */
import { computed } from 'vue';
import { useStudioDocument } from '../../state/document';
import { useBlocklyCanvas } from './blockly-canvas';
import DiagnosticsPanel from './DiagnosticsPanel.vue';

const store = useStudioDocument();
const {
	hostRef,
	diagnostics,
	status,
	statusText,
	failure,
	blockCount,
	writeSuspended,
	selectedBlockId,
	decoratedBlocks,
	moduleTitle,
} = useBlocklyCanvas();

const taskName = computed(() => store.declaration.value?.name ?? '');

/** 已经挂上 `data-node-id` 与序号徽标的积木数——三个视图之间「同一件事」的锚点数。 */
const anchoredCount = computed(() => decoratedBlocks.value.length);
</script>

<template>
	<section class="blockly-view" data-testid="view-blockly">
		<header class="view-header">
			<span class="view-title">积木画布</span>
			<span class="view-tag">BLOCKLY</span>
			<span class="view-tag">唯一可写</span>
			<span class="view-count" data-testid="blockly-block-count">{{ blockCount }} 块</span>
		</header>

		<p class="view-module" data-testid="blockly-module-title">{{ moduleTitle }}</p>

		<p v-if="taskName !== ''" class="view-task" data-testid="blockly-task">{{ taskName }}</p>

		<div class="canvas" data-testid="blockly-canvas-frame">
			<div ref="hostRef" class="canvas-host" data-testid="blockly-canvas" />
			<p v-if="failure !== null" class="canvas-failure" data-testid="blockly-failure">{{ failure }}</p>
		</div>

		<footer class="view-footer">
			<span class="write-state" :class="status" data-testid="blockly-write-state">{{ statusText }}</span>
			<span
				v-if="anchoredCount > 0"
				class="footer-hint"
				data-testid="blockly-anchored-count"
				title="每块积木的 SVG 上都挂了 data-node-id，跨栏连线只靠它定位"
			>
				{{ anchoredCount }} 块带 nodeId 锚点
			</span>
			<span v-if="writeSuspended" class="footer-hint">画布不完整，写回已暂停</span>
			<span v-else-if="selectedBlockId !== null" class="footer-hint" data-testid="blockly-selected">
				{{ selectedBlockId }}
			</span>
		</footer>

		<DiagnosticsPanel :rows="diagnostics" />
	</section>
</template>

<style scoped>
.blockly-view {
	display: flex;
	flex-direction: column;
	gap: var(--cc-space-2);
	height: 100%;
	min-height: 0;
	padding: var(--cc-space-4);
}

.view-header {
	display: flex;
	align-items: baseline;
	gap: var(--cc-space-2);
	flex-wrap: wrap;
	padding-bottom: var(--cc-space-2);
	border-bottom: 1px solid var(--cc-line);
}

.view-title {
	font-size: var(--cc-fs-lg);
	font-weight: 600;
	color: var(--cc-text);
}

.view-tag {
	padding: 2px var(--cc-space-2);
	font-family: var(--cc-font-mono);
	font-size: var(--cc-fs-xs);
	letter-spacing: 0.06em;
	color: var(--cc-accent);
	background: var(--cc-accent-veil);
	border: 1px solid var(--cc-accent-dim);
	border-radius: var(--cc-radius-sm);
}

.view-count {
	margin-left: auto;
	font-family: var(--cc-font-mono);
	font-size: var(--cc-fs-sm);
	color: var(--cc-text-faint);
}

.view-task {
	margin: 0;
	font-family: var(--cc-font-mono);
	font-size: var(--cc-fs-sm);
	color: var(--cc-text-dim);
}

/*
 * 模块标题：「<能力的 label> · 实现」。它是这一栏唯一的「我在看什么」的说明——
 * 积木画布现在只显示一个模块的内部，标题不写清楚，用户就不知道这堆积木属于谁。
 */
.view-module {
	margin: 0;
	font-size: var(--cc-fs-md);
	font-weight: 600;
	color: var(--cc-text);
}

/*
 * Blockly 自己往这个容器里塞 SVG 与工具箱，所以容器必须是个有尺寸的定位盒子。
 * 底色由主题给（componentStyles.workspaceBackgroundColour = --cc-surface-sunken）。
 */
.canvas {
	position: relative;
	flex: 1 1 auto;
	min-height: 240px;
	overflow: hidden;
	border: 1px solid var(--cc-line);
	border-radius: var(--cc-radius);
}

.canvas-host {
	width: 100%;
	height: 100%;
}

/*
 * 单位标签：`@codecanvas/blockly-toolkit` 的 BLOCK_UNIT_CLASS 挂在块内那个只读小标签上。
 * Blockly 块内文字共用一个字号，这里按 class 单独压到 --cc-fs-xs——
 * 单位因此不占主行宽度，`angular (rad/s)` 那种截断不会再发生（单位也留在 tooltip 里）。
 */
.canvas-host :deep(.cc-block-unit) {
	font-family: var(--cc-font-mono);
	font-size: var(--cc-fs-xs);
	fill: var(--cc-text);
	opacity: 0.85;
}

/*
 * 序号徽标：它是画在积木 `<g>` 里的 SVG（见 `sequence-badge.ts`），所以色值走属性、
 * 交互走 pointer-events——这里只钉一件事：徽标不参与命中，点它等于点积木。
 * 新模型下它数的是「**实现里的第几步**」（这个模块内部 1、2、3），与流程卡片上
 * 「任务里的第几步」不是同一个数——后者属于整条链，前者属于这个模块的内部。
 */
.canvas-host :deep(.cc-seq-badge) {
	pointer-events: none;
}

/* 选中：与另外两栏同一套——徽标反白压实心强调色、描边加粗一档（形状见 updateBadge）。 */
.canvas-host :deep(.cc-seq-badge-active) {
	filter: drop-shadow(0 0 4px var(--cc-accent-glow));
}

.canvas-failure {
	position: absolute;
	inset: auto var(--cc-space-3) var(--cc-space-3) var(--cc-space-3);
	margin: 0;
	padding: var(--cc-space-2);
	font-size: var(--cc-fs-sm);
	color: var(--cc-text);
	background: var(--cc-danger-veil);
	border: 1px solid var(--cc-danger);
	border-radius: var(--cc-radius-sm);
}

.view-footer {
	display: flex;
	align-items: baseline;
	gap: var(--cc-space-2);
	flex-wrap: wrap;
	font-size: var(--cc-fs-sm);
}

.write-state {
	color: var(--cc-text-dim);
}

.write-state.written {
	color: var(--cc-accent);
}

.write-state.rejected,
.write-state.broken,
.write-state.failed {
	color: var(--cc-danger-strong);
}

.footer-hint {
	font-family: var(--cc-font-mono);
	font-size: var(--cc-fs-xs);
	color: var(--cc-text-faint);
	overflow-wrap: anywhere;
}
</style>
