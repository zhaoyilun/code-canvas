<script setup lang="ts">
/**
 * 右栏的「任务 JSON」视图：**当前声明还原出来的那份任务**，格式化、带行号、等宽、只读。
 *
 * 它存在的意义是**指向**：点 JSON 里的某一段，对应的流程卡片、积木、代码行一起跳出来
 * （复用 `store.select(nodeId)` 与 `store.selectStep(index)`，与既有三向联动同一套状态、
 * 同一条 `--cc-highlight`）；反过来，在流程画布或积木里选中某个模块，JSON 里那一段也带标记。
 *
 * 三种点击粒度，都是**推出来的**、不是猜的：
 * - 点结构行（`{`、`"steps"`、`}`）→ 只选中那个模块（卡片 + 积木 + 代码面板跟着换）；
 * - 点 `"action"`/`"id"` 行 → 同上，不带「第几步」；
 * - 点**参数行**（`"linear": 0.2`）→ 除选中模块外，还点亮实现里用到这个参数的那条顶层语句
 *   （下标从目录的实现树扫出来，见 `task-json.ts` 的 `referencedStepIndex`）。
 *
 * 只读：这里没有一条写回路径。要改参数去积木画布（spec §4.1）。
 */
import { computed, nextTick, ref, watch } from 'vue';
import IconBase from '../../../shell/IconBase.vue';
import { findCatalogWithCapability, useStudioDevices } from '../../../shell/devices';
import { useStudioDocument } from '../../../state/document';
import { renderTaskJson, type TaskJsonLine } from './task-json';

const doc = useStudioDocument();
const devices = useStudioDevices();

/**
 * 参数 → 实现里第几步，靠的是**给出实现的目录**：先看当前选中的设备目录，
 * 再按登记顺序找（生成之后换了设备时，声明还是上一台产出的，这时不该硬套新目录）。
 */
const view = computed(() => {
	const declaration = doc.declaration.value;
	if (declaration === null) return null;
	return renderTaskJson(declaration, (capabilityRef) =>
		findCatalogWithCapability(capabilityRef, devices.selectedCatalog.value),
	);
});

const lines = computed<readonly TaskJsonLine[]>(() => view.value?.lines ?? []);
const stepCount = computed(() => view.value?.stepCount ?? 0);
const taskId = computed(() => {
	const meta = doc.declaration.value?.meta;
	const value = meta === undefined ? undefined : meta['task_id'];
	return typeof value === 'string' ? value : '';
});
/** 映射用的目录名：面板上的联动就是从它的实现树推出来的，写出来免得读者以为在猜。 */
const mappedCatalog = computed(() => devices.selectedCatalog.value?.displayName ?? '');

const selectedNodeId = computed(() => doc.selectedNodeId.value);
const selectedStepIndex = computed(() => doc.selectedStepIndex.value);

const isSelectedNode = (line: TaskJsonLine): boolean =>
	line.nodeId !== null && line.nodeId === selectedNodeId.value;

/** 这一行的参数正好落在当前选中的那一步实现上：比「模块选中」再亮一档。 */
const isSelectedStep = (line: TaskJsonLine): boolean =>
	isSelectedNode(line) && line.implStepIndex !== null && line.implStepIndex === selectedStepIndex.value;

const isClickable = (line: TaskJsonLine): boolean => line.nodeId !== null;

/**
 * 点一行 = 选中它指向的那一步。
 *
 * 参数行再点一次收回「第几步」的选中（不然就没法取消），收回只动 `selectedStepIndex`，
 * 不动节点选中——与代码面板的规矩一致。
 */
const pick = (line: TaskJsonLine): void => {
	const nodeId = line.nodeId;
	if (nodeId === null) return;
	const sameNode = selectedNodeId.value === nodeId;
	const index = line.implStepIndex;
	doc.select(nodeId);
	if (index === null || (sameNode && selectedStepIndex.value === index)) {
		doc.selectStep(null);
		return;
	}
	doc.selectStep(index);
};

const pickByKey = (event: KeyboardEvent, line: TaskJsonLine): void => {
	if (event.key !== 'Enter' && event.key !== ' ') return;
	event.preventDefault();
	pick(line);
};

/** 读屏用的一行说明：这一步是第几个、参数叫什么、会不会点亮实现里的某一步。 */
const describe = (line: TaskJsonLine): string => {
	const owner = line.stepOrdinal === null ? '任务级' : `第 ${line.stepOrdinal} 步`;
	if (line.parameter === null) return `${owner} · ${line.text.trim()}`;
	const mapped = line.implStepIndex === null ? '' : `，实现第 ${line.implStepIndex + 1} 步`;
	return `${owner} · 参数 ${line.parameter}${mapped}`;
};

const scroller = ref<HTMLElement | null>(null);

/** 别处选中模块（点卡片、点积木、点代码）时，把 JSON 里那一段滚进视野。 */
watch(selectedNodeId, async (nodeId) => {
	if (nodeId === null) return;
	await nextTick();
	const target = scroller.value?.querySelector(`[data-tj-node="${nodeId}"]`);
	if (target !== null && target !== undefined && typeof target.scrollIntoView === 'function') {
		target.scrollIntoView({ block: 'nearest' });
	}
});
</script>

<template>
	<section class="task-json-panel" data-testid="task-json-panel">
		<header class="tj-header">
			<div class="tj-head-row">
				<IconBase name="json" :size="16" />
				<span class="tj-title">任务 JSON</span>
				<span class="tj-tag">声明还原</span>
				<span class="tj-tag tj-tag-readonly">只读</span>
				<span v-if="doc.hasDeclaration.value" class="tj-count" data-testid="task-json-step-count">
					{{ stepCount }} 步
				</span>
			</div>
			<span v-if="taskId !== ''" class="tj-task" data-testid="task-json-task-id">{{ taskId }}</span>
		</header>

		<div v-if="!doc.hasDeclaration.value" class="tj-empty" data-testid="task-json-empty">
			<p>还没有声明——导入一份任务 JSON（或在入口生成一份）后，这里显示它还原出来的任务。</p>
		</div>

		<div v-else ref="scroller" class="tj-code" data-testid="task-json-scroll">
			<ol class="tj-lines">
				<!--
					一行 = JSON 里的一行。`data-tj-node` 只在属于某一步的行上出现：
					有它就代表这一行可以点，点了会选中那一步（参数行还会点亮实现里的那一步）。
				-->
				<li
					v-for="line in lines"
					:key="line.line"
					class="tj-line"
					:class="{
						'is-step': line.section === 'step',
						'is-selected': isSelectedNode(line),
						'is-step-selected': isSelectedStep(line),
						'is-clickable': isClickable(line),
					}"
					:data-line="line.line"
					:data-section="line.section"
					:data-tj-node="line.nodeId ?? undefined"
					:data-tj-step="line.stepOrdinal ?? undefined"
					:data-tj-param="line.parameter ?? undefined"
					:data-tj-impl-step="line.implStepIndex ?? undefined"
					:data-selected="isSelectedNode(line) ? 'true' : 'false'"
					:data-selected-step="isSelectedStep(line) ? 'true' : 'false'"
					:role="isClickable(line) ? 'button' : undefined"
					:tabindex="isClickable(line) ? 0 : undefined"
					:title="isClickable(line) ? `选中${describe(line)}` : undefined"
					@click="pick(line)"
					@keydown="pickByKey($event, line)"
				>
					<span class="tj-ln" aria-hidden="true">{{ line.line }}</span>
					<code class="tj-src">{{ line.text === '' ? ' ' : line.text }}</code>
				</li>
			</ol>
		</div>

		<footer class="tj-footer">
			<span class="tj-footer-hint" data-testid="task-json-hint">
				点一段 → 流程卡片 / 积木 / 代码行一起跳（点参数行还会点亮实现里的那一步）
			</span>
			<span v-if="mappedCatalog !== ''" class="tj-footer-source">
				参数映射来自目录：{{ mappedCatalog }}
			</span>
		</footer>
	</section>
</template>

<style scoped>
.task-json-panel {
	display: flex;
	flex-direction: column;
	height: 100%;
	min-height: 0;
	background: var(--cc-surface);
}

.tj-header {
	display: flex;
	flex-direction: column;
	gap: var(--cc-space-1);
	flex: 0 0 auto;
	padding: var(--cc-space-3) var(--cc-space-4);
	border-bottom: 1px solid var(--cc-line);
}

.tj-head-row {
	display: flex;
	align-items: center;
	gap: var(--cc-space-2);
	flex-wrap: wrap;
	color: var(--cc-text-dim);
}

.tj-title {
	font-size: var(--cc-fs-md);
	font-weight: 600;
	color: var(--cc-text);
}

.tj-tag {
	padding: 2px var(--cc-space-2);
	font-family: var(--cc-font-mono);
	font-size: var(--cc-fs-xs);
	letter-spacing: 0.06em;
	color: var(--cc-accent);
	background: var(--cc-accent-veil);
	border: 1px solid var(--cc-accent-dim);
	border-radius: var(--cc-radius-sm);
}

.tj-tag-readonly {
	color: var(--cc-text-dim);
	background: transparent;
	border-color: var(--cc-line-strong);
}

.tj-count {
	margin-left: auto;
	font-family: var(--cc-font-mono);
	font-size: var(--cc-fs-sm);
	color: var(--cc-text-faint);
}

.tj-task {
	font-family: var(--cc-font-mono);
	font-size: var(--cc-fs-xs);
	color: var(--cc-text-faint);
}

.tj-empty {
	display: flex;
	align-items: center;
	justify-content: center;
	flex: 1 1 auto;
	min-height: 0;
	padding: var(--cc-space-5);
	color: var(--cc-text-dim);
	text-align: center;
}

.tj-empty p {
	max-width: 34ch;
	margin: 0;
	line-height: 1.7;
}

.tj-code {
	flex: 1 1 auto;
	min-height: 0;
	overflow: auto;
	padding: var(--cc-space-3) 0;
	background: var(--cc-surface-sunken);
}

.tj-lines {
	margin: 0;
	padding: 0;
	list-style: none;
	font-family: var(--cc-font-mono);
	font-size: var(--cc-fs-sm);
	line-height: 1.65;
}

/*
 * 一行 = JSON 的一行。缩进写在文本里（`white-space: pre-wrap` 保住行首空格），
 * 这一层只补行号与描边；高亮用的描边常驻（透明），选中时只换颜色——
 * 换粗细会让整块文字左右跳一格。长行折行显示，右栏只有 360px，不横向滚。
 */
.tj-line {
	display: flex;
	align-items: baseline;
	gap: var(--cc-space-2);
	padding: 0 var(--cc-space-2);
	border-left: var(--cc-highlight-border-width) solid transparent;
}

.tj-line.is-clickable {
	cursor: pointer;
}

.tj-line.is-clickable:hover {
	background: var(--cc-surface-raised);
}

.tj-line:focus-visible {
	outline: 1px solid var(--cc-highlight);
	outline-offset: -1px;
}

/* 属于某一步的整段：底色抬一档，让人看得出「这一段是一个 step」。 */
.tj-line.is-step {
	background: var(--cc-surface);
}

/* 模块选中：整段带强调色描边（与流程卡片、代码行同一条 --cc-highlight）。 */
.tj-line.is-selected {
	background: var(--cc-accent-veil);
	border-left-color: var(--cc-highlight);
}

/* 再亮一档：这一行的参数正好落在当前选中的那一步实现上。 */
.tj-line.is-step-selected {
	box-shadow: inset 0 0 0 var(--cc-highlight-border-width) var(--cc-highlight);
}

.tj-ln {
	flex: 0 0 auto;
	min-width: 2ch;
	text-align: right;
	color: var(--cc-text-faint);
	user-select: none;
}

.tj-src {
	flex: 1 1 auto;
	min-width: 0;
	color: var(--cc-text-dim);
	white-space: pre-wrap;
	overflow-wrap: anywhere;
}

/* 选中的那一段文字提亮：高亮是对比出来的，光把边框画亮不够。 */
.tj-line.is-selected .tj-src,
.tj-line.is-step-selected .tj-src {
	color: var(--cc-text);
}

.tj-footer {
	display: flex;
	align-items: baseline;
	flex-wrap: wrap;
	gap: var(--cc-space-1) var(--cc-space-2);
	flex: 0 0 auto;
	padding: var(--cc-space-2) var(--cc-space-4);
	font-family: var(--cc-font-mono);
	font-size: var(--cc-fs-xs);
	color: var(--cc-text-faint);
	border-top: 1px solid var(--cc-line);
}

.tj-footer-hint {
	color: var(--cc-text-dim);
}

.tj-footer-source {
	margin-left: auto;
}
</style>
