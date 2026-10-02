<script setup lang="ts">
/**
 * 左栏：积木画布（spec §4.1）。三个视图里**只有这块能改**。
 *
 * 改字段 → 编译回同一份 workflow 声明 → `store.applyDeclaration`；校验不过就只留诊断。
 * 接线全在 `useBlocklyCanvas()` 里，这里只摆放 DOM 与显示状态。
 */
import { computed } from 'vue';
import { useStudioDocument } from '../../state/document';
import { useBlocklyCanvas } from './blockly-canvas';
import DiagnosticsPanel from './DiagnosticsPanel.vue';

const store = useStudioDocument();
const { hostRef, diagnostics, status, statusText, failure, blockCount, writeSuspended, selectedBlockId } =
	useBlocklyCanvas();

const taskName = computed(() => store.declaration.value?.name ?? '');
</script>

<template>
	<section class="blockly-view" data-testid="view-blockly">
		<header class="view-header">
			<span class="view-title">积木画布</span>
			<span class="view-tag">BLOCKLY</span>
			<span class="view-tag">唯一可写</span>
			<span class="view-count" data-testid="blockly-block-count">{{ blockCount }} 块</span>
		</header>

		<p v-if="taskName !== ''" class="view-task" data-testid="blockly-task">{{ taskName }}</p>

		<div class="canvas" data-testid="blockly-canvas-frame">
			<div ref="hostRef" class="canvas-host" data-testid="blockly-canvas" />
			<p v-if="failure !== null" class="canvas-failure" data-testid="blockly-failure">{{ failure }}</p>
		</div>

		<footer class="view-footer">
			<span class="write-state" :class="status" data-testid="blockly-write-state">{{ statusText }}</span>
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
