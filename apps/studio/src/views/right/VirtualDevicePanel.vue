<script setup lang="ts">
/**
 * 右栏那一块：**当前选中的设备**（事实 + 3D 或占位）+ 三个按钮 + 步骤账本。
 *
 * ## 按钮上为什么不写「虚拟 / 真机 / 仿真」
 *
 * 因为**设备下拉已经把这件事定掉了**：选虚拟设备就是本机 3D（`@codecanvas/robot3d` 的执行器，
 * 一个网络请求都不发），选真机就是经 bridge 真下发（HTTP 到基地址，一个技能一条请求）。
 * 同一个「运行」跟着当前设备走——按钮上再写一遍「在虚拟设备上运行」，就是把设备下拉已经说过的
 * 那件事又说一遍；而两处说法一旦不同步，屏幕上就会自相矛盾（选着真机、按钮上写着「虚拟设备」）。
 * 所以按钮只有三个词：`运行` / `复位` / `单步运行`。
 *
 * ## 三个按钮各是什么
 *
 * - `运行`：整份计划一口气跑完——**运行是所有块**。
 * - `复位`：虚拟设备回零位（`rig.reset()`，与 3D 里那个姿态同一个来源）；真机那条路上本机
 *   没有可复位的东西，它停掉本机这一趟并清账本——**不替真机下发一个回零动作**：那是让真机
 *   动一下，不该由一个「复位」按钮偷偷做（真机回零位是它那一侧的事）。
 * - `单步运行`：一次走**一个顶层步**（流程画布上的一张卡，不是技能内部的一条原语）。
 *   没在跑时按它 = 开始一趟并走完第一步；已经在单步跑时按它 = 走下一步；跑完了回到初始语义。
 *   停住是**执行侧真的停住**：虚拟设备上第二步不下发、3D 不动；真机上第二个请求不发出去。
 *
 * ## 两条路（同一个按钮，两套执行）
 *
 * 虚拟设备：`@codecanvas/robot3d` 的 `run(plan)`（整趟）/ `beginStepRun(plan)` + `releaseStep()`
 * （单步），3D 就在下面那块画布里。真机：`runCompiledPlan`（`@codecanvas/robot-bridge`）
 * 把这份计划编成一列请求真发出去，单步用的是**同一个放行闸**（形状在 `@codecanvas/contracts`）——
 * 于是「按一次走一步」在两条路上是同一件事，不是两套语义。
 *
 * 3D 只在**虚拟设备**上有（真机连不上它，画一个「正在仿真」的画面就是编），
 * 所以真机那一档下面是一个占位说明；按钮与步骤账本两条路都有。
 *
 * ## 运行按钮做四件事，一步都不含糊
 * 1. **还原**：`findTaskFormat(declarationFormatRef).fromDeclaration(declaration)`——
 *    用这份声明**出生时**那把尺子，而不是当前选中设备的（同一份声明在两种格式下还原出来的原文完全不一样）；
 * 2. **拒接**：出生格式不是 `skill_plan` 就停下并说明——那种声明不是这台设备产出的，硬套等于拿它当别的东西用；
 * 3. **校验**：`validateSkillPlan(plan, { catalog })`，判据是**当前设备的目录**；不合法就把诊断原样显示，一步不跑；
 * 4. **执行**：只有合法才交给设备（虚拟走本机执行器，真机走 bridge），失败即停
 *    （重试与否由技能自己的 `recovery_policy` 决定）。
 *
 * 步骤行说的是**计划步**（技能步、分支步、等待步与原语步各一行），不是技能内部的**原语**：
 * 只有 `primitive` 步是**直接叫一个原语**的那一步，它的行写的是目录里那个原语的标签（「张开夹爪」）——
 * 分支步没有原语事件，而「走了哪条臂」只有计划步事件说得清；等待步同样没有原语事件
 * （它什么都没下发），「等了多久」也只有它自己那一行说得清；顺带也修掉了老毛病——
 * 一个技能里几条原语会把同一句「第 N 步」连写三遍。行里的缩进与 `path`（`2.then.0` 这种）
 * 说明它在计划的哪一格，`第 N 步` 说的仍是它所属的**顶层**步。
 *
 * 两条路的步骤行来自两处、画法是同一处（`writeRow`）：虚拟设备是执行侧的计划步事件
 * （`onPlanStep`），真机是 bridge 回来的 `PlanRunEvent`（带 `stepPath`，与计划树同一个口径）；
 * 于是「哪一行现在是什么状态」只有一份写法。
 *
 * 跑的时候三块视图一起走：**每一步先报 `running`**，那一条同时做两件事——
 * 把「设备正在这一步」写进 `shell/device-run.ts`（流程画布据此给那张卡一个运行标记），
 * 以及（跟随开着时）`select(那一步的节点)`，于是积木与代码面板跟着切到那一步的实现。
 * **不复位选中**：跑完停在哪一步就停在哪一步——用户跟到最后一步，正是为了看它。
 *
 * 3D 那部分的可视尺寸：由右栏宽度与这个面板的 flex 比例决定，
 * 全部走 `--cc-*` 变量（右栏栏宽是 `--cc-right-w`），组件里不写死像素。
 *
 * 3D 画布下面那一行是**本机布景**：待抓的方块摆在哪（x / y / z，米）+ 复位。
 * 为什么它是布景而不是任务参数：真机上目标物是相机看见的——`pick_object` 的 `target_name`
 * 是「红色方块」这种**视觉查询**（上游 `ibrobot_msgs` 的 `PickObject.action` 里那是运行时文本查询），
 * 不是我们给坐标。所以这三个数**不进声明、不进任务 JSON**，只改这一场仿真里那块方块的位置；
 * 面板上必须把这句话写在看得见的地方（不是塞进 `title`），否则人会以为它是任务的一部分。
 */
import { computed, onBeforeUnmount, onMounted, ref, shallowRef } from 'vue';
import {
	ROBOFRAME_GRASP_CATALOG,
	ROBOFRAME_GRASP_PROVENANCE,
	ROBOFRAME_SO101_CATALOG,
	ROBOFRAME_SO101_PROVENANCE,
} from '@codecanvas/capabilities';
import {
	createStepGate,
	validateSkillPlan,
	type CapabilityCatalog,
	type Diagnostic,
	type SkillPlan,
	type SkillPlanStep,
	type StepGate,
} from '@codecanvas/contracts';
import { compilePlanToCalls, runCompiledPlan, type CompiledPlan, type PlanRunEvent } from '@codecanvas/robot-bridge';
import {
	DEFAULT_TARGET_BLOCK,
	mountVirtualDevice,
	type BranchArm,
	type MountedVirtualDevice,
	type PlanStepReport,
} from '@codecanvas/robot3d';
import { findTaskFormat, type TaskFormatRef } from '@codecanvas/task-import';
import IconBase from '../../shell/IconBase.vue';
import { clearRunningPlanPath, setRunningPlanPath } from '../../shell/device-run';
import type { StudioDevice } from '../../shell/devices';
import { useStudioDocument } from '../../state/document';
import { nodeAtPlanPath, primitiveLabelOf, waitLabelOf } from '../shared/plan-structure';
import { DISPATCH_PATH_NOTE, readBridgeBaseUrl } from './robot-calls/plan-run';

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
	/** 这一步为什么是现在这个状态（只有需要解释的状态才有，例如本机演不了的委托）。 */
	readonly note?: string;
}

const stepLines = ref<StepRow[]>([]);
const runDiagnostics = ref<readonly Diagnostic[]>([]);
const status = ref('未运行');
/** 整趟跑（`运行`）正在跑吗。 */
const busy = ref(false);
/**
 * 这一趟是**单步**跑吗（还没跑完）。
 * 它决定「单步运行」那一按是「开始一趟」还是「走下一步」——跑完就回到初始语义。
 */
const stepping = ref(false);
/** 单步停住等放行了（执行侧推的）。界面据此说清「它停住了」，见 `onGate`。 */
const paused = ref(false);
/** 放行下一步的把手：两条路各有一个（虚拟设备上是设备里的闸，真机上是这一层建的那个闸）。 */
let releaseStep: (() => void) | null = null;
/**
 * 真机那条路的取消把手（虚拟设备那条路是 `device.cancel()`）。
 * 「复位」要能停掉正在跑的这一趟——停不下来就会有一个请求在设备那边跑着，而屏幕上写着「已复位」。
 */
let bridgeAbort: AbortController | null = null;
/**
 * 每一趟（整趟跑 / 单步跑 / 复位）各领一个号：只有**最新那一趟**能改状态语与运行标记。
 * 不领号的话，被复位取消掉的那一趟会在收尾时把「已复位」那句话覆盖成「计划中断」。
 */
let runSeq = 0;

/** bridge 的基地址：与「发给机器人」那块**同一个存储格**（联调时两个地方一起改）。每次要发的时候读一次。 */
const bridgeBaseUrl = (): string => readBridgeBaseUrl().trim();

/** 真机那条路的全句（挂在那一行的 `title` 上）：一个技能一条请求这件事具体长什么样。 */
const BRIDGE_PATH_NOTE =
	'选真机时按「运行」：这份计划被编成一列请求，真的 HTTP 发给 bridge 的基地址（请求一个字节都不改）——'
	+ '一个技能一条 POST，随后在客户端轮询它的 task 到终态；「单步运行」在每个顶层步之前等一次放行，'
	+ '停住时下一个请求一个字节都不发。地址与「发给机器人」那块共用同一格（联调时一起改）。';

/**
 * 本机布景：方块摆在哪儿（米，方块中心）。显示值就是**设备上那个值**（每次改动后从设备读回）——
 * 不另存一份「界面以为的位置」，否则屏幕上的数和 3D 里的方块早晚会不一致。
 *
 * 存的是**自己的拷贝、且不冻**：设备读回来的那份是冻结的（读到的值不该被外面改掉），
 * 拿它直接当界面状态，下一次改一个分量就会静默失败——输入框再也不动了。
 */
const targetBlock = ref<{ x: number; y: number; z: number }>({ ...DEFAULT_TARGET_BLOCK });
/** 上一次被拒的原因（本机布景没有范围限制，但非有限数会被拒；界面上得说清是哪一项）。 */
const targetError = ref<string | null>(null);

/** 复位：回到缺省那一处（与 `createStage` 建方块时那句同一个数，见 `DEFAULT_TARGET_BLOCK`）。 */
function resetTargetBlock(): void {
	targetBlock.value = { ...DEFAULT_TARGET_BLOCK };
	applyTargetBlock();
}

/**
 * 三个数**一个整体**生效：改一个就把当前这三个交给设备，不做「先应用一半」的中间态。
 *
 * 拒了就如实说出来并**把显示值写回设备上的那个值**：反了会留下一个屏幕上写着 0.4、
 * 3D 里其实是 0.12 的输入框——那正是这个面板最不该有的东西（读数与画面打架）。
 *
 * 「写回去」得**直接落到 DOM**，不能只靠 `:value` 重渲染：被拒之后的那个好值往往与拒之前
 * 的显示值一模一样（`targetBlock` 没变），Vue 于是合理地不重渲染，输入框里那个被拒的值
 * 会一直留在屏幕上——屏幕写 0.9、设备里是 0.12。所以这里连输入框一起接过来写。
 */
function applyTargetBlock(field?: HTMLInputElement, axis?: 'x' | 'y' | 'z'): void {
	const current = device3d.value;
	if (current === null) return;
	const position = { ...targetBlock.value };
	try {
		current.setTargetBlock(position);
		targetBlock.value = { ...current.targetBlock };
		targetError.value = null;
	} catch (error) {
		targetError.value = error instanceof Error ? error.message : String(error);
		targetBlock.value = { ...current.targetBlock };
		if (field !== undefined && axis !== undefined) field.value = String(targetBlock.value[axis]);
	}
}

/**
 * 输入框改一下：只认能读成有限数的写法（空串 / 半截数字都不是）。
 * 读不出来就原地退回上一个值——输入框里留一个「读不出来」的东西，等于把判断推给看的人。
 */
function onTargetInput(axis: 'x' | 'y' | 'z', event: Event): void {
	const field = event.target;
	if (!(field instanceof HTMLInputElement)) return;
	const value = Number(field.value.trim());
	if (field.value.trim() === '' || !Number.isFinite(value)) {
		field.value = String(targetBlock.value[axis]);
		return;
	}
	targetBlock.value = { ...targetBlock.value, [axis]: value };
	applyTargetBlock(field, axis);
}

/**
 * 跟随：跑到哪一步就选中那一步（默认开）。
 *
 * 关掉之后**只是没人替用户改选中**——事件照旧写步骤行、照旧有运行标记，
 * 用户自己的手点（流程画布、积木、步骤行）一个字都不受影响：
 * 这个开关管的是「自动」，不是「能不能选」。
 */
const follow = ref(true);

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

/**
 * 一步在界面上叫什么：技能步报技能名（那是设备那边真收到的调用），分支步说这是个判断，
 * 等待步说等了多久，原语步报**目录里那个原语的标签**（「张开夹爪」）。
 *
 * 两条路共用这一个（虚拟设备从事件里的 `step` 取，真机从计划树上取）：
 * 同一件事在两个地方各写一套叫法，屏幕上就会出现两种说法。
 */
function labelOfPlanStep(step: SkillPlanStep, catalog: CapabilityCatalog | null): string {
	if (step.step === 'if') return '分支';
	if (step.step === 'wait') return waitLabelOf(step.seconds);
	// 原语步没有技能名：显示的是**目录里那个原语的标签**，查不到就退回原语名——
	// 那是设备真收到的东西，不编一个中文名。
	if (step.step === 'primitive') return primitiveLabelOf(catalog, step.primitive);
	return step.skill;
}

/** 一条**计划步事件**（虚拟设备那条路）→ 一行。分支行说的是「走了哪条臂」，等待行说的是等了多久。 */
function rowOf(event: PlanStepReport): StepRow {
	return {
		path: event.path,
		index: event.index,
		label:
			event.step.step === 'if'
				? `分支 · ${armText(event.arm)}`
				: labelOfPlanStep(event.step, props.device?.catalog ?? null),
		depth: armDepth(event.path),
		state: event.state,
		...(event.detail === undefined ? {} : { note: event.detail }),
	};
}

/**
 * 写一行：**两条路共用这一处**（虚拟设备是执行侧的计划步事件，真机是 bridge 回来的事件）。
 *
 * `path` 相同就是同一行：起点与终点写同一格（换状态而不是添一行），
 * 于是臂一开始跑，那一行就在它自己的子步骤**上面**出现了。
 *
 * `running` 那一条同时管两件事：画布上的运行标记（写 `shell/device-run.ts`，与跟随无关——
 * 机器在哪儿就说哪儿），以及跟随（替用户改选中）。判据只有这一个分支，
 * 两处各写一遍早晚会有一处忘了更新。
 */
function writeRow(row: StepRow): void {
	const at = stepLines.value.findIndex((line) => line.path === row.path);
	stepLines.value = at < 0 ? [...stepLines.value, row] : stepLines.value.map((line, i) => (i === at ? row : line));

	if (row.state !== 'running') return;
	setRunningPlanPath(row.path);
	if (!follow.value) return;
	const node = nodeAtPlanPath(declaration.value, row.path);
	// 路径推不出节点（声明被改坏了）时不猜一个顶上：宁可这一格不亮。
	if (node !== null) doc.select(node.id);
}

/**
 * 计划树 → 每个 `stepPath` 上那一步。
 *
 * 为什么真机那条路需要它：bridge 的事件只带**路径**（`stepPath`，与执行侧、代码/积木两侧同一个口径），
 * 要让那一行写出「这一步是什么」就得先把计划按同一套路径摊开——顶层是 `'0'`，臂里是 `'0.then.1'`。
 * 路径的算法与执行侧逐字一致（顶层取下标、臂里接 `.then` / `.else` 再接下标），不另立一套。
 */
function indexPlanSteps(
	plan: SkillPlan,
): Map<string, { readonly step: SkillPlanStep; readonly index: number; readonly depth: number }> {
	const index = new Map<string, { step: SkillPlanStep; index: number; depth: number }>();
	const walk = (steps: readonly SkillPlanStep[], base: string, top: number, depth: number): void => {
		steps.forEach((step, at) => {
			const path = `${base}.${String(at)}`;
			index.set(path, { step, index: top, depth });
			if (step.step !== 'if') return;
			walk(step.then, `${path}.then`, top, depth + 1);
			walk(step.else ?? [], `${path}.else`, top, depth + 1);
		});
	};
	plan.plan.forEach((step, at) => {
		const path = String(at);
		index.set(path, { step, index: at + 1, depth: 0 });
		if (step.step !== 'if') return;
		walk(step.then, `${path}.then`, at + 1, 1);
		walk(step.else ?? [], `${path}.else`, at + 1, 1);
	});
	return index;
}

/**
 * bridge 的五档状态 → 面板上的状态。
 * `completed` 在界面上就是 `done`（与执行侧同一套观感）；`unreachable` 是「请求没发出去」，
 * 与执行侧那档同名不同源，所以**那句话分两条路说**（见 `outcomeLine`）。
 */
const BRIDGE_ROW_STATE: Readonly<Record<PlanRunEvent['state'], string>> = {
	running: 'running',
	completed: 'done',
	failed: 'failed',
	unreachable: 'unreachable',
	skipped: 'skipped',
};

/** bridge 的一条事件 → 一行。步是什么从计划树上取（查不到就退回路径本身——那也是一条真发生过的事件）。 */
function bridgeRowOf(
	event: PlanRunEvent,
	steps: ReadonlyMap<string, { readonly step: SkillPlanStep; readonly index: number; readonly depth: number }>,
): StepRow {
	const known = steps.get(event.stepPath);
	return {
		path: event.stepPath,
		index: known?.index ?? Number(event.stepPath.split('.')[0] ?? '0') + 1,
		label: known === undefined ? event.stepPath : labelOfPlanStep(known.step, props.device?.catalog ?? null),
		depth: known?.depth ?? armDepth(event.stepPath),
		state: BRIDGE_ROW_STATE[event.state],
		...(event.detail === undefined ? {} : { note: event.detail }),
	};
}

const isVirtual = computed(() => props.device?.virtual === true);
const declaration = computed(() => doc.declaration.value);

/**
 * 点步骤行 → 选中那一行对应的节点。
 *
 * 与跟随**同一个判据**（`nodeAtPlanPath`）：跑的时候跟到哪、跑完回头看哪一步，指的是同一棵树上的
 * 同一个位置——两处各写一份路径解析，早晚会有一处把臂里的步认成顶层的那一步。
 * 路径推不出节点（声明被改坏了）时什么都不做：宁可不亮，也不选一个编出来的位置。
 */
function selectRow(line: StepRow): void {
	const node = nodeAtPlanPath(declaration.value, line.path);
	if (node !== null) doc.select(node.id);
}

/** 仿真还是真机：设备表里写着的事实，界面上照实说，不靠设备名里的括号让人自己猜。 */
const deviceKind = computed(() => (props.device === null ? '' : props.device.virtual ? '仿真' : '真机'));

/**
 * 目录的出处**只在拿到真实上游数据时才说**（与右栏另一处同一口径）：
 * RoboFrame 那两份都是 `tools/import-roboframe/import.mjs` 从上游仓库机械转出来的，
 * `provenance` 里记着 commit；一期那份是示意，没有出处可报——编一个出处比不显示更坏。
 *
 * 按 `catalogRef` 查表而不是「是不是 SO-101」：两份真实目录各有各的出处，
 * 写死一份会让另一份显示**别人的** commit（同源同 commit 只是碰巧，不是保证）。
 */
const PROVENANCE_BY_CATALOG: Readonly<Record<string, typeof ROBOFRAME_SO101_PROVENANCE>> = {
	[ROBOFRAME_SO101_CATALOG.catalogRef]: ROBOFRAME_SO101_PROVENANCE,
	[ROBOFRAME_GRASP_CATALOG.catalogRef]: ROBOFRAME_GRASP_PROVENANCE,
};

const provenance = computed(() =>
	props.device === null ? null : (PROVENANCE_BY_CATALOG[props.device.catalog.catalogRef] ?? null),
);
const shortCommit = computed(() => (provenance.value === null ? '' : provenance.value.commit.slice(0, 8)));

/**
 * 按钮按不下去的**唯一原因**（为空＝可以按）。它是界面上那句说明的来源——
 * 禁用而不说为什么，就是让人对着一个灰按钮猜。
 *
 * 真机**不是**按不动的原因：同一个「运行」在真机上经 bridge 真下发（3D 有没有画面与能不能跑
 * 是两件事——真机没有画面，但它有去处）。所以这里只判「有没有设备、有没有声明、格式对不对」。
 */
const blockedReason = computed<string | null>(() => {
	if (props.device === null) return '没有选中设备。';
	if (declaration.value === null) return '还没有导入任何声明。';
	if (props.formatRef !== 'skill_plan') {
		const label = props.formatRef === null ? '（未知）' : findTaskFormat(props.formatRef).label;
		return `这份声明的出生格式是「${label}」，不是技能计划——它不是这台设备产出的，不硬套。`;
	}
	return null;
});

/**
 * `运行`（整趟）按不按得动：计划合法、而且没有另一趟在跑。
 * 单步跑着的时候不按得动——两套跑法不许叠在一起（叠起来那条步骤账就说不清是谁写的了）。
 */
const canRun = computed(() => blockedReason.value === null && !busy.value && !stepping.value);
/**
 * `单步运行`按不按得动：计划合法、而且**没有整趟在跑**。
 *
 * 单步跑着的时候它**按得动**——那一按就是「走下一步」。所以这里不能拿 `busy` 一起判：
 * 单步那一趟的账挂在 `stepping` 上（见 `stepRun`），`busy` 说的是整趟那一趟。
 */
const canStep = computed(() => blockedReason.value === null && !busy.value);

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

/** 这一趟的结局（两条路共有的那两栏）：成没成、停在哪。 */
interface RunReport {
	readonly ok: boolean;
	readonly reason?: string;
}

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** 「计划都没还原出来」那句话：诊断原样摆在屏幕上，**一步都不跑**。整趟跑与单步跑共用这一句。 */
function reportNothingRan(): void {
	status.value = runDiagnostics.value.some((item) => item.severity === 'error')
		? `这份计划没通过校验（${String(runDiagnostics.value.length)} 条诊断），一步没跑。`
		: '这份声明不是技能计划格式，没有可执行的计划。';
}

/**
 * 开一趟：上一趟留在画布上的运行标记不该跟过来，账本也从头记。
 * 返回这一趟的号——收尾时拿它对「还是不是我」（见 `runSeq`）。
 */
function openLedger(): number {
	stepLines.value = [];
	clearRunningPlanPath();
	runSeq += 1;
	return runSeq;
}

/** 起步那句话：虚拟设备说「执行中」；真机说「下发中」并把**发给谁**写出来（地址是这一趟的一部分）。 */
function startLine(plan: SkillPlan): string {
	return isVirtual.value
		? `执行中：${String(plan.plan.length)} 步`
		: `下发中：${String(plan.plan.length)} 步 → ${bridgeBaseUrl()}`;
}

/**
 * 跑完之后那句话：对着**屏幕上的那几行**说，不是对着计划长度说。
 *
 * 一条带 `onFailure: 'continue'` 的计划里，某一步失败了但计划照样往下走完；
 * 拿 `plan.plan.length` 报「N 步都走通了」，就会跟同一块面板上那行红色 failed 打架。
 * 所以失败数从**步骤行**里数——它就是屏幕上看得见的那份账，两个数不可能不一致。
 *
 * `unreachable` 那一档**两条路说的不是同一件事**，所以那句话分两条路说：虚拟设备上是
 * 「本机仿真演不了这一步」（实现在执行侧），真机上是「请求没发出去」（bridge 连不上 / 404）。
 * 拿一句话盖住两种事实，就会有一边的看的人去查一个并不存在的故障。
 */
function outcomeLine(result: RunReport, plan: SkillPlan): string {
	const failed = stepLines.value.filter((line) => line.state === 'failed').length;
	const unreachable = stepLines.value.filter((line) => line.state === 'unreachable').length;
	const unreachableFace = isVirtual.value ? '本机仿真演不了（实现在执行侧）' : '发不出去（请求没到设备）';
	const tail = unreachable === 0 ? '' : `另有 ${String(unreachable)} 步${unreachableFace}，`;
	if (result.ok) {
		if (failed === 0 && unreachable === 0) return `计划完成：${String(plan.plan.length)} 步都走通了。`;
		if (failed === 0) return `计划跑完了：${String(unreachable)} 步${unreachableFace}，其余走通。`;
		return `计划跑完了：有 ${String(failed)} 步失败（计划里标了失败也往下走），${tail}其余走通。`;
	}
	return `计划中断：${result.reason ?? '某一步没做成'}（失败即停，不自动重试）`;
}

/** 虚拟设备那条路：本机执行器（`@codecanvas/robot3d`），一个网络请求都不发。 */
async function runOnDevice(plan: SkillPlan): Promise<RunReport> {
	const target = device3d.value;
	// 换设备的那一瞬间 3D 会先卸掉：那时候按不了按钮（`canRun` 拦着），这里只是如实说一句
	if (target === null) return { ok: false, reason: '这台设备的 3D 还没挂上，这一趟没跑' };
	return target.run(plan);
}

/**
 * 真机那条路：`compilePlanToCalls` → `runCompiledPlan`（**真的 HTTP**，一个技能一条请求 + 轮询）。
 *
 * `gate` 给了就是单步（每走一个顶层步等一次放行），`null` 就是整趟跑完——
 * 与虚拟设备那边 `beginStepRun` / `run` 的分法完全对应，闸也是同一个形状（contracts 的 `StepGate`）。
 */
async function runOverBridge(plan: SkillPlan, gate: StepGate | null): Promise<RunReport> {
	const compiled: CompiledPlan = compilePlanToCalls(plan, {
		catalog: props.device?.catalog ?? ROBOFRAME_SO101_CATALOG,
		deviceRef: props.device?.deviceRef ?? 'unknown_device',
	});
	/*
	 * 编译期说的问题（`primitive` 步编不出请求那类）与计划层的诊断摆在一起：
	 * 它们是同一屏上的两类事实（计划过不过得了校验 / 有没有请求可编），都在这块面板上说，
	 * 否则「这一步没发出去」在屏幕上没有位置——看起来就像漏了一步。
	 */
	runDiagnostics.value = [...runDiagnostics.value, ...compiled.diagnostics];

	const steps = indexPlanSteps(plan);
	const controller = new AbortController();
	bridgeAbort = controller;
	try {
		return await runCompiledPlan(compiled, {
			baseUrl: bridgeBaseUrl(),
			signal: controller.signal,
			...(gate === null ? {} : { stepGate: gate }),
			onStep: (event) => {
				writeRow(bridgeRowOf(event, steps));
			},
		});
	} finally {
		if (bridgeAbort === controller) bridgeAbort = null;
	}
}

/** 整趟跑：**运行是所有块**——一口气把这份计划走完。 */
async function runPlan(): Promise<void> {
	if (busy.value || stepping.value) return;
	const plan = buildPlan();
	if (plan === null) {
		reportNothingRan();
		return;
	}
	const mine = openLedger();
	busy.value = true;
	status.value = startLine(plan);
	try {
		// 步骤行由两条路各自订的监听器写（最终都走 `writeRow`），这里不再照着结果重画一遍：
		// 两个来源写同一块地方，早晚会有一处忘了更新。
		const result = await (isVirtual.value ? runOnDevice(plan) : runOverBridge(plan, null));
		if (mine === runSeq) status.value = outcomeLine(result, plan);
	} catch (error) {
		// `run()` 的回绝（设备已卸载那种）在界面上要有一句人话，不许变成一个没人接的 rejection
		if (mine === runSeq) status.value = `这一趟没跑起来：${messageOf(error)}`;
	} finally {
		busy.value = false;
		/*
		 * 跑完就没有「正在跑的那一步」了，运行标记该灭。
		 *
		 * **但选中一动不动**：跑完停在最后一步，正是用户跟着看完的那一步——
		 * 在这里把它复位（清空、或跳回第一步），等于刚跑完就把人看的东西收走。
		 * 运行标记与选中因此是两件事，见 `shell/device-run.ts`。
		 */
		if (mine === runSeq) clearRunningPlanPath();
	}
}

/**
 * 单步停住 / 放开的那一刻（执行侧推的）：状态语跟着换。
 * 不通知的话，界面分不出它是「停住了」还是「还在动」——停在闸上时**没有任何别的事件**。
 */
function onGate(waiting: boolean): void {
	paused.value = waiting;
	if (!waiting) return;
	status.value = pausedLine();
}

/**
 * 停住时那句话：走到第几步、按哪儿继续。数的是**屏幕上那几行**里走完的顶层格
 * （不是计划长度，也不是另记一个数）：屏幕说几，这句话就说几。
 */
function pausedLine(): string {
	const done = stepLines.value.filter((line) => line.depth === 0 && line.state !== 'running').length;
	return `单步：第 ${String(done)} 步走完了，停住——按「单步运行」走下一步。`;
}

/**
 * 单步：这一按是「开始一趟」还是「走下一步」，只看**这一趟还在不在**。
 *
 * - 没在单步跑（也没在整趟跑）→ 开始一趟：还原、校验、走完**第一步**就停住；
 * - 已经在单步跑 → 放行下一步（上一步还在动时按的那几下也记着：按几次走几步，不丢按）；
 * - 跑完（或失败停下）→ 又回到第一种语义。
 *
 * 「停住」是**执行侧真的停住**：虚拟设备上下一步不下发、3D 不动（`beginStepRun` 那趟停在闸上）；
 * 真机上第二个请求不发出去（`runCompiledPlan` 在发之前等闸）。
 */
async function stepRun(): Promise<void> {
	if (busy.value) return;
	if (stepping.value) {
		releaseStep?.();
		return;
	}
	const plan = buildPlan();
	if (plan === null) {
		reportNothingRan();
		return;
	}
	const mine = openLedger();
	stepping.value = true;
	status.value = `单步执行中：共 ${String(plan.plan.length)} 步，走完一步就停住。`;
	try {
		if (isVirtual.value) {
			const target = device3d.value;
			if (target === null) {
				status.value = '这台设备的 3D 还没挂上，这一趟没跑';
				return;
			}
			// 放行下一步的把手就是设备上那个闸（`beginStepRun` 建的那一个）
			releaseStep = () => {
				target.releaseStep();
			};
			const result = await target.beginStepRun(plan);
			if (mine === runSeq) status.value = outcomeLine(result, plan);
			return;
		}
		// 真机：同一个形状的闸，建在这一层（bridge 那条路每趟一个）
		const gate = createStepGate(onGate);
		releaseStep = () => {
			gate.release();
		};
		const result = await runOverBridge(plan, gate);
		if (mine === runSeq) status.value = outcomeLine(result, plan);
	} catch (error) {
		if (mine === runSeq) status.value = `这一趟没跑起来：${messageOf(error)}`;
	} finally {
		// 这三栏是「这一趟」的状态，无条件收（它们说的是事实，不是谁写的那句话）
		stepping.value = false;
		paused.value = false;
		releaseStep = null;
		if (mine === runSeq) clearRunningPlanPath();
	}
}

function resetDevice(): void {
	/*
	 * 先停掉正在跑的那一趟（含停在放行闸上的单步）：不停，屏幕上就会写「已复位」而设备那边还在动。
	 * 两条路的停法各一个（本机执行器的 `cancel()` / bridge 那条路的 `AbortSignal`），
	 * 但都收在 `runSeq` 之下——被取消的那一趟收尾时不许再改状态语。
	 */
	if (stepping.value || busy.value) {
		if (isVirtual.value) device3d.value?.cancel();
		else bridgeAbort?.abort();
	}
	device3d.value?.reset();
	stepLines.value = [];
	runSeq += 1;
	// 复位之后没有「正在跑的那一步」了（选中照旧不动，见 `runPlan` 的收尾那段）。
	clearRunningPlanPath();
	status.value = isVirtual.value
		? '已复位到零位。'
		: '复位：停掉本机这一趟并清空本机账本。真机回零位是它那一侧的事——本机不替它下发一个动作。';
}

/**
 * 挂 3D。**只有**虚拟设备、且宿主真的在 DOM 里时才建——
 * 换设备重建时先把旧的 `dispose()` 掉，避免留下第二个 WebGL 上下文。
 *
 * 目录**跟着设备走**：执行器要拿它去查每个技能的实现。喂错一份，`pick_object`
 * 会变成「目录里没有这个技能」——而它其实在**另一份**目录里，
 * 于是面板上那句错话指向的是一次并不存在的缺失。
 */
function syncMount(): void {
	device3d.value?.dispose();
	device3d.value = null;
	stepLines.value = [];
	// 换了设备（或卸了）就没有正在跑的东西了：运行标记不许留在画布上。
	clearRunningPlanPath();
	if (!isVirtual.value) return;
	const element = host.value;
	const current = props.device;
	if (element === null || current === null) return;
	device3d.value = mountVirtualDevice(element, { catalog: current.catalog });
	/*
	 * 挂上就把显示着的那个位置交给新设备：换设备时设备是新建的（方块回到缺省），
	 * 而输入框里那三个数还在——不推一次，屏幕上写的位置与 3D 里那块就不一致了。
	 */
	applyTargetBlock();
	/*
	 * 每走一步在面板上留一行——**计划步**那种一步（技能步 / 分支步），不是技能内部的原语：
	 * 分支步没有原语事件，而「走了哪条臂」只有它说得清。
	 * `running` 也收：`path` 相同就是同一行，起点与终点写同一格（换状态而不是添一行），
	 * 于是臂一开始跑，那一行就在它自己的子步骤**上面**出现了。
	 * 画法只有一处（`writeRow`）：真机那条路的事件也走它。
	 */
	device3d.value.onPlanStep((event: PlanStepReport) => {
		writeRow(rowOf(event));
	});
	/*
	 * 单步：设备停住等放行的那一刻推一次（`true` = 刚停住）。
	 * 那一刻没有别的事件——不订它，界面就分不出「停住了」与「还在动」。
	 */
	device3d.value.onStepGate(onGate);
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
				但**按钮照旧有三个**（见下面那一行）：真机的「运行」经 bridge 真下发，
				所以这里没有画面不等于这台设备没事可做。
			-->
			<div v-if="isVirtual" ref="host" class="device-stage" data-testid="virtual-device-stage"></div>
			<p v-else class="device-absent" data-testid="virtual-device-absent">
				这台是真机：这里没有本机 3D 画面（本机连不上它，画出来的都是编的）。
				三个按钮照旧：「运行」经 bridge 真下发，一个技能一条 HTTP 请求。
			</p>

			<!--
				本机布景：待抓的方块摆在哪。**只有虚拟设备有这一行**（真机没有 3D，摆给谁看）。
				三个数一个整体生效；「本机布景」那句话与控件同一行、一眼看得见——
				它说的是这三个数**不是任务参数**，真机那边靠视觉找 `target_name`。
			-->
			<div v-if="isVirtual" class="device-scene" data-testid="virtual-device-scene">
				<span class="scene-scope" data-testid="virtual-device-scene-scope">本机布景</span>
				<label class="scene-field">
					<span class="scene-axis">x</span>
					<input
						type="text"
						inputmode="decimal"
						class="scene-input"
						data-testid="virtual-device-target-x"
						:value="targetBlock.x"
						aria-label="方块位置 x（米）"
						@input="onTargetInput('x', $event)"
					/>
				</label>
				<label class="scene-field">
					<span class="scene-axis">y</span>
					<input
						type="text"
						inputmode="decimal"
						class="scene-input"
						data-testid="virtual-device-target-y"
						:value="targetBlock.y"
						aria-label="方块位置 y（米）"
						@input="onTargetInput('y', $event)"
					/>
				</label>
				<label class="scene-field">
					<span class="scene-axis">z</span>
					<input
						type="text"
						inputmode="decimal"
						class="scene-input"
						data-testid="virtual-device-target-z"
						:value="targetBlock.z"
						aria-label="方块位置 z（米）"
						@input="onTargetInput('z', $event)"
					/>
				</label>
				<span class="scene-unit">m</span>
				<button
					type="button"
					class="scene-reset"
					data-testid="virtual-device-target-reset"
					@click="resetTargetBlock()"
				>
					复位
				</button>
				<!-- 每个字都得对得上事实：坐标是本机布景；真机那边 `pick_object` 找的是视觉查询里的那个名字。 -->
				<span class="scene-note" data-testid="virtual-device-scene-note">
					本机布景；真机那边靠视觉找 <code>target_name</code>，不是我们给坐标
				</span>
			</div>
			<p v-if="isVirtual && targetError !== null" class="scene-error" data-testid="virtual-device-target-error">
				{{ targetError }}
			</p>

			<!--
				三条按钮：`运行` / `复位` / `单步运行`。**真机与虚拟设备都有**——
				按钮上不写「虚拟 / 真机 / 仿真」：目标由**设备下拉**定死（选哪台就发给哪台），
				同一个「运行」跟着当前设备走（虚拟设备＝本机 3D，真机＝经 bridge 真下发）。
				状态/理由跟按钮同一行摆：它是动作的注解，单占一行只是白花 14px 的高度。
				`data-awaiting` 把「单步停住等放行」这件事也放在 DOM 上：状态语说的是同一件事。
			-->
			<div class="device-run" data-testid="virtual-device-run-row" :data-awaiting="paused ? 'true' : 'false'">
				<div class="device-run-buttons">
					<button
						type="button"
						class="cc-run"
						data-testid="virtual-device-run"
						:disabled="!canRun"
						@click="void runPlan()"
					>
						运行
					</button>
					<button
						type="button"
						class="cc-reset"
						data-testid="virtual-device-reset"
						@click="resetDevice()"
					>
						复位
					</button>
					<button
						type="button"
						class="cc-step"
						data-testid="virtual-device-step"
						:disabled="!canStep"
						@click="void stepRun()"
					>
						单步运行
					</button>
				</div>
				<!--
					跟随开关：开着时「跑到哪一步就选中那一步」。关掉只停掉**自动**那一半——
					用户手点卡片/步骤行照常改选中，运行标记也照常跟着设备走。
				-->
				<label class="device-follow" title="跑到哪一步就选中那一步（关掉后仍可自己点）">
					<input type="checkbox" data-testid="virtual-device-follow" v-model="follow" />
					跟随运行
				</label>
				<!-- 按不了就说清为什么：灰按钮自己不会解释。 -->
				<p v-if="blockedReason !== null" class="device-note" data-testid="virtual-device-blocked">
					{{ blockedReason }}
				</p>
				<p v-else class="device-note" data-testid="virtual-device-status">{{ status }}</p>
			</div>

			<!--
				这一句是**防误读**的，两条路各一句（都摆在看得见的地方，不塞进 `title`）：
				虚拟设备那条跑的是本机仿真（`@codecanvas/robot3d` 的执行器，一个网络请求都不发）；
				真机那条经 bridge 真下发（HTTP 到基地址，一个技能一条请求）。
				不写它，人会把「这里跑通了」当成另一件事。
			-->
			<p
				v-if="isVirtual"
				class="device-path-note"
				data-testid="virtual-device-path-note"
				:title="DISPATCH_PATH_NOTE"
			>
				本机仿真（我们的执行器），不发网络请求；选真机那台时「运行」才经 bridge 真下发
			</p>
			<p
				v-else
				class="device-path-note"
				data-testid="virtual-device-bridge-note"
				:title="BRIDGE_PATH_NOTE"
			>
				经 bridge 真下发（HTTP 到 {{ bridgeBaseUrl() }}）：一个技能一条请求，机器真的会动
			</p>

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
				**行可点**：点它 = 选中那一步的节点（与跟随同一个判据），
				于是跑完回头看某一步、或跟随关掉之后自己走一遍，都从这几行走。
			-->
			<ol v-if="stepLines.length > 0" class="device-steps" data-testid="virtual-device-steps">
				<li
					v-for="line in stepLines"
					:key="line.path"
					:data-state="line.state"
					:data-path="line.path"
					:data-depth="line.depth"
					:style="{ '--step-depth': line.depth }"
					role="button"
					tabindex="0"
					title="选中这一步（流程画布与代码面板都会切到它）"
					@click="selectRow(line)"
					@keydown.enter.prevent="selectRow(line)"
					@keydown.space.prevent="selectRow(line)"
				>
					<span v-if="line.depth > 0" class="step-path">{{ line.path }}</span>
					第 {{ line.index }} 步 · {{ line.label }} · {{ line.state }}
					<span v-if="line.note !== undefined" class="step-note">{{ line.note }}</span>
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
	/* 三条按钮 + 跟随开关 + 状态语挤在一行：窄栏下让状态语掉到下一行，而不是把按钮压扁 */
	flex-wrap: wrap;
}

/*
 * 本机布景那一行：3D 画布下面、运行按钮上面。**一行、紧凑**——它从 3D 画面里让高度，
 * 所以只占一行，三个数字框各 58px 宽。
 *
 * 「本机布景」这句话留在一眼看得见的地方（不是 `title`）：它说的是这一行的**身份**——
 * 摆的是这一场仿真的布景，不是任务参数；真机那边 `pick_object` 靠视觉查询找目标物。
 */
.device-scene {
	display: flex;
	align-items: center;
	gap: var(--cc-space-1);
	flex: 0 0 auto;
	flex-wrap: wrap;
	font-size: var(--cc-fs-xs);
}

/* 身份标签：本机布景 vs 任务参数是两件事，这一句先把它说清 */
.scene-scope {
	padding: 1px var(--cc-space-1);
	border: 1px solid var(--cc-line-strong);
	border-radius: var(--cc-radius-sm);
	color: var(--cc-text-dim);
	white-space: nowrap;
}

.scene-field {
	display: flex;
	align-items: center;
	gap: 2px;
	flex: 0 0 auto;
}

.scene-axis {
	color: var(--cc-accent);
	font-family: var(--cc-font-mono);
}

.scene-input {
	width: 58px;
	padding: 3px var(--cc-space-1);
	border: 1px solid var(--cc-line-strong);
	border-radius: var(--cc-radius-sm);
	background: var(--cc-surface-sunken);
	color: var(--cc-text);
	font: var(--cc-fs-xs) / 1.2 var(--cc-font-mono);
}

.scene-input:focus-visible {
	outline: 1px solid var(--cc-highlight);
	outline-offset: -1px;
}

/* 单位只说一次，跟在 z 后面：三个框都是米（与目录里的 workspace_limits 同一个坐标系） */
.scene-unit {
	color: var(--cc-text-faint);
}

.scene-reset {
	padding: 3px var(--cc-space-2);
	border: 1px solid var(--cc-line-strong);
	border-radius: var(--cc-radius-sm);
	background: var(--cc-surface-raised);
	color: var(--cc-text);
	font-size: var(--cc-fs-xs);
	cursor: pointer;
}

.scene-reset:hover {
	border-color: var(--cc-accent);
}

/* 那一句说明：跟在控件后面，压暗——它不是读数，是这个控件的注解 */
.scene-note {
	color: var(--cc-text-faint);
	line-height: 1.4;
}

.scene-note code {
	font-family: var(--cc-font-mono);
	color: var(--cc-text-dim);
}

/* 被拒的原因：红字一行，紧贴在那一行下面（说清是哪个数读不出来） */
.scene-error {
	margin: 0;
	flex: 0 0 auto;
	font-size: var(--cc-fs-xs);
	color: var(--cc-danger);
}

.device-run-buttons {
	display: flex;
	gap: var(--cc-space-2);
	flex: 0 0 auto;
}

.cc-run,
.cc-reset,
.cc-step {
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

.cc-reset,
.cc-step {
	flex: 0 0 auto;
}

/*
 * 单步是**第二条跑法**：与「运行」一样是实心可点的动作，但描边而不是实心——
 * 两个实心按钮并排会让人以为它们是一件事的两半（它们不是：一个跑完，一个走一步）。
 */
.cc-step {
	border-color: var(--cc-accent);
	color: var(--cc-accent-strong);
}

.cc-run:hover:not(:disabled),
.cc-reset:hover:not(:disabled),
.cc-step:hover:not(:disabled) {
	border-color: var(--cc-accent);
}

.cc-run:disabled,
.cc-step:disabled {
	background: var(--cc-disabled-surface);
	border-color: var(--cc-line);
	color: var(--cc-disabled-text);
	cursor: not-allowed;
}

/* 跟随开关：与按钮同一行、同一套字号——它跟按钮一样是「运行期间怎么表现」的一个选择。 */
.device-follow {
	display: flex;
	align-items: center;
	gap: 4px;
	flex: 0 0 auto;
	font-size: var(--cc-fs-xs);
	color: var(--cc-text-dim);
	cursor: pointer;
	white-space: nowrap;
}

.device-follow input {
	margin: 0;
	accent-color: var(--cc-accent);
	cursor: pointer;
}

.cc-run:hover:not(:disabled),
.cc-reset:hover:not(:disabled),
.cc-step:hover:not(:disabled) {
	border-color: var(--cc-accent);
}

.cc-run:disabled,
.cc-step:disabled {
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

/* 两条路那句：单占一行，虚线跟运行那一行分开——它不是控件，是一句要说清的话 */
.device-path-note {
	margin: 0;
	padding-top: var(--cc-space-1);
	flex: 0 0 auto;
	min-width: 0;
	font-size: var(--cc-fs-xs);
	line-height: 1.5;
	color: var(--cc-text-faint);
	border-top: 1px dashed var(--cc-line-strong);
}

.device-path-note strong {
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
	/* 行是可点的（选中那一步）：手型光标与 hover 是它「点得动」的唯一提示 */
	cursor: pointer;
	border-radius: var(--cc-radius-sm);
}

.device-steps li:hover,
.device-steps li:focus-visible {
	background: var(--cc-accent-veil);
	outline: none;
}

/* 正在跑的那一行也标一下：设备走到哪儿，面板上这几行里就亮哪一行 */
.device-steps li[data-state='running'] {
	color: var(--cc-accent-strong);
}

/* 路径是层级凭据（`2.then.0`），不是读数：压暗、跟在缩进后面，别抢「第 N 步」那句主语 */
.step-path {
	margin-right: var(--cc-space-1);
	color: var(--cc-text-faint);
}

.device-steps li[data-state='failed'] {
	color: var(--cc-danger);
}

/*
 * 本机仿真演不了的那一步：虚线框 + 压暗，与「失败」明确分开。
 *
 * 它既不红也不亮：红字说的是「这一步没做成」，而这一步**根本没演**——
 * 实现在执行侧，本机没有那套东西。把它画成失败，看的人会去查一个并不存在的故障。
 * （派发面板里「原语送不出去」用的是同一套说法：边界不是欠账。）
 */
.device-steps li[data-state='unreachable'] {
	/*
	 * `--cc-line-strong` 是主题里那条分隔线用的色。
	 * （这一行原来引的是 `--cc-border` —— 那个名字 `theme.css` 里**从来没有定义过**，
	 * 于是这个虚线框一直没画出来，只剩压暗的颜色在起作用。写样式时别引没定义的名字。）
	 */
	border: 1px dashed var(--cc-line-strong);
	color: var(--cc-text-dim);
}

/* 需要解释的状态那半句：跟在状态后面，小一号，不抢「第 N 步」那句主语 */
.step-note {
	margin-left: var(--cc-space-1);
	color: var(--cc-text-faint);
	font-size: var(--cc-fs-xs);
}
</style>
