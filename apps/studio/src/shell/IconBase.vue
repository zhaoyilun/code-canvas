<script setup lang="ts">
// 内联 SVG 图标，不引图标库。
// 这里存的是纯 path 的 `d` 数据（不带 <path> 标签）——写标签进去浏览器会整条忽略。
import { computed } from 'vue';
import type { IconName } from './tabs';

const props = withDefaults(defineProps<{ name: IconName; size?: number }>(), { size: 20 });

const PATHS: Record<IconName, readonly string[]> = {
	// 一个节点分叉到两个（计划）
	plan: ['M9.75 3.75h4.5v3.5h-4.5z', 'M4.5 16.75h4.5v3.5H4.5z', 'M15 16.75h4.5v3.5H15z', 'M12 7.25v5M6.75 16.75v-4.5h10.5v4.5'],
	// 两块咬合的拼图积木
	blocks: [
		'M4.5 5.25h6.2v3.1h1.6v-3.1h6.2v5.3h-3.1v1.6h3.1v5.6h-6.2v-3.1h-1.6v3.1H4.5v-5.6h3.1v-1.6H4.5z',
	],
	// 流程图：框 + 分支
	flow: ['M4.5 3.75h6v4h-6z', 'M13.5 12h6v4h-6z', 'M7.5 7.75v4.5h6M13.5 14h-4'],
	// 播放三角（仿真）
	sim: ['M8.5 5.5l10 6.5-10 6.5z'],
	// 芯片（硬件）
	hardware: [
		'M7.5 7.5h9v9h-9z',
		'M10.5 4.25v3.25M13.5 4.25v3.25M10.5 16.5v3.25M13.5 16.5v3.25M4.25 10.5h3.25M4.25 13.5h3.25M16.5 10.5h3.25M16.5 13.5h3.25',
	],
};

const paths = computed(() => PATHS[props.name]);
</script>

<template>
	<svg
		class="cc-icon"
		:width="size"
		:height="size"
		viewBox="0 0 24 24"
		fill="none"
		stroke="currentColor"
		stroke-width="1.5"
		stroke-linecap="round"
		stroke-linejoin="round"
		aria-hidden="true"
		focusable="false"
	>
		<path v-for="(d, i) in paths" :key="i" :d="d" />
	</svg>
</template>

<style scoped>
.cc-icon {
	display: block;
}
</style>
