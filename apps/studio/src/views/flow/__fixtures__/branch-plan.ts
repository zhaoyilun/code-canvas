/**
 * 分支用例的素材：**真实目录里的技能**拼出来的技能计划（`ROBOFRAME_SO101_CATALOG`）。
 *
 * 为什么不用手写的假技能名：技能计划这一路的校验判据是目录（`validateSkillPlan` 认
 * `capabilityRef` 与它声明的参数），假名字过不了 `loadTaskJson`，也就测不到真正要测的东西。
 * 这里写成 `SkillPlan` 类型的对象再序列化：字段名与形状**由契约保证**，
 * 写错一个键在 typecheck 就炸，不会等到界面上才现形。
 *
 * 素材各管一件事：
 * - `BRANCH_PLAN_JSON`：两条臂 + `main[2]` 的后续（这一层 `if` 之后还有一步）；
 * - `NESTED_NO_ELSE_PLAN_JSON`：没有 `else` 的形态，且 then 臂里再嵌一层分支；
 * - `MIXED_STEPS_PLAN_JSON`：**四类步混排**（技能 / 原语 / 等待 / 分支），原语步的判据也是目录
 *   （`catalog.primitives`），所以原语名同样照真实目录写。
 */
import type { JsonObject, SkillPlan, SkillPlanStep } from '@codecanvas/contracts';

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
	onFailure?: 'stop' | 'continue',
): SkillPlanStep => ({
	step: 'skill',
	skill: ref,
	...(params === undefined ? {} : { params }),
	...(timeoutSec === undefined ? {} : { timeoutSec }),
	...(onFailure === undefined ? {} : { onFailure }),
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

/**
 * 带等待的素材：**没有分支**——「夹住 → 等它稳定两秒 → 再移动」。
 *
 * 这是等待步最典型的用法（技能自己带的时长管不了两步之间的间隔），
 * 也是「选中等待卡时看什么」的素材：流程卡上是「等待 2 秒」，计划层代码里是 `wait(2.0)`。
 */
const WAIT_PLAN: SkillPlan = {
	schemaVersion: 1,
	robot: 'so101_single_arm',
	description: '夹住，等两秒再走',
	plan: [
		skill('close_gripper_skill'),
		{ step: 'wait', seconds: 2 },
		skill('move_relative_ee', { motion_direction: 'forward', motion_distance: 0.05 }),
	],
};

export const WAIT_PLAN_JSON = JSON.stringify(WAIT_PLAN, null, 2);

/** 分支的两臂里各放一步等待：看「臂里的等待」在计划层代码/积木里怎么写（跟着臂缩进）。 */
const BRANCH_WAIT_PLAN: SkillPlan = {
	schemaVersion: 1,
	robot: 'so101_single_arm',
	description: '两臂里各等一拍',
	plan: [
		{
			step: 'if',
			condition: { field: 'last.success', op: '==', value: false },
			then: [skill('close_gripper_skill'), { step: 'wait', seconds: 2 }],
			else: [{ step: 'wait', seconds: 0.5 }],
		},
	],
};

export const BRANCH_WAIT_PLAN_JSON = JSON.stringify(BRANCH_WAIT_PLAN, null, 2);

/**
 * 失败处置的素材：挪一点（**可能不成，但失败也往下走**）→ 按「上一步成没成」补救 → 打个招呼。
 *
 * 三张卡的处置各不相同，正好量「哪张卡该标那句话」：带 `continue` 的标，缺省（停）的不标，
 * 显式写 `'stop'` 的也不标（它就是缺省，标出来是在每一张卡上重复默认行为）。
 */
const CONTINUE_ON_FAILURE_PLAN: SkillPlan = {
	schemaVersion: 1,
	robot: 'so101_single_arm',
	description: '挪一点，没成就回原位，最后打个招呼',
	plan: [
		skill('move_relative_ee', { motion_direction: 'forward', motion_distance: 0.1 }, 10, 'continue'),
		{
			step: 'if',
			condition: { field: 'last.success', op: '==', value: false },
			then: [skill('recover_safe_pose', undefined, undefined, 'stop')],
			else: [skill('celebrate')],
		},
		skill('wave_hello'),
	],
};

export const CONTINUE_ON_FAILURE_PLAN_JSON = JSON.stringify(CONTINUE_ON_FAILURE_PLAN, null, 2);

/**
 * 一条原语步（`{step:'primitive', primitive, params?, timeoutSec?, onFailure?}`）。
 * 原语名同样只能从 `ROBOFRAME_SO101_CATALOG.primitives` 里挑——那里有 `open_gripper` / `close_gripper`
 * 这两条**没有技能包装**的原子动作，正是原语步存在的理由。
 */
const primitive = (
	ref: string,
	params?: JsonObject,
	timeoutSec?: number,
	onFailure?: 'stop' | 'continue',
): SkillPlanStep => ({
	step: 'primitive',
	primitive: ref,
	...(params === undefined ? {} : { params }),
	...(timeoutSec === undefined ? {} : { timeoutSec }),
	...(onFailure === undefined ? {} : { onFailure }),
});

/**
 * 四类步混排的素材：看一眼 → **直接张开夹爪**（没有技能包装的那种） → 等两秒 → 分叉
 * （没成就自己合上，成了就打个招呼）→ 最后往前挪一点（失败也往下走）。
 *
 * 覆盖四件事：原语步的卡头用目录标签、参数行来自原语声明、单格出边、`onFailure` 与技能步同待遇。
 */
const MIXED_STEPS_PLAN: SkillPlan = {
	schemaVersion: 1,
	robot: 'so101_single_arm',
	description: '四类步都有的计划',
	plan: [
		skill('inspect_scene'),
		primitive('open_gripper'),
		{ step: 'wait', seconds: 2 },
		{
			step: 'if',
			condition: { field: 'last.success', op: '==', value: false },
			then: [primitive('close_gripper')],
			else: [skill('wave_hello')],
		},
		skill('move_relative_ee', { motion_direction: 'forward', motion_distance: 0.03 }, 10, 'continue'),
	],
};

export const MIXED_STEPS_PLAN_JSON = JSON.stringify(MIXED_STEPS_PLAN, null, 2);

/** 带参数的命名位姿原语：用来看「实参按原语声明的顺序与名字写出来」。 */
const POSE_PRIMITIVE_PLAN: SkillPlan = {
	schemaVersion: 1,
	robot: 'so101_single_arm',
	description: '直接回命名位姿',
	plan: [primitive('move_to_named_pose', { pose_name: 'home' })],
};

export const POSE_PRIMITIVE_PLAN_JSON = JSON.stringify(POSE_PRIMITIVE_PLAN, null, 2);

/**
 * 参数顺序的素材：计划里把两个参数**倒着给**，代码那一行仍要按原语声明的顺序写
 * （`joint_positions` 在前、`duration_sec` 在后）——与 `code-render` 渲染实现里那些调用同一个口径。
 */
const ORDERED_ARGS_PLAN: SkillPlan = {
	schemaVersion: 1,
	robot: 'so101_single_arm',
	description: '关节位置与时长',
	plan: [primitive('move_to_joint_positions', { duration_sec: 2, joint_positions: { '1': 0.02 } })],
};

export const ORDERED_ARGS_PLAN_JSON = JSON.stringify(ORDERED_ARGS_PLAN, null, 2);
