import { describe, expect, it } from 'vitest';
import type { CapabilitySpec, PrimitiveSpec } from '@codecanvas/contracts';
import { countCalls, RoboFrameExecutor, type ArmRigLike, type StepEvent } from './executor';
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
	{ primitiveRef: 'rotate_gripper_cw', label: '顺时针', parameters: [{ name: 'motion_distance', label: '角度', type: 'number' }] },
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

describe('countCalls', () => {
	it('连 if 分支里的调用一起数', () => {
		expect(countCalls(celebrateTail.implementation)).toBe(4);
		expect(
			countCalls([
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
