<script setup lang="ts">
/**
 * 右栏代码面板（spec §4.1）：**编译产物，只读**。
 *
 * 粒度是「工作流上的一个模块 = 一个函数」：面板显示**当前选中模块的实现**——
 * 那个能力在目录里的 `implementation`（一棵**语句树**），也就是机器为了执行它具体做了什么。
 * 文本一个字都不在这里拼：`renderImplementation()` 从**当前设备目录**的原语定义递归推导，
 * 连缩进、「第几行是哪一步」也是它给的（`lines[].stepPath` / `lines[].stepIndex`），这里只渲染，不重算。
 *
 * - 选中项从 `useStudioDocument()` 读（流程卡片、积木、都一样）；还没选时退到第一个模块，
 *   于是面板一打开就有东西可看——**退档只影响显示，不去改写共享的选中状态**。
 * - **点某一行 → `selectStep(该行的顶层下标)`**；反过来 `selectedStepIndex` 一变，
 *   属于那一步的行全部高亮（一个顶层 `if` 会有好几行）。积木那边接的是同一根线、同一套
 *   `--cc-*` 高亮语言（`--cc-highlight`），所以「点代码 → 积木亮」这条链是同一个状态推出来的。
 * - 行首的序号徽标是这个模块里的**第几条顶层语句**（`SequenceBadge`，与流程卡片、积木同一个组件、
 *   同一组 `--cc-seq-*` 变量）。一个 `if` 的子语句行不再挂徽标（它们和分支头是同一步），
 *   否则同一个数字会在三行上重复，反倒看不出一共几步。
 * - 安全限值常驻底部——它属于**整个任务**（`meta.limits`），不随选中哪个模块变。
 */
import { computed, nextTick, ref, watch } from 'vue';
import { renderImplementation, type RenderedLine } from '@codecanvas/code-render';
import { useStudioDocument } from '../../state/document';
import { stepNumbersOf } from '../shared/sequence-badge';
import SequenceBadge from '../shared/SequenceBadge.vue';

const doc = useStudioDocument();

/** 当前显示的模块：选中的那个；没选中时退到第一个（不改共享状态）。 */
const activeNode = computed(() => doc.selectedNode.value ?? doc.nodes.value[0] ?? null);

/** 退档显示：面板显示的不是「选中的」模块，页脚要如实说出来。 */
const isFallback = computed(() => doc.selectedNodeId.value === null && activeNode.value !== null);

/*
 * 目录从 store 取（`declarationCatalog`），**不在这里写死哪一份**：
 * 面板显示的是「机器为了执行它具体做了什么」，而那句话只有在**给出这份实现的那份目录**里才成立。
 * 写死一份常量，换设备之后就会拿另一份目录去查同一个能力名——查不到时看起来像目录缺了东西，
 * 其实是面板拿错了尺子（真机上「技能计划」四个字也永远显示不出来）。
 * 目录还没定下来（没导入过、也没选中设备）时按「没有模块」渲染，不编一份实现出来。
 */
const program = computed(() =>
	renderImplementation({
		node: activeNode.value,
		catalog: doc.declarationCatalog.value,
		declaration: doc.declaration.value,
	}),
);

/** 这个模块是工作流里的第几步（与流程卡片、积木徽标同一个口径）。 */
const nodeOrdinal = computed(() => {
	const node = activeNode.value;
	if (node === null) return null;
	return stepNumbersOf(doc.nodes.value).get(node.id) ?? null;
});

/** 它属于哪份任务：面板是任务级视图（限值也是任务级的），顶上说清这一点。 */
const taskName = computed(() => doc.declaration.value?.name ?? '');

const limits = computed(() => program.value.limits);
const warnings = computed(() => program.value.diagnostics);

const scroller = ref<HTMLElement | null>(null);

/** 当前选中的是**哪一条顶层语句**（0 基）；null = 没选。 */
const selectedStep = computed(() => doc.selectedStepIndex.value);

/** 这一行属不属于当前选中步：属于就整行高亮（一个 `if` 的每一行都亮）。 */
const isSelectedStep = (line: RenderedLine): boolean =>
	selectedStep.value !== null && line.stepIndex === selectedStep.value;

/**
 * 每一行的**行号 → 顶层语句头行号**。徽标只挂在头上：
 * 同一个数字在三行上重复不等于「这三行是同一步」，而是让人以为有三步。
 * 判据是「上一行的顶层下标与我不同」——`if` 的 then/else 子语句行因此不挂徽标。
 */
const stepHeads = computed(() => {
	const heads = new Set<number>();
	let previousStep: number | null = null;
	for (const line of program.value.lines) {
		if (line.stepIndex !== null && line.stepIndex !== previousStep) heads.add(line.line);
		previousStep = line.stepIndex;
	}
	return heads;
});

const isStepHead = (line: RenderedLine): boolean => stepHeads.value.has(line.line);

/**
 * 点一行 = 选中它所属的那一步。再点同一行收回选中（不然就没法「取消选中」了）——
 * 收回只动 `selectedStepIndex`，不动节点选中。
 */
const pickLine = (line: RenderedLine): void => {
	if (line.stepIndex === null) return;
	doc.selectStep(selectedStep.value === line.stepIndex ? null : line.stepIndex);
};

/** 键盘走同一件事：回车/空格选中那一行所属的步。 */
const pickLineByKey = (event: KeyboardEvent, line: RenderedLine): void => {
	if (event.key !== 'Enter' && event.key !== ' ') return;
	event.preventDefault();
	pickLine(line);
};

/** 读屏用的整行说明：缩进说成「缩进 n 档」，比四个空格好懂。 */
const describeLine = (line: RenderedLine): string =>
	line.indent === 0 ? line.text.trim() : `缩进 ${line.indent} 档：${line.text.trim()}`;

// 换模块时视线回到实现的第一行，并清掉上一步的选中（跨模块谈「第几步」没有意义，
// 这半件事 `state/document.ts` 的 `select()` 已经做了；这里只负责滚动）。
watch(
	() => program.value.nodeId,
	async () => {
		await nextTick();
		const target = scroller.value?.querySelector('[data-line="1"]');
		if (target !== null && target !== undefined && typeof target.scrollIntoView === 'function') {
			target.scrollIntoView({ block: 'nearest' });
		}
	},
);

/** 选中的那一步：把它滚进视野（积木那边点过来时，代码这侧得跟上）。 */
watch(selectedStep, async (index) => {
	if (index === null) return;
	await nextTick();
	const target = scroller.value?.querySelector(`[data-step-head="${index}"]`);
	if (target !== null && target !== undefined && typeof target.scrollIntoView === 'function') {
		target.scrollIntoView({ block: 'nearest' });
	}
});
</script>

<template>
	<section class="code-panel" data-testid="code-panel">
		<header class="cp-header">
			<div class="cp-head-row">
				<SequenceBadge v-if="nodeOrdinal !== null" :index="nodeOrdinal" testid="code-node-index" />
				<span class="cp-title" data-testid="code-title">{{ program.title ?? '代码' }}</span>
				<span class="cp-tag">编译产物</span>
				<span class="cp-tag cp-tag-readonly">只读</span>
				<span v-if="program.nodeId !== null" class="cp-count">{{ program.callCount }} 个原语</span>
			</div>
			<span v-if="taskName !== ''" class="cp-task" data-testid="code-task-name">{{ taskName }}</span>
		</header>

		<div v-if="!doc.hasDeclaration.value" class="cp-empty" data-testid="code-empty-task">
			<p>还没有声明——导入一份任务 JSON 后，这里会显示选中模块的实现。</p>
		</div>

		<template v-else>
			<div v-if="program.lines.length === 0" class="cp-empty" data-testid="code-empty-module">
				<p>还没有选中模块——在流程画布或积木里点一个，这里显示它的实现。</p>
			</div>

			<div v-else ref="scroller" class="cp-code" data-testid="code-scroll">
				<ol class="cp-lines">
					<!--
						一行 = 一条语句（或一句注记）。`if` 展开成多行，子语句那几行的缩进**已经写在文本里**
						（4 个空格一档，见 code-render 的 INDENT_UNIT），所以复制出去的文本与看到的一致。
						`data-step` 是**顶层**语句下标（0 基，界面联动只认它）；
						`data-path` 是精确树路径（`1.then.0`），高亮到具体那一行。
					-->
					<li
						v-for="line in program.lines"
						:key="line.line"
						class="cp-line"
						:class="{
							'is-call': line.kind === 'call',
							'is-set': line.kind === 'set',
							'is-branch': line.kind === 'if' || line.kind === 'else',
							'is-unsupported': line.kind === 'unsupported',
							'is-selected': isSelectedStep(line),
							'is-clickable': line.stepIndex !== null,
						}"
						:data-line="line.line"
						:data-kind="line.kind"
						:data-indent="line.indent"
						:data-step="line.stepIndex ?? undefined"
						:data-path="line.stepPath ?? undefined"
						:data-step-head="isStepHead(line) ? (line.stepIndex ?? undefined) : undefined"
						:data-primitive="line.primitiveRef ?? undefined"
						:data-selected="isSelectedStep(line) ? 'true' : 'false'"
						:data-node-id="activeNode?.id ?? undefined"
						:role="line.stepIndex !== null ? 'button' : undefined"
						:tabindex="line.stepIndex !== null ? 0 : undefined"
						:title="line.stepIndex !== null ? `选中第 ${line.stepIndex + 1} 步（${describeLine(line)}）` : undefined"
						@click="pickLine(line)"
						@keydown="pickLineByKey($event, line)"
					>
						<span class="cp-hit">
							<!--
								徽标只挂在顶层语句的头上：一个 `if` 展开的三行是同一步，
								三行都挂「2」会让人以为有三步。
							-->
							<SequenceBadge
								v-if="line.stepIndex !== null && isStepHead(line)"
								:index="line.stepIndex + 1"
								:active="isSelectedStep(line)"
								testid="code-step-index"
							/>
							<span v-else class="cp-seq-gap" aria-hidden="true" />
							<span class="cp-ln" aria-hidden="true">{{ line.line }}</span>
							<code class="cp-src">{{ line.text === '' ? ' ' : line.text }}</code>
						</span>
					</li>
				</ol>
			</div>

			<ul v-if="warnings.length > 0" class="cp-warnings" data-testid="code-warnings">
				<li v-for="(diagnostic, index) in warnings" :key="`${index}-${diagnostic.code}`">
					<span class="cp-warn-code">{{ diagnostic.code }}</span>
					{{ diagnostic.message }}
				</li>
			</ul>

			<section class="cp-limits" data-testid="code-limits">
				<header class="cp-limits-head">
					<span class="cp-limits-title">安全限值</span>
					<span class="cp-limits-note">整个任务的上限</span>
					<span v-if="!limits.present" class="cp-limits-note">声明里没有，显示协议安全上限</span>
				</header>
				<!--
					限值排成一行可折的芯片，不排成表：它属于整个任务、不随选中模块变，
					但也不能把上面那块实现挤到只剩一行。四条信息一条不漏，只是更紧。
					「已收紧」只在真的比安全上限紧时才占位置——常态下每个都挂着「上限」是噪音。
				-->
				<ul class="cp-limit-list">
					<li
						v-for="limit in limits.numeric"
						:key="limit.name"
						class="cp-limit"
						:title="limit.tightened ? '比协议安全上限更紧' : '协议安全上限'"
					>
						<span class="cp-limit-name">{{ limit.name }}</span>
						<span class="cp-limit-value">{{ limit.text }}</span>
						<span v-if="limit.tightened" class="cp-limit-flag">已收紧</span>
					</li>
					<li class="cp-limit cp-limit-confirm">
						运行前需确认：<strong>{{ limits.requireConfirmation ? '是' : '否' }}</strong>
					</li>
				</ul>
			</section>

			<footer class="cp-footer">
				<span v-if="isFallback" class="cp-footer-hint" data-testid="code-footer-fallback">
					还没选中模块，先显示第 {{ nodeOrdinal }} 个：{{ program.nodeName }}
				</span>
				<span v-else-if="program.nodeId !== null" class="cp-footer-selected" data-testid="code-footer-selected">
					选中 {{ program.nodeName }} · 实现 {{ program.lines.length }} 行
				</span>
				<span v-else class="cp-footer-hint">在流程画布或积木里点一个模块，这里显示它的实现</span>
				<span v-if="doc.declarationCatalog.value !== null" class="cp-footer-source" data-testid="code-footer-catalog">
					实现来自目录：{{ doc.declarationCatalog.value.displayName }}
				</span>
			</footer>
		</template>
	</section>
</template>

<style scoped>
.code-panel {
	display: flex;
	flex-direction: column;
	height: 100%;
	min-height: 0;
	background: var(--cc-surface);
}

.cp-header {
	display: flex;
	flex-direction: column;
	gap: var(--cc-space-1);
	padding: var(--cc-space-3) var(--cc-space-4);
	border-bottom: 1px solid var(--cc-line);
}

.cp-head-row {
	display: flex;
	align-items: baseline;
	gap: var(--cc-space-2);
	flex-wrap: wrap;
}

/* 任务名：退到第二行，字号最小——它是上下文（这个模块属于哪份任务），不是标题。 */
.cp-task {
	font-family: var(--cc-font-mono);
	font-size: var(--cc-fs-xs);
	color: var(--cc-text-faint);
}

.cp-title {
	font-size: var(--cc-fs-md);
	font-weight: 600;
	color: var(--cc-text);
}

.cp-tag {
	padding: 2px var(--cc-space-2);
	font-family: var(--cc-font-mono);
	font-size: var(--cc-fs-xs);
	letter-spacing: 0.06em;
	color: var(--cc-accent);
	background: var(--cc-accent-veil);
	border: 1px solid var(--cc-accent-dim);
	border-radius: var(--cc-radius-sm);
}

.cp-tag-readonly {
	color: var(--cc-text-dim);
	background: transparent;
	border-color: var(--cc-line-strong);
}

.cp-count {
	margin-left: auto;
	font-family: var(--cc-font-mono);
	font-size: var(--cc-fs-sm);
	color: var(--cc-text-faint);
}

.cp-empty {
	flex: 1 1 auto;
	display: flex;
	align-items: center;
	justify-content: center;
	padding: var(--cc-space-5);
	color: var(--cc-text-dim);
	text-align: center;
}

.cp-code {
	flex: 1 1 auto;
	/* 再挤也要留住三行实现的可见高度：这块是面板的主体，限值与页脚不许把它顶没。 */
	min-height: 7em;
	overflow: auto;
	padding: var(--cc-space-3) 0;
	background: var(--cc-surface-sunken);
}

.cp-lines {
	margin: 0;
	padding: 0;
	list-style: none;
	font-family: var(--cc-font-mono);
	font-size: var(--cc-fs-md);
	/* 行距紧一档：右栏那块地方要容得下「模块的实现」整段，而不是让人先滚一下才看得到末尾。 */
	line-height: 1.7;
}

/*
 * 一行 = 一条语句。行本身可点（点它 = 选中它那一步），所以给指针反馈；
 * 缩进写在文本里（`white-space: pre-wrap` 保住行首空格），这一层不再补 padding。
 */
.cp-line {
	display: flex;
	align-items: stretch;
	/* 高亮用的描边常驻（透明），选中时只换颜色——换粗细会让整块文字左右跳一格。 */
	border-left: var(--cc-highlight-border-width) solid transparent;
}

/* 只有占着步骤号的行可点（注释行不占，点了也没有「第几步」可选）。 */
.cp-line.is-clickable {
	cursor: pointer;
}

.cp-line.is-clickable:hover {
	background: var(--cc-surface-raised);
}

.cp-line:focus-visible {
	outline: 1px solid var(--cc-highlight);
	outline-offset: -1px;
}

.cp-line.is-selected {
	background: var(--cc-accent-veil);
	border-left-color: var(--cc-highlight);
}

/*
 * 行内容：序号徽标 + 行号 + 源码。五种行（调用 / 赋值 / 分支头 / 说明 / 注记）共用同一套排版，
 * 差别只在颜色与「有没有徽标」——不为了好看把行号码齐到不同的列上。
 */
.cp-hit {
	display: flex;
	align-items: flex-start;
	gap: var(--cc-space-1);
	flex: 1 1 auto;
	min-width: 0;
	padding: 0 var(--cc-space-2);
}

/* 没有徽标的行占住同样的宽度：源码左边缘于是永远对齐。 */
.cp-seq-gap {
	flex: 0 0 auto;
	width: 20px;
}

.cp-ln {
	flex: 0 0 auto;
	min-width: 2ch;
	text-align: right;
	color: var(--cc-text-faint);
	user-select: none;
}

/* 右栏只有 360px：长调用折行显示，不横向滚动（折行不改行号，行 ↔ 步骤仍然一一对应）。 */
.cp-src {
	flex: 1 1 auto;
	min-width: 0;
	color: var(--cc-text-dim);
	white-space: pre-wrap;
	overflow-wrap: anywhere;
}

.cp-line.is-call .cp-src,
.cp-line.is-set .cp-src {
	color: var(--cc-text);
}

/* 分支头（`if` / `else`）与它缩进的体：同一段程序的两个层次，靠字号与颜色分出来。 */
.cp-line.is-branch .cp-src {
	color: var(--cc-accent-strong);
}

.cp-line.is-unsupported .cp-src {
	color: var(--cc-danger-strong);
}

.cp-warnings {
	margin: 0;
	padding: var(--cc-space-2) var(--cc-space-4);
	list-style: none;
	max-height: 96px;
	overflow-y: auto;
	font-size: var(--cc-fs-sm);
	color: var(--cc-danger-strong);
	background: var(--cc-danger-veil);
	border-top: 1px solid var(--cc-line);
}

.cp-warn-code {
	font-family: var(--cc-font-mono);
	color: var(--cc-text-faint);
	margin-right: var(--cc-space-2);
}

.cp-limits {
	padding: var(--cc-space-3) var(--cc-space-4);
	border-top: 1px solid var(--cc-line);
}

.cp-limits-head {
	display: flex;
	align-items: baseline;
	gap: var(--cc-space-2);
	flex-wrap: wrap;
	margin-bottom: var(--cc-space-2);
}

.cp-limits-title {
	font-size: var(--cc-fs-sm);
	letter-spacing: 0.08em;
	color: var(--cc-text-dim);
}

.cp-limits-note {
	font-size: var(--cc-fs-xs);
	color: var(--cc-text-faint);
}

.cp-limit-list {
	margin: 0;
	padding: 0;
	list-style: none;
	display: flex;
	flex-wrap: wrap;
	gap: var(--cc-space-1) var(--cc-space-2);
}

.cp-limit {
	display: inline-flex;
	align-items: baseline;
	gap: var(--cc-space-1);
	font-family: var(--cc-font-mono);
	font-size: var(--cc-fs-sm);
}

.cp-limit-name {
	color: var(--cc-text-dim);
}

.cp-limit-value {
	color: var(--cc-accent);
}

.cp-limit-flag {
	padding: 0 var(--cc-space-1);
	font-size: var(--cc-fs-xs);
	color: var(--cc-accent-dim);
	border: 1px solid var(--cc-accent-dim);
	border-radius: var(--cc-radius-sm);
}

.cp-limit-confirm {
	color: var(--cc-text-dim);
}

.cp-limit-confirm strong {
	color: var(--cc-text);
}

.cp-footer {
	display: flex;
	align-items: baseline;
	flex-wrap: wrap;
	gap: var(--cc-space-1) var(--cc-space-2);
	padding: var(--cc-space-2) var(--cc-space-4);
	font-family: var(--cc-font-mono);
	font-size: var(--cc-fs-sm);
	color: var(--cc-text-faint);
	border-top: 1px solid var(--cc-line);
}

.cp-footer-source {
	margin-left: auto;
	font-size: var(--cc-fs-xs);
	color: var(--cc-text-faint);
}
</style>
