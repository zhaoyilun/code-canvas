/**
 * 能力目录的实现侧：谁家的设备，谁提供一份 `CapabilityCatalog`。
 *
 * 形状定义在 `@codecanvas/contracts` 的 `capability.ts`；这里只放具体的目录。
 * 将来 RoboFrame 接入时，它的技能目录会作为另一个模块加进来，核心不用改。
 */
export { PHASE1_ROBOT_CATALOG } from './phase1-robot';
export { ROBOFRAME_SO101_CATALOG, ROBOFRAME_SO101_PROVENANCE, type CatalogProvenance } from './roboframe';
