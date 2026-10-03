/**
 * 设备登记处 + 当前选中的那台设备。
 *
 * 入口带要回答的第一个问题是「给谁下指令」，所以它得知道**有哪些设备**；
 * 右栏的虚拟设备那块要知道**选的是哪一台**。两处问的是同一个数，所以只有一个地方存它。
 *
 * 「设备」不是「目录」：目录说的是**会做什么**，设备说的是**往哪儿发**。
 * 同一份 SO-101 技能库既可以发给真机，也可以发给仿真——这正是 RoboFrame 自己的分法
 * （它的 launch 参数就分 `sim` / `hardware`）。所以一台设备 = 一份目录 + 一套任务格式 + 一个去处。
 *
 * 任务格式也是**设备属性**：一期设备听的是那七个固定动作，RoboFrame 的设备听的是一串技能调用。
 * 选哪台设备，入口就收哪种 JSON，写回时也拿对应那把尺子量（见 `@codecanvas/task-import` 的 `format.ts`）。
 *
 * 这里**不碰真相**：选中哪台设备不改变已导入的声明，它只影响「下一条指令发给谁」。
 * 所以它跟 `state/document.ts` 是两件事，不混进那份 store。
 */
import { computed, ref } from 'vue';
import { PHASE1_ROBOT_CATALOG, ROBOFRAME_GRASP_CATALOG, ROBOFRAME_SO101_CATALOG } from '@codecanvas/capabilities';
import { findCapability, type CapabilityCatalog } from '@codecanvas/contracts';
import type { TaskFormatRef } from '@codecanvas/task-import';

export interface StudioDevice {
	/** 稳定引用。请求里带的是它，日志与追溯也认它。 */
	readonly deviceRef: string;
	readonly label: string;
	/** 仿真（没有实机也能跑通整条链）。界面上要如实标出来。 */
	readonly virtual: boolean;
	readonly catalog: CapabilityCatalog;
	readonly formatRef: TaskFormatRef;
}

/** 登记在册的设备。顺序就是下拉里的顺序，第一条是默认选中。 */
/*
 * 顺序就是下拉里的顺序，**第一条是打开页面时选中的那台**。
 *
 * 虚拟设备排第一，不是因为它更重要，而是因为**打开页面就能把一件事看完**：
 * 写一句话、生成、看它动。真机排第二——它跑的是同一份技能库，差的只是"谁去下发原语"，
 * 而现在没有硬件可接，选它只能看到一份目录事实。把一台"看不出动静"的设备放在默认位置，
 * 演示的人第一眼就以为这东西还没做完。
 *
 * 两台机器各一对（虚拟 / 真机），因为它们跑的是**两份不同的目录**：
 * 单臂那份十六个技能全是动作，抓取那份多了一条抓取流水线（`pick_object` 的实现在执行侧）。
 * 把抓取那对排在后面，是因为它的技能更多、也更接近真活。
 */
export const DEVICES: readonly StudioDevice[] = [
	{
		deviceRef: 'so101_sim',
		label: '虚拟设备（SO-101 仿真）',
		virtual: true,
		// 同一份技能库：仿真与真机跑的是同一串技能调用，换的只是去处。
		catalog: ROBOFRAME_SO101_CATALOG,
		formatRef: 'skill_plan',
	},
	{
		deviceRef: 'so101_robot',
		label: 'SO-101 单臂（真机）',
		virtual: false,
		catalog: ROBOFRAME_SO101_CATALOG,
		formatRef: 'skill_plan',
	},
	{
		/*
		 * 第二份真实目录：同一台臂，腕上多了一个 RealSense，于是配置里多了一条**抓取流水线**
		 * （`grasp_execution.action_name` = `/manipulation/execute_pick`）。
		 *
		 * 它的七个技能里有一个 `pick_object`，实现在执行侧——转出来是一条 `delegate`。
		 * 所以这台设备是「同一套机制、一半能演一半不能演」的实证：
		 * 其余六个技能在本机 3D 上照跑，抓取那一步会如实报「本机仿真演不了」。
		 */
		deviceRef: 'so101_grasp_sim',
		label: '虚拟设备（SO-101 抓取仿真）',
		virtual: true,
		catalog: ROBOFRAME_GRASP_CATALOG,
		formatRef: 'skill_plan',
	},
	{
		deviceRef: 'so101_grasp_robot',
		label: 'SO-101 抓取（真机，腕装 RealSense）',
		virtual: false,
		catalog: ROBOFRAME_GRASP_CATALOG,
		formatRef: 'skill_plan',
	},
	{
		deviceRef: 'phase1_robot',
		label: '一期设备（差速底盘 + 六轴臂）',
		virtual: false,
		catalog: PHASE1_ROBOT_CATALOG,
		formatRef: 'phase1_task',
	},
];

/** 按 `deviceRef` 查一台设备；不在册的就是 null（不认没登记的设备）。 */
export const findDevice = (deviceRef: string): StudioDevice | null =>
	DEVICES.find((device) => device.deviceRef === deviceRef) ?? null;

const firstDevice = DEVICES[0];
/** 默认选中在册的第一台。设备表空着时是空串——调用方要当「没有设备」处理。 */
const DEFAULT_DEVICE_REF = firstDevice === undefined ? '' : firstDevice.deviceRef;

const selectedDeviceRef = ref<string>(DEFAULT_DEVICE_REF);

const selectedDevice = computed<StudioDevice | null>(() => findDevice(selectedDeviceRef.value));

/** 当前设备的目录。没有设备时是 null——调用方不许把它当成一份空目录。 */
const selectedCatalog = computed<CapabilityCatalog | null>(() => selectedDevice.value?.catalog ?? null);

/** 换设备。不在册的直接忽略——不许选中一个查不到的设备（那会让生成请求带上假 ref）。 */
export function setSelectedDevice(deviceRef: string): void {
	if (findDevice(deviceRef) === null) return;
	selectedDeviceRef.value = deviceRef;
}

/**
 * 声明里的一个能力属于哪份目录：先看选中的那台，再按登记顺序找。
 *
 * 需要它是因为「参数 → 实现里的哪一步」这条映射只能从**给出实现的目录**推。
 * 用户在生成之后换了设备时，声明还是上一台产出的，这时不该硬套新目录——
 * 找不到就照实返回 null，联动少一条而已，不编一条错的。
 */
export const findCatalogWithCapability = (
	capabilityRef: string,
	preferred: CapabilityCatalog | null,
): CapabilityCatalog | null => {
	if (preferred !== null && findCapability(preferred, capabilityRef) !== undefined) return preferred;
	return DEVICES.find((device) => findCapability(device.catalog, capabilityRef) !== undefined)?.catalog ?? null;
};

export function useStudioDevices() {
	return {
		devices: DEVICES,
		selectedDeviceRef: computed<string>(() => selectedDeviceRef.value),
		selectedDevice,
		selectedCatalog,
		setSelectedDevice,
	};
}
