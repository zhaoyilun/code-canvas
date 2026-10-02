/**
 * 分支用例的素材：**真实目录里的技能**拼出来的技能计划（`ROBOFRAME_SO101_CATALOG`）。
 *
 * 为什么不用手写的假技能名：技能计划这一路的校验判据是目录（`validateSkillPlan` 认
 * `capabilityRef` 与它声明的参数），假名字过不了 `loadTaskJson`，也就测不到真正要测的东西。
 * 这里写成 `SkillPlan` 类型的对象再序列化：字段名与形状**由契约保证**，
 * 写错一个键在 typecheck 就炸，不会等到界面上才现形。
 *
 * 两份素材各管一件事：
 * - `BRANCH_PLAN_JSON`：两条臂 + `main[2]` 的后续（这一层 `if` 之后还有一步）；
 * - `NESTED_NO_ELSE_PLAN_JSON`：没有 `else` 的形态，且 then 臂里再嵌一层分支。
 */
import type { SkillPlan, SkillPlanStep } from '@codecanvas/contracts';

/** 素材里出现的技能名（全部是目录里的原名）。验收里拿来核对「没编技能」。 */
export const BRANCH_PLAN_SKILLS: readonly string[] = [
	'inspect_scene',
	'close_gripper_skill',
	'open_gripper_skill',
	'move_relative_ee',
	'rotate_gripper_cw',
	'dance_basic',
	'nod_yes',
	'shake_no',
	'celebrate',
];

const skill = (
	ref: string,
	params?: Readonly<Record<string, string | number>>,
	timeoutSec?: number,
): SkillPlanStep => ({
	step: 'skill',
	skill: ref,
	...(params === undefined ? {} : { params }),
	...(timeoutSec === undefined ? {} : { timeoutSec }),
});

/** 看一眼桌面 → 按「上一步成没成」分叉（成/没成各一步）→ 往前走一点。 */
const BRANCH_PLAN: SkillPlan = {
	schemaVersion: 1,
	robot: 'so101_single_arm',
	description: '夹爪分叉演示',
	plan: [
		skill('inspect_scene'),
		{
			step: 'if',
			condition: { field: 'last.success', op: '==', value: false },
			then: [skill('close_gripper_skill')],
			else: [skill('open_gripper_skill')],
		},
		skill('move_relative_ee', { motion_direction: 'forward', motion_distance: 0.03 }, 10),
	],
};

export const BRANCH_PLAN_JSON = JSON.stringify(BRANCH_PLAN, null, 2);

/** 跳个舞 → 分叉（**没有否则**），then 臂里再嵌一层分叉 → 庆祝。 */
const NESTED_NO_ELSE_PLAN: SkillPlan = {
	schemaVersion: 1,
	robot: 'so101_single_arm',
	description: '没有否则 + 嵌套分支',
	plan: [
		skill('dance_basic'),
		{
			step: 'if',
			condition: { field: 'last.success', op: '==', value: false },
			then: [
				skill('close_gripper_skill'),
				{
					step: 'if',
					condition: { field: 'last.success', op: '==', value: true },
					then: [skill('nod_yes')],
					else: [skill('shake_no')],
				},
			],
		},
		skill('celebrate'),
	],
};

export const NESTED_NO_ELSE_PLAN_JSON = JSON.stringify(NESTED_NO_ELSE_PLAN, null, 2);

/**
 * 臂里那一步带技能参数的素材：用来看「计划层的调用怎么写」——
 * `motion_distance` 这类是技能自己声明的参数，`timeoutSec` 是这一步的超时（不是技能参数）。
 */
const ARM_PARAMS_PLAN: SkillPlan = {
	schemaVersion: 1,
	robot: 'so101_single_arm',
	description: '臂里带参数的调用',
	plan: [
		{
			step: 'if',
			condition: { field: 'last.success', op: '==', value: false },
			then: [skill('move_relative_ee', { motion_direction: 'forward', motion_distance: 0.03 }, 10)],
			else: [skill('rotate_gripper_cw', { motion_distance: 90 })],
		},
	],
};

export const ARM_PARAMS_PLAN_JSON = JSON.stringify(ARM_PARAMS_PLAN, null, 2);
