/**
 * RoboFrame 设备目录：**真实上游数据**，不是示意。
 *
 * 数据由 `tools/import-roboframe/import.mjs` 从上游仓库
 * `gitcode.com/openeuler/IB_Robot`（分支 `RoboFrame`）机械地转出来——技能、原语、
 * 实参、命名位姿全部照抄，`provenance` 里记着是哪一次 commit。
 * 这个文件只做一件事：**加载时拿契约过一遍**。上游改了、转换脚本漏了，都会在这里炸，
 * 而不是等到界面上渲染出半个目录。
 *
 * 现在有两台配置（同一份上游仓库、同一个 commit，所以两份 `provenance.commit` 必然相同）：
 * - `so101_single_arm` —— 单臂，16 个技能，实现全是 `primitive_sequence` 展开出来的原语调用；
 * - `so101_handeye_realsense_grasp` —— 腕装 RealSense 的抓取配置，7 个技能，
 *   其中 `pick_object` 的实现**不在模板里**：它是一条 `delegate`，指向执行侧的
 *   `/manipulation/execute_pick`（GraspGen 在运行时才生成候选，模板给不出步骤）。
 *
 * 与 `phase1-robot.ts` 的区别就在这儿：那一份的实现是示意（一期协议只规定「做什么」，
 * 没有「怎么做」的信息），这一份的实现是真的。
 */
import { capabilityCatalogSchema, type CapabilityCatalog } from '@codecanvas/contracts';
import graspRaw from './so101_handeye_realsense_grasp.catalog.json';
import singleArmRaw from './so101_single_arm.catalog.json';

/** 这份目录是从哪儿来的。界面要能如实说明，不然「真实数据」四个字就是空口白话。 */
export interface CatalogProvenance {
	readonly upstream: string;
	readonly branch: string;
	readonly commit: string;
	readonly robotConfig: string;
	readonly generatedBy: string;
}

/** 转换脚本落盘的形状：出处 + 待校验的目录。 */
interface CatalogFile {
	readonly provenance: CatalogProvenance;
	readonly catalog: unknown;
}

/** 加载即校验：形状不合契约就当场抛，不把半个目录交给界面。 */
const parseCatalog = (file: CatalogFile): CapabilityCatalog => capabilityCatalogSchema.parse(file.catalog);

export const ROBOFRAME_SO101_PROVENANCE: CatalogProvenance = singleArmRaw.provenance;
export const ROBOFRAME_SO101_CATALOG: CapabilityCatalog = parseCatalog(singleArmRaw);

export const ROBOFRAME_GRASP_PROVENANCE: CatalogProvenance = graspRaw.provenance;
export const ROBOFRAME_GRASP_CATALOG: CapabilityCatalog = parseCatalog(graspRaw);
