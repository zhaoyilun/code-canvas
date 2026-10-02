/**
 * RoboFrame 设备目录（SO-101 单臂）：**真实上游数据**，不是示意。
 *
 * 数据由 `tools/import-roboframe/import.mjs` 从上游仓库
 * `gitcode.com/openeuler/IB_Robot`（分支 `RoboFrame`）机械地转出来——技能、原语、
 * 实参、命名位姿全部照抄，`provenance` 里记着是哪一次 commit。
 * 这个文件只做一件事：**加载时拿契约过一遍**。上游改了、转换脚本漏了，都会在这里炸，
 * 而不是等到界面上渲染出半个目录。
 *
 * 与 `phase1-robot.ts` 的区别就在这儿：那一份的实现是示意（一期协议只规定「做什么」，
 * 没有「怎么做」的信息），这一份的实现是真的（`skill_templates` 的 `primitive_sequence`
 * 就是 RoboFrame 执行器会逐步下发的原子动作）。
 */
import { capabilityCatalogSchema, type CapabilityCatalog } from '@codecanvas/contracts';
import raw from './so101_single_arm.catalog.json';

/** 这份目录是从哪儿来的。界面要能如实说明，不然「真实数据」四个字就是空口白话。 */
export interface CatalogProvenance {
	readonly upstream: string;
	readonly branch: string;
	readonly commit: string;
	readonly robotConfig: string;
	readonly generatedBy: string;
}

export const ROBOFRAME_SO101_PROVENANCE: CatalogProvenance = raw.provenance;

/** 加载即校验：形状不合契约就当场抛，不把半个目录交给界面。 */
export const ROBOFRAME_SO101_CATALOG: CapabilityCatalog = capabilityCatalogSchema.parse(raw.catalog);
