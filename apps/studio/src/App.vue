<script setup lang="ts">
import StudioShell from './shell/StudioShell.vue';
// 主题变量在这里进全局：外壳下的每个组件都只引用 var(--cc-*)，不再自带色值。
import './shell/theme.css';
</script>

<template>
	<StudioShell />
</template>
