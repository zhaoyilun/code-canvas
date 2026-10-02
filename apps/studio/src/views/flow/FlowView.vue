<script setup lang="ts">
/**
 * 中栏：流程画布（spec §4.1）。
 *
 * 只回答三件事：顺序是什么、每步的参数落在什么范围里、哪一步带着诊断。
 * **这里没有一条写回路径**——真相只从 `useStudioDocument()` 读，改参数是积木画布的事。
 */
import { computed } from 'vue';
import { LIMIT_LABELS, type Diagnostic, type NumericLimitName, type WorkflowNode } from '@codecanvas/contracts';
import { useStudioDocument } from '../../state/document';
import SequenceBadge from '../shared/SequenceBadge.vue';
import {
	actionLabel,
	declarationLimits,
	nodeAction,
	nodeActionName,
	nodeDiagnostics,
	nodeStepId,
	summarizeNodeParameters,
	type NodeLimits,
	type ParameterSummary,
} from './summary';

const store = useStudioDocument();

interface FlowCard {
	readonly node: WorkflowNode;
	readonly index: number;
	/** 卡头显示的中文动作名。 */
	readonly action: string;
	/** 协议里的动作名，只进 `data-action`。 */
	readonly actionName: string;
	readonly stepId: string | null;
	readonly parameters: readonly ParameterSummary[];
	readonly diagnostics: readonly Diagnostic[];
}

const limits = computed<NodeLimits>(() => declarationLimits(store.declaration.value?.meta));

/** 声明的标题：任务里有 description 就用它（转换器就是这么起名的）。 */
const taskTitle = computed(() => store.declaration.value?.name ?? '');

/** 限值条：这几个数字决定参数摘要里的上界，摆在画布上比藏在声明里有用。名字同样取自协议描述表。 */
const limitChips = computed<readonly string[]>(() =>
	Object.entries(limits.value)
		.filter((entry): entry is [NumericLimitName, number] => entry[1] !== undefined)
		.map(([name, value]) => `${LIMIT_LABELS[name]} ≤ ${String(value)}`),
);

const cards = computed<readonly FlowCard[]>(() =>
	store.nodes.value.map((node, index) => ({
		node,
		index,
		action: actionLabel(node),
		actionName: nodeActionName(node),
		stepId: nodeStepId(node),
		parameters: summarizeNodeParameters(node.parameters, nodeAction(node), limits.value),
		diagnostics: nodeDiagnostics(store.diagnostics.value, node, index),
	})),
);

/** 卡片之间的连线：链上两个节点之间恰好一条，所以是 `节点数 - 1`。 */
const connectorCount = computed(() => Math.max(cards.value.length - 1, 0));

/** 选中是共享状态，不在这里另存一份：点卡片只把 nodeId 推给真相。 */
function selectNode(nodeId: string): void {
	store.select(nodeId);
}

const isSelected = (nodeId: string): boolean => store.selectedNodeId.value === nodeId;
</script>

<template>
	<section class="flow-view" data-testid="view-flow">
		<header class="flow-header">
			<span class="flow-title">流程画布</span>
			<span class="flow-tag">WORKFLOW</span>
			<span class="flow-tag">只读</span>
			<span v-if="store.hasDeclaration.value" class="flow-task" data-testid="flow-task-name">
				{{ taskTitle }}
			</span>
		</header>

		<div v-if="store.hasDeclaration.value" class="flow-body" data-testid="flow-canvas">
			<div class="flow-chain" role="list" data-testid="flow-chain">
				<template v-for="(card, position) in cards" :key="`${card.node.id}:${position}`">
					<article
						class="node-card"
						:class="{ selected: isSelected(card.node.id) }"
						role="listitem"
						tabindex="0"
						data-testid="flow-node-card"
						:data-node-id="card.node.id"
						:data-selected="isSelected(card.node.id) ? 'true' : 'false'"
						:aria-current="isSelected(card.node.id) ? 'true' : undefined"
						@click="selectNode(card.node.id)"
						@keydown.enter.prevent="selectNode(card.node.id)"
						@keydown.space.prevent="selectNode(card.node.id)"
					>
						<header class="card-head">
							<!--
								序号徽标（M3）：`card.index + 1` 就是这一步在声明里的序数，
								与积木上的徽标、代码行的徽标是同一个数（三处同一个组件/同一组变量）。
							-->
							<SequenceBadge
								:index="card.index + 1"
								:active="isSelected(card.node.id)"
								testid="flow-node-index"
							/>
							<div class="card-headings">
								<span class="card-action" data-testid="flow-node-action" :data-action="card.actionName">
									{{ card.action }}
								</span>
								<span v-if="card.stepId !== null" class="card-step" data-testid="flow-node-step">
									{{ card.stepId }}
								</span>
							</div>
						</header>

						<dl v-if="card.parameters.length > 0" class="card-params" data-testid="flow-node-params">
							<!--
								一行一个字段，但宽了就并成多列：名字在左、读数与范围在右。
								显示的是描述表里的中文名，`data-param` 留协议字段名给机器对账。
							-->
							<div v-for="parameter in card.parameters" :key="parameter.name" class="param-row">
								<dt class="param-name" :data-label="parameter.name" :title="`${parameter.name} · ${parameter.description}`">
									{{ parameter.label }}
								</dt>
								<dd class="param-value" :class="{ missing: parameter.missing }">
									<span class="param-number" :data-param="parameter.name" :data-value="parameter.value">
										{{ parameter.value }}{{ parameter.unit }}
									</span>
									<span v-if="parameter.constraint !== ''" class="param-range">
										{{ parameter.constraint }}
									</span>
								</dd>
							</div>
						</dl>
						<p v-else class="card-params-empty">这个动作没有参数</p>

						<ul v-if="card.diagnostics.length > 0" class="card-diagnostics" data-testid="flow-node-diagnostics">
							<li
								v-for="diagnostic in card.diagnostics"
								:key="`${diagnostic.code}:${diagnostic.path ?? ''}`"
								class="diagnostic"
								:class="diagnostic.severity"
								:title="diagnostic.path ?? ''"
							>
								<span class="diagnostic-code">{{ diagnostic.code }}</span>
								{{ diagnostic.message }}
							</li>
						</ul>
					</article>

					<div
						v-if="position < connectorCount"
						class="node-connector"
						data-testid="flow-connector"
						aria-hidden="true"
					>
						<span class="connector-line" />
					</div>
				</template>
			</div>
		</div>

		<div v-else class="flow-empty" data-testid="flow-empty">
			<p class="empty-text">
				流程画布画的是那份 workflow 声明里的一串步骤：顺序、参数、哪一步有问题。<br />
				现在还没有声明——导入一份任务 JSON，这条链就会出现在这里。
			</p>
		</div>

		<footer class="flow-footer">
			<span v-if="store.hasDeclaration.value" class="footer-count" data-testid="flow-count">
				{{ cards.length }} 步 · {{ connectorCount }} 条连线
			</span>
			<span v-for="chip in limitChips" :key="chip" class="footer-chip">{{ chip }}</span>
			<span class="footer-note">只读：参数在积木画布上改</span>
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

.flow-tag {
	padding: 2px var(--cc-space-2);
	font-family: var(--cc-font-mono);
	font-size: var(--cc-fs-xs);
	letter-spacing: 0.06em;
	color: var(--cc-accent);
	background: var(--cc-accent-veil);
	border: 1px solid var(--cc-accent-dim);
	border-radius: var(--cc-radius-sm);
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

/* 自上而下的链：卡片等宽撑满中栏，一条列排版。 */
.flow-chain {
	display: flex;
	flex-direction: column;
	align-items: stretch;
	width: 100%;
	padding: var(--cc-space-3);
}

/* 连线是定高的一小段：卡片之间的呼吸，也是那条向下的箭头。留白压到刚好，一屏才装得下几个步骤。 */
.node-connector {
	display: flex;
	justify-content: center;
	flex: 0 0 auto;
	height: var(--cc-space-3);
}

.connector-line {
	position: relative;
	width: 2px;
	height: 100%;
	background: var(--cc-line-strong);
}

/* 箭头用两条边框转 135° 画出来（顶边 + 右边 → 尖朝下），不给这个深色画布塞第二位色。 */
.connector-line::after {
	position: absolute;
	bottom: 0;
	left: 50%;
	width: 7px;
	height: 7px;
	border-top: 2px solid var(--cc-line-strong);
	border-right: 2px solid var(--cc-line-strong);
	content: '';
	transform: translateX(-50%) rotate(135deg);
}

.node-card {
	display: flex;
	flex-direction: column;
	gap: var(--cc-space-1);
	flex: 0 0 auto;
	width: 100%;
	padding: var(--cc-space-2) var(--cc-space-3);
	background: var(--cc-surface-raised);
	border: 1px solid var(--cc-line);
	border-radius: var(--cc-radius);
	cursor: pointer;
	transition:
		border-color 0.15s ease,
		box-shadow 0.15s ease;
}

.node-card:hover {
	border-color: var(--cc-line-strong);
}

.node-card:focus-visible {
	outline: 2px solid var(--cc-accent);
	outline-offset: 2px;
}

/*
 * 卡片高亮（M3）：**与另外两栏同一套**——同一条强调色（`--cc-highlight`）、同一个描边粗细
 * （`--cc-highlight-border-width`）、同一个辉光，都不写字面值。
 *
 * 不直接把 border-color 改掉而是加 box-shadow 内描边：卡片本来就带 1px 边框，
 * 直接换色只是「变亮了一点」，说不上「选中」；内描边叠上去，边框仍占 1px、观感上多出一圈 2px 强调色。
 */
.node-card.selected {
	border-color: var(--cc-highlight);
	box-shadow:
		inset 0 0 0 var(--cc-highlight-border-width) var(--cc-highlight),
		var(--cc-highlight-glow);
}

.card-head {
	display: flex;
	align-items: center;
	gap: var(--cc-space-2);
}

.card-headings {
	display: flex;
	align-items: baseline;
	gap: var(--cc-space-2);
	flex: 1 1 auto;
	min-width: 0;
}

.card-action {
	font-family: var(--cc-font-mono);
	font-size: var(--cc-fs-md);
	font-weight: 600;
	color: var(--cc-text);
	overflow-wrap: anywhere;
}

/* 有宽度了：动作名靠左，step_id 推到行尾，一眼能对齐着读。 */
.card-step {
	margin-left: auto;
	font-family: var(--cc-font-mono);
	font-size: var(--cc-fs-xs);
	color: var(--cc-text-faint);
}

.card-params {
	/* 宽了就并成多列：三个参数的卡片从三行压到两行，七关节的从七行压到四行，信息一行没少。 */
	display: grid;
	grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
	gap: var(--cc-space-1) var(--cc-space-4);
	margin: 0;
	padding-top: var(--cc-space-1);
	border-top: 1px dashed var(--cc-line);
}

/* 一行一个字段：名字与读数分居两端，读数后面跟着范围标签。 */
.param-row {
	display: flex;
	align-items: baseline;
	justify-content: space-between;
	gap: var(--cc-space-2);
	min-width: 0;
	padding: 1px var(--cc-space-2);
	background: var(--cc-surface-sunken);
	border-radius: var(--cc-radius-sm);
}

.param-name {
	font-size: var(--cc-fs-sm);
	color: var(--cc-text-dim);
	min-width: 0;
	/* 中文名很短，正常情况一行放得下；协议不认识的字段名再长也让它折行，不许顶破格子。 */
	overflow-wrap: anywhere;
}

.param-value {
	display: flex;
	align-items: baseline;
	justify-content: flex-end;
	flex-wrap: wrap;
	gap: var(--cc-space-2);
	margin: 0;
	min-width: 0;
	text-align: right;
}

.param-number {
	font-family: var(--cc-font-mono);
	font-size: var(--cc-fs-md);
	color: var(--cc-text);
}

.param-value.missing .param-number {
	color: var(--cc-text-faint);
}

.param-range {
	font-family: var(--cc-font-mono);
	font-size: var(--cc-fs-xs);
	color: var(--cc-text-faint);
}

.card-params-empty {
	margin: 0;
	padding-top: var(--cc-space-1);
	font-size: var(--cc-fs-sm);
	color: var(--cc-text-faint);
	border-top: 1px dashed var(--cc-line);
}

.card-diagnostics {
	display: flex;
	flex-direction: column;
	gap: var(--cc-space-1);
	margin: 0;
	padding: var(--cc-space-2);
	list-style: none;
	background: var(--cc-danger-veil);
	border: 1px solid var(--cc-danger);
	border-radius: var(--cc-radius-sm);
}

.diagnostic {
	font-size: var(--cc-fs-sm);
	line-height: 1.5;
	color: var(--cc-text);
	overflow-wrap: anywhere;
}

.diagnostic.warning {
	color: var(--cc-text-dim);
}

.diagnostic-code {
	display: block;
	font-family: var(--cc-font-mono);
	font-size: var(--cc-fs-xs);
	color: var(--cc-danger-strong);
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

.footer-count {
	color: var(--cc-text-dim);
}

.footer-chip {
	padding: 1px var(--cc-space-2);
	border: 1px solid var(--cc-line);
	border-radius: var(--cc-radius-sm);
}

.footer-note {
	margin-left: auto;
}
</style>
