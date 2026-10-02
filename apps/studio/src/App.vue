<script setup lang="ts">
import StudioShell from './shell/StudioShell.vue';
// 主题变量在这里进全局：外壳下的每个组件都只引用 var(--cc-*)，不再自带色值。
import './shell/theme.css';
import { loadSampleTask } from './state/document';

// 启动就灌一份示例任务，三个视图有东西可显示；真实导入入口是 store 的 loadTaskJson。
loadSampleTask();
</script>

<template>
	<StudioShell />
</template>
