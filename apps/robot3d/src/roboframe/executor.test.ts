import { describe, expect, it } from 'vitest';
import type { CapabilitySpec, PrimitiveSpec } from '@codecanvas/contracts';
import { countSteps, RoboFrameExecutor, type ArmRigLike, type StepEvent } from './executor';
import type { Waypoint } from './trajectory';

/** 用假 rig 记录"设备收到了什么指令"——执行器的测试不该依赖画布 */
function fakeRig() {
	const log: string[] = [];
	const rig: ArmRigLike = {
		moveJoints: async (joints, sec) => {
			log.push(`joints ${JSON.stringify(joints)} ${sec}s`);
		},
		playWaypoints: async (waypoints: readonly Waypoint[]) => {
			log.push(`waypoints ${waypoints.length}`);
		},
		setGripper: async (v) => {
			log.push(`gripper ${v}`);
		},
		rotateTool: async (deg) => {
			log.push(`tool ${deg}`);
		},
		moveEE: async (dir, m) => {
			log.push(`ee ${dir} ${m}`);
		},
		poseJoints: () => ({ '1': 0, '2': 0, '3': 0, '4': 0, '5': 0 }),
		toolPosition: () => ({ x: 0, y: 0, z: 0.2 }),
		linkPositions: () => null,
		calibration: 'verified',
		reset: () => {
			log.push('reset');
		},
	};
	return { rig, log };
}

const primitives: PrimitiveSpec[] = [
	{ primitiveRef: 'move_to_named_pose', label: '移动到命名位姿', parameters: [{ name: 'pose_name', label: '命名位姿', type: 'pose' }] },
	{ primitiveRef: 'move_to_joint_positions', label: '移动到关节位置', parameters: [{ name: 'joint_positions', label: '关节', type: 'json' }, { name: 'duration_sec', label: '时长', type: 'number' }] },
	{ primitiveRef: 'move_through_joint_positions', label: '多关节轨迹', parameters: [{ name: 'trajectory_template', label: '模板', type: 'json' }] },
	{ primitiveRef: 'move_relative_ee', label: '相对末端', parameters: [{ name: 'motion_direction', label: '方向', type: 'string' }, { name: 'motion_distance', label: '距离', type: 'number' }] },
	{ primitiveRef: 'open_gripper', label: '张开夹爪', parameters: [] },
	{ primitiveRef: 'close_gripper', label: '闭合夹爪', parameters: [] },
	// 上游说必填的原语参数：缺了是错误（判据在目录里）
	{ primitiveRef: 'rotate_gripper_cw', label: '顺时针', parameters: [{ name: 'motion_distance', label: '角度', type: 'number', required: true }] },
	{ primitiveRef: 'rotate_gripper_ccw', label: '逆时针', parameters: [{ name: 'motion_distance', label: '角度', type: 'number' }] },
];

/** 目录里 inspect_scene 的真实形状：move_to_named_pose(observe_table) */
const inspectScene: CapabilitySpec = {
	capabilityRef: 'inspect_scene',
	label: '观察桌面',
	kind: 'skill',
	parameters: [],
	implementation: [
		{ kind: 'call', primitiveRef: 'move_to_named_pose', arguments: { pose_name: { kind: 'literal', value: 'observe_table' } } },
	],
};

/** 目录里 move_relative_ee 的真实形状：两个参数由 {kind:'param'} 引用 */
const relativeCap: CapabilitySpec = {
	capabilityRef: 'move_relative_ee',
	label: '往前一点',
	kind: 'skill',
	parameters: [
		{ name: 'motion_direction', label: 'motion_direction', type: 'string' },
		{ name: 'motion_distance', label: 'motion_distance', type: 'number' },
	],
	implementation: [
		{
			kind: 'call',
			primitiveRef: 'move_relative_ee',
			arguments: {
				motion_direction: { kind: 'param', name: 'motion_direction' },
				motion_distance: { kind: 'param', name: 'motion_distance' },
			},
		},
	],
};

/** 目录里 celebrate 的尾部：连续 up/down/left/right 相对移动 */
const celebrateTail: CapabilitySpec = {
	capabilityRef: 'celebrate',
	label: '庆祝',
	kind: 'skill',
	parameters: [],
	implementation: [
		{ kind: 'call', primitiveRef: 'close_gripper', arguments: {} },
		{ kind: 'call', primitiveRef: 'move_to_named_pose', arguments: { pose_name: { kind: 'literal', value: 'observe_table' } } },
		{ kind: 'call', primitiveRef: 'move_relative_ee', arguments: { motion_direction: { kind: 'literal', value: 'up' }, motion_distance: { kind: 'literal', value: 0.04 } } },
		{ kind: 'call', primitiveRef: 'move_relative_ee', arguments: { motion_direction: { kind: 'literal', value: 'down' }, motion_distance: { kind: 'literal', value: 0.08 } } },
	],
};

describe('countSteps', () => {
	it('连 if 分支里的调用一起数', () => {
		expect(countSteps(celebrateTail.implementation)).toBe(4);
		expect(
			countSteps([
				{ kind: 'call', primitiveRef: 'open_gripper', arguments: {} },
				{
					kind: 'if',
					condition: { kind: 'literal', value: true },
					then: [{ kind: 'call', primitiveRef: 'close_gripper', arguments: {} }],
					else: [{ kind: 'call', primitiveRef: 'open_gripper', arguments: {} }],
				},
			]),
		).toBe(3);
	});
});

describe('RoboFrameExecutor', () => {
	it('按目录顺序把原语下发给设备', async () => {
		const { rig, log } = fakeRig();
		const exec = new RoboFrameExecutor(rig, primitives);
		const outcome = await exec.run(celebrateTail, {});
		expect(outcome.ok).toBe(true);
		expect(log).toEqual(['gripper 0', 'joints {"1":0.02,"2":0.54,"3":-0.82,"4":-0.18,"5":0.02} 1.6s', 'ee up 0.04', 'ee down 0.08']);
		expect(outcome.steps).toHaveLength(4);
		// 第 2 步是命名位姿，detail 要如实标出这个位姿值的来源
		expect(outcome.steps[1]?.detail).toContain('upstream');
	});

	it('参数引用能取到调用方给的值', async () => {
		const { rig, log } = fakeRig();
		const exec = new RoboFrameExecutor(rig, primitives);
		const outcome = await exec.run(relativeCap, { motion_direction: 'left', motion_distance: '0.04' });
		expect(outcome.ok).toBe(true);
		expect(log).toEqual(['ee left 0.04']);
	});

	it('缺参数不执行，并说清缺哪个', async () => {
		const { rig, log } = fakeRig();
		const exec = new RoboFrameExecutor(rig, primitives);
		const outcome = await exec.run(relativeCap, { motion_direction: 'up' });
		expect(outcome.ok).toBe(false);
		expect(outcome.reason).toContain('motion_distance');
		expect(log).toEqual([]);
	});

	it('未知位姿如实报 skipped，不当成做过', async () => {
		const { rig } = fakeRig();
		const exec = new RoboFrameExecutor(rig, primitives);
		const outcome = await exec.run(
			{
				capabilityRef: 'ghost',
				label: '幽灵位姿',
				kind: 'skill',
				parameters: [],
				implementation: [{ kind: 'call', primitiveRef: 'move_to_named_pose', arguments: { pose_name: { kind: 'literal', value: 'nowhere' } } }],
			},
			{},
		);
		expect(outcome.ok).toBe(true);
		expect(outcome.steps[0]?.state).toBe('skipped');
		expect(outcome.steps[0]?.detail).toContain('未知命名位姿');
	});

	it('夹爪旋转按目录单位（度）处理，ccw 为正', async () => {
		const { rig, log } = fakeRig();
		const exec = new RoboFrameExecutor(rig, primitives);
		await exec.run(
			{
				capabilityRef: 'twist',
				label: '拧一下',
				kind: 'skill',
				parameters: [],
				implementation: [
					{ kind: 'call', primitiveRef: 'rotate_gripper_cw', arguments: { motion_distance: { kind: 'literal', value: 30 } } },
					{ kind: 'call', primitiveRef: 'rotate_gripper_ccw', arguments: { motion_distance: { kind: 'literal', value: 30 } } },
				],
			},
			{},
		);
		expect(log).toEqual(['tool -30', 'tool 30']);
	});

	it('轨迹模板走合成路点，不是逐关节插值', async () => {
		const { rig, log } = fakeRig();
		const exec = new RoboFrameExecutor(rig, primitives);
		await exec.run(
			{
				capabilityRef: 'wave_hello',
				label: '打招呼',
				kind: 'skill',
				parameters: [],
				implementation: [
					{
						kind: 'call',
						primitiveRef: 'move_through_joint_positions',
						arguments: {
							trajectory_template: {
								kind: 'literal',
								value: { type: 'single_joint_wave_v1', waypoint_duration_sec: 0.05, active_waypoint_count: 4, repeat_count: 2, base_pose: { '1': 0 }, joint: '5', amplitude: 0.35 },
							},
						},
					},
				],
			},
			{},
		);
		expect(log).toEqual(['waypoints 8']);
	});

	it('标定已验证时：越界就拒绝执行，并报出数值', async () => {
		const { rig, log } = fakeRig();
		const linked = {
			...rig,
			linkPositions: () => ({ ee: { x: 0, y: 0, z: 0.9 } }),
		};
		const exec = new RoboFrameExecutor(linked, primitives);
		const outcome = await exec.run(
			{
				capabilityRef: 'dance_basic',
				label: '跳舞',
				kind: 'skill',
				parameters: [],
				implementation: [
					{
						kind: 'call',
						primitiveRef: 'move_through_joint_positions',
						arguments: {
							trajectory_template: {
								kind: 'literal',
								value: {
									type: 'single_joint_wave_v1',
									waypoint_duration_sec: 0.05,
									active_waypoint_count: 4,
									repeat_count: 1,
									base_pose: { '1': 0 },
									joint: '5',
									amplitude: 0.35,
									workspace_limits: { points: { ee: { z: [0.05, 0.55] } } },
								},
							},
						},
					},
				],
			},
			{},
		);
		expect(outcome.ok).toBe(false);
		expect(outcome.steps[0]?.state).toBe('refused');
		expect(outcome.steps[0]?.detail).toContain('越界');
		expect(log).toEqual([]); // 没有真的去动设备
	});

	it('标定未验证时：同样越界只提示、照常执行（不拿估算否决动作）', async () => {
		const { rig, log } = fakeRig();
		const approximate = {
			...rig,
			calibration: 'approximate' as const,
			linkPositions: () => ({ ee: { x: 0, y: 0, z: 0.9 } }),
		};
		const exec = new RoboFrameExecutor(approximate, primitives);
		const outcome = await exec.run(
			{
				capabilityRef: 'dance_basic',
				label: '跳舞',
				kind: 'skill',
				parameters: [],
				implementation: [
					{
						kind: 'call',
						primitiveRef: 'move_through_joint_positions',
						arguments: {
							trajectory_template: {
								kind: 'literal',
								value: {
									type: 'single_joint_wave_v1',
									waypoint_duration_sec: 0.05,
									active_waypoint_count: 4,
									repeat_count: 1,
									base_pose: { '1': 0 },
									joint: '5',
									amplitude: 0.35,
									workspace_limits: { points: { ee: { z: [0.05, 0.55] } } },
								},
							},
						},
					},
				],
			},
			{},
		);
		expect(outcome.steps[0]?.state).toBe('done');
		expect(outcome.steps[0]?.detail).toContain('边界提示');
		expect(log).toEqual(['waypoints 4']); // 照跑
	});

	it('事件流带进度与状态，界面照这个渲染就行', async () => {
		const { rig } = fakeRig();
		const seen: StepEvent[] = [];
		const exec = new RoboFrameExecutor(rig, primitives, { onStep: (e) => seen.push(e) });
		await exec.run(inspectScene, {});
		expect(seen.map((e) => e.state)).toEqual(['running', 'done']);
		expect(seen[0]?.total).toBe(1);
		expect(seen[1]?.index).toBe(1);
	});
});

// ---------------------------------------------------------------------------
// 公开的单原语入口（`runPrimitiveCommand`）：上游 `/embodied/execute_primitive` 那条路
// ---------------------------------------------------------------------------

/**
 * 这一组钉住四件事（与 `run()` 同一套口径）：
 * 1. 它**真的把那一个原语下发给设备**（设备收到的就是它，不经过任何能力）；
 * 2. 参数按**目录声明**校验：名字多给了当场拒、标了必填的缺了拒、没标必填的缺了照跑（有默认值）；
 * 3. 事件照常报（`running` → 终态），跑计划时带着计划序号与 task_id，直接叫时如实缺席；
 * 4. 取消与失败如实返回，不抛异常、不粉饰。
 */
describe('RoboFrameExecutor · 跑单个原语', () => {
	it('把那个原语下发给设备，事件带进度与状态', async () => {
		const { rig, log } = fakeRig();
		const seen: StepEvent[] = [];
		const exec = new RoboFrameExecutor(rig, primitives, { onStep: (e) => seen.push(e) });

		const outcome = await exec.runPrimitiveCommand('open_gripper');
		expect(outcome.ok).toBe(true);
		expect(log).toEqual(['gripper 1']);
		expect(seen.map((e) => e.state)).toEqual(['running', 'done']);
		// 一个原语就是一步：1/1
		expect(seen.map((e) => `${String(e.index)}/${String(e.total)}`)).toEqual(['1/1', '1/1']);
		// 直接叫原语时**没有能力可指**：这一栏如实缺席（与 planIndex 同一个口径）
		expect(seen.every((e) => e.capabilityRef === undefined)).toBe(true);
		expect(outcome.steps.map((e) => e.primitiveRef)).toEqual(['open_gripper']);
	});

	it('参数按目录声明校验：多给的名字当场拒，一个字节都不下发', async () => {
		const { rig, log } = fakeRig();
		const exec = new RoboFrameExecutor(rig, primitives);

		const outcome = await exec.runPrimitiveCommand('open_gripper', { nope: 1 });
		expect(outcome.ok).toBe(false);
		expect(outcome.reason).toContain('没有参数 nope');
		expect(log).toEqual([]);
	});

	it('标了必填的缺了 → 拒绝执行；没标必填的缺了 → 照跑（执行侧有默认值）', async () => {
		const { rig, log } = fakeRig();
		const exec = new RoboFrameExecutor(rig, primitives);

		const refused = await exec.runPrimitiveCommand('rotate_gripper_cw');
		expect(refused.ok).toBe(false);
		expect(refused.reason).toContain('缺少参数 motion_distance');
		expect(log).toEqual([]);

		// `duration_sec` 没标必填：只给关节目标位置也跑得动（与计划层那条「只提醒」同一条口径）
		const ok = await exec.runPrimitiveCommand('move_to_joint_positions', { joint_positions: { '1': 0.02 } });
		expect(ok.ok).toBe(true);
		expect(log).toEqual(['joints {"1":0.02} 1.5s']);
	});

	it('目录里没有这个原语：如实拒绝，不当成做过', async () => {
		const { rig, log } = fakeRig();
		const exec = new RoboFrameExecutor(rig, primitives);

		const outcome = await exec.runPrimitiveCommand('fly');
		expect(outcome.ok).toBe(false);
		expect(outcome.reason).toBe('目录里没有原语 fly');
		expect(log).toEqual([]);
	});

	it('跑计划时带计划上下文：事件里有计划序号与 task_id', async () => {
		const { rig } = fakeRig();
		const seen: StepEvent[] = [];
		const exec = new RoboFrameExecutor(rig, primitives, { onStep: (e) => seen.push(e) });
		exec.beginRun();
		exec.setPlanContext({ planIndex: 3, taskId: 'plan-3-abc' });

		await exec.runPrimitiveCommand('open_gripper');
		expect(seen.map((e) => `${String(e.planIndex)} ${String(e.taskId)}`)).toEqual(['3 plan-3-abc', '3 plan-3-abc']);
	});

	it('取消之后如实拒绝，不碰设备（原语一旦下发就没法从中间叫停——与技能步同一个口径）', async () => {
		const { rig, log } = fakeRig();
		const exec = new RoboFrameExecutor(rig, primitives);
		exec.cancel();

		const outcome = await exec.runPrimitiveCommand('open_gripper');
		expect(outcome.ok).toBe(false);
		expect(outcome.reason).toBe('已取消');
		expect(log).toEqual([]);

		// `beginRun()` 清掉取消标记之后照跑（与跑计划开始一趟同一个口径）
		exec.beginRun();
		expect((await exec.runPrimitiveCommand('open_gripper')).ok).toBe(true);
		expect(log).toEqual(['gripper 1']);
	});
});

/*
 * 委托步：实现在执行侧，本机这套执行器没有那套东西。
 *
 * 这一条以前是**静默跳过**的（`if (statement.kind !== 'call') continue`）：
 * 跑 `pick_object` 会得到「ok: true、零步」，界面于是报「1 步都走通了」而屏幕上一条都没有。
 * 那是假账，所以现在它照报一步（`skipped` + 接口名），并把接口名记进 `unrunnable`。
 */
describe('委托步：照报一步，不静默跳过', () => {
	const pickObject: CapabilitySpec = {
		capabilityRef: 'pick_object',
		label: '抓取物体',
		kind: 'skill',
		parameters: [{ name: 'target_name', label: '目标物', type: 'string', required: true }],
		implementation: [
			{
				kind: 'delegate',
				interfaceRef: '/manipulation/execute_pick',
				arguments: { target_name: { kind: 'param', name: 'target_name' } },
			},
		],
	};

	it('报一步：没有原语（不拿接口名冒充），但有接口名与实参', async () => {
		const { rig, log } = fakeRig();
		const exec = new RoboFrameExecutor(rig, primitives);
		const outcome = await exec.run(pickObject, { target_name: '红色方块' });

		expect(outcome.ok).toBe(true);
		expect(outcome.unrunnable).toEqual(['/manipulation/execute_pick']);
		expect(outcome.steps).toHaveLength(1);
		expect(outcome.steps[0]).toMatchObject({
			primitiveRef: null,
			interfaceRef: '/manipulation/execute_pick',
			state: 'skipped',
			index: 1,
			total: 1,
		});
		expect(outcome.steps[0]?.args).toEqual({ target_name: '红色方块' });
		expect(outcome.steps[0]?.detail).toContain('实现在执行侧');
		// 机械臂一动没动：这一步本机压根没演。
		expect(log).toEqual([]);
	});

	it('与别的步骤混在一棵树里：步号连着数，委托那一步也没被吞掉', async () => {
		const { rig } = fakeRig();
		const exec = new RoboFrameExecutor(rig, primitives);
		const outcome = await exec.run(
			{
				...pickObject,
				implementation: [
					{ kind: 'call', primitiveRef: 'open_gripper', arguments: {} },
					...pickObject.implementation,
				],
			},
			{ target_name: '方块' },
		);
		expect(outcome.ok).toBe(true);
		expect(outcome.steps.map((event) => event.index)).toEqual([1, 2]);
		expect(outcome.steps.map((event) => event.state)).toEqual(['done', 'skipped']);
		// 总数把委托也算进去——不数它，第 2 步就会报成「2/1」。
		expect(outcome.steps[1]?.total).toBe(2);
	});

	it('嵌在 if 的 else 里也照样报出来', async () => {
		const { rig } = fakeRig();
		const exec = new RoboFrameExecutor(rig, primitives);
		const outcome = await exec.run(
			{
				...pickObject,
				parameters: [{ name: 'target_name', label: '目标物', type: 'string' }],
				implementation: [
					{
						kind: 'if',
						condition: { kind: 'literal', value: false },
						then: [{ kind: 'call', primitiveRef: 'open_gripper', arguments: {} }],
						else: pickObject.implementation,
					},
				],
			},
			{ target_name: '方块' },
		);
		expect(outcome.ok).toBe(true);
		expect(outcome.steps).toHaveLength(1);
		expect(outcome.steps[0]?.interfaceRef).toBe('/manipulation/execute_pick');
	});
});
