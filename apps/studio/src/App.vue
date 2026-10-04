<script setup lang="ts">
import StudioShell from './shell/StudioShell.vue';
// 主题变量在这里进全局：外壳下的每个组件都只引用 var(--cc-*)，不再自带色值。
import './shell/theme.css';
import { startTeachingWatch } from './state/teaching';
import { demoRequested, runDemoScript } from './shell/demo-script';

/*
 * 开局**什么都不灌**：声明为空，三个视图各自说「还没有」。
 *
 * 从前这里挂载时就 `loadSampleTask()`，于是打开页面三张画布上就有东西——那些东西
 * 不属于用户说过的任何一句话，却长得跟真的一样。这一版去掉它：有内容只有一条路，
 * 就是用户敲一句话点「生成」（`TaskInputBand` → `loadTaskJson`）。
 *
 * `loadSampleTask` 这个函数留着（它是「按当前设备格式灌一份样例」的唯一实现，
 * 手工验证与测试都在用），只是不再在启动时调它。
 */
// 声明一换就让模型重画那三样（第二次调用）。挂在这里而不是各视图里：
// 三张画布读的是同一份规格，重画的时机也就只该有一个。
// `immediate` 仍然开着：这一刻声明是空的，它什么都不做（`runTeaching` 见没有声明就返回），
// 而用户第一次生成完，这条线要能立刻接上。
startTeachingWatch();

/*
 * 演示脚本：**只在 URL 带 `?demo=1` 时跑**（录屏/自动化用）。
 * 平时这一行什么都不做——`demoRequested()` 是纯读参数，`runDemoScript` 根本不会被调。
 * 为什么把驱动放进页面而不是从外面灌指令：外部驱动（CDP 的 Runtime.evaluate）在推帧录屏时
 * 会静默失败（帧消息把信道灌满），实测录到一整段没打字的空场。理由写在 demo-script.ts 头上。
 */
if (demoRequested()) {
	void runDemoScript();
}
</script>

<template>
	<StudioShell />
</template>
