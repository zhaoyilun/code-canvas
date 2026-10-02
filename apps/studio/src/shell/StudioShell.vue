<script setup lang="ts">
/**
 * 固定分区外壳：顶部品牌条 + 输入带 → 三栏（积木 / 流程 / 右栏）→ 底部状态条。
 *
 * 这里**没有 tab**：三栏是同时可见的固定布局，不存在「切下面显示什么」这回事，
 * 所以既没有 tab 条也没有图标栏——不摆点了没用的控件。
 *
 * 右栏（虚拟设备 + 代码面板）自管内容，此处只摆放。
 */
import { ref } from 'vue';
import StatusBar from './StatusBar.vue';
import TaskInputBand from './TaskInputBand.vue';
import { FIRST_REACHABLE_STAGE } from './stages';
import BlocklyView from '../views/blockly/BlocklyView.vue';
import FlowView from '../views/flow/FlowView.vue';
import RightPanel from '../views/right/RightPanel.vue';

const currentStage = ref<string>(FIRST_REACHABLE_STAGE);
</script>

<template>
	<div class="shell">
		<header class="topbar">
			<span class="brand">CodeCanvas</span>
			<span class="brand-sub">STUDIO</span>
		</header>
		<TaskInputBand />
		<div class="studio-body">
			<main class="workspace">
				<section class="pane pane-canvas">
					<BlocklyView />
				</section>
				<section class="pane pane-flow">
					<FlowView />
				</section>
				<aside class="pane pane-inspector">
					<RightPanel />
				</aside>
			</main>
		</div>
		<StatusBar :current-stage="currentStage" @select-stage="currentStage = $event" />
	</div>
</template>

<style scoped>
.shell {
	display: flex;
	flex-direction: column;
	height: 100%;
	min-height: 0;
	background: var(--cc-bg);
}

.topbar {
	display: flex;
	align-items: center;
	gap: var(--cc-space-2);
	flex: 0 0 auto;
	height: var(--cc-topbar-h);
	padding: 0 var(--cc-space-4) 0 var(--cc-space-3);
	background: var(--cc-surface);
	border-bottom: 1px solid var(--cc-line);
}

.brand {
	font-size: var(--cc-fs-lg);
	font-weight: 650;
	letter-spacing: 0.01em;
	color: var(--cc-text);
}

.brand-sub {
	font-size: var(--cc-fs-xs);
	letter-spacing: 0.18em;
	color: var(--cc-accent-dim);
}

.studio-body {
	display: flex;
	flex: 1 1 auto;
	min-height: 0;
}

.workspace {
	display: grid;
	grid-template-columns: minmax(320px, 1fr) minmax(320px, 1fr) var(--cc-right-w);
	flex: 1 1 auto;
	min-width: 0;
	min-height: 0;
	background: var(--cc-stage);
}

.pane {
	display: flex;
	flex-direction: column;
	min-width: 0;
	min-height: 0;
	overflow: hidden;
}

.pane-flow {
	border-left: 1px solid var(--cc-line);
}

.pane-inspector {
	border-left: 1px solid var(--cc-line);
	background: var(--cc-surface);
}

/*
 * 窄窗退化：三栏不再挤成一团。给工作区一个下限宽度并允许横向滚动，
 * 外壳本身不塌（页面仍可见顶部 + 底部）。
 */
@media (max-width: 1100px) {
	.workspace {
		grid-template-columns: minmax(300px, 1fr) minmax(300px, 1fr) 300px;
		overflow-x: auto;
	}
}
</style>
