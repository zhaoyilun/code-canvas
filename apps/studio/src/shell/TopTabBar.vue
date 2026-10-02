<script setup lang="ts">
// 顶部 tab 条：与左图标栏读同一份 SECTIONS，点任一处都切。
import { SECTIONS } from './tabs';

defineProps<{ active: string }>();
const emit = defineEmits<{ (e: 'select', id: string): void }>();
</script>

<template>
	<header class="topbar">
		<span class="brand">CodeCanvas</span>
		<span class="brand-sub">STUDIO</span>
		<div class="tabs" role="tablist" aria-label="工作区">
			<button
				v-for="section in SECTIONS"
				:key="section.id"
				type="button"
				role="tab"
				class="tab"
				:class="{ active: section.id === active }"
				:aria-selected="section.id === active"
				:data-testid="`tab-${section.id}`"
				@click="emit('select', section.id)"
			>
				{{ section.label }}
			</button>
		</div>
	</header>
</template>

<style scoped>
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
	margin-right: var(--cc-space-4);
	font-size: var(--cc-fs-xs);
	letter-spacing: 0.18em;
	color: var(--cc-accent-dim);
}

.tabs {
	display: flex;
	align-items: center;
	gap: var(--cc-space-1);
	overflow-x: auto;
}

.tab {
	padding: 6px var(--cc-space-3);
	color: var(--cc-text-dim);
	background: transparent;
	border: 1px solid transparent;
	border-radius: var(--cc-radius-sm);
	white-space: nowrap;
	cursor: pointer;
	transition:
		color 0.15s ease,
		background 0.15s ease,
		border-color 0.15s ease;
}

.tab:hover {
	color: var(--cc-text);
	background: var(--cc-surface-raised);
}

.tab.active {
	color: var(--cc-accent);
	background: var(--cc-accent-veil);
	border-color: var(--cc-accent-dim);
}
</style>
