<script setup lang="ts">
/**
 * 流程画布上的一串步骤（**递归组件**：分支的两条臂装的还是同一串东西）。
 *
 * 它只读两样：`rows`（由 `rows.ts` 从 `connections` 推出来的行）与共享的选中状态。
 * 缩进靠 DOM 嵌套——臂里的卡片真的在 `.flow-arm` 里面，所以「这一步属于哪条臂」
 * 在 DOM 上就查得到（`closest('[data-testid="flow-arm"]')`），验收不必靠肉眼。
 *
 * 连线（`node-connector`）画在**两张相邻卡片**之间：分支卡与它的两条臂之间不画——
 * 那是同一个构造（臂是分支的展开，不是它的下一步）；臂收口之后接的那张卡前面照画，
 * 于是「分支走完接着往下走」在画布上看得见。没有分支时这一条与从前逐字一致（每两张相邻卡片一条）。
 */
import SequenceBadge from '../shared/SequenceBadge.vue';
import { useStudioDocument } from '../../state/document';
import type { FlowArmRow, FlowRow } from './rows';

const props = defineProps<{ readonly rows: readonly FlowRow[] }>();

const store = useStudioDocument();

const isSelected = (nodeId: string): boolean => store.selectedNodeId.value === nodeId;

/** 选中是共享状态，不在这里另存一份：点卡片只把 nodeId 推给真相。 */
function selectNode(nodeId: string): void {
	store.select(nodeId);
}

/** 臂里的行（普通卡没有臂）。模板里读不到类型收窄，收在这里。 */
const armRowsOf = (row: FlowRow): readonly FlowArmRow[] => (row.kind === 'card' ? row.arms : []);

/** 这一行后面要不要画连线：下一行也是一张卡片才画（见文件头）。 */
const connectorAfter = (position: number): boolean => {
	const current = props.rows[position];
	const next = props.rows[position + 1];
	return current?.kind === 'card' && next?.kind === 'card';
};
</script>

<template>
	<template v-for="(row, position) in rows" :key="row.key">
		<article
			v-if="row.kind === 'card'"
			class="node-card"
			:class="{ selected: isSelected(row.card.node.id), branch: row.card.condition !== null }"
			role="listitem"
			tabindex="0"
			data-testid="flow-node-card"
			:data-node-id="row.card.node.id"
			:data-selected="isSelected(row.card.node.id) ? 'true' : 'false'"
			:aria-current="isSelected(row.card.node.id) ? 'true' : undefined"
			@click="selectNode(row.card.node.id)"
			@keydown.enter.prevent="selectNode(row.card.node.id)"
			@keydown.space.prevent="selectNode(row.card.node.id)"
		>
			<header class="card-head">
				<!--
					序号徽标（M3）：`card.index + 1` 就是这一步在声明里的序数，
					与积木上的徽标、代码行的徽标是同一个数（三处同一个组件/同一组变量）。
				-->
				<SequenceBadge
					:index="row.card.index + 1"
					:active="isSelected(row.card.node.id)"
					testid="flow-node-index"
				/>
				<div class="card-headings">
					<span class="card-action" data-testid="flow-node-action" :data-action="row.card.actionName">
						{{ row.card.action }}
					</span>
					<span v-if="row.card.stepId !== null" class="card-step" data-testid="flow-node-step">
						{{ row.card.stepId }}
					</span>
				</div>
			</header>

			<!--
				分支卡画的是**条件本身**（人话），不是参数表：分支节点没有 `action`，
				拿动作那一套渲染只会得到一句「这个动作没有参数」——那是在说一件不成立的事。
				`data-field` / `data-op` / `data-value` 留着声明里的原值给机器对账。
			-->
			<p
				v-if="row.card.condition !== null"
				class="card-condition"
				data-testid="flow-node-condition"
				:data-field="row.card.condition.field"
				:data-op="row.card.condition.op"
				:data-value="row.card.condition.value"
				:data-readable="row.card.condition.readable ? 'true' : 'false'"
			>
				如果 {{ row.card.condition.text }}
			</p>

			<dl v-else-if="row.card.parameters.length > 0" class="card-params" data-testid="flow-node-params">
				<!--
					一行一个字段，但宽了就并成多列：名字在左、读数与范围在右。
					显示的是描述表里的中文名，`data-param` 留协议字段名给机器对账。
				-->
				<div v-for="parameter in row.card.parameters" :key="parameter.name" class="param-row">
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

			<ul v-if="row.card.diagnostics.length > 0" class="card-diagnostics" data-testid="flow-node-diagnostics">
				<li
					v-for="diagnostic in row.card.diagnostics"
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

		<!--
			两条臂：各自缩进一级，各自的链画在自己的臂里（嵌套的分支在这里递归下去）。
			臂是分支的展开，所以它们贴在分支卡后面、中间不夹连线。
			**空臂不画成一条臂**（不摆一个空壳子），只留一句说明——
			尤其「没有否则」那一种：画一条空的 else 臂等于说「这里有否则，只是空的」，那是假的。
		-->
		<template v-for="arm in armRowsOf(row)" :key="arm.key">
			<div
				v-if="arm.rows.length > 0"
				class="flow-arm"
				:class="`arm-${arm.arm}`"
				data-testid="flow-arm"
				:data-arm="arm.arm"
				:data-depth="arm.depth"
				role="group"
				:aria-label="arm.arm === 'then' ? '那么' : '否则'"
			>
				<span class="arm-label" aria-hidden="true">{{ arm.arm === 'then' ? '那么' : '否则' }}</span>
				<FlowSequence :rows="arm.rows" />
			</div>
			<p
				v-else
				class="arm-note"
				data-testid="flow-arm-empty"
				:data-arm="arm.arm"
				:data-depth="arm.depth"
			>
				{{ arm.note }}
			</p>
		</template>

		<div v-if="connectorAfter(position)" class="node-connector" data-testid="flow-connector" aria-hidden="true">
			<span class="connector-line" />
		</div>
	</template>
</template>

<style scoped>
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

/* 分支卡：左边的粗竖线与它下面的两条臂连成一体，一眼看出「这一坨是它的展开」。 */
.node-card.branch {
	border-left: var(--cc-highlight-border-width) solid var(--cc-accent-dim);
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

/* 条件的人话：与参数行同一段位置与分隔，读起来仍是「这张卡上的一条信息」。 */
.card-condition {
	margin: 0;
	padding-top: var(--cc-space-1);
	font-family: var(--cc-font-mono);
	font-size: var(--cc-fs-sm);
	color: var(--cc-accent-strong);
	border-top: 1px dashed var(--cc-line);
	overflow-wrap: anywhere;
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

/*
 * 一条臂：缩进一级 + 一条竖向导引线。缩进用 margin（不是 padding）——
 * 臂里的卡片是等宽撑满的，缩进量要真的把它的可用宽度让出来。
 */
.flow-arm {
	display: flex;
	flex-direction: column;
	gap: var(--cc-space-1);
	margin-left: var(--cc-space-4);
	padding-left: var(--cc-space-3);
	border-left: 1px solid var(--cc-line-strong);
}

.arm-label {
	font-family: var(--cc-font-mono);
	font-size: var(--cc-fs-xs);
	color: var(--cc-text-faint);
}

.arm-note {
	/* 与臂里的内容对齐：空臂也缩进一级，读者一眼看出它属于上面那张分支卡。 */
	margin: 0 0 0 var(--cc-space-4);
	padding: var(--cc-space-1) var(--cc-space-2);
	font-size: var(--cc-fs-sm);
	color: var(--cc-text-faint);
	background: var(--cc-surface-sunken);
	border: 1px dashed var(--cc-line);
	border-radius: var(--cc-radius-sm);
}

/* 臂里的卡片之间也要有呼吸：嵌套的那一串自己会画连线，这里只把纵向间距补齐。 */
.flow-arm :deep(.node-connector) {
	height: var(--cc-space-2);
}
</style>
