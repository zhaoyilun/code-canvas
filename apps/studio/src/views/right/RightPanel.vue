<script setup lang="ts">
// 右侧检查器：随当前 tab 切换内容。本阶段每个 tab 只给说明，M2 再填真东西。
import { computed } from 'vue';
import { labelOf, type TabId } from '../../shell/tabs';

const props = defineProps<{ tab: TabId }>();

interface PanelCopy {
	tag: string;
	body: string;
	note: string;
}

const CONTENT: Record<TabId, PanelCopy> = {
	plan: {
		tag: 'AI PLAN',
		body: '自然语言变成任务 JSON 的那一步不归这个界面管——上游生成器负责。这里以后放计划预览与差异审核。',
		note: '后置：设计期 diff 审核',
	},
	blockly: {
		tag: 'INSPECTOR',
		body: '选中一块积木后，它的字段与取值落在哪条限值里会显示在这里。改参数是从积木画布改的。',
		note: 'M2 接入：由校验器推导的字段面板',
	},
	workflow: {
		tag: 'CODE',
		body: '代码面板显示的是编译产物——改一个积木上的参数，这里那个数字跟着变。这份文本只读。',
		note: 'M2 接入：声明 → 代码文本（规则由校验器推导）',
	},
	simulation: {
		tag: 'SIMULATION',
		body: '本阶段不执行、不仿真，所以这里画不出任何东西，也不会给你一个假的状态。',
		note: '后置：执行器落地后再接',
	},
	hardware: {
		tag: 'HARDWARE',
		body: '设备连上后报出的能力目录决定积木里多出哪些设备积木——「设备连上」和「积木长出来」是同一件事。',
		note: '后置：设备协议定稿后再接',
	},
};

const copy = computed<PanelCopy>(() => CONTENT[props.tab]);
</script>

<template>
	<section class="right-panel" data-testid="right-panel">
		<header class="panel-header">
			<span class="panel-title">{{ labelOf(tab) }}</span>
			<span class="panel-tag">{{ copy.tag }}</span>
		</header>
		<div class="panel-body">
			<p class="panel-text">{{ copy.body }}</p>
		</div>
		<footer class="panel-footer">{{ copy.note }}</footer>
	</section>
</template>

<style scoped>
.right-panel {
	display: flex;
	flex-direction: column;
	height: 100%;
	min-height: 0;
}

.panel-header {
	display: flex;
	align-items: baseline;
	gap: var(--cc-space-2);
	padding: var(--cc-space-3) var(--cc-space-4);
	border-bottom: 1px solid var(--cc-line);
}

.panel-title {
	font-size: var(--cc-fs-md);
	font-weight: 600;
	color: var(--cc-text);
}

.panel-tag {
	margin-left: auto;
	padding: 2px var(--cc-space-2);
	font-family: var(--cc-font-mono);
	font-size: var(--cc-fs-xs);
	letter-spacing: 0.06em;
	color: var(--cc-accent);
	background: var(--cc-accent-veil);
	border: 1px solid var(--cc-accent-dim);
	border-radius: var(--cc-radius-sm);
}

.panel-body {
	flex: 1 1 auto;
	min-height: 0;
	padding: var(--cc-space-4);
	overflow-y: auto;
}

.panel-text {
	margin: 0;
	color: var(--cc-text-dim);
	line-height: 1.75;
}

.panel-footer {
	padding: var(--cc-space-3) var(--cc-space-4);
	font-family: var(--cc-font-mono);
	font-size: var(--cc-fs-sm);
	color: var(--cc-text-faint);
	border-top: 1px solid var(--cc-line);
}
</style>
