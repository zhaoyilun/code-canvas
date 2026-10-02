<script setup lang="ts">
/**
 * 中栏：流程画布（spec §4.1）。
 *
 * 只回答三件事：顺序是什么、每步的参数落在什么范围里、哪一步带着诊断。
 * **这里没有一条写回路径**——真相只从 `useStudioDocument()` 读，改参数是积木画布的事。
 *
 * 「顺序」不是声明里 `nodes` 的排列，而是 **`connections` 推出来的图**（见 `plan-structure.ts`）：
 * 链头（没有入边的节点）出发走到底，遇到分支节点就展开成两条臂（then / else），
 * 各自缩进一级；`main[2]` 的后续回到分支所在那一层的缩进继续。
 * 从前按声明顺序竖排一列，是因为那时只可能是一条链；分支一来，「声明顺序」与「执行的顺序」
 * 就不是同一件事了（臂里的节点在声明里排在分支后面，但它们在画布上属于臂里）。
 *
 * 图推不出来时（悬空引用、环、多个链头）不崩、也不静默少画：能画的照画，
 * 问题摆在画布顶上那一条里（`flow-graph-diagnostics`）。
 */
import { computed } from 'vue';
import { LIMIT_LABELS, type NumericLimitName } from '@codecanvas/contracts';
import { useStudioDocument } from '../../state/document';
import FlowSequence from './FlowSequence.vue';
import { declarationLimits, type NodeLimits } from './summary';
import { planStructureOf } from '../shared/plan-structure';
import { buildFlowRows } from './rows';

const store = useStudioDocument();

const limits = computed<NodeLimits>(() => declarationLimits(store.declaration.value?.meta));

/** 声明的标题：任务里有 description 就用它（转换器就是这么起名的）。 */
const taskTitle = computed(() => store.declaration.value?.name ?? '');

/** 限值条：这几个数字决定参数摘要里的上界，摆在画布上比藏在声明里有用。名字同样取自协议描述表。 */
const limitChips = computed<readonly string[]>(() =>
	Object.entries(limits.value)
		.filter((entry): entry is [NumericLimitName, number] => entry[1] !== undefined)
		.map(([name, value]) => `${LIMIT_LABELS[name]} ≤ ${String(value)}`),
);

/** 这份声明的结构：一列步骤，分支自带两条臂。 */
const plan = computed(() => planStructureOf(store.declaration.value));

const rows = computed(() => buildFlowRows(plan.value.steps, store.diagnostics.value, limits.value));

/** 图本身的问题（悬空引用、环、多个链头）。有才画那一条，没有时一个像素都不多。 */
const graphDiagnostics = computed(() => plan.value.diagnostics);
</script>

<template>
	<section class="flow-view" data-testid="view-flow">
		<header class="flow-header">
			<span class="flow-title">流程画布</span>
			<span v-if="store.hasDeclaration.value" class="flow-task" data-testid="flow-task-name">
				{{ taskTitle }}
			</span>
		</header>

		<div v-if="store.hasDeclaration.value" class="flow-body" data-testid="flow-canvas">
			<!--
				图自己的毛病：说出来，但**不影响画**。下面能画的部分照画，
				所以这条在画布顶上，而不是把整块替换成一句错误。
			-->
			<ul v-if="graphDiagnostics.length > 0" class="flow-graph" data-testid="flow-graph-diagnostics">
				<li
					v-for="diagnostic in graphDiagnostics"
					:key="`${diagnostic.code}:${diagnostic.nodeId ?? ''}`"
					class="graph-row"
					:data-code="diagnostic.code"
					:data-node-id="diagnostic.nodeId ?? undefined"
				>
					<span class="graph-code">{{ diagnostic.code }}</span>
					{{ diagnostic.message }}
				</li>
			</ul>

			<div class="flow-chain" role="list" data-testid="flow-chain">
				<FlowSequence :rows="rows" />
			</div>
		</div>

		<div v-else class="flow-empty" data-testid="flow-empty">
			<p class="empty-text">
				流程画布画的是那份 workflow 声明里的一串步骤：顺序、参数、哪一步有问题。<br />
				现在还没有声明——导入一份任务 JSON，这条链就会出现在这里。
			</p>
		</div>

		<!-- 限值芯片：声明里写了 meta.limits 才有；没有就不画这条页脚（空容器会白占一段栏间距） -->
		<footer v-if="limitChips.length > 0" class="flow-footer">
			<span v-for="chip in limitChips" :key="chip" class="footer-chip">{{ chip }}</span>
		</footer>
	</section>
</template>

<style scoped>
.flow-view {
	display: flex;
	flex-direction: column;
	gap: var(--cc-space-3);
	height: 100%;
	min-height: 0;
	padding: var(--cc-space-4);
}

.flow-header {
	display: flex;
	align-items: baseline;
	gap: var(--cc-space-2);
	flex-wrap: wrap;
	padding-bottom: var(--cc-space-3);
	border-bottom: 1px solid var(--cc-line);
}

.flow-title {
	font-size: var(--cc-fs-lg);
	font-weight: 600;
	color: var(--cc-text);
}

.flow-task {
	margin-left: auto;
	font-family: var(--cc-font-mono);
	font-size: var(--cc-fs-sm);
	color: var(--cc-text-dim);
}

/* 纵向滚动：链子长了就往下走，横向永远不滚（横向留给卡片自己撑满）。 */
.flow-body {
	flex: 1 1 auto;
	min-height: 0;
	overflow-x: hidden;
	overflow-y: auto;
	background: var(--cc-surface-sunken);
	border: 1px solid var(--cc-line);
	border-radius: var(--cc-radius);
}

/* 图的问题条：与卡片同一套语言，但用危险色的面与描边，摆在画布最上面一条。 */
.flow-graph {
	display: flex;
	flex-direction: column;
	gap: var(--cc-space-1);
	margin: 0;
	padding: var(--cc-space-2) var(--cc-space-3);
	list-style: none;
	background: var(--cc-danger-veil);
	border-bottom: 1px solid var(--cc-danger);
}

.graph-row {
	font-size: var(--cc-fs-sm);
	line-height: 1.5;
	color: var(--cc-text);
	overflow-wrap: anywhere;
}

.graph-code {
	display: block;
	font-family: var(--cc-font-mono);
	font-size: var(--cc-fs-xs);
	color: var(--cc-danger-strong);
}

/* 自上而下的链：卡片等宽撑满中栏，一条列排版。 */
.flow-chain {
	display: flex;
	flex-direction: column;
	align-items: stretch;
	width: 100%;
	padding: var(--cc-space-3);
}

.flow-empty {
	display: flex;
	align-items: center;
	justify-content: center;
	flex: 1 1 auto;
	min-height: 0;
	padding: var(--cc-space-5);
	text-align: center;
	background: var(--cc-surface-sunken);
	border: 1px dashed var(--cc-line-strong);
	border-radius: var(--cc-radius);
}

.empty-text {
	max-width: 40ch;
	margin: 0;
	color: var(--cc-text-dim);
	line-height: 1.7;
}

.flow-footer {
	display: flex;
	align-items: center;
	gap: var(--cc-space-2);
	flex-wrap: wrap;
	font-family: var(--cc-font-mono);
	font-size: var(--cc-fs-sm);
	color: var(--cc-text-faint);
}

.footer-chip {
	padding: 1px var(--cc-space-2);
	border: 1px solid var(--cc-line);
	border-radius: var(--cc-radius-sm);
}
</style>
