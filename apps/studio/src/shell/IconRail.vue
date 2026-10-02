<script setup lang="ts">
// 左侧窄图标栏：纯展示 + 透传选择，不持有 tab 状态（状态在 StudioShell）。
import IconBase from './IconBase.vue';
import { SECTIONS } from './tabs';

defineProps<{ active: string }>();
const emit = defineEmits<{ (e: 'select', id: string): void }>();
</script>

<template>
	<nav class="rail" aria-label="工作区">
		<button
			v-for="section in SECTIONS"
			:key="section.id"
			type="button"
			class="rail-item"
			:class="{ active: section.id === active }"
			:aria-pressed="section.id === active"
			:aria-label="section.label"
			:title="section.label"
			:data-testid="`nav-${section.id}`"
			@click="emit('select', section.id)"
		>
			<IconBase :name="section.icon" :size="20" />
			<!-- 「AI」两个字画不成图标，用文字；其余四项只留图标，免得 48px 宽里塞两样都看不清 -->
			<span v-if="section.glyph.length > 1" class="rail-glyph">{{ section.glyph }}</span>
		</button>
	</nav>
</template>

<style scoped>
.rail {
	display: flex;
	flex-direction: column;
	flex: 0 0 auto;
	gap: var(--cc-space-1);
	width: var(--cc-rail-w);
	padding: var(--cc-space-2) 0;
	background: var(--cc-surface-sunken);
	border-right: 1px solid var(--cc-line);
}

.rail-item {
	display: flex;
	flex-direction: column;
	align-items: center;
	justify-content: center;
	gap: 3px;
	width: 48px;
	height: 56px;
	margin: 0 auto;
	color: var(--cc-text-faint);
	background: transparent;
	border: 1px solid transparent;
	border-radius: var(--cc-radius);
	cursor: pointer;
	transition:
		color 0.15s ease,
		background 0.15s ease,
		border-color 0.15s ease;
}

.rail-item:hover {
	color: var(--cc-text-dim);
	background: var(--cc-surface);
}

.rail-item.active {
	color: var(--cc-accent);
	background: var(--cc-accent-veil);
	border-color: var(--cc-accent-dim);
}

.rail-glyph {
	font-size: 13px;
	font-weight: 650;
	line-height: 1;
	letter-spacing: 0.02em;
}
</style>
