<script setup lang="ts">
import StudioShell from './shell/StudioShell.vue';
// 主题变量在这里进全局：外壳下的每个组件都只引用 var(--cc-*)，不再自带色值。
import './shell/theme.css';
import { loadSampleTask } from './state/document';
import { startTeachingWatch } from './state/teaching';

// 启动就灌一份示例任务，三个视图有东西可显示；真实导入入口是 store 的 loadTaskJson。
loadSampleTask();
// 声明一换就让模型重画那三样（第二次调用）。挂在这里而不是各视图里：
// 三张画布读的是同一份规格，重画的时机也就只该有一个。
startTeachingWatch();
</script>

<template>
	<StudioShell />
</template>
