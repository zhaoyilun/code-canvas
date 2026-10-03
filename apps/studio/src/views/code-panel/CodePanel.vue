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
 *
 * 原先底部还常驻一栏「安全限值」（整个任务的 `meta.limits`）与三行页脚小字，都已去掉：
 * 限值是声明级的事实，不随这块面板看什么变，摆在只读面板底下只是一堆数字与标签，
 * 页脚那几句更是把已经看得见的事又说了一遍。
 */
import { computed, nextTick, ref, watch } from 'vue';
import { renderImplementation, type RenderedImplementation, type RenderedLine } from '@codecanvas/code-render';
import { useStudioDocument } from '../../state/document';
import { runningPlanPath } from '../../shell/device-run';
import { stepNumbersOf } from '../shared/sequence-badge';
import { nodeAtPlanPath } from '../shared/plan-structure';
import SequenceBadge from '../shared/SequenceBadge.vue';
import { PLAN_LAYER_NOTE, lineNodeId, planProgramOf, type PlanLine, type PlanProgram } from './branch-code';

const doc = useStudioDocument();

/**
 * 面板上显示的两种东西：某个能力的**实现**，或一个分支节点的**计划层代码**。
 * 两者行的形状一样（`RenderedLine`），所以渲染与联动只有一套；
 * 判据不同、也不许混——见 `branch-code.ts` 的文件头。
 */
type PanelProgram = RenderedImplementation | PlanProgram;

/** 当前显示的模块：选中的那个；没选中时退到第一个（不改共享状态）。 */
const activeNode = computed(() => doc.selectedNode.value ?? doc.nodes.value[0] ?? null);

/** 选中的是计划层节点（分支 / 等待 / 原语）→ 它的计划层代码；否则 null（退回能力实现那条路）。 */
const planProgram = computed<PlanProgram | null>(() => {
	const node = activeNode.value;
	// 目录也交给它：原语那一行要按**原语声明的顺序**写实参（与实现里的调用同一个口径）。
	return node === null ? null : planProgramOf(doc.declaration.value, node.id, doc.declarationCatalog.value);
});

/*
 * 目录从 store 取（`declarationCatalog`），**不在这里写死哪一份**：
 * 面板显示的是「机器为了执行它具体做了什么」，而那句话只有在**给出这份实现的那份目录**里才成立。
 * 写死一份常量，换设备之后就会拿另一份目录去查同一个能力名——查不到时看起来像目录缺了东西，
 * 其实是面板拿错了尺子（真机上「技能计划」四个字也永远显示不出来）。
 * 目录还没定下来（没导入过、也没选中设备）时按「没有模块」渲染，不编一份实现出来。
 */
const program = computed<PanelProgram>(() =>
	planProgram.value ??
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

const warnings = computed(() => program.value.diagnostics);

const scroller = ref<HTMLElement | null>(null);

/** 面板上的一行：实现行与计划行是同一个形状（`PlanLine` 只是多带一个 `nodeId`）。 */
type PanelLine = RenderedLine | PlanLine;

/** 当前选中的是**哪一条顶层语句**（0 基）；null = 没选。 */
const selectedStep = computed(() => doc.selectedStepIndex.value);

/** 这一行属不属于当前选中步：属于就整行高亮（一个 `if` 的每一行都亮）。 */
const isSelectedStep = (line: PanelLine): boolean =>
	selectedStep.value !== null && line.stepIndex === selectedStep.value;

// ---------------------------------------------------------------------------
// 动线在代码这一侧的落点：设备正在跑的那一步
// ---------------------------------------------------------------------------

/**
 * 设备**正在跑**的那一步是哪个节点。
 *
 * 判据与流程卡、积木那侧同一份（`runningPlanPath` + `nodeAtPlanPath`）**不是**同一份状态：
 * 「选中」是人在看哪一步（`selectedStepIndex` / `selectedNodeId`），这里是机器在哪一步。
 * 跟随开着时两者重合，用户手点别处时就分开——所以它们是两个独立的东西，不合成一个。
 */
const runningNodeId = computed<string | null>(() => {
	const path = runningPlanPath.value;
	return path === null ? null : (nodeAtPlanPath(doc.declaration.value, path)?.id ?? null);
});

/**
 * 这一行属不属于**正在跑**的那一步（不计注释行：它不占步号，也没在执行）。
 *
 * 判据是这一行指的那个节点（计划行是它自己那一步，实现行是这个模块）——
 * 与挂 `data-node-id` 用的是同一个函数，于是「连线连到哪一行」与「哪一行在跑」必然是同一行。
 * 计划层里臂内那一行因此只亮它自己；实现层里亮的是这个模块的每一行
 * （画布一次只画一个模块，模块就是计划里的一步，它内部没有更细的计划步可言）。
 */
const isRunningLine = (line: PanelLine): boolean =>
	runningNodeId.value !== null &&
	line.kind !== 'comment' &&
	(lineNodeId(line) ?? activeNode.value?.id ?? null) === runningNodeId.value;

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

const isStepHead = (line: PanelLine): boolean => stepHeads.value.has(line.line);

/**
 * 可点的行：有步可选（实现行），或有节点可进（计划行——臂里那一行说的是另一步）。
 * 注释行一律不可点：它不占步骤号，点了也没有「第几步」可选。
 */
const isClickable = (line: PanelLine): boolean =>
	line.kind !== 'comment' && (line.stepIndex !== null || lineNodeId(line) !== null);

/**
 * 点一行：实现行选中它所属的那一步；**计划行说的是另一步**时改成进那一步——
 * 选中那一行指的那个节点，面板随之换成它的实现（这就是「从计划看进实现」那条路）。
 * 再点同一行收回选中（不然就没法「取消选中」了）——收回只动 `selectedStepIndex`，不动节点选中。
 */
const pickLine = (line: PanelLine): void => {
	const target = lineNodeId(line);
	if (target !== null && target !== doc.selectedNodeId.value) {
		doc.select(target);
		return;
	}
	if (line.stepIndex === null) return;
	doc.selectStep(selectedStep.value === line.stepIndex ? null : line.stepIndex);
};

/** 键盘走同一件事：回车/空格选中那一行所属的步。 */
const pickLineByKey = (event: KeyboardEvent, line: PanelLine): void => {
	if (event.key !== 'Enter' && event.key !== ' ') return;
	event.preventDefault();
	pickLine(line);
};

/** 读屏用的整行说明：缩进说成「缩进 n 档」，比四个空格好懂。 */
const describeLine = (line: PanelLine): string =>
	line.indent === 0 ? line.text.trim() : `缩进 ${line.indent} 档：${line.text.trim()}`;

/** 这一行的锚点（跨栏连线只认 `data-node-id`）：计划行是它自己那一步，实现行是这个模块。 */
const lineAnchorId = (line: PanelLine): string | undefined => lineNodeId(line) ?? activeNode.value?.id ?? undefined;

/** 行的提示：进另一步的行说「进哪一步」，其余说「选中第几步」。 */
const lineTitle = (line: PanelLine): string | undefined => {
	const target = lineNodeId(line);
	if (target !== null && target !== doc.selectedNodeId.value) {
		return `进这一步的实现：${doc.nodes.value.find((node) => node.id === target)?.name ?? target}`;
	}
	if (line.stepIndex === null) return undefined;
	return `选中第 ${line.stepIndex + 1} 步（${describeLine(line)}）`;
};

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
			</div>
		</header>

		<div v-if="!doc.hasDeclaration.value" class="cp-empty" data-testid="code-empty-task">
			<p>还没有声明——导入一份任务 JSON 后，这里会显示选中模块的实现。</p>
		</div>

		<template v-else>
			<!--
				分支节点显示的是**计划层**的代码（臂里是技能调用），与「某个能力的实现」是两件事。
				这句话必须说出来：不说的话，`close_gripper_skill()` 看着就像这个模块的实现。
			-->
			<p v-if="planProgram !== null" class="cp-plan-note" data-testid="code-plan-note">{{ PLAN_LAYER_NOTE }}</p>

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
						计划行另外带一个 `data-node-id`（它说的那一步）：点它 = 进那一步的实现。
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
							'is-running': isRunningLine(line),
							'is-clickable': isClickable(line),
						}"
						:data-line="line.line"
						:data-kind="line.kind"
						:data-indent="line.indent"
						:data-step="line.stepIndex ?? undefined"
						:data-path="line.stepPath ?? undefined"
						:data-step-head="isStepHead(line) ? (line.stepIndex ?? undefined) : undefined"
						:data-primitive="line.primitiveRef ?? undefined"
						:data-selected="isSelectedStep(line) ? 'true' : 'false'"
						:data-running="isRunningLine(line) ? 'true' : undefined"
						:data-node-id="lineAnchorId(line)"
						:role="isClickable(line) ? 'button' : undefined"
						:tabindex="isClickable(line) ? 0 : undefined"
						:title="lineTitle(line)"
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
					{{ diagnostic.message }}
				</li>
			</ul>
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

.cp-title {
	font-size: var(--cc-fs-md);
	font-weight: 600;
	color: var(--cc-text);
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

/*
 * 计划层那句注记（只在选中分支节点时出现）：它说的是「你看的是哪一层的代码」，
 * 所以跟代码放在一起、用强调色的面把它和下面的代码分开，但**不占代码的高度**（一行，可折行）。
 */
.cp-plan-note {
	margin: 0;
	padding: var(--cc-space-2) var(--cc-space-4);
	font-size: var(--cc-fs-sm);
	line-height: 1.6;
	color: var(--cc-accent-strong);
	background: var(--cc-accent-veil);
	border-bottom: 1px solid var(--cc-accent-dim);
}

.cp-code {
	flex: 1 1 auto;
	/* 再挤也要留住三行实现的可见高度：这块是面板的主体，下面的警告条不许把它顶没。 */
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
 * 「设备正在跑这一步」（M4 的动线在代码这一侧的落点）。
 *
 * 与上面那条**选中**是两种观感，缺一种就分不清「机器在这儿」与「我在看那儿」：
 *   选中 → 左边一条实心强调色 + 一层 veil 底色（静态，一直在）
 *   在跑 → 一行**内描边**从亮到弱地亮一下，最后停在一条很淡的圈上
 *
 * 只动 `box-shadow`、不动 `background`：两者会同时出现（跟随开着时正好同一行），
 * 动画若占了 `background` 就会把选中那层底色盖掉——两个信号不该互相吃掉。
 * `box-shadow` 不触发布局，行高与文字位置一个像素不动。
 */
.cp-line.is-running {
	animation: cc-line-lit var(--cc-lit-flash-ms) ease-out 1 forwards;
}

@keyframes cc-line-lit {
	0% {
		box-shadow:
			inset 0 0 0 var(--cc-highlight-border-width) var(--cc-highlight),
			0 0 10px var(--cc-lit-flash-glow);
	}

	100% {
		box-shadow: inset 0 0 0 1px var(--cc-flow-settled);
	}
}

/* 不动效的人也看得见「这一行在跑」：只剩那个静态的淡圈，信息一个不少。 */
@media (prefers-reduced-motion: reduce) {
	.cp-line.is-running {
		animation: none;
		box-shadow: inset 0 0 0 1px var(--cc-flow-settled);
	}
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
</style>
