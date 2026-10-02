<script setup lang="ts">
/**
 * 右栏的「虚拟设备」：**真的 3D 设备**（`@codecanvas/robot3d` 的执行器）+ 一份能读的事实 + 一个运行按钮。
 *
 * 为什么 3D 只挂在虚拟设备上：`device.virtual` 是设备表里写着的事实。真机那一台**没有** 3D——
 * 这台应用连不上它，画一个「正在仿真」的画面就是编。所以真机时不挂 3D、运行按钮也收起来，
 * 只把「3D 只在虚拟设备上有」这句话说出来。
 *
 * 运行按钮做四件事，一步都不含糊：
 * 1. **还原**：`findTaskFormat(declarationFormatRef).fromDeclaration(declaration)`——
 *    用这份声明**出生时**那把尺子，而不是当前选中设备的（同一份声明在两种格式下还原出来的原文完全不一样）；
 * 2. **拒接**：出生格式不是 `skill_plan` 就停下并说明——那种声明不是这台设备产出的，硬套等于拿它当别的东西用；
 * 3. **校验**：`validateSkillPlan(plan, { catalog })`，判据是**当前设备的目录**；不合法就把诊断原样显示，一步不跑；
 * 4. **执行**：只有合法才 `device.run(plan)`，失败即停（重试与否由技能自己的 `recovery_policy` 决定）。
 *
 * 步骤行说的是**计划步**（技能步、分支步与等待步各一行），不是技能内部的**原语**：
 * 分支步没有原语事件，而「走了哪条臂」只有计划步事件说得清；等待步同样没有原语事件
 * （它什么都没下发），「等了多久」也只有它自己那一行说得清；顺带也修掉了老毛病——
 * 一个技能里几条原语会把同一句「第 N 步」连写三遍。行里的缩进与 `path`（`2.then.0` 这种）
 * 说明它在计划的哪一格，`第 N 步` 说的仍是它所属的**顶层**步。
 *
 * 3D 那部分的可视尺寸：由右栏宽度与这个面板的 flex 比例决定，
 * 全部走 `--cc-*` 变量（右栏栏宽是 `--cc-right-w`），组件里不写死像素。
 */
import { computed, onBeforeUnmount, onMounted, ref, shallowRef } from 'vue';
import { ROBOFRAME_SO101_CATALOG, ROBOFRAME_SO101_PROVENANCE } from '@codecanvas/capabilities';
import { validateSkillPlan, type Diagnostic, type SkillPlan } from '@codecanvas/contracts';
import { mountVirtualDevice, type BranchArm, type MountedVirtualDevice, type PlanStepReport } from '@codecanvas/robot3d';
import { findTaskFormat, type TaskFormatRef } from '@codecanvas/task-import';
import IconBase from '../../shell/IconBase.vue';
import type { StudioDevice } from '../../shell/devices';
import { useStudioDocument } from '../../state/document';
import { waitLabelOf } from '../shared/plan-structure';

/** 目录出处按 `catalogRef` 认：认不着就不显示（编一个出处比不显示更坏） */
const SO101_CATALOG_REF = ROBOFRAME_SO101_CATALOG.catalogRef;

const props = defineProps<{
	device: StudioDevice | null;
	formatRef: TaskFormatRef | null;
}>();

const doc = useStudioDocument();

/** 3D 的宿主。只有虚拟设备会渲染它——真机那台下面是一个 `v-else` 的说明块。 */
const host = ref<HTMLElement | null>(null);
/** 卸载之后不该再有人碰它（重建时先 dispose 旧的） */
const device3d = shallowRef<MountedVirtualDevice | null>(null);

/**
 * 面板上的一行 = 计划里的一步（技能步或分支步）。
 * `path` 是它在计划树里的位置（`2.then.0`，与代码/积木两侧同一个口径），
 * 它同时决定缩进级数——所以行的键、层级、身份都是这一个字段说清的。
 */
interface StepRow {
	readonly path: string;
	/** 所属的顶层步（1 基）：臂里的步报的也是它，于是「第 N 步」这条主语仍然成立。 */
	readonly index: number;
	readonly label: string;
	readonly depth: number;
	readonly state: string;
}

const stepLines = ref<StepRow[]>([]);
const runDiagnostics = ref<readonly Diagnostic[]>([]);
const status = ref('未运行');
const busy = ref(false);

/** 分支走了哪条臂。`null` 是事实不是「不知道」：条件不成立又没给否则，这一步什么也不做。 */
function armText(arm: BranchArm): string {
	if (arm === 'then') return '走 then';
	if (arm === 'else') return '走 else';
	return '条件不成立，没有否则';
}

/** 路径里 `.then` / `.else` 的个数就是层级数（`'2'` 是顶层，`'2.then.0'` 在臂里第一层）。 */
function armDepth(path: string): number {
	return path.split('.').filter((segment) => segment === 'then' || segment === 'else').length;
}

/** 一条计划步事件 → 一行。分支行说的是「走了哪条臂」，等待行说的是等了多久，技能行就是那一步的技能名。 */
function rowOf(event: PlanStepReport): StepRow {
	return {
		path: event.path,
		index: event.index,
		label:
			event.step.step === 'if'
				? `分支 · ${armText(event.arm)}`
				: event.step.step === 'wait'
					? waitLabelOf(event.step.seconds)
					: event.step.skill,
		depth: armDepth(event.path),
		state: event.state,
	};
}

const isVirtual = computed(() => props.device?.virtual === true);
const declaration = computed(() => doc.declaration.value);

/** 仿真还是真机：设备表里写着的事实，界面上照实说，不靠设备名里的括号让人自己猜。 */
const deviceKind = computed(() => (props.device === null ? '' : props.device.virtual ? '仿真' : '真机'));

/**
 * 目录的出处**只在拿到真实上游数据时才说**（与右栏另一处同一口径）：
 * SO-101 那份是 `tools/import-roboframe/import.mjs` 从上游仓库机械转出来的，`provenance` 里记着 commit；
 * 一期那份是示意，没有出处可报——编一个出处比不显示更坏。
 */
const provenance = computed(() =>
	props.device?.catalog.catalogRef === SO101_CATALOG_REF ? ROBOFRAME_SO101_PROVENANCE : null,
);
const shortCommit = computed(() => (provenance.value === null ? '' : provenance.value.commit.slice(0, 8)));

/**
 * 按钮按不下去的**唯一原因**（为空＝可以按）。它是界面上那句说明的来源——
 * 禁用而不说为什么，就是让人对着一个灰按钮猜。
 */
const blockedReason = computed<string | null>(() => {
	if (props.device === null) return '没有选中设备。';
	if (!isVirtual.value) return '这台是真机：3D 与执行只在虚拟设备上有。';
	if (declaration.value === null) return '还没有导入任何声明。';
	if (props.formatRef !== 'skill_plan') {
		const label = props.formatRef === null ? '（未知）' : findTaskFormat(props.formatRef).label;
		return `这份声明的出生格式是「${label}」，不是技能计划——它不是这台设备产出的，不硬套。`;
	}
	return null;
});

const canRun = computed(() => blockedReason.value === null && !busy.value);

/** 声明 → 技能计划。出生格式不对时返回 null（不硬套）。 */
function buildPlan(): SkillPlan | null {
	const current = declaration.value;
	if (current === null || props.formatRef !== 'skill_plan') return null;
	const format = findTaskFormat(props.formatRef);
	const json = format.fromDeclaration(current);
	const result = validateSkillPlan(json, {
		catalog: props.device?.catalog ?? ROBOFRAME_SO101_CATALOG,
		...(props.device?.catalog.robotName === undefined ? {} : { expectedRobot: props.device.catalog.robotName }),
	});
	if (!result.ok) {
		// 诊断原样交给界面：契约负责判，这里只做转交
		runDiagnostics.value = result.diagnostics;
		return null;
	}
	runDiagnostics.value = result.diagnostics;
	return result.plan;
}

async function runPlan(): Promise<void> {
	const target = device3d.value;
	if (target === null) return;
	const plan = buildPlan();
	if (plan === null) {
		status.value = runDiagnostics.value.some((item) => item.severity === 'error')
			? `这份计划没通过校验（${String(runDiagnostics.value.length)} 条诊断），一步没跑。`
			: '这份声明不是技能计划格式，没有可执行的计划。';
		return;
	}
	stepLines.value = [];
	busy.value = true;
	status.value = `执行中：${String(plan.plan.length)} 步`;
	try {
		// 步骤行由挂载时订的那个监听器写（计划步事件一路推过来），这里不再照着结果重画一遍：
		// 两个来源写同一块地方，早晚会有一处忘了更新。
		const result = await target.run(plan);
		/*
		 * 「都走通了」这句话得对着**屏幕上的那几行**说，不能对着计划长度说。
		 *
		 * 一条带 `onFailure: 'continue'` 的计划里，某一步失败了但计划照样往下走完；
		 * 拿 `plan.plan.length` 报「N 步都走通了」，就会跟同一块面板上那行红色 failed 打架。
		 * 所以失败数从**步骤行**里数——它就是屏幕上看得见的那份账，两个数不可能不一致。
		 */
		const failed = stepLines.value.filter((line) => line.state === 'failed').length;
		status.value = result.ok
			? failed === 0
				? `计划完成：${String(plan.plan.length)} 步都走通了。`
				: `计划跑完了：有 ${String(failed)} 步失败（计划里标了失败也往下走），其余走通。`
			: `计划中断：${result.reason ?? '某一步没做成'}（失败即停，不自动重试）`;
	} finally {
		busy.value = false;
	}
}

function resetDevice(): void {
	device3d.value?.reset();
	stepLines.value = [];
	status.value = '已复位到零位。';
}

/**
 * 挂 3D。**只有**虚拟设备、且宿主真的在 DOM 里时才建——
 * 换设备重建时先把旧的 `dispose()` 掉，避免留下第二个 WebGL 上下文。
 */
function syncMount(): void {
	device3d.value?.dispose();
	device3d.value = null;
	stepLines.value = [];
	if (!isVirtual.value) return;
	const element = host.value;
	if (element === null) return;
	device3d.value = mountVirtualDevice(element);
	/*
	 * 每走一步在面板上留一行——**计划步**那种一步（技能步 / 分支步），不是技能内部的原语：
	 * 分支步没有原语事件，而「走了哪条臂」只有它说得清。
	 * `running` 也收：`path` 相同就是同一行，起点与终点写同一格（换状态而不是添一行），
	 * 于是臂一开始跑，那一行就在它自己的子步骤**上面**出现了。
	 */
	device3d.value.onPlanStep((event: PlanStepReport) => {
		const row = rowOf(event);
		const at = stepLines.value.findIndex((line) => line.path === row.path);
		stepLines.value = at < 0 ? [...stepLines.value, row] : stepLines.value.map((line, i) => (i === at ? row : line));
	});
}

// 挂载/卸载就挂在生命周期上，**不用 watch**：换设备时由父组件换掉这个组件的 `key`（见 RightPanel），
// 于是「旧的先 dispose、新的再 mount」是 Vue 自己保证的，不必在这里维护一份设备迁移逻辑。
// （`immediate` 的 watch 在这里是错的：它在 setup 阶段就跑，那时模板还没渲染、`host.value` 是 null，
//  挂不上而且不会再补一次——3D 会安静地不出现。）
onMounted(() => {
	syncMount();
});

onBeforeUnmount(() => {
	device3d.value?.dispose();
	device3d.value = null;
});
</script>

<template>
	<section class="device" data-testid="virtual-device">
		<header class="panel-header">
			<IconBase name="device" :size="20" />
			<span class="panel-title">虚拟设备</span>
		</header>

		<div class="device-body">
			<!--
				事实表：**两行**。这几行都是真的——设备在册、目录存在、入口带上选的就是它。
				为什么不是「一行一条」：右栏的每一像素都该给下面的 3D 画面（画面太小就是这次要修的事），
				而这些值都很短，两行排得下又一眼看得清。标签仍逐条写出来，不靠位置让人猜。
			-->
			<dl v-if="device !== null" class="device-facts" data-testid="virtual-device-facts">
				<div class="fact-row">
					<dt class="fact-name">当前设备</dt>
					<dd class="fact-value" data-testid="virtual-device-name">{{ device.label }}</dd>
				</div>
				<div class="fact-row">
					<dt class="fact-name">真机 / 仿真</dt>
					<dd class="fact-value" data-testid="virtual-device-sim">{{ deviceKind }}</dd>
				</div>
				<div class="fact-row fact-row-catalog">
					<dt class="fact-name">目录</dt>
					<dd class="fact-value fact-mono" data-testid="virtual-device-catalog-ref">
						{{ device.catalog.catalogRef }} · {{ device.catalog.revisionRef }}
					</dd>
				</div>
				<div class="fact-row">
					<dt class="fact-name">目录里的动作</dt>
					<dd class="fact-value fact-mono">
						{{ device.catalog.capabilities.length }} 个能力 · {{ device.catalog.primitives.length }} 个原语
					</dd>
				</div>
				<!-- 出处只在拿到真实上游数据时才有一行（一期那份是示意，没有出处可报）。 -->
				<div v-if="provenance !== null" class="fact-row fact-row-wide">
					<dt class="fact-name">出处</dt>
					<dd class="fact-value fact-mono fact-quiet" data-testid="virtual-device-provenance">
						上游 {{ provenance.branch }}@{{ shortCommit }}
					</dd>
				</div>
			</dl>

			<!--
				3D：**虚拟设备才有**。真机那一档不画任何东西——它连不上，画出来的都是编的。
			-->
			<div v-if="isVirtual" ref="host" class="device-stage" data-testid="virtual-device-stage"></div>
			<p v-else class="device-absent" data-testid="virtual-device-absent">
				这台是真机：3D 画面与执行能力只在虚拟设备上有。要在这里看机械臂动，把设备切到虚拟那台。
			</p>

			<!--
				运行按钮**只在虚拟设备上**：真机那台连不上，按了也没有去处。
				状态/理由跟按钮同一行摆：它是动作的注解，单占一行只是白花 14px 的高度——
				那 14px 给 3D 画面更值。
			-->
			<div v-if="isVirtual" class="device-run">
				<div class="device-run-buttons">
					<button
						type="button"
						class="cc-run"
						data-testid="virtual-device-run"
						:disabled="!canRun"
						@click="void runPlan()"
					>
						在虚拟设备上运行
					</button>
					<button
						type="button"
						class="cc-reset"
						data-testid="virtual-device-reset"
						@click="resetDevice()"
					>
						复位
					</button>
				</div>
				<!-- 按不了就说清为什么：灰按钮自己不会解释。 -->
				<p v-if="blockedReason !== null" class="device-note" data-testid="virtual-device-blocked">
					{{ blockedReason }}
				</p>
				<p v-else class="device-note" data-testid="virtual-device-status">{{ status }}</p>
			</div>
			<p v-else class="device-note" data-testid="virtual-device-blocked">{{ blockedReason }}</p>

			<!-- 校验诊断原样显示：哪个技能、哪个参数、哪条路径 -->
			<ul v-if="runDiagnostics.length > 0" class="device-diags" data-testid="virtual-device-diagnostics">
				<li v-for="item in runDiagnostics" :key="`${item.code}@${item.path ?? ''}`" :data-severity="item.severity">
					{{ item.severity === 'error' ? '✕' : '!' }} {{ item.code }}{{ item.path ? ` @ ${item.path}` : '' }} —
					{{ item.message }}
				</li>
			</ul>

			<!--
				每走一步一行：`第 N 步 · 技能名 / 分支 · 走哪条臂 · 结果`。
				臂里的步靠 `--step-depth` 缩进，行首那个 `2.then.0` 是它的路径（层级凭据）。
			-->
			<ol v-if="stepLines.length > 0" class="device-steps" data-testid="virtual-device-steps">
				<li
					v-for="line in stepLines"
					:key="line.path"
					:data-state="line.state"
					:data-path="line.path"
					:data-depth="line.depth"
					:style="{ '--step-depth': line.depth }"
				>
					<span v-if="line.depth > 0" class="step-path">{{ line.path }}</span>
					第 {{ line.index }} 步 · {{ line.label }} · {{ line.state }}
				</li>
			</ol>
		</div>
	</section>
</template>

<style scoped>
.device {
	display: flex;
	flex-direction: column;
	/*
	 * 虚拟设备占右栏的**大头**：8:3（去掉 tab 条后约七成）。
	 * 用户的话是「右边虚拟设备的位置有点太小了」，而 3D 画面是这块里最吃地方的东西。
	 * 用 flex 比例而不是 max-height 封顶：两块的分界稳定，内容多少都不改变比例。
	 */
	flex: 8 1 0;
	min-height: 0;
	border-bottom: 1px solid var(--cc-line);
}

.panel-header {
	display: flex;
	align-items: center;
	gap: var(--cc-space-2);
	flex: 0 0 auto;
	padding: var(--cc-space-2) var(--cc-space-4);
	color: var(--cc-text-dim);
	border-bottom: 1px solid var(--cc-line);
}

.panel-title {
	font-size: var(--cc-fs-md);
	font-weight: 600;
	color: var(--cc-text);
}

.device-body {
	display: flex;
	flex-direction: column;
	gap: var(--cc-space-1);
	flex: 1 1 auto;
	min-height: 0;
	padding: var(--cc-space-2) var(--cc-space-4);
	overflow-y: auto;
}

/* 出处跨两列：它是凭据，一行字，不该占半格去和读数挤 */
.fact-row-catalog {
	grid-column: span 2;
}

.fact-row-wide {
	grid-column: 1 / -1;
}

/*
 * 目录事实：**两列、每条一行高**的紧凑网格。
 *
 * 上一版是一列五行（每行「标签 …… 读数」分居两端），实测占掉 142px——那是右栏里
 * 除 3D 之外最贵的一块。5 条事实值都不长（设备名、真机/仿真、目录 ref、计数、出处），
 * 两列并排摆得下，还省掉一半的纵向开销。省下来的高度全给 3D 画面——
 * 画面太小正是这次要修的那件事。
 *
 * 标签压在值上面（各占一行），而不是左右分居：一格里只剩 ~180px，分居会把值挤成两行。
 */
.device-facts {
	display: grid;
	grid-template-columns: repeat(3, minmax(0, 1fr));
	gap: 2px var(--cc-space-1);
	margin: 0;
	flex: 0 0 auto;
}

.fact-row {
	display: flex;
	flex-direction: column;
	gap: 0;
	min-width: 0;
	padding: 0 var(--cc-space-2);
	background: var(--cc-surface-sunken);
	border: 1px solid var(--cc-line);
	border-radius: var(--cc-radius-sm);
}

.fact-name {
	font-size: 9px;
	line-height: 1.2;
	color: var(--cc-text-dim);
}

.fact-value {
	margin: 0;
	font: 10px / 1.2 var(--cc-font-mono);
	color: var(--cc-text);
	overflow-wrap: anywhere;
}

.fact-mono {
	font-family: var(--cc-font-mono);
	font-size: var(--cc-fs-xs);
	color: var(--cc-accent);
}

/* 出处是一行小字：它是凭据，不是读数 */
.fact-quiet {
	color: var(--cc-text-faint);
}

/*
 * 3D 那一块。它是这一栏里唯一会长大的东西（flex: 1），
 * 最小高度用视口高度表达，免得矮窗下被挤成一条缝——那正是用户抱怨的「太小」。
 */
.device-stage {
	flex: 1 1 auto;
	min-height: clamp(180px, 34vh, 520px);
	border: 1px solid var(--cc-line);
	border-radius: var(--cc-radius-sm);
	background: var(--cc-stage);
	overflow: hidden;
}

.device-absent {
	margin: 0;
	padding: var(--cc-space-3);
	flex: 1 1 auto;
	display: flex;
	align-items: center;
	font-size: var(--cc-fs-sm);
	color: var(--cc-text-faint);
	background: var(--cc-surface-sunken);
	border: 1px dashed var(--cc-line-strong);
	border-radius: var(--cc-radius-sm);
}

.device-run {
	display: flex;
	align-items: center;
	gap: var(--cc-space-2);
	flex: 0 0 auto;
}

.device-run-buttons {
	display: flex;
	gap: var(--cc-space-2);
	flex: 0 0 auto;
}

.cc-run,
.cc-reset {
	padding: 5px var(--cc-space-3);
	border-radius: var(--cc-radius-sm);
	border: 1px solid var(--cc-line-strong);
	background: var(--cc-surface-raised);
	color: var(--cc-text);
	font-size: var(--cc-fs-sm);
	font-weight: 600;
	cursor: pointer;
}

.cc-run {
	flex: 1 1 auto;
	background: var(--cc-accent);
	border-color: var(--cc-accent-strong);
	color: var(--cc-surface-sunken);
}

.cc-reset {
	flex: 0 0 auto;
}

.cc-run:hover:not(:disabled),
.cc-reset:hover:not(:disabled) {
	border-color: var(--cc-accent);
}

.cc-run:disabled {
	background: var(--cc-disabled-surface);
	border-color: var(--cc-line);
	color: var(--cc-disabled-text);
	cursor: not-allowed;
}

.device-note {
	margin: 0;
	flex: 1 1 auto;
	min-width: 0;
	font-size: var(--cc-fs-xs);
	color: var(--cc-text-dim);
}

.device-diags {
	margin: 0;
	padding-left: var(--cc-space-4);
	flex: 0 0 auto;
	max-height: 96px;
	overflow-y: auto;
	font: var(--cc-fs-xs) / 1.5 var(--cc-font-mono);
	color: var(--cc-text-dim);
}

.device-diags li[data-severity='error'] {
	color: var(--cc-danger);
}

/*
 * 步骤账本：这块本来就小（右栏最贵的地方是 3D），所以它自己的高度封在上限里、内部滚动——
 * 计划嵌套深了行会变多，长出去的是**这一块里面**，不是整个面板。
 */
.device-steps {
	margin: 0;
	padding-left: var(--cc-space-4);
	flex: 0 0 auto;
	max-height: 120px;
	overflow-y: auto;
	font: var(--cc-fs-xs) / 1.5 var(--cc-font-mono);
	color: var(--cc-text-dim);
}

/* 缩进按 `--step-depth`（路径里 `.then` / `.else` 的层数）算：臂里的步一眼看得出在第几层 */
.device-steps li {
	padding-left: calc(var(--step-depth, 0) * var(--cc-space-3));
}

/* 路径是层级凭据（`2.then.0`），不是读数：压暗、跟在缩进后面，别抢「第 N 步」那句主语 */
.step-path {
	margin-right: var(--cc-space-1);
	color: var(--cc-text-faint);
}

.device-steps li[data-state='failed'] {
	color: var(--cc-danger);
}
</style>
