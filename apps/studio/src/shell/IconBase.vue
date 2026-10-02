<script setup lang="ts">
// 内联 SVG 图标，不引图标库。
// 这里存的是纯 path 的 `d` 数据（不带 <path> 标签）——写标签进去浏览器会整条忽略。
import { computed } from 'vue';

/** 图标名。目前只有虚拟设备一个；再加图标就在 PATHS 里补，名字同时列进这里。 */
export type IconName = 'device';

const props = withDefaults(defineProps<{ name: IconName; size?: number }>(), { size: 20 });

const PATHS: Record<IconName, readonly string[]> = {
	// 一台设备：机壳 + 顶部指示灯 + 两条支脚
	device: [
		'M3.75 5.25h16.5v12.5H3.75z',
		'M15.5 8.75h1.75v1.75h-1.75z',
		'M8.75 17.75v2.5M15.25 17.75v2.5',
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
