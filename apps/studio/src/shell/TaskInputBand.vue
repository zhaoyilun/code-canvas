<script setup lang="ts">
/**
 * 上层输入带：品牌条与三栏之间那一条。
 *
 * 左半是本阶段**唯一的真实输入口**——任务 JSON。粘贴或拖入都走同一条路：
 * `useStudioDocument().loadTaskJson(text)`。成功才换真相（三个视图跟着刷新），
 * 失败只把诊断摆在输入区下方，不弹窗、不 alert、不动已有的声明。
 *
 * 右半是一条静态转译链：上游生成任务 JSON，这一层把它转成积木 / 流程 / 代码三种表达。
 * 「自然语言 → 任务 JSON」不归这个界面管（spec §0），位置留在这里，不做。
 */
import { computed, ref } from 'vue';
import type { Diagnostic } from '@codecanvas/contracts';
import { useStudioDocument } from '../state/document';
import { SAMPLE_TASK_JSON } from '../state/sample-task';

const doc = useStudioDocument();

/** 预填示例任务：输入带一上来就是可转换的，改一个数字就能试。 */
const text = ref(SAMPLE_TASK_JSON);
const status = ref<'idle' | 'ok' | 'failed'>('idle');
const dragging = ref(false);
const sourceName = ref('');

const diagnostics = computed<readonly Diagnostic[]>(() => doc.diagnostics.value);
const nodeCount = computed(() => doc.nodes.value.length);

/** 唯一入口。store 保证「失败时真相不动」，这里只负责把结果说出来。 */
function convert(): void {
	status.value = doc.loadTaskJson(text.value) ? 'ok' : 'failed';
}

function clear(): void {
	text.value = '';
	sourceName.value = '';
	status.value = 'idle';
}

// `.prevent` 是必须的：不拦 dragover 浏览器就把文件当导航打开了。
function onDragOver(): void {
	dragging.value = true;
}

function onDragLeave(): void {
	dragging.value = false;
}

async function onDrop(event: DragEvent): Promise<void> {
	dragging.value = false;
	const file = event.dataTransfer?.files?.[0];
	if (file === undefined) return;
	// 读进来先落到输入框，再走和「转换」按钮同一个函数——拖入只是另一种粘贴。
	text.value = await file.text();
	sourceName.value = file.name;
	convert();
}

const location = (diagnostic: Diagnostic): string => {
	const path = diagnostic.path ?? '';
	const ref = diagnostic.ref ?? '';
	if (path !== '' && ref !== '') return `${path} · ${ref}`;
	return path !== '' ? path : ref;
};
</script>

<template>
	<section
		class="input-band"
		:class="{ 'is-dragging': dragging }"
		data-testid="task-input-band"
		@dragover.prevent="onDragOver"
		@dragleave="onDragLeave"
		@drop.prevent="onDrop"
	>
		<div class="band-row">
			<div class="intake">
				<header class="intake-head">
					<span class="intake-title">任务 JSON</span>
					<span class="intake-hint">粘贴文本，或把 .json 拖进来</span>
					<span class="intake-meta">
						<!-- 顺利时不占第二行：带子就守在 88px，失败或带诊断才往下长 -->
						<span
							v-if="status === 'ok' && diagnostics.length === 0"
							class="feedback-state ok"
							data-testid="task-input-status"
						>
							已转换 · {{ nodeCount }} 个节点
						</span>
						<span v-if="sourceName !== ''" class="intake-file" data-testid="task-input-file">
							{{ sourceName }}
						</span>
					</span>
				</header>
				<div class="intake-row">
					<textarea
						v-model="text"
						class="intake-text"
						data-testid="task-json-input"
						aria-label="任务 JSON"
						spellcheck="false"
						placeholder='{ "schema_version": "1.0", "task_id": "task-1", "steps": [ ... ] }'
					></textarea>
					<div class="intake-actions">
						<button
							type="button"
							class="btn btn-convert"
							data-testid="task-convert"
							:disabled="text.trim() === ''"
							@click="convert"
						>
							转换
						</button>
						<button type="button" class="btn btn-clear" data-testid="task-clear" @click="clear">
							清空
						</button>
					</div>
				</div>
			</div>

			<div class="chain" data-testid="translation-chain">
				<span class="chain-title">TRANSLATION</span>
				<ol class="chain-list">
					<li class="chain-node chain-source">
						<span class="chain-dot" aria-hidden="true"></span>任务 JSON
					</li>
					<li class="chain-arrow" aria-hidden="true">→</li>
					<li class="chain-node">积木</li>
					<li class="chain-slash" aria-hidden="true">/</li>
					<li class="chain-node">流程</li>
					<li class="chain-slash" aria-hidden="true">/</li>
					<li class="chain-node">代码</li>
				</ol>
				<span class="chain-note">上游生成器负责「自然语言 → 任务 JSON」，不在这个界面里</span>
			</div>
		</div>

		<div
			v-if="status === 'failed' || diagnostics.length > 0"
			class="feedback"
			data-testid="task-input-feedback"
		>
			<div class="feedback-head">
				<span class="feedback-state" :class="status" data-testid="task-input-status">
					{{
						status === 'ok'
							? `已转换 · ${nodeCount} 个节点`
							: '转换失败 · 声明未改动，三个视图保持原样'
					}}
				</span>
				<span v-if="diagnostics.length > 0" class="feedback-count">
					{{ diagnostics.length }} 条诊断
				</span>
			</div>
			<ul v-if="diagnostics.length > 0" class="feedback-list" data-testid="task-input-diagnostics">
				<li
					v-for="(diagnostic, index) in diagnostics"
					:key="`${index}-${diagnostic.code}-${diagnostic.path ?? ''}`"
					class="diagnostic"
					:class="diagnostic.severity"
					data-testid="task-input-diagnostic"
				>
					<span class="diagnostic-code">{{ diagnostic.code }}</span>
					<span class="diagnostic-message">{{ diagnostic.message }}</span>
					<span v-if="location(diagnostic) !== ''" class="diagnostic-where">
						{{ location(diagnostic) }}
					</span>
				</li>
			</ul>
		</div>
	</section>
</template>

<style scoped>
.input-band {
	display: flex;
	flex-direction: column;
	gap: var(--cc-space-2);
	flex: 0 0 auto;
	min-height: var(--cc-inputband-h);
	padding: var(--cc-space-2) var(--cc-space-3);
	background: var(--cc-surface);
	border-bottom: 1px solid var(--cc-line);
}

.band-row {
	display: grid;
	grid-template-columns: minmax(0, 1fr) auto;
	gap: var(--cc-space-4);
	align-items: stretch;
	/*
	 * 行高由变量钉死（减掉带子自己的内边距与下边框），带子总高才正好是 --cc-inputband-h。
	 * 不钉的话高度会被内容撑开：转译链是三层，输入区跟着长，一条「输入带」就厚成一块面板。
	 * 诊断出现时带子靠 min-height 自然长高，行高不受影响。
	 */
	height: calc(var(--cc-inputband-h) - var(--cc-space-2) * 2 - 1px);
	/* 轨道钉成 1fr：不然行高会跟着子项的 min-content 长（输入区那 60px 的文本框说了算），
	   行比带子还高，内容就压到下面的画布上去了。 */
	grid-template-rows: minmax(0, 1fr);
	min-height: 0;
}

/* 输入区：虚线框，明示「这里可以拖东西进来」 */
.intake {
	display: flex;
	flex-direction: column;
	gap: var(--cc-space-1);
	min-width: 0;
	padding: var(--cc-space-2);
	min-height: 0;
	overflow: hidden;
	background: var(--cc-surface-sunken);
	border: 1px dashed var(--cc-line-strong);
	border-radius: var(--cc-radius);
	transition:
		border-color 0.15s ease,
		background 0.15s ease;
}

.input-band.is-dragging .intake {
	border-color: var(--cc-accent);
	background: var(--cc-accent-veil);
}

.intake-head {
	display: flex;
	align-items: baseline;
	gap: var(--cc-space-2);
	min-width: 0;
}

.intake-title {
	font-size: var(--cc-fs-sm);
	font-weight: 600;
	color: var(--cc-text);
}

.intake-hint {
	min-width: 0;
	overflow: hidden;
	font-size: var(--cc-fs-xs);
	color: var(--cc-text-faint);
	text-overflow: ellipsis;
	white-space: nowrap;
}

.intake-meta {
	display: flex;
	align-items: baseline;
	gap: var(--cc-space-2);
	margin-left: auto;
	flex: 0 0 auto;
}

.intake-file {
	font-family: var(--cc-font-mono);
	font-size: var(--cc-fs-xs);
	color: var(--cc-accent);
	max-width: 220px;
	overflow: hidden;
	text-overflow: ellipsis;
	white-space: nowrap;
}

.intake-row {
	display: grid;
	grid-template-columns: minmax(0, 1fr) auto;
	grid-template-rows: minmax(0, 1fr);
	gap: var(--cc-space-2);
	flex: 1 1 auto;
	min-height: 0;
}

.intake-text {
	width: 100%;
	height: 100%;
	min-height: 0;
	padding: var(--cc-space-1) var(--cc-space-2);
	font-family: var(--cc-font-mono);
	font-size: var(--cc-fs-sm);
	line-height: 1.5;
	color: var(--cc-text);
	background: var(--cc-bg);
	border: 1px solid var(--cc-line);
	border-radius: var(--cc-radius-sm);
	resize: none;
}

.intake-text::placeholder {
	color: var(--cc-text-faint);
}

.intake-text:focus {
	outline: none;
	border-color: var(--cc-accent-dim);
	box-shadow: 0 0 0 1px var(--cc-accent-glow) inset;
}

.intake-actions {
	display: flex;
	align-items: center;
	gap: var(--cc-space-1);
}

.btn {
	padding: 5px var(--cc-space-2);
	font-size: var(--cc-fs-sm);
	font-weight: 650;
	letter-spacing: 0.04em;
	border: 1px solid transparent;
	border-radius: var(--cc-radius-sm);
	cursor: pointer;
	transition:
		filter 0.15s ease,
		color 0.15s ease,
		background 0.15s ease;
}

.btn-convert {
	min-width: 58px;
	color: var(--cc-surface-sunken);
	background: var(--cc-accent);
	border-color: var(--cc-accent-strong);
	box-shadow: 0 0 12px var(--cc-accent-glow);
}

.btn-convert:hover:not(:disabled) {
	filter: brightness(1.1);
}

.btn-convert:disabled {
	color: var(--cc-disabled-text);
	background: var(--cc-disabled-surface);
	border-color: var(--cc-line);
	box-shadow: none;
	cursor: not-allowed;
}

.btn-clear {
	color: var(--cc-text-dim);
	background: transparent;
	border-color: var(--cc-line-strong);
}

.btn-clear:hover {
	color: var(--cc-text);
	background: var(--cc-surface-raised);
}

/* 转译链：与底部 PIPELINE 同一套观感（胶囊 + 箭头 + 淡色标题） */
.chain {
	display: flex;
	flex-direction: column;
	justify-content: center;
	gap: var(--cc-space-1);
	flex: 0 0 auto;
	min-height: 0;
	overflow: hidden;
	padding: 0 var(--cc-space-1) 0 var(--cc-space-2);
}

.chain-title {
	font-size: var(--cc-fs-xs);
	letter-spacing: 0.18em;
	color: var(--cc-text-faint);
}

.chain-list {
	display: flex;
	align-items: center;
	gap: var(--cc-space-1);
	margin: 0;
	padding: 0;
	list-style: none;
}

.chain-node {
	display: flex;
	align-items: center;
	gap: var(--cc-space-2);
	padding: 3px var(--cc-space-2);
	font-size: var(--cc-fs-sm);
	color: var(--cc-text-dim);
	border: 1px solid var(--cc-line-strong);
	border-radius: 999px;
	white-space: nowrap;
}

.chain-source {
	color: var(--cc-accent);
	background: var(--cc-accent-veil);
	border-color: var(--cc-accent-dim);
}

.chain-dot {
	width: 6px;
	height: 6px;
	border-radius: 50%;
	background: currentColor;
	opacity: 0.55;
}

.chain-arrow,
.chain-slash {
	font-size: var(--cc-fs-sm);
	color: var(--cc-line-strong);
}

.chain-note {
	font-size: var(--cc-fs-xs);
	color: var(--cc-text-faint);
}

/* 诊断：跟积木侧那份同一形状（左侧色条区分严重度），摆在输入区下方 */
.feedback {
	display: flex;
	flex-direction: column;
	gap: var(--cc-space-1);
	flex: 0 0 auto;
	min-width: 0;
}

.feedback-head {
	display: flex;
	align-items: baseline;
	gap: var(--cc-space-2);
}

.feedback-state {
	font-size: var(--cc-fs-sm);
	font-weight: 600;
}

.feedback-state.ok {
	color: var(--cc-accent);
}

.feedback-state.failed {
	color: var(--cc-danger-strong);
}

.feedback-count {
	font-family: var(--cc-font-mono);
	font-size: var(--cc-fs-xs);
	color: var(--cc-text-faint);
}

.feedback-list {
	display: flex;
	flex-direction: column;
	gap: var(--cc-space-1);
	max-height: 72px;
	margin: 0;
	padding: 0;
	overflow-y: auto;
	list-style: none;
}

.diagnostic {
	display: flex;
	align-items: baseline;
	gap: var(--cc-space-2);
	padding: var(--cc-space-1) var(--cc-space-2);
	background: var(--cc-surface-sunken);
	border: 1px solid var(--cc-line);
	border-left-width: 3px;
	border-radius: var(--cc-radius-sm);
}

.diagnostic.error {
	border-left-color: var(--cc-danger);
}

.diagnostic.warning {
	border-left-color: var(--cc-accent-dim);
}

.diagnostic.info {
	border-left-color: var(--cc-line-strong);
}

.diagnostic-code {
	flex: 0 0 auto;
	font-family: var(--cc-font-mono);
	font-size: var(--cc-fs-xs);
	color: var(--cc-text-dim);
}

.diagnostic.error .diagnostic-code {
	color: var(--cc-danger-strong);
}

.diagnostic-message {
	font-size: var(--cc-fs-sm);
	line-height: 1.5;
	color: var(--cc-text);
	overflow-wrap: anywhere;
}

.diagnostic-where {
	flex: 0 0 auto;
	margin-left: auto;
	font-family: var(--cc-font-mono);
	font-size: var(--cc-fs-xs);
	color: var(--cc-text-faint);
	overflow-wrap: anywhere;
}

/* 窄窗：先舍注释，再舍整条链——输入口永远留着，它才是这一带的功能 */
@media (max-width: 1180px) {
	.chain-note {
		display: none;
	}
}

@media (max-width: 900px) {
	.chain {
		display: none;
	}
}
</style>
