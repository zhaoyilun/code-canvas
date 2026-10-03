<script setup lang="ts">
/**
 * 右栏的「发给机器人」视图：**这一句话编出来会变成哪些请求**。
 *
 * 这一屏是「接到真执行链」的可见证据，所以它只说两件事，且都不许含糊：
 *
 * 1. **每一步会发什么**：`execute` 摆出方法、路径与请求体（`task_id` / `skill` / `params` /
 *    `timeout_sec`，逐字对得上 bridge 的 `ExecuteRequest`），后面紧跟**轮询**那一行
 *    （`GET /v1/tasks/{id}`，间隔与余量来自编译期带的 `PollSpec`）；
 *    `wait` 与 `branch` 明写「本地」——**它们不发请求**，画成请求就是编。
 * 2. **送不出去的那一步也在**：原语步在 `calls` 里根本不存在（执行侧没有原语端点），
 *    所以它必须**在它本来的位置上**以危险色显示那条诊断。少一行是最坏的——
 *    看起来像计划里没有这一步（判断在 `robot-calls.ts` 里，这里只管画）。
 *
 * 每一行只摆结论（徽标那三个字 + 会发什么），**理由挂在 `title` 上**：这一块只有一百多像素高，
 * 把编译包那一份路由 note 铺成字，六步就能把面板撑出十屏滚动（真的量过：919px / 94px）。
 * note 全句照抄、不改写一个标点，只是改成「问它才说」。
 *
 * 判据一份都不在这里：步去哪儿读 `@codecanvas/robot-bridge` 的 `STEP_ROUTING`，
 * 技能在不在目录里由 `compilePlanToCalls` 说，条件的人话与流程卡共用 `conditionViewOf`。
 *
 * 三段状态如实分开：**没有声明**（先在上面写一句话生成任务）、**出生格式不是技能计划**
 * （一期设备那份不是这台设备产出的，编译不出请求，不硬套）、**计划过不了校验**（诊断原样摆出来）。
 * 与右栏「虚拟设备」按下运行时的拒接是同一套判据（同一个 `buildPlanFromDeclaration`）。
 *
 * 只读：这一屏没有一条写回路径——要改计划去积木画布，要重下发得先有端点（这版不发请求）。
 */
import { computed } from 'vue';
import { findTaskFormat } from '@codecanvas/task-import';
import IconBase from '../../../shell/IconBase.vue';
import { useStudioDevices } from '../../../shell/devices';
import { useStudioDocument } from '../../../state/document';
import {
	ROUTING_FACE,
	compileDeclarationToCalls,
	type RobotCallRow,
} from './robot-calls';

const doc = useStudioDocument();
const devices = useStudioDevices();

/**
 * 拿哪份目录判「技能在不在」：**声明该用的那份**（`document.ts` 的 `declarationCatalog`，
 * 出生格式优先），没有就退到当前设备的。这与右栏另两处同一把尺子——
 * 视图里再写死一份常量目录，换设备之后「查不到这个技能」看起来就会像目录缺了东西。
 */
const catalog = computed(() => doc.declarationCatalog.value ?? devices.selectedCatalog.value);

/** 这批调用是给哪台设备编的：`deviceRef` 进 `task_id` 的摘要，所以它必须是**真的那一台**。 */
const deviceRef = computed(() => devices.selectedDevice.value?.deviceRef ?? '');

/** 出生格式的标签：拒接时要说清「这份声明是哪种格式」，那句话说给读者听。 */
const bornFormatLabel = computed(() => {
	const ref = doc.declarationFormatRef.value;
	return ref === null ? '未知格式' : findTaskFormat(ref).label;
});

/**
 * 一屏 = 还原 + 编译 + 摊平。没有声明、没有目录、没有设备时 `null`——
 * 那几件事各自有自己的状态块说，不该落到「编译失败」那一档里去。
 */
const result = computed(() => {
	const declaration = doc.declaration.value;
	const currentCatalog = catalog.value;
	if (declaration === null || currentCatalog === null || deviceRef.value === '') return null;
	return compileDeclarationToCalls({
		declaration,
		// 出生格式：没导入过时退到当前设备的（与右栏另两处同一个退法）。
		formatRef: doc.declarationFormatRef.value ?? devices.selectedDevice.value?.formatRef ?? 'phase1_task',
		catalog: currentCatalog,
		deviceRef: deviceRef.value,
	});
});

const rows = computed<readonly RobotCallRow[]>(() => (result.value?.ok === true ? result.value.view.rows : []));
const summary = computed(() => (result.value?.ok === true ? result.value.view.summary : null));
const emptyReason = computed(() => (result.value?.ok === true ? result.value.view.emptyReason : null));
const floatingDiagnostics = computed(() =>
	result.value?.ok === true ? result.value.view.floatingDiagnostics : [],
);
/** 编译不了的那两种情形（一期声明 / 计划过不了校验）。`null`＝编译了。 */
const blocked = computed(() => (result.value !== null && !result.value.ok ? result.value : null));

/** 送不出去的那几行：面板顶部那行摘要里的「K 步送不出去」说的就是它们的条数。 */
const blockedRows = computed(() => rows.value.filter((row) => row.kind === 'blocked'));

/** 这一步在哪一格（`2.then.0`）：臂里的步也认得出自己属于哪一层。 */
const depthOf = (row: RobotCallRow): number =>
	row.stepPath.split('.').filter((segment) => segment === 'then' || segment === 'else').length;

const badgeOf = (row: RobotCallRow): string => ROUTING_FACE[row.routing.where];

/**
 * 读屏与 `title` 用的一句话：这一步是什么、会发什么，以及**它为什么是这个去向**。
 *
 * 去向那句 note 挂在 `title` 上而不是铺成一行字：它是**凭据**（全句照抄编译包那份清单），
 * 而这一块的高度只有一百多像素——一条一步的 note 铺开就是两三行，六步就是六百像素。
 * 徽标上那三个字（发给 bridge / 本地 / 送不出去）已经把结论说了，note 留给人问的时候再展开。
 * 它同时也是这一行「为什么长这样」的说明，所以与请求体那几栏同源、不需要另写一份。
 */
const describe = (row: RobotCallRow): string => {
	const where = `节点 ${String(row.nodeOrdinal)}（${row.stepPath}）`;
	const routing = `去向：${ROUTING_FACE[row.routing.where]} —— ${row.routing.note}`;
	if (row.kind === 'execute') return `${where}：${row.method} ${row.path} · ${routing}`;
	if (row.kind === 'wait') return `${where}：本地等 ${String(row.seconds)} 秒，不发请求 · ${routing}`;
	if (row.kind === 'branch') return `${where}：本地判断 ${row.conditionText}，不发请求 · ${routing}`;
	// 送不出去那一行两句话都给：诊断说这一步为什么发不了，note 说这个去向本身意味着什么
	// （原语那条 note 里写着「这不是我们还没做，是上游边界」——那句话正是这一屏要传达的）
	return `${where}：送不出去 · ${row.code} —— ${row.message} · ${routing}`;
};

/** `timeout_sec` 这一栏在不在：在，说明计划里写了；不在，说明按缺省算。轮询那行要说清是哪种。 */
const hasTimeout = (row: Extract<RobotCallRow, { kind: 'execute' }>): boolean =>
	row.body.some((field) => field.field === 'timeout_sec');
</script>

<template>
	<section class="robot-calls-panel" data-testid="robot-calls-panel">
		<header class="rc-header">
			<div class="rc-head-row">
				<IconBase name="device" :size="16" />
				<span class="rc-title">发给机器人</span>
				<span class="rc-tag" data-testid="robot-calls-target">{{ deviceRef }}</span>
				<!--
					汇总这一行走的是**编译结果的三个数**：请求看 `calls`、本地步看行、送不出去看诊断。
					没有可编的东西时这行不出现——摆一个 `0 条请求` 在那里，读起来像「编了，结果是零」。
				-->
				<span v-if="summary !== null" class="rc-summary" data-testid="robot-calls-summary">
					{{ summary.requests }} 条请求 · {{ summary.local }} 步在本地 ·
					{{ summary.blocked }} 步送不出去
				</span>
			</div>
		</header>

		<!-- 没有声明：说清先做什么，而不是摆一片空白 -->
		<div v-if="!doc.hasDeclaration.value" class="rc-empty" data-testid="robot-calls-empty">
			<p>还没有声明——先在上面写一句话生成任务（或直接粘贴一份计划），这里才有东西可编。</p>
		</div>

		<!-- 出生格式不是技能计划：**不硬套**，如实说这份声明不是这台设备产出的 -->
		<div v-else-if="blocked !== null && blocked.reason === 'format_mismatch'" class="rc-empty" data-testid="robot-calls-format">
			<p>
				这份声明的出生格式是「{{ bornFormatLabel }}」，不是技能计划——它不是这台设备产出的，
				编译不出请求。要发给机器人，先在入口带选一台说技能话的设备（SO-101 那两台），再生成一份计划。
			</p>
		</div>

		<!-- 格式对但计划过不了校验：诊断原样摆出来，一条请求都不编 -->
		<div v-else-if="blocked !== null" class="rc-empty" data-testid="robot-calls-invalid">
			<p>还原出来的计划过不了校验（{{ blocked.diagnostics.length }} 条诊断），没有请求可编：</p>
			<ul class="rc-diag-list">
				<li v-for="item in blocked.diagnostics" :key="`${item.code}@${item.path ?? ''}`">
					{{ item.code }}{{ item.path ? ` @ ${item.path}` : '' }} — {{ item.message }}
				</li>
			</ul>
		</div>

		<div v-else class="rc-body" data-testid="robot-calls-body">
			<!--
				零条请求也要说清为什么：整份计划都在本地做（等与判断），或者全卡在诊断上。
				这句话的来路是编译结果的三个数，不是面板自己猜的一个理由。
			-->
			<p v-if="emptyReason !== null" class="rc-nothing" data-testid="robot-calls-nothing">
				{{ emptyReason }}
			</p>

			<ol class="rc-rows" data-testid="robot-calls-rows">
				<li
					v-for="row in rows"
					:key="`${String(row.line)}-${row.stepPath}-${row.kind}`"
					class="rc-row"
					:class="`is-${row.kind}`"
					:data-testid="`robot-call-${row.kind}`"
					:data-kind="row.kind"
					:data-step-path="row.stepPath"
					:data-node-ordinal="row.nodeOrdinal"
					:data-where="row.routing.where"
					:data-depth="depthOf(row)"
					:style="{ '--rc-depth': depthOf(row) }"
					:title="describe(row)"
				>
					<div class="rc-row-head">
						<span class="rc-ln" aria-hidden="true">{{ row.line }}</span>
						<span class="rc-step">节点 {{ row.nodeOrdinal }}</span>
						<span class="rc-path">{{ row.stepPath }}</span>
						<span class="rc-badge" :class="`is-${row.routing.where}`">{{ badgeOf(row) }}</span>
					</div>

					<!-- execute：方法 + 路径 + 请求体，后面紧跟轮询那一行 -->
					<template v-if="row.kind === 'execute'">
						<div class="rc-request" data-testid="robot-call-execute-line">
							<span class="rc-method">{{ row.method }}</span>
							<code class="rc-target-path">{{ row.path }}</code>
						</div>
						<div class="rc-body-fields" data-testid="robot-call-body">
							<span
								v-for="field in row.body"
								:key="field.field"
								class="rc-field"
								:data-field="field.field"
							>
								{{ field.field }}={{ field.value }}
							</span>
						</div>
						<div class="rc-poll" data-testid="robot-call-poll">
							轮询 <code class="rc-target-path">GET {{ row.poll.path }}</code> —
							每 {{ row.poll.intervalMs }}ms 一次 · 截止 {{ row.poll.deadlineSec }}s（{{
								hasTimeout(row)
									? '计划里的 timeout_sec'
									: `计划的缺省 ${row.poll.defaultTimeoutSec}s`
							}} + {{ row.poll.marginSec }}s 余量）；成败只在这里读得到
						</div>
					</template>

					<!-- wait：本地等，明写不发请求 -->
					<p v-else-if="row.kind === 'wait'" class="rc-line" data-testid="robot-call-wait-line">
						本地等 {{ row.seconds }} 秒 —— <strong class="rc-no-request">不发请求</strong>
					</p>

					<!-- branch：本地判断，明写不发请求 -->
					<p v-else-if="row.kind === 'branch'" class="rc-line" data-testid="robot-call-branch-line">
						本地判断：{{ row.conditionText }} —— <strong class="rc-no-request">不发请求</strong>
					</p>

					<!-- 送不出去：诊断在它本来的位置上，危险色 -->
					<p v-else class="rc-line rc-blocked-line" data-testid="robot-call-blocked-line">
						<strong>送不出去</strong> · {{ row.code }} —— {{ row.message }}
					</p>
				</li>
			</ol>

			<!-- 摆不出位置的诊断不丢：它们不属于哪一步，但也是编译期说的问题 -->
			<div v-if="floatingDiagnostics.length > 0" class="rc-floating" data-testid="robot-calls-floating">
				<p>以下是编译期说的问题，它们不对应具体某一步：</p>
				<ul class="rc-diag-list">
					<li v-for="item in floatingDiagnostics" :key="item.code">
						{{ item.code }} — {{ item.message }}
					</li>
				</ul>
			</div>
		</div>

		<footer v-if="blockedRows.length > 0" class="rc-footer" data-testid="robot-calls-footer">
			{{ blockedRows.length }} 步在这个工作台里发不出去：执行侧（bridge / CLI）只有技能端点，没有原语通路。
		</footer>
	</section>
</template>

<style scoped>
.robot-calls-panel {
	display: flex;
	flex-direction: column;
	height: 100%;
	min-height: 0;
	background: var(--cc-surface);
}

.rc-header {
	display: flex;
	flex-direction: column;
	gap: var(--cc-space-1);
	flex: 0 0 auto;
	padding: var(--cc-space-3) var(--cc-space-4);
	border-bottom: 1px solid var(--cc-line);
}

.rc-head-row {
	display: flex;
	align-items: center;
	gap: var(--cc-space-2);
	flex-wrap: wrap;
	color: var(--cc-text-dim);
}

.rc-title {
	font-size: var(--cc-fs-md);
	font-weight: 600;
	color: var(--cc-text);
}

.rc-tag {
	padding: 2px var(--cc-space-2);
	font-family: var(--cc-font-mono);
	font-size: var(--cc-fs-xs);
	color: var(--cc-accent);
	background: var(--cc-accent-veil);
	border: 1px solid var(--cc-accent-dim);
	border-radius: var(--cc-radius-sm);
}

/*
 * 摘要那三个数是这一屏的第一句实话：它与标题、设备引用同一行。
 * 右栏只有 360px 上下，放不下时 `flex-wrap` 让它自己掉到下一行——不写死换行位置。
 */
.rc-summary {
	margin-left: auto;
	font-family: var(--cc-font-mono);
	font-size: var(--cc-fs-sm);
	color: var(--cc-text);
	white-space: nowrap;
}

.rc-empty {
	display: flex;
	flex-direction: column;
	gap: var(--cc-space-2);
	align-items: center;
	justify-content: center;
	flex: 1 1 auto;
	min-height: 0;
	padding: var(--cc-space-5);
	color: var(--cc-text-dim);
	text-align: center;
	overflow-y: auto;
}

.rc-empty p {
	max-width: 40ch;
	margin: 0;
	line-height: 1.7;
}

.rc-body {
	display: flex;
	flex-direction: column;
	gap: var(--cc-space-2);
	flex: 1 1 auto;
	min-height: 0;
	overflow-y: auto;
	padding: var(--cc-space-2) var(--cc-space-3);
}

.rc-nothing {
	margin: 0;
	padding: var(--cc-space-2);
	font-size: var(--cc-fs-xs);
	line-height: 1.6;
	color: var(--cc-text-dim);
	background: var(--cc-surface-sunken);
	border: 1px dashed var(--cc-line-strong);
	border-radius: var(--cc-radius-sm);
}

.rc-rows {
	display: flex;
	flex-direction: column;
	gap: var(--cc-space-2);
	margin: 0;
	padding: 0;
	list-style: none;
}

/*
 * 一行 = 计划里的一步。臂里的步靠 `--rc-depth` 缩进（与右栏步骤行同一套做法），
 * 于是「这一步在哪一层」不用读路径也看得出来。
 */
.rc-row {
	display: flex;
	flex-direction: column;
	gap: 3px;
	padding: var(--cc-space-2);
	margin-left: calc(var(--rc-depth, 0) * var(--cc-space-3));
	background: var(--cc-surface-sunken);
	border: 1px solid var(--cc-line);
	border-left: 3px solid var(--cc-line-strong);
	border-radius: var(--cc-radius-sm);
}

/* 发到 bridge 的那一步：左边一条强调色——「这一条真的会出去」 */
.rc-row.is-execute {
	border-left-color: var(--cc-accent);
}

/* 送不出去的那一步：整块染危险色。它在列表里**有位置**，只是发不出去 */
.rc-row.is-blocked {
	background: var(--cc-danger-veil);
	border-color: var(--cc-danger);
	border-left-color: var(--cc-danger);
}

.rc-row-head {
	display: flex;
	align-items: baseline;
	flex-wrap: wrap;
	gap: var(--cc-space-1) var(--cc-space-2);
	font-family: var(--cc-font-mono);
	font-size: var(--cc-fs-xs);
	color: var(--cc-text-dim);
}

.rc-ln {
	min-width: 2ch;
	text-align: right;
	color: var(--cc-text-faint);
}

.rc-step {
	color: var(--cc-text);
	font-weight: 600;
}

/* 路径是层级凭据（`2.then.0`），不是读数：压暗、跟在「第 N 步」后面 */
.rc-path {
	color: var(--cc-text-faint);
}

.rc-badge {
	margin-left: auto;
	padding: 1px var(--cc-space-1);
	border: 1px solid var(--cc-line-strong);
	border-radius: var(--cc-radius-sm);
	color: var(--cc-text-dim);
	white-space: nowrap;
}

.rc-badge.is-bridge {
	color: var(--cc-accent);
	border-color: var(--cc-accent-dim);
	background: var(--cc-accent-veil);
}

.rc-badge.is-nowhere {
	color: var(--cc-danger-strong);
	border-color: var(--cc-danger);
	background: var(--cc-danger-veil);
}

.rc-request {
	display: flex;
	align-items: baseline;
	gap: var(--cc-space-2);
	font-family: var(--cc-font-mono);
	font-size: var(--cc-fs-sm);
}

.rc-method {
	font-weight: 700;
	color: var(--cc-accent-strong);
}

.rc-target-path {
	color: var(--cc-text);
	overflow-wrap: anywhere;
}

.rc-body-fields {
	display: flex;
	flex-direction: column;
	gap: 1px;
	font-family: var(--cc-font-mono);
	font-size: var(--cc-fs-xs);
	color: var(--cc-text);
}

/* 请求体一行一栏：右栏窄，长值折行显示，不横向滚 */
.rc-field {
	overflow-wrap: anywhere;
}

.rc-poll {
	font-size: var(--cc-fs-xs);
	line-height: 1.5;
	color: var(--cc-text-dim);
	overflow-wrap: anywhere;
}

.rc-line {
	margin: 0;
	font-size: var(--cc-fs-sm);
	line-height: 1.5;
	color: var(--cc-text);
	overflow-wrap: anywhere;
}

/* 「不发请求」这四个字要跳出来：这一屏最容易被误读的地方就是它 */
.rc-no-request {
	color: var(--cc-text-dim);
	letter-spacing: 0.04em;
}

.rc-blocked-line {
	color: var(--cc-danger-strong);
}

/* 去向的说明不铺在行里（见 `describe`）：徽标说结论，note 在 `title` 里等人问 */

.rc-floating {
	display: flex;
	flex-direction: column;
	gap: var(--cc-space-1);
	padding: var(--cc-space-2);
	font-size: var(--cc-fs-xs);
	color: var(--cc-text-dim);
	background: var(--cc-surface-sunken);
	border: 1px dashed var(--cc-line-strong);
	border-radius: var(--cc-radius-sm);
}

.rc-floating p {
	margin: 0;
}

.rc-diag-list {
	margin: 0;
	padding-left: var(--cc-space-4);
	text-align: left;
	font-family: var(--cc-font-mono);
	font-size: var(--cc-fs-xs);
	line-height: 1.6;
}

.rc-footer {
	flex: 0 0 auto;
	padding: var(--cc-space-2) var(--cc-space-4);
	font-size: var(--cc-fs-xs);
	line-height: 1.5;
	color: var(--cc-text-dim);
	border-top: 1px solid var(--cc-line);
	background: var(--cc-surface);
}
</style>
