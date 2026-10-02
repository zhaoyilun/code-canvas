/**
 * 任务 JSON → workflow 声明。**一台设备一套任务格式**，两条路汇进同一份声明：
 *
 * - `convert.ts`：一期协议的七种动作（那台差速底盘 + 六轴臂设备的词汇表）；
 * - `skill-plan.ts`：RoboFrame 的技能计划（技能名由设备目录给）。
 *
 * 校验分别在 `@codecanvas/contracts` 的 `validateTask` / `validateSkillPlan`，这里不重复判断。
 */
export * from './convert';
export * from './skill-plan';
export * from './format';
