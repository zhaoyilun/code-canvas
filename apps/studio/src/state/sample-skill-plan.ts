/**
 * 技能计划示例：`sample-task.ts` 的姊妹。**一台设备一份样例**，这里放技能计划格式那份。
 *
 * 为什么要两份：默认设备是 SO-101（说的是技能话），而一期那份 JSON 灌进技能计划格式里，
 * 第一秒就会被判不合法。样例是界面在没有输入时摆出来的**第一个东西**——一开机就红
 * 是最坏的示范，所以样例必须跟着当前设备说同一种话。
 *
 * 技能名和参数名都照 `ROBOFRAME_SO101_CATALOG` 里的原名写（上游 `robot_config` 的名字，
 * 不是这里自造的），形状与 `packages/contracts/src/skill-plan.ts` 的 `SkillPlan` 一致。
 */
export const SAMPLE_SKILL_PLAN_JSON = `{
  "schemaVersion": 1,
  "robot": "so101_single_arm",
  "description": "看一眼桌面，往前挪一点，打开夹爪",
  "plan": [
    { "step": "skill", "skill": "inspect_scene" },
    {
      "step": "skill",
      "skill": "move_relative_ee",
      "params": { "motion_direction": "forward", "motion_distance": 0.03 },
      "timeoutSec": 10
    },
    { "step": "skill", "skill": "open_gripper_skill" }
  ]
}
`;
