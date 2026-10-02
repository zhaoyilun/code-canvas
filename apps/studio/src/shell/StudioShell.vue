<script setup lang="ts">
// 左栏：积木画布 / 流程画布 / 右栏检查器。三块都自管内容，此处只摆放。
import { computed, ref } from 'vue';
import IconRail from './IconRail.vue';
import StatusBar from './StatusBar.vue';
import TopTabBar from './TopTabBar.vue';
import { DEFAULT_TAB, isTabId, labelOf, type TabId } from './tabs';
import { FIRST_REACHABLE_STAGE } from './stages';
import BlocklyView from '../views/blockly/BlocklyView.vue';
import FlowView from '../views/flow/FlowView.vue';
import RightPanel from '../views/right/RightPanel.vue';

const activeTab = ref<TabId>(DEFAULT_TAB);
const currentStage = ref<string>(FIRST_REACHABLE_STAGE);

// 当前工作区名交给底部状态条，RUN/STOP 的日志里带上它，便于确认 tab 生效。
const activeLabel = computed(() => labelOf(activeTab.value));

// 子组件只抛字符串，在这里收窄一次，非法值忽略。
function selectTab(id: string): void {
	if (isTabId(id)) {
		activeTab.value = id;
	}
}
</script>

<template>
	<div class="shell">
		<TopTabBar :active="activeTab" @select="selectTab" />
		<div class="studio-body">
			<IconRail :active="activeTab" @select="selectTab" />
			<main class="workspace">
				<section class="pane pane-canvas">
					<BlocklyView />
				</section>
				<section class="pane pane-flow">
					<FlowView />
				</section>
				<aside class="pane pane-inspector">
					<RightPanel :tab="activeTab" />
				</aside>
			</main>
		</div>
		<StatusBar
			:current-stage="currentStage"
			:context="activeLabel"
			@select-stage="currentStage = $event"
		/>
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
 * 外壳本身不塌（页面仍可见左栏 + 顶部 + 底部）。
 */
@media (max-width: 1100px) {
	.workspace {
		grid-template-columns: minmax(300px, 1fr) minmax(300px, 1fr) 300px;
		overflow-x: auto;
	}
}
</style>
