<script setup lang="ts">
/**
 * 右栏代码面板（spec §4.1）：**模型写的教学代码全文**，只读。
 *
 * 从前这一栏显示的是「从目录推出来的实现」——`capability.implementation` 那棵语句树
 * 经 `@codecanvas/code-render` 渲染成的代码。现在不是了：那套只能推出目录里有的东西
 * （`inspect_scene` 就一行 `move_to_named_pose(pose_name="observe_table")`），
 * 讲不出「为什么这么做、失败了怎么办、执行侧内部那条管线长什么样」——
 * 而那正是「教学」两个字的意思。所以这一栏的字**全部来自模型**（`spec.code`），
 * 一个字都不在这里拼：面板只负责按节拍一行行铺开。
 *
 * 节拍与另外两栏同一个来源（`state/teaching.ts` 的播放队列）：积木铺到第 4 块、
 * 代码铺到第 4 行，说的是同一件事。行号是**这一份代码自己的行号**（只影响显示），
 * 不参与任何判据。
 *
 * 这一版多接了一条线：**设备执行到哪一步 → 切到那几行**。判据是每一段代码的归属
 * （`codeSegments[].planPath`，指向流程节点）与当前步在流程图上对应的那个框是否同一个 id；
 * 行范围是**推出来的**（`segmentLineRanges`），模型只写「这一段属于哪一步」。
 * 归属指不到图上任何一个框时这一段永远不亮——**不猜一个顶上**。
 *
 * 与声明的关系：没有。这栏一个字都不写回 `state/document.ts`。
 */
import { computed, nextTick, ref, watch } from 'vue';
import { codeLinesOf, useTeaching, useTeachingLinkage } from '../../state/teaching';

const teaching = useTeaching();
const linkage = useTeachingLinkage();

const spec = teaching.spec;
const revealed = teaching.revealedCodeLines;
const totalLines = computed(() => (spec.value === null ? 0 : codeLinesOf(spec.value.code).length));

/** 每一段的行范围（推出来的）；规格没到就是空表。 */
const ranges = computed(() => linkage.codeRangesOf.value);

/**
 * 当前步落在哪几行上（0 基，闭区间）。空表 = 没有当前步，或者这一步在这段代码里没有段。
 *
 * 判据与另外两栏同一条：段上那个流程节点 id，等于当前步在流程图上对应的那个框。
 */
const activeRange = computed<{ readonly from: number; readonly to: number } | null>(() => {
	const node = linkage.currentNodeId.value;
	if (node === null) return null;
	const hit = ranges.value.find((range) => range.planPath === node);
	return hit === undefined ? null : { from: hit.from, to: hit.to };
});

const isActive = (index: number): boolean => {
	const range = activeRange.value;
	return range !== null && index >= range.from && index <= range.to;
};

/** 每行所属的那一段（`undefined` = 那一段的归属指不到图上任何一个框）。 */
const anchorOfLine = (index: number): string | undefined =>
	ranges.value.find((range) => index >= range.from && index <= range.to)?.planPath;

/**
 * 切过去之后**滚到那几行**。
 *
 * 为什么用 `scrollIntoView` 而不是自己算偏移：行高由 CSS（`line-height` + 换行）定，
 * 自己算就是把一份排版参数抄进脚本里，改一次样式就错一次。`block: 'nearest'` 是刻意的
 * ——已经看得见的那几行不动（铺开过程中每来一格都滚一次会把画面抖散）。
 */
const linesRef = ref<HTMLElement | null>(null);
watch(activeRange, async (range) => {
	if (range === null) return;
	await nextTick();
	const first = linesRef.value?.querySelector(`[data-cc-line="${String(range.from)}"]`);
	if (first instanceof Element) first.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
});

/** 有没有一行话要说（联动那条不生效时照实说，与另外两栏同一句）。 */
const linkNote = computed(() => linkage.note.value);
</script>

<template>
	<section class="code-panel" data-testid="code-panel">
		<header class="cp-header">
			<span class="cp-title">教学代码</span>
			<span v-if="spec !== null" class="cp-name" data-testid="code-panel-title">{{ spec.title }}</span>
		</header>

		<ol v-if="revealed.length > 0" ref="linesRef" class="cp-lines" data-testid="code-panel-lines">
			<li
				v-for="(line, index) in revealed"
				:key="`${String(index)}:${line}`"
				class="cp-line"
				:class="{ 'cp-line-current': isActive(index) }"
				data-testid="code-line"
				:data-cc-line="index"
				:data-cc-plan-node="anchorOfLine(index)"
				:data-cc-current-line="isActive(index) ? index : undefined"
			>
				<span class="cp-no">{{ index + 1 }}</span>
				<span class="cp-text">{{ line === '' ? ' ' : line }}</span>
			</li>
		</ol>

		<!-- 联动那条不生效时照实说（与另外两栏同一句，`state/teaching.ts` 给的）。 -->
		<p v-if="revealed.length > 0 && linkNote !== ''" class="cp-state cp-link-note" data-testid="code-panel-linkage-note">
			{{ linkNote }}
		</p>

		<p
			v-else-if="teaching.status.value === 'failed' && teaching.failure.value !== null"
			class="cp-state cp-failed"
			data-testid="code-panel-failed"
		>
			模型没写出来：{{ teaching.failure.value.message }}
		</p>
		<p v-else-if="teaching.status.value === 'drawing'" class="cp-state" data-testid="code-panel-drawing">
			正在写…（已经收到 {{ teaching.streamedChars.value }} 字）
		</p>
		<!--
			空态只在**一行都还没有**时说话：链尾的 `v-else` 会把「有行、只是没别的话要说」
			也接住，于是四十二行代码底下挂着一句「还没有代码」（录屏里就是这么露的）。
		-->
		<p v-else-if="revealed.length === 0" class="cp-state" data-testid="code-panel-empty">
			还没有代码。这一栏显示的是「这件事怎么做」的一整段教学代码，由任务 JSON 与这台设备的目录讲出来。
		</p>

		<footer v-if="revealed.length > 0" class="cp-footer">
			<span class="cp-progress" data-testid="code-panel-progress">
				{{ revealed.length }} / {{ totalLines }} 行
			</span>
		</footer>
	</section>
</template>

<style scoped>
.code-panel {
	display: flex;
	flex-direction: column;
	gap: var(--cc-space-2);
	min-height: 0;
	height: 100%;
	overflow: hidden;
}

.cp-header {
	display: flex;
	align-items: baseline;
	gap: var(--cc-space-2);
	padding-bottom: var(--cc-space-2);
	border-bottom: 1px solid var(--cc-line);
}

.cp-title {
	font-size: var(--cc-fs-md);
	font-weight: 600;
	color: var(--cc-text);
}

.cp-name {
	margin-left: auto;
	font-family: var(--cc-font-mono);
	font-size: var(--cc-fs-xs);
	color: var(--cc-text-dim);
}

.cp-lines {
	flex: 1 1 auto;
	min-height: 0;
	margin: 0;
	padding: var(--cc-space-2) 0;
	overflow: auto;
	list-style: none;
	font-family: var(--cc-font-mono);
	font-size: var(--cc-fs-sm);
	line-height: 1.55;
	background: var(--cc-surface-sunken);
	border: 1px solid var(--cc-line);
	border-radius: var(--cc-radius);
}

/* 一行出场：只动 opacity（不动任何会触发布局的东西——后面还要接着往下排）。 */
.cp-line {
	display: flex;
	gap: var(--cc-space-2);
	padding: 0 var(--cc-space-2);
	animation: cc-line-in 220ms ease-out 1 both;
}

@keyframes cc-line-in {
	from {
		opacity: 0;
	}

	to {
		opacity: 1;
	}
}

/*
 * 设备跑到的那一步那几行：**与另外两栏同一条强调色**（`--cc-highlight` = `--cc-accent`）。
 * 左侧那条竖线与「选中」用的是同一个色，所以同一行上不会出现两种强调色打架。
 */
.cp-line-current {
	background: var(--cc-accent-glow);
	box-shadow: inset var(--cc-highlight-border-width) 0 0 var(--cc-highlight);
}

.cp-line-current .cp-no {
	color: var(--cc-highlight);
}

.cp-link-note {
	margin: 0;
	font-size: var(--cc-fs-xs);
	color: var(--cc-text-dim);
}

.cp-no {
	flex: 0 0 2.5em;
	color: var(--cc-text-faint);
	text-align: right;
	user-select: none;
}

.cp-text {
	flex: 1 1 auto;
	color: var(--cc-text);
	white-space: pre-wrap;
	overflow-wrap: anywhere;
}

.cp-state {
	margin: 0;
	padding: var(--cc-space-3);
	color: var(--cc-text-dim);
	line-height: 1.7;
	background: var(--cc-surface-sunken);
	border: 1px dashed var(--cc-line-strong);
	border-radius: var(--cc-radius);
}

.cp-failed {
	color: var(--cc-text);
	background: var(--cc-danger-veil);
	border-style: solid;
	border-color: var(--cc-danger);
}

.cp-footer {
	display: flex;
	align-items: baseline;
	gap: var(--cc-space-2);
	font-size: var(--cc-fs-sm);
}

.cp-progress {
	font-family: var(--cc-font-mono);
	font-size: var(--cc-fs-xs);
	color: var(--cc-text-faint);
}

@media (prefers-reduced-motion: reduce) {
	.cp-line {
		animation: none;
	}
}
</style>
