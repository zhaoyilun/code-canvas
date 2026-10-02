/**
 * 校验器对照语料：同一批输入同时喂给 TS 校验器与 `docs/reference/task_protocol.py`。
 *
 * 覆盖七种 action 的全部合法分支，以及验收清单点名的每一条非法情形。
 * `expectation` 是声明式期望（python3 不可用时退化成它）；`expectedCodes` 是 TS 侧必须命中的诊断码。
 */

const DEFAULT_LIMITS = {
	max_linear: 0.3,
	max_angular: 1.2,
	max_duration: 30.0,
	require_confirmation: true,
};

export interface TaskCase {
	readonly name: string;
	readonly task: unknown;
	readonly expectation: 'valid' | 'invalid';
	readonly seenTaskIds?: readonly string[];
	/** TS 侧必须命中的诊断码（至少一个）。 */
	readonly expectedCodes?: readonly string[];
	/** 参考实现在该输入上抛的不是 TaskValidationError（例如 dict 当 action 用会 TypeError）。 */
	readonly referenceCrashes?: boolean;
}

// `steps` is deliberately `unknown`: the corpus feeds non-array values to exercise
// the validator's negative paths.
const task = (steps: unknown, limits: unknown = DEFAULT_LIMITS, extra: Record<string, unknown> = {}): unknown => ({
	schema_version: '1.0',
	task_id: 'task-demo-001',
	description: '前进1米，避障后停止',
	steps,
	limits,
	...extra,
});

export const TASK_CASES: readonly TaskCase[] = [
	// ---------------------------------------------------------------- 合法分支
	{
		name: 'move 合法（默认限值）',
		task: task([{ id: 's1', action: 'move', linear: 0.2, angular: 0.0, duration: 5.0 }]),
		expectation: 'valid',
	},
	{
		name: '七种 action 全部合法',
		task: task([
			{ id: 's1', action: 'move', linear: 0.3, angular: 1.2, duration: 1.0 },
			{ id: 's2', action: 'turn', angular: -1.2, duration: 1.0 },
			{ id: 's3', action: 'stop' },
			{ id: 's4', action: 'stop_if_obstacle', sensors: ['/scan0', '/scan1'], distance: 2.0 },
			{ id: 's5', action: 'get_status' },
			{ id: 's6', action: 'arm_joint', joint_id: 6, joint: 180, time: 100 },
			{ id: 's7', action: 'arm6_joints', joint1: 0, joint2: 45, joint3: 90, joint4: 135, joint5: 180, joint6: 90, time: 10000 },
		]),
		expectation: 'valid',
	},
	{
		name: '负速度合法（限值看量值）',
		task: task([{ id: 's1', action: 'move', linear: -0.3, angular: -1.2, duration: 0.5 }]),
		expectation: 'valid',
	},
	{
		name: 'arm_joint 省略 time 用默认 1500',
		task: task([{ id: 's1', action: 'arm_joint', joint_id: 1, joint: 0 }]),
		expectation: 'valid',
	},
	{
		name: 'arm6_joints 省略 time',
		task: task([{ id: 's1', action: 'arm6_joints', joint1: 10, joint2: 20, joint3: 30, joint4: 40, joint5: 50, joint6: 60 }]),
		expectation: 'valid',
	},
	{
		name: 'distance 恰好 2.0',
		task: task([{ id: 's1', action: 'stop_if_obstacle', sensors: ['/scan0'], distance: 2.0 }]),
		expectation: 'valid',
	},
	{
		name: 'sensors 允许重复',
		task: task([{ id: 's1', action: 'stop_if_obstacle', sensors: ['/scan0', '/scan0'], distance: 0.5 }]),
		expectation: 'valid',
	},
	{
		name: '限值收紧合法',
		task: task([{ id: 's1', action: 'move', linear: 0.05, angular: 0.1, duration: 1.0 }], {
			max_linear: 0.1,
			max_angular: 0.5,
			max_duration: 2.0,
			require_confirmation: false,
		}),
		expectation: 'valid',
	},
	{
		name: 'limits 缺省字段用默认值补齐',
		task: task([{ id: 's1', action: 'move', linear: 0.3, angular: 0.5, duration: 1.0 }], { max_angular: 0.5 }),
		expectation: 'valid',
	},
	{
		name: '未知字段被容忍（task 与 step 各一处）',
		task: task([{ id: 's1', action: 'stop', note: '以后再说' }], DEFAULT_LIMITS, { author: 'unknown' }),
		expectation: 'valid',
	},
	{
		name: '总时长恰好等于 max_duration',
		task: task(
			[
				{ id: 's1', action: 'move', linear: 0.1, angular: 0, duration: 20.0 },
				{ id: 's2', action: 'turn', angular: 0.1, duration: 10.0 },
			],
			{ max_linear: 0.3, max_angular: 1.2, max_duration: 30.0, require_confirmation: true },
		),
		expectation: 'valid',
	},
	{
		name: '没有 description 也合法',
		task: { schema_version: '1.0', task_id: 't1', steps: [{ id: 's1', action: 'stop' }], limits: DEFAULT_LIMITS },
		expectation: 'valid',
	},

	// ---------------------------------------------------------------- 顶层非法
	{ name: '任务不是对象（字符串）', task: 'not-a-task', expectation: 'invalid', expectedCodes: ['task.not_object'] },
	{ name: '任务不是对象（数组）', task: [1, 2, 3], expectation: 'invalid', expectedCodes: ['task.not_object'] },
	{
		name: 'schema_version 不是 1.0',
		task: task([{ id: 's1', action: 'stop' }], DEFAULT_LIMITS, { schema_version: '2.0' }),
		expectation: 'invalid',
		expectedCodes: ['task.schema_version'],
	},
	{
		name: '缺 schema_version',
		task: { task_id: 't1', steps: [{ id: 's1', action: 'stop' }], limits: DEFAULT_LIMITS },
		expectation: 'invalid',
		expectedCodes: ['task.schema_version'],
	},
	{
		name: '缺 task_id',
		task: { schema_version: '1.0', steps: [{ id: 's1', action: 'stop' }], limits: DEFAULT_LIMITS },
		expectation: 'invalid',
		expectedCodes: ['task.task_id.missing'],
	},
	{
		name: 'task_id 是空白串',
		task: task([{ id: 's1', action: 'stop' }], DEFAULT_LIMITS, { task_id: '   ' }),
		expectation: 'invalid',
		expectedCodes: ['task.task_id.invalid'],
	},
	{
		name: 'task_id 不是字符串',
		task: task([{ id: 's1', action: 'stop' }], DEFAULT_LIMITS, { task_id: 123 }),
		expectation: 'invalid',
		expectedCodes: ['task.task_id.invalid'],
	},
	{
		name: 'task_id 与执行端已有任务重复',
		task: task([{ id: 's1', action: 'stop' }]),
		expectation: 'invalid',
		seenTaskIds: ['task-demo-001'],
		expectedCodes: ['task.task_id.duplicate'],
	},
	{
		name: '缺 steps',
		task: { schema_version: '1.0', task_id: 't1', limits: DEFAULT_LIMITS },
		expectation: 'invalid',
		expectedCodes: ['task.steps.missing'],
	},
	{
		name: 'steps 为空数组',
		task: task([]),
		expectation: 'invalid',
		expectedCodes: ['task.steps.invalid'],
	},
	{
		name: 'steps 不是数组',
		task: task('s1'),
		expectation: 'invalid',
		expectedCodes: ['task.steps.invalid'],
	},
	{
		name: 'step 不是对象',
		task: task(['s1']),
		expectation: 'invalid',
		expectedCodes: ['step.not_object'],
	},

	// ---------------------------------------------------------------- step 身份
	{
		name: '缺 step id',
		task: task([{ action: 'stop' }]),
		expectation: 'invalid',
		expectedCodes: ['step.id.missing'],
	},
	{
		name: 'step id 为空串',
		task: task([{ id: '', action: 'stop' }]),
		expectation: 'invalid',
		expectedCodes: ['step.id.invalid'],
	},
	{
		name: '重复 step id',
		task: task([
			{ id: 's1', action: 'stop' },
			{ id: 's1', action: 'get_status' },
		]),
		expectation: 'invalid',
		expectedCodes: ['step.id.duplicate'],
	},
	{
		name: '缺 action',
		task: task([{ id: 's1' }]),
		expectation: 'invalid',
		expectedCodes: ['step.action.missing'],
	},
	{
		name: '未知 action',
		task: task([{ id: 's1', action: 'fly' }]),
		expectation: 'invalid',
		expectedCodes: ['step.action.unknown'],
	},
	{
		name: 'action 不是字符串',
		task: task([{ id: 's1', action: 42 }]),
		expectation: 'invalid',
		expectedCodes: ['step.action.unknown'],
	},
	{
		name: 'action 是对象（参考实现会 TypeError，两边都拒）',
		task: task([{ id: 's1', action: { kind: 'move' } }]),
		expectation: 'invalid',
		expectedCodes: ['step.action.unknown'],
		referenceCrashes: true,
	},

	// ---------------------------------------------------------------- move / turn
	{
		name: 'move 缺 linear',
		task: task([{ id: 's1', action: 'move', angular: 0, duration: 1.0 }]),
		expectation: 'invalid',
		expectedCodes: ['step.move.linear.missing'],
	},
	{
		name: 'move linear 是字符串',
		task: task([{ id: 's1', action: 'move', linear: '0.2', angular: 0, duration: 1.0 }]),
		expectation: 'invalid',
		expectedCodes: ['step.move.linear.type'],
	},
	{
		name: 'move linear 是布尔',
		task: task([{ id: 's1', action: 'move', linear: true, angular: 0, duration: 1.0 }]),
		expectation: 'invalid',
		expectedCodes: ['step.move.linear.type'],
	},
	{
		name: 'move linear 超过 max_linear',
		task: task([{ id: 's1', action: 'move', linear: 0.31, angular: 0, duration: 1.0 }]),
		expectation: 'invalid',
		expectedCodes: ['step.move.linear.range'],
	},
	{
		name: 'move angular 超过 max_angular',
		task: task([{ id: 's1', action: 'move', linear: 0.1, angular: 1.5, duration: 1.0 }]),
		expectation: 'invalid',
		expectedCodes: ['step.move.angular.range'],
	},
	{
		name: 'move duration 为 0',
		task: task([{ id: 's1', action: 'move', linear: 0.1, angular: 0, duration: 0 }]),
		expectation: 'invalid',
		expectedCodes: ['step.move.duration.range'],
	},
	{
		name: 'move duration 为负',
		task: task([{ id: 's1', action: 'move', linear: 0.1, angular: 0, duration: -1 }]),
		expectation: 'invalid',
		expectedCodes: ['step.move.duration.range'],
	},
	{
		name: 'turn angular 超过 max_angular',
		task: task([{ id: 's1', action: 'turn', angular: 2.0, duration: 1.0 }]),
		expectation: 'invalid',
		expectedCodes: ['step.turn.angular.range'],
	},
	{
		name: 'turn 缺 duration',
		task: task([{ id: 's1', action: 'turn', angular: 0.5 }]),
		expectation: 'invalid',
		expectedCodes: ['step.turn.duration.missing'],
	},

	// ---------------------------------------------------------------- limits
	{
		name: '缺 limits',
		task: { schema_version: '1.0', task_id: 't1', steps: [{ id: 's1', action: 'stop' }] },
		expectation: 'invalid',
		expectedCodes: ['task.limits.missing'],
	},
	{
		name: 'limits 不是对象',
		task: task([{ id: 's1', action: 'stop' }], 'wide-open'),
		expectation: 'invalid',
		expectedCodes: ['task.limits.invalid'],
	},
	{
		name: '放宽 max_linear（0.9）',
		task: task([{ id: 's1', action: 'move', linear: 0.5, angular: 0, duration: 1.0 }], {
			max_linear: 0.9,
			max_angular: 1.2,
			max_duration: 30.0,
			require_confirmation: true,
		}),
		expectation: 'invalid',
		expectedCodes: ['limits.max_linear.exceeds'],
	},
	{
		name: '放宽 max_angular（2.0）',
		task: task([{ id: 's1', action: 'turn', angular: 1.0, duration: 1.0 }], {
			max_linear: 0.3,
			max_angular: 2.0,
			max_duration: 30.0,
			require_confirmation: true,
		}),
		expectation: 'invalid',
		expectedCodes: ['limits.max_angular.exceeds'],
	},
	{
		name: '放宽 max_duration（60）',
		task: task([{ id: 's1', action: 'move', linear: 0.1, angular: 0, duration: 1.0 }], {
			max_linear: 0.3,
			max_angular: 1.2,
			max_duration: 60.0,
			require_confirmation: true,
		}),
		expectation: 'invalid',
		expectedCodes: ['limits.max_duration.exceeds'],
	},
	{
		name: 'max_linear 为 0',
		task: task([{ id: 's1', action: 'stop' }], { max_linear: 0, max_angular: 1.2, max_duration: 30, require_confirmation: true }),
		expectation: 'invalid',
		expectedCodes: ['limits.max_linear.exceeds'],
	},
	{
		name: 'max_linear 为负',
		task: task([{ id: 's1', action: 'stop' }], { max_linear: -0.2, max_angular: 1.2, max_duration: 30, require_confirmation: true }),
		expectation: 'invalid',
		expectedCodes: ['limits.max_linear.exceeds'],
	},
	{
		name: 'max_linear 是字符串',
		task: task([{ id: 's1', action: 'stop' }], { max_linear: '0.3', max_angular: 1.2, max_duration: 30, require_confirmation: true }),
		expectation: 'invalid',
		expectedCodes: ['limits.max_linear.type'],
	},
	{
		name: 'require_confirmation 不是布尔',
		task: task([{ id: 's1', action: 'stop' }], { max_linear: 0.3, max_angular: 1.2, max_duration: 30, require_confirmation: 'yes' }),
		expectation: 'invalid',
		expectedCodes: ['limits.require_confirmation.type'],
	},
	{
		name: '总时长超过 max_duration',
		task: task(
			[
				{ id: 's1', action: 'move', linear: 0.1, angular: 0, duration: 20.0 },
				{ id: 's2', action: 'turn', angular: 0.1, duration: 11.0 },
			],
			{ max_linear: 0.3, max_angular: 1.2, max_duration: 30.0, require_confirmation: true },
		),
		expectation: 'invalid',
		expectedCodes: ['task.total_duration'],
	},

	// ---------------------------------------------------------------- stop_if_obstacle
	{
		name: 'stop_if_obstacle 缺 sensors',
		task: task([{ id: 's1', action: 'stop_if_obstacle', distance: 1.0 }]),
		expectation: 'invalid',
		expectedCodes: ['step.stop_if_obstacle.sensors.missing'],
	},
	{
		name: 'sensors 为空数组',
		task: task([{ id: 's1', action: 'stop_if_obstacle', sensors: [], distance: 1.0 }]),
		expectation: 'invalid',
		expectedCodes: ['step.stop_if_obstacle.sensors.invalid'],
	},
	{
		name: 'sensors 含白名单外的值',
		task: task([{ id: 's1', action: 'stop_if_obstacle', sensors: ['/scan0', '/scan2'], distance: 1.0 }]),
		expectation: 'invalid',
		expectedCodes: ['step.stop_if_obstacle.sensors.invalid'],
	},
	{
		name: 'sensors 不是数组',
		task: task([{ id: 's1', action: 'stop_if_obstacle', sensors: '/scan0', distance: 1.0 }]),
		expectation: 'invalid',
		expectedCodes: ['step.stop_if_obstacle.sensors.invalid'],
	},
	{
		name: '缺 distance',
		task: task([{ id: 's1', action: 'stop_if_obstacle', sensors: ['/scan0'] }]),
		expectation: 'invalid',
		expectedCodes: ['step.stop_if_obstacle.distance.missing'],
	},
	{
		name: 'distance 为 0（落在 (0, 2] 之外）',
		task: task([{ id: 's1', action: 'stop_if_obstacle', sensors: ['/scan0'], distance: 0 }]),
		expectation: 'invalid',
		expectedCodes: ['step.stop_if_obstacle.distance.range'],
	},
	{
		name: 'distance 为负',
		task: task([{ id: 's1', action: 'stop_if_obstacle', sensors: ['/scan0'], distance: -1.0 }]),
		expectation: 'invalid',
		expectedCodes: ['step.stop_if_obstacle.distance.range'],
	},
	{
		name: 'distance 超过 2 米',
		task: task([{ id: 's1', action: 'stop_if_obstacle', sensors: ['/scan0'], distance: 2.5 }]),
		expectation: 'invalid',
		expectedCodes: ['step.stop_if_obstacle.distance.range'],
	},
	{
		name: 'distance 是布尔',
		task: task([{ id: 's1', action: 'stop_if_obstacle', sensors: ['/scan0'], distance: true }]),
		expectation: 'invalid',
		expectedCodes: ['step.stop_if_obstacle.distance.type'],
	},

	// ---------------------------------------------------------------- 机械臂
	{
		name: 'arm_joint 缺 joint_id',
		task: task([{ id: 's1', action: 'arm_joint', joint: 90 }]),
		expectation: 'invalid',
		expectedCodes: ['step.arm_joint.joint_id.missing'],
	},
	{
		name: 'joint_id 越界（0）',
		task: task([{ id: 's1', action: 'arm_joint', joint_id: 0, joint: 90 }]),
		expectation: 'invalid',
		expectedCodes: ['step.arm_joint.joint_id.range'],
	},
	{
		name: 'joint_id 越界（7）',
		task: task([{ id: 's1', action: 'arm_joint', joint_id: 7, joint: 90 }]),
		expectation: 'invalid',
		expectedCodes: ['step.arm_joint.joint_id.range'],
	},
	{
		name: 'joint_id 不是整数（1.5）',
		task: task([{ id: 's1', action: 'arm_joint', joint_id: 1.5, joint: 90 }]),
		expectation: 'invalid',
		expectedCodes: ['step.arm_joint.joint_id.range'],
	},
	{
		name: 'joint 超过 180 度',
		task: task([{ id: 's1', action: 'arm_joint', joint_id: 1, joint: 181 }]),
		expectation: 'invalid',
		expectedCodes: ['step.arm_joint.joint.range'],
	},
	{
		name: 'joint 小于 0 度',
		task: task([{ id: 's1', action: 'arm_joint', joint_id: 1, joint: -1 }]),
		expectation: 'invalid',
		expectedCodes: ['step.arm_joint.joint.range'],
	},
	{
		name: 'time 小于 100ms',
		task: task([{ id: 's1', action: 'arm_joint', joint_id: 1, joint: 90, time: 50 }]),
		expectation: 'invalid',
		expectedCodes: ['step.arm_joint.time.range'],
	},
	{
		name: 'time 大于 10000ms',
		task: task([{ id: 's1', action: 'arm_joint', joint_id: 1, joint: 90, time: 10001 }]),
		expectation: 'invalid',
		expectedCodes: ['step.arm_joint.time.range'],
	},
	{
		name: 'time 是字符串',
		task: task([{ id: 's1', action: 'arm_joint', joint_id: 1, joint: 90, time: '1500' }]),
		expectation: 'invalid',
		expectedCodes: ['step.arm_joint.time.type'],
	},
	{
		name: 'arm6_joints 缺 joint3',
		task: task([{ id: 's1', action: 'arm6_joints', joint1: 0, joint2: 0, joint4: 0, joint5: 0, joint6: 0 }]),
		expectation: 'invalid',
		expectedCodes: ['step.arm6_joints.joint3.missing'],
	},
	{
		name: 'arm6_joints joint6 超过 180 度',
		task: task([{ id: 's1', action: 'arm6_joints', joint1: 0, joint2: 0, joint3: 0, joint4: 0, joint5: 0, joint6: 200 }]),
		expectation: 'invalid',
		expectedCodes: ['step.arm6_joints.joint6.range'],
	},
	{
		name: '多步多处出错（收集式：一次给全）',
		task: task([
			{ id: 's1', action: 'move', linear: 0.9, angular: 0, duration: 1.0 },
			{ id: 's2', action: 'arm_joint', joint_id: 9, joint: 90 },
		]),
		expectation: 'invalid',
		expectedCodes: ['step.move.linear.range', 'step.arm_joint.joint_id.range'],
	},
];
