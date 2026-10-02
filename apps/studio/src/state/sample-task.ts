/**
 * 示例任务：界面在没有输入时的默认内容，也用作三个视图的手工验证素材。
 *
 * 一期那份的形状与 docs/spec.md §1.1 一致；技能计划那份在 `sample-skill-plan.ts`。
 * 两份都摆在这里的映射表里，**由调用方按当前设备的格式挑**（`loadSampleTask`）——
 * 样例和任务格式一样是设备属性的从属物：设备说哪种话，样例就说哪种话。
 */
import type { TaskFormatRef } from '@codecanvas/task-import';
import { SAMPLE_SKILL_PLAN_JSON } from './sample-skill-plan';

export const SAMPLE_TASK_JSON = `{
  "schema_version": "1.0",
  "task_id": "task-demo-001",
  "description": "前进，遇障停止后转向",
  "steps": [
    { "id": "s1", "action": "move", "linear": 0.2, "angular": 0.0, "duration": 5.0 },
    { "id": "s2", "action": "stop_if_obstacle", "sensors": ["/scan0"], "distance": 0.5 },
    { "id": "s3", "action": "turn", "angular": 0.8, "duration": 2.0 },
    { "id": "s4", "action": "stop" }
  ],
  "limits": {
    "max_linear": 0.3,
    "max_angular": 1.2,
    "max_duration": 30.0,
    "require_confirmation": true
  }
}
`;

/**
 * 格式 → 样例。**缺哪个格式就缺着**：调用方（`loadSampleTask`）会照实说「这个格式还没有样例」，
 * 而不是随便塞一份别的格式的进去——那等于让第二道闸在一开机就报一条看不懂的错。
 */
export const SAMPLE_BY_FORMAT: Readonly<Partial<Record<TaskFormatRef, string>>> = {
	phase1_task: SAMPLE_TASK_JSON,
	skill_plan: SAMPLE_SKILL_PLAN_JSON,
};
