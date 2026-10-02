/**
 * 设备目录登记处 + 当前选中的那台设备。
 *
 * 入口带要回答的第一个问题是「给谁下指令」，所以它得知道**有哪些设备**；
 * 右栏的虚拟设备那块要知道**选的是哪一台**。两处问的是同一个数，所以只有一个地方存它。
 *
 * 目录本身由设备侧（插件）提供：形状定义在 `@codecanvas/contracts` 的 `capability.ts`，
 * 具体的目录在 `@codecanvas/capabilities` 里。一期只有一台设备——差速底盘 + 六轴臂——
 * 将来 RoboFrame 接入时把它的目录加进 `DEVICE_CATALOGS` 就行，这个文件不用改结构。
 *
 * 这里**不碰真相**：选中哪台设备不改变已导入的声明，它只影响「下一条指令发给谁」。
 * 所以它跟 `state/document.ts` 是两件事，不混进那份 store。
 */
import { computed, ref } from 'vue';
import { PHASE1_ROBOT_CATALOG } from '@codecanvas/capabilities';
import { findCapability, type CapabilityCatalog } from '@codecanvas/contracts';

/** 登记在册的设备目录。顺序就是下拉里的顺序，第一条是默认选中。 */
export const DEVICE_CATALOGS: readonly CapabilityCatalog[] = [PHASE1_ROBOT_CATALOG];

/** 按 `catalogRef` 查一台设备；不在册的就是 null（不认没登记的设备）。 */
export const findDeviceCatalog = (catalogRef: string): CapabilityCatalog | null =>
	DEVICE_CATALOGS.find((catalog) => catalog.catalogRef === catalogRef) ?? null;

const firstCatalog = DEVICE_CATALOGS[0];
/** 默认选中在册的第一台。目录空着时是空串——调用方要当「没有设备」处理，别当成一台叫空串的设备。 */
const DEFAULT_CATALOG_REF = firstCatalog === undefined ? '' : firstCatalog.catalogRef;

const activeCatalogRef = ref<string>(DEFAULT_CATALOG_REF);

const selectedCatalog = computed<CapabilityCatalog | null>(() => findDeviceCatalog(activeCatalogRef.value));

/** 换设备。不在册的直接忽略——不许选中一个查不到的目录（那会让生成请求带上假 ref）。 */
export function setSelectedCatalog(catalogRef: string): void {
	if (findDeviceCatalog(catalogRef) === null) return;
	activeCatalogRef.value = catalogRef;
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
	return DEVICE_CATALOGS.find((catalog) => findCapability(catalog, capabilityRef) !== undefined) ?? null;
};

export function useStudioDevices() {
	return {
		catalogs: DEVICE_CATALOGS,
		selectedCatalogRef: computed<string>(() => activeCatalogRef.value),
		selectedCatalog,
		setSelectedCatalog,
	};
}
