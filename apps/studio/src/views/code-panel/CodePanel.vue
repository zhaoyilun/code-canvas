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
 * 与声明的关系：没有。这栏一个字都不写回 `state/document.ts`，也不做「这一行对应哪一步」
 * 那种对应关系——那需要一份模型没有给、我们也不该编的映射。
 */
import { computed } from 'vue';
import { codeLinesOf, useTeaching } from '../../state/teaching';

const teaching = useTeaching();

const spec = teaching.spec;
const revealed = teaching.revealedCodeLines;
const totalLines = computed(() => (spec.value === null ? 0 : codeLinesOf(spec.value.code).length));
</script>

<template>
	<section class="code-panel" data-testid="code-panel">
		<header class="cp-header">
			<span class="cp-title">教学代码</span>
			<span v-if="spec !== null" class="cp-name" data-testid="code-panel-title">{{ spec.title }}</span>
		</header>

		<ol v-if="revealed.length > 0" class="cp-lines" data-testid="code-panel-lines">
			<li
				v-for="(line, index) in revealed"
				:key="`${String(index)}:${line}`"
				class="cp-line"
				data-testid="code-line"
			>
				<span class="cp-no">{{ index + 1 }}</span>
				<span class="cp-text">{{ line === '' ? ' ' : line }}</span>
			</li>
		</ol>

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
		<p v-else class="cp-state" data-testid="code-panel-empty">
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
