/**
 * Studio 的唯一真相：导入后的 workflow 声明，加上当前的选中项。
 *
 * 每个视图都从这里读；**只有积木画布可以写回**（docs/spec.md §4.1）。
 * 写回走 `applyDeclaration`，它连过两道闸才改真相：先结构、再任务协议语义。
 *
 * 两道闸里的**第二道**，尺子由「这份声明**出生时**那台设备的格式」决定，不是「现在选中的设备」：
 * 语言格式是设备属性（见 `@codecanvas/task-import` 的 `format.ts`），而用户完全可能在生成之后
 * 换台设备看看、再回来改一个数字。那时声明一个字节都没坏，变的只是尺子——拿新设备那把量，
 * 一份好好的技能计划会因为「一期协议里没有 inspect_scene 这个动作」而被拒，改个数字都不让。
 * 所以出生时那把尺子记在 `declarationFormatRef` 里，导入成功那一刻写下，之后写回只认它。
 *
 * 用模块级 ref 做单例——这个应用是单文档单窗口，不需要更重的东西。
 */
import { computed, ref, shallowRef } from 'vue';
import {
	computeWorkflowDigest,
	validateWorkflowDeclaration,
	type CapabilityCatalog,
	type Diagnostic,
	type WorkflowDeclaration,
	type WorkflowDeclarationDraft,
	type WorkflowNode,
} from '@codecanvas/contracts';
import { findTaskFormat, type TaskFormatRef } from '@codecanvas/task-import';
import { useStudioDevices } from '../shell/devices';
import { SAMPLE_BY_FORMAT } from './sample-task';

const declaration = shallowRef<WorkflowDeclaration | null>(null);
const diagnostics = ref<Diagnostic[]>([]);

/**
 * 当前这份声明是哪种格式产出的（「出生时的尺子」）。
 *
 * 只有导入那一步写它：`loadTaskJson` 成功时记下当时那台设备的格式。
 * `null` = 还没导入过任何东西（这个窗口一开机就是 `loadSampleTask`，所以正常路径上它很快就有值）。
 */
const declarationFormatRef = shallowRef<TaskFormatRef | null>(null);

/**
 * 当前这份声明出生时用的那份**目录**。
 *
 * 为什么格式之外还要记目录：**格式认不出目录**（两台 RoboFrame 设备都是 `skill_plan`，
 * 目录却不同）。只记格式的话，第二道闸与三个视图会去登记表里「按格式挑第一条」，
 * 那台恰好是单臂——抓取那份声明于是被拿到别人的目录里查，「查不到 pick_object」
 * 这种错话就出来了。见 `activeCatalog`。
 */
const declarationCatalogRef = shallowRef<CapabilityCatalog | null>(null);

/** 选中项：节点与积木是一对，映射表负责把一侧推成另一侧（M3）。 */
const selectedNodeId = ref<string | null>(null);
const selectedBlockId = ref<string | null>(null);

const devices = useStudioDevices();

/** 没有设备就没有「往哪儿发」，也就没有格式与目录——读和写都只能说不知道。 */
const DEVICE_MISSING_CODE = 'document.device.missing';
const deviceMissingDiagnostic = (): Diagnostic => ({
	code: DEVICE_MISSING_CODE,
	severity: 'error',
	message: '没有选中设备：拿不到任务格式与目录',
});

/**
 * 第二道闸拿哪份**目录**：声明出生时那台设备的。
 *
 * 为什么不能只按格式挑一份：判据（技能名、参数名、类型）全在目录里，而目录是设备属性
 * ——同一份技能计划换到一台目录不同的设备上，参数名一个都对不上。尺子和尺子上的刻度必须来自
 * 同一台设备，否则「按出生时的格式量」只做了一半。
 *
 * **格式认不出目录**：这一版之前这里按 `formatRef` 在登记表里取第一条，理由写的是
 * 「同一格式的设备共用一份技能库」。那句话在只有一个 RoboFrame 设备时碰巧成立，
 * 加了抓取那台之后就不成立了——两台都是 `skill_plan`，目录却不同（抓取那份多一条
 * `pick_object` 的委托）。按格式取第一条，会把抓取那份声明拿去单臂的目录里查，
 * 于是 `pick_object` 变成「目录里没有这个技能」：一句指向并不存在的缺失的错话。
 * 所以目录**跟着声明走**（`declarationCatalogRef`，与格式同一个来源、同一个写入点）。
 */

/** 载入任务 JSON。成功才换真相；失败只留诊断，界面保持原样。 */
function loadTaskJson(text: string): boolean {
	const device = devices.selectedDevice.value;
	if (device === null) {
		diagnostics.value = [deviceMissingDiagnostic()];
		return false;
	}

	const result = findTaskFormat(device.formatRef).parse(text, { catalog: device.catalog });
	diagnostics.value = [...result.diagnostics];
	if (!result.ok) return false;

	declaration.value = result.declaration;
	// 「出生时的尺子」在这一刻定下来：写回的第二道闸只认它（见文件头）。
	// 格式与目录一起记：格式说「用哪把尺子」，目录说「尺子上的刻度是什么」，两者缺一不可。
	declarationFormatRef.value = device.formatRef;
	declarationCatalogRef.value = device.catalog;
	selectedNodeId.value = null;
	selectedBlockId.value = null;
	return true;
}

/**
 * 积木写回的入口。**这是唯一能改真相的通道。**
 * 任何一道闸不过，就只留诊断、真相不动——非法状态不许进系统。
 */
function applyDeclaration(next: WorkflowDeclaration): boolean {
	// 调用方只管改内容，摘要这里替它重算——否则每个调用方都得记得这一手，
	// 迟早有人忘，然后被第一道闸拒得莫名其妙。
	const sealed: WorkflowDeclarationDraft = { ...next, digest: computeWorkflowDigest(next) };

	const structural = validateWorkflowDeclaration(sealed);
	if (!structural.ok) {
		diagnostics.value = [...structural.diagnostics];
		return false;
	}

	/*
	 * 第二道闸：任务语义。
	 *
	 * 声明层的 schema **故意不解释 `parameters`**（spec §1.2 把它定为不透明载荷），
	 * 所以「越界参数」在结构那一层根本拦不住——`distance = 0`、`joint_id = 9`、
	 * `action = 'fly'`、技能名写错，全都会被结构校验放行。写回通道必须自己再走一趟任务层，
	 * 否则改坏的积木会静默进真相。
	 *
	 * 拿哪把尺子：出生时那把（`declarationFormatRef`），没导入过就退到当前设备——
	 * 总得有一把，而没导入过时「当前设备」就是唯一说得通的那把。
	 */
	const formatRef = activeFormatRef.value;
	const catalog = activeCatalog.value;
	if (formatRef === null || catalog === null) {
		diagnostics.value = [deviceMissingDiagnostic()];
		return false;
	}

	const semantic = findTaskFormat(formatRef).validateDeclaration(structural.declaration, { catalog });
	if (!semantic.ok) {
		diagnostics.value = [...semantic.diagnostics];
		return false;
	}

	diagnostics.value = [...structural.diagnostics];
	declaration.value = structural.declaration;
	return true;
}

/**
 * 选中实现里的第几步（语句树的下标，0 基）。
 *
 * 它必须跟节点一起变：跨模块谈「第 3 步」没有意义，所以换节点时清空。
 * 代码行与积木块都靠它对齐——「点代码某行 → 高亮积木那一步」就是这条。
 */
const selectedStepIndex = ref<number | null>(null);

function select(nodeId: string | null, blockId: string | null = null): void {
	// 取消选中（nodeId 为 null）也要清步选中：否则会出现「没有任何节点被选中，
	// 但某一步还亮着」这种自相矛盾的状态——守卫只比较 nodeId 变没变是拦不住它的。
	if (nodeId === null || selectedNodeId.value !== nodeId) selectedStepIndex.value = null;
	selectedNodeId.value = nodeId;
	selectedBlockId.value = blockId;
}

function selectStep(index: number | null): void {
	selectedStepIndex.value = index;
}

/**
 * 现在该拿哪把尺子：出生格式优先，没导入过就退到当前设备。
 *
 * 两个地方要它，问的是同一个数：写回的第二道闸（校验）与三个视图（渲染）。
 * 分流出去只会分叉——渲染用一份目录、校验用另一份，界面显示的实现和真正被承认的实现就不是同一个了。
 */
const activeFormatRef = computed<TaskFormatRef | null>(
	() => declarationFormatRef.value ?? devices.selectedDevice.value?.formatRef ?? null,
);

const activeCatalog = computed<CapabilityCatalog | null>(() => {
	if (declaration.value !== null) return declarationCatalogRef.value;
	return devices.selectedCatalog.value;
});

export function useStudioDocument() {
	return {
		declaration,
		diagnostics,
		/** 只读：它是「这份声明的出生格式」，只有 `loadTaskJson` 那一步能改。 */
		declarationFormatRef: computed<TaskFormatRef | null>(() => declarationFormatRef.value),
		/**
		 * 当前这份声明该用哪份目录渲染/校验。来自设备，**不是常量**——
		 * 视图里再写死一份 `PHASE1_ROBOT_CATALOG` 就会在换设备之后指向另一份目录，
		 * 于是「查不到能力」这种错看起来像目录缺了东西，其实是视图拿错了尺子。
		 */
		declarationCatalog: activeCatalog,
		selectedNodeId,
		selectedBlockId,
		selectedStepIndex,
		nodes: computed<readonly WorkflowNode[]>(() => declaration.value?.nodes ?? []),
		selectedNode: computed<WorkflowNode | null>(() => {
			const id = selectedNodeId.value;
			if (id === null) return null;
			return declaration.value?.nodes.find((node) => node.id === id) ?? null;
		}),
		hasDeclaration: computed(() => declaration.value !== null),
		loadTaskJson,
		applyDeclaration,
		select,
		selectStep,
	};
}

/**
 * 首次挂载时灌入示例任务，让三个视图有东西可显示。**样例跟当前设备的格式走**：
 * 给技能计划格式灌一期那份，等于一开机就摆一份第二道闸判为不合法的东西。
 *
 * 这个格式还没有样例时什么都不灌，只出一条诊断——宁可空着，也不塞一份形状不对的。
 */
export function loadSampleTask(): boolean {
	const device = devices.selectedDevice.value;
	if (device === null) {
		diagnostics.value = [deviceMissingDiagnostic()];
		return false;
	}

	const sample = SAMPLE_BY_FORMAT[device.formatRef];
	if (sample === undefined) {
		const format = findTaskFormat(device.formatRef);
		diagnostics.value = [
			{
				code: 'document.sample.missing',
				severity: 'error',
				message: `「${device.label}」用的${format.label}还没有示例任务`,
				details: { deviceRef: device.deviceRef, formatRef: device.formatRef },
			},
		];
		return false;
	}

	return loadTaskJson(sample);
}
