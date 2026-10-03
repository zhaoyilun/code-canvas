<script setup lang="ts">
/**
 * 左栏：积木画布（spec §4.1）。三个视图里**只有这块能改**。
 *
 * 画的是**当前选中模块的实现**：一个模块 = 一个能力，实现是一棵**语句树**——
 * 赋值块、C 形条件块，条件里嵌着比较块、比较两侧再嵌引用块与数字块。
 * 改字段 → 编译回同一份 workflow 声明（只改这个节点的 parameters）→ `store.applyDeclaration`；
 * 校验不过就只留诊断。接线全在 `useBlocklyCanvas()` 里，这里只摆放 DOM 与显示状态。
 */
import { computed } from 'vue';
import { useStudioDocument } from '../../state/document';
import { useBlocklyCanvas } from './blockly-canvas';
import DiagnosticsPanel from './DiagnosticsPanel.vue';

const store = useStudioDocument();
const {
	hostRef,
	diagnostics,
	status,
	statusText,
	failure,
	writeSuspended,
	selectedBlockId,
	moduleTitle,
	planView,
	activeStepIndex,
} = useBlocklyCanvas();

const taskName = computed(() => store.declaration.value?.name ?? '');
</script>

<template>
	<section class="blockly-view" data-testid="view-blockly">
		<header class="view-header">
			<span class="view-title">积木画布</span>
		</header>

		<p class="view-module" data-testid="blockly-module-title">{{ moduleTitle }}</p>

		<p v-if="taskName !== ''" class="view-task" data-testid="blockly-task">{{ taskName }}</p>

		<div class="canvas" data-testid="blockly-canvas-frame">
			<div ref="hostRef" class="canvas-host" data-testid="blockly-canvas" />
			<p v-if="failure !== null" class="canvas-failure" data-testid="blockly-failure">{{ failure }}</p>
		</div>

		<footer class="view-footer">
			<span class="write-state" :class="status" data-testid="blockly-write-state">{{ statusText }}</span>
			<span
				v-if="activeStepIndex !== null"
				class="footer-hint footer-step"
				data-testid="blockly-selected-step"
				:data-plan="planView ? 'true' : 'false'"
				:title="
					planView
						? '计划里的第几步（声明里的顺序）；点积木或点代码行都会改这一个数'
						: '实现里的第几步（顶层语句）；点积木或点代码行都会改这一个数'
				"
			>
				选中{{ planView ? '计划' : '' }}第 {{ activeStepIndex + 1 }} 步
			</span>
			<span v-if="writeSuspended" class="footer-hint">画布不完整，写回已暂停</span>
			<span v-else-if="selectedBlockId !== null" class="footer-hint" data-testid="blockly-selected">
				{{ selectedBlockId }}
			</span>
		</footer>

		<DiagnosticsPanel :rows="diagnostics" />
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
	margin: 0;
	font-family: var(--cc-font-mono);
	font-size: var(--cc-fs-sm);
	color: var(--cc-text-dim);
}

/*
 * 模块标题：「<能力的 label> · 实现」。它是这一栏唯一的「我在看什么」的说明——
 * 积木画布现在只显示一个模块的内部，标题不写清楚，用户就不知道这堆积木属于谁。
 */
.view-module {
	margin: 0;
	font-size: var(--cc-fs-md);
	font-weight: 600;
	color: var(--cc-text);
}

/*
 * Blockly 自己往这个容器里塞 SVG 与工具箱，所以容器必须是个有尺寸的定位盒子。
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
 * 单位标签：`@codecanvas/blockly-toolkit` 的 BLOCK_UNIT_CLASS 挂在块内那个只读小标签上。
 * Blockly 块内文字共用一个字号，这里按 class 单独压到 --cc-fs-xs——
 * 单位因此不占主行宽度，`angular (rad/s)` 那种截断不会再发生（单位也留在 tooltip 里）。
 */
.canvas-host :deep(.cc-block-unit) {
	font-family: var(--cc-font-mono);
	font-size: var(--cc-fs-xs);
	fill: var(--cc-text);
	opacity: 0.85;
}

/*
 * 序号徽标：它是画在积木 `<g>` 里的 SVG（见 `sequence-badge.ts`），所以色值走属性、
 * 交互走 pointer-events——这里只钉一件事：徽标不参与命中，点它等于点积木。
 * 现在它只挂在**顶层语句**上，数的是「实现里的第几步」（这个模块内部 1、2、3）；
 * 嵌在条件里、比较里的块不是「步」，不挂徽标。它与流程卡片上「任务里的第几步」
 * 不是同一个数——后者属于整条链，前者属于这个模块的内部。
 */
.canvas-host :deep(.cc-seq-badge) {
	pointer-events: none;
}

/* 选中：与另外两栏同一套——徽标反白压实心强调色、描边加粗一档（形状见 updateBadge）。 */
.canvas-host :deep(.cc-seq-badge-active) {
	filter: drop-shadow(0 0 4px var(--cc-accent-glow));
}

/*
 * 「设备正在跑这一步」（M4 的动线在积木这一侧的落点）。
 *
 * 与上面那条**选中**是两种观感，缺一种就分不清「机器在这儿」与「我在看那儿」
 * （跟随开着时两者落在同一块上，那时要能同时看出来）：
 *   选中 → 徽标反白 + Blockly 自己那圈高亮描边
 *   在跑 → 这一块整体亮一下：`filter` 的辉光从强到弱，停在很淡的一圈上
 *
 * 用 `filter` 而不是改几何：它不触发布局（积木的形状、位置、命中区一个像素没动），
 * 而且画布上本来就用 `filter` 画徽标那圈光（上面那条），同一套手段。
 * 动效关掉时只剩一个静态的淡辉光——「这一块在跑」照样看得出来。
 */
/*
 * 换模块时的入场：整层积木淡入一下（类由 `blockly-canvas.ts` 的 `playBlockEntrance` 挂/摘）。
 *
 * 只管 `opacity`：块层上做 `transform` 或 `scale` 会挪动 `blocklyBlockCanvas` 的坐标系，
 * 而 Blockly 按内部坐标算命中区与连线——那两百毫秒里点下去会落空。
 * 动效偏好关掉时这条整条不生效，画面直接换。
 */
.canvas-host :deep(.blocklyBlockCanvas.cc-blocks-enter) {
	animation: cc-blocks-in 220ms ease-out 1 both;
}

@keyframes cc-blocks-in {
	from {
		opacity: 0;
	}

	to {
		opacity: 1;
	}
}

.canvas-host :deep([data-cc-step-running='true']) {
	animation: cc-block-lit var(--cc-lit-flash-ms) ease-out 1 forwards;
}

@keyframes cc-block-lit {
	0% {
		filter: drop-shadow(0 0 3px var(--cc-accent-strong)) drop-shadow(0 0 12px var(--cc-lit-flash-glow));
	}

	100% {
		filter: drop-shadow(0 0 2px var(--cc-flow-settled));
	}
}

@media (prefers-reduced-motion: reduce) {
	.canvas-host :deep([data-cc-step-running='true']) {
		animation: none;
		filter: drop-shadow(0 0 2px var(--cc-flow-settled));
	}

	.canvas-host :deep(.blocklyBlockCanvas.cc-blocks-enter) {
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

.write-state {
	color: var(--cc-text-dim);
}

.write-state.written {
	color: var(--cc-accent);
}

/* 计划视图：只读，与「已写回」区分开（那两件事不一样）。 */
.write-state.plan {
	color: var(--cc-accent-strong);
}

.write-state.rejected,
.write-state.broken,
.write-state.failed {
	color: var(--cc-danger-strong);
}

/* 选中步：与另外两栏同一根线（`--cc-highlight`），只是这里是一句话。 */
.footer-step {
	color: var(--cc-highlight);
}

.footer-hint {
	font-family: var(--cc-font-mono);
	font-size: var(--cc-fs-xs);
	color: var(--cc-text-faint);
	overflow-wrap: anywhere;
}
</style>
