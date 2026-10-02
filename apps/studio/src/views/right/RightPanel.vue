<script setup lang="ts">
/**
 * 右栏 = **虚拟设备**（固定常驻，上）+ **代码面板**（固定常驻，下）。
 *
 * 这里没有 tab：界面是固定分区，右栏两块始终都在，不随任何选择切换。
 *
 * 上面那块现在**是空的，因为我们还没接上设备层**——虚拟表示要显示的是一台真实设备的
 * 状态与能力目录，设备没连上就没有可显示的东西。所以这里只说明它将来放什么、
 * 现在为什么空着，不画占位假数据，也不写「即将上线」。
 *
 * 下面那块是声明的编译产物（spec §4.1），自带滚动，吃掉右栏剩余的全部高度。
 */
import IconBase from '../../shell/IconBase.vue';
import { CodePanel } from '../code-panel';
</script>

<template>
	<section class="right-panel" data-testid="right-panel">
		<!-- 虚拟设备：固定常驻，现在如实为空 -->
		<section class="device" data-testid="virtual-device">
			<header class="panel-header">
				<IconBase name="device" :size="20" />
				<span class="panel-title">虚拟设备</span>
				<span class="panel-tag">设备层未接入</span>
			</header>

			<div class="device-body" data-testid="virtual-device-note">
				<p class="panel-text">
					这里将来放一台设备的虚拟表示：它当前的状态，以及它报出来的能力目录。设备层还没接上，
					没有设备可表示，所以这块现在空着——不画占位图，也不给假状态。
				</p>
				<p class="panel-footnote">后置：设备协议定稿、设备层接上之后才有内容</p>
			</div>
		</section>

		<!-- 代码面板：固定常驻，占满右栏剩下的全部高度 -->
		<div class="panel-code" data-testid="right-panel-code">
			<CodePanel />
		</div>
	</section>
</template>

<style scoped>
.right-panel {
	display: flex;
	flex-direction: column;
	height: 100%;
	min-height: 0;
}

/* 虚拟设备：按内容定高，封上限——不许把代码面板挤没 */
.device {
	display: flex;
	flex-direction: column;
	flex: 0 0 auto;
	max-height: 40%;
	border-bottom: 1px solid var(--cc-line);
}

.panel-header {
	display: flex;
	align-items: center;
	gap: var(--cc-space-2);
	flex: 0 0 auto;
	padding: var(--cc-space-3) var(--cc-space-4);
	color: var(--cc-text-dim);
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
	color: var(--cc-text-faint);
	background: var(--cc-surface-sunken);
	border: 1px solid var(--cc-line-strong);
	border-radius: var(--cc-radius-sm);
}

.device-body {
	flex: 0 0 auto;
	padding: var(--cc-space-3) var(--cc-space-4);
	overflow-y: auto;
}

.panel-text {
	margin: 0;
	font-size: var(--cc-fs-sm);
	line-height: 1.6;
	color: var(--cc-text-dim);
}

.panel-footnote {
	margin: var(--cc-space-1) 0 0;
	font-family: var(--cc-font-mono);
	font-size: var(--cc-fs-xs);
	color: var(--cc-text-faint);
}

/*
 * 代码面板的槽位。用 grid 而不是 flex：单行单列的轨道会把子元素拉到满高满宽，
 * 面板内部的 height:100% 也就有了确定的基准，不会只画出半截。
 */
.panel-code {
	display: grid;
	grid-template-columns: minmax(0, 1fr);
	grid-template-rows: minmax(0, 1fr);
	flex: 1 1 auto;
	min-height: 0;
	overflow: hidden;
}
</style>
