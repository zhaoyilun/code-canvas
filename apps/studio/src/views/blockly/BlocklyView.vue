<script setup lang="ts">
/**
 * 左栏：积木画布（spec §4.1）——**模型写的块树**。
 *
 * 画的是第二次调用的产出（`state/teaching.ts` 的 `spec.blocks`）：一棵可嵌套的块树——
 * 调用块、C 形条件块、重复块、等待块、说明块，实参是插进槽位里的**值块**。
 * 块的定义按规格动态生成（`spec-canvas.ts`），铺开由播放队列一格一格放出来，
 * 每一块入场是「从工具箱方向拖进来、落位」（`playBlockStepEntrance`，收在 identity）。
 *
 * 这一栏从前是**唯一能写回声明**的地方。现在不是了，而且是有意的：屏幕上这棵树讲的是
 * 「这件事怎么做」（模型的教学），机器要执行的那份契约仍然是 `state/document.ts` 的声明。
 * 拿一棵讲解用的树去改契约，等于让讲解变成命令——那两件事不是一回事。
 * 声明那条通道一个字都没动（`applyDeclaration` 还在，只是这里不再调它）。
 *
 * 画不出来时照实说，不退回旧那套「从目录推实现」的积木顶上：
 * 那不是这块画布现在要画的东西，拿它顶上等于把「模型没画出来」这句话藏起来。
 */
import { computed } from 'vue';
import { teachingBlockCount } from '@codecanvas/contracts';
import { useSpecCanvas } from './spec-canvas';
import { useTeaching } from '../../state/teaching';

const teaching = useTeaching();

/** 播放队列放到第几格（值块也算一格——它插进槽里的那一刻也该是一块块落进来的一块）。 */
const revealedCount = computed(() => teaching.revealedBlockItems.value.length);

const { hostRef, failure, blockCount } = useSpecCanvas({ spec: teaching.spec, revealedCount });

const spec = teaching.spec;

/** 规格里一共有几块（铺开的进度读数用它，与画布上真实块数对账）。 */
const specBlockCount = computed(() => (spec.value === null ? 0 : teachingBlockCount(spec.value.blocks)));
</script>

<template>
	<section class="blockly-view" data-testid="view-blockly">
		<header class="view-header">
			<span class="view-title">积木画布</span>
			<span v-if="spec !== null" class="view-task" data-testid="blockly-title">{{ spec.title }}</span>
		</header>

		<div class="canvas" data-testid="blockly-canvas-frame">
			<div ref="hostRef" class="canvas-host" data-testid="blockly-canvas" />
			<p v-if="failure !== null" class="canvas-failure" data-testid="blockly-failure">{{ failure }}</p>
		</div>

		<footer class="view-footer">
			<!--
				两个数分开说：规格里有几块、讲到第几块，是**规格与播放队列**的事实（画布起没起来都成立）；
				画布上真有几块是**画布**的事实，画布没建起来时一个字都不说它——
				那时报一个「0 块」会读成「这份规格是空的」，而那是假的。
			-->
			<span v-if="spec !== null" class="footer-hint" data-testid="blockly-block-count">
				共 {{ specBlockCount }} 块（讲到了第 {{ revealedCount }} 块<template v-if="failure === null">，画布上 {{ blockCount }} 块</template>）
			</span>
			<span v-else-if="teaching.status.value === 'drawing'" class="footer-hint" data-testid="blockly-drawing">
				正在写…（已经收到 {{ teaching.streamedChars.value }} 字）
			</span>
			<span v-else-if="teaching.failure.value !== null" class="footer-hint footer-failed" data-testid="blockly-failed">
				模型没画出来：{{ teaching.failure.value.message }}
			</span>
			<span v-else class="footer-hint" data-testid="blockly-empty">还没有积木可画</span>
		</footer>
	</section>
</template>

<style scoped>
.blockly-view {
	display: flex;
	flex-direction: column;
	gap: var(--cc-space-2);
	height: 100%;
	min-height: 0;
	padding: var(--cc-space-4);
}

.view-header {
	display: flex;
	align-items: baseline;
	gap: var(--cc-space-2);
	flex-wrap: wrap;
	padding-bottom: var(--cc-space-2);
	border-bottom: 1px solid var(--cc-line);
}

.view-title {
	font-size: var(--cc-fs-lg);
	font-weight: 600;
	color: var(--cc-text);
}

.view-task {
	margin-left: auto;
	font-family: var(--cc-font-mono);
	font-size: var(--cc-fs-sm);
	color: var(--cc-text-dim);
}

/*
 * Blockly 自己往这个容器里塞 SVG（没有工具箱——这些块是讲解，不是可拖的东西）。
 * 底色由主题给（componentStyles.workspaceBackgroundColour = --cc-surface-sunken）。
 */
.canvas {
	position: relative;
	flex: 1 1 auto;
	min-height: 240px;
	overflow: hidden;
	border: 1px solid var(--cc-line);
	border-radius: var(--cc-radius);
}

.canvas-host {
	width: 100%;
	height: 100%;
}

/*
 * 还没轮到的那一块：按住（透明、不吃指针）。用 `opacity` 而不是 `display/visibility`——
 * 块的位置是画的时候就定下来的，铺开过程里**一个位置都不许变**；透明只是「还没出现」。
 * 指针也不给它：不然画布上会出现一块看不见却点得中的东西。
 */
.canvas-host :deep(.cc-spec-pending) {
	opacity: 0;
	pointer-events: none;
}

/*
 * 积木的入场：**从工具箱那边拖进来 → 落位**（类由 `blockly-canvas.ts` 的
 * `playBlockStepEntrance` 挂/摘）。三个属性各自干什么：
 *   - `translate`：从工具箱那一边（左侧）滑进来，路上略过一点再收回——落定的手感；
 *   - `scale`：起手小一点，落定时收回 1（**收在 identity**）；
 *   - `opacity`：同一趟里渐显，免得块在半空中是透明的。
 *
 * 为什么用独立的 `translate`/`scale` 而不用 `transform` 简写：Blockly 给每个块的 `<g>` 写着
 * `transform="translate(x, y)"` —— 块的定位就靠它。CSS 的 `transform` 会整个盖掉那个属性
 * （元素会跳到画布原点）；这两个独立属性是与它复合的，不碰定位。
 */
/*
 * ⚠ 选择器**不带** `blocklyDraggable`：这块画布是 `readOnly` 的（这些积木是讲解，不是可拖的东西），
 * 而 Blockly 只在可拖时给块根元素挂那个类——实测 readOnly 的块根上没有 `blocklyDraggable`
 * （真浏览器里量过），照旧写那个类，入场动画会一条都不生效。
 * `cc-block-enter` 是我们自己挂的类，拿它当判据最准。
 */
.canvas-host :deep(g.cc-block-enter) {
	animation: cc-block-land 220ms cubic-bezier(0.22, 0.9, 0.3, 1) 1 both;
}

@keyframes cc-block-land {
	from {
		opacity: 0;
		translate: -60px -14px;
		scale: 0.9;
	}

	/* 落定的手感：略过一点再收回（这一段之后才是真正的终态）。 */
	62% {
		opacity: 1;
		translate: 5px 0;
		scale: 1.012;
	}

	to {
		opacity: 1;
		translate: none;
		scale: none;
	}
}

@media (prefers-reduced-motion: reduce) {
	.canvas-host :deep(g.cc-block-enter) {
		animation: none;
	}
}

.canvas-failure {
	position: absolute;
	inset: auto var(--cc-space-3) var(--cc-space-3) var(--cc-space-3);
	margin: 0;
	padding: var(--cc-space-2);
	font-size: var(--cc-fs-sm);
	color: var(--cc-text);
	background: var(--cc-danger-veil);
	border: 1px solid var(--cc-danger);
	border-radius: var(--cc-radius-sm);
}

.view-footer {
	display: flex;
	align-items: baseline;
	gap: var(--cc-space-2);
	flex-wrap: wrap;
	font-size: var(--cc-fs-sm);
}

.footer-hint {
	font-family: var(--cc-font-mono);
	font-size: var(--cc-fs-xs);
	color: var(--cc-text-faint);
	overflow-wrap: anywhere;
}

.footer-failed {
	color: var(--cc-danger-strong);
}
</style>
