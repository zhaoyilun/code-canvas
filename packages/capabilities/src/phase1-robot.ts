/**
 * 一期设备的能力目录：底盘动作 + 六轴臂动作。
 *
 * ⚠ **这份 `implementation` 是示意，不是设备真实逻辑。** 一期协议（`docs/reference/task_protocol.py`）
 * 只规定「要做什么」和参数范围，没有任何「怎么做」的信息；真实实现在 RoboFrame / 设备侧。
 * 这里手写一份，是为了先把「点一个模块 → 看到它的实现」这条穿透链在演示上跑通。
 * 等 RoboFrame 能给出真正的原语序列，换掉这个文件即可，数据结构不用动。
 */
import type { CapabilityCatalog } from '@codecanvas/contracts';

export const PHASE1_ROBOT_CATALOG: CapabilityCatalog = {
	catalogRef: 'phase1_robot',
	displayName: '一期设备（差速底盘 + 六轴臂）',
	revisionRef: 'phase1-robot-catalog-v1',

	primitives: [
		{
			primitiveRef: 'set_velocity',
			label: '下发速度',
			parameters: [
				{ name: 'linear', label: '线速度', type: 'number' },
				{ name: 'angular', label: '角速度', type: 'number' },
			],
		},
		{
			primitiveRef: 'wait',
			label: '等待',
			parameters: [{ name: 'seconds', label: '时长', type: 'number' }],
		},
		{
			primitiveRef: 'stop_motion',
			label: '停止运动',
			parameters: [],
		},
		{
			primitiveRef: 'read_scan',
			label: '读取激光',
			parameters: [{ name: 'sensor', label: '传感器', type: 'sensor' }],
		},
		{
			primitiveRef: 'compare_below',
			label: '判断小于',
			parameters: [{ name: 'threshold', label: '阈值', type: 'number' }],
		},
		{
			primitiveRef: 'brake',
			label: '刹停',
			parameters: [],
		},
		{
			primitiveRef: 'read_status',
			label: '读取状态',
			parameters: [],
		},
		{
			primitiveRef: 'drive_joint',
			label: '驱动单关节',
			parameters: [
				{ name: 'joint_id', label: '关节号', type: 'number', integer: true },
				{ name: 'angle', label: '角度', type: 'number' },
				{ name: 'time', label: '时长', type: 'number', integer: true },
			],
		},
		{
			primitiveRef: 'drive_joints',
			label: '驱动六关节',
			parameters: [
				{ name: 'joint1', label: '关节1', type: 'number' },
				{ name: 'joint2', label: '关节2', type: 'number' },
				{ name: 'joint3', label: '关节3', type: 'number' },
				{ name: 'joint4', label: '关节4', type: 'number' },
				{ name: 'joint5', label: '关节5', type: 'number' },
				{ name: 'joint6', label: '关节6', type: 'number' },
				{ name: 'time', label: '时长', type: 'number', integer: true },
			],
		},
	],

	capabilities: [
		{
			capabilityRef: 'move',
			label: '前进',
			kind: 'skill',
			parameters: [
				{ name: 'linear', label: '线速度', type: 'number' },
				{ name: 'angular', label: '角速度', type: 'number' },
				{ name: 'duration', label: '时长', type: 'number' },
			],
			implementation: [
				{ step: 'set_velocity', arguments: { linear: '$linear', angular: '$angular' } },
				{ step: 'wait', arguments: { seconds: '$duration' } },
				{ step: 'stop_motion', arguments: {} },
			],
		},
		{
			capabilityRef: 'turn',
			label: '转向',
			kind: 'skill',
			parameters: [
				{ name: 'angular', label: '角速度', type: 'number' },
				{ name: 'duration', label: '时长', type: 'number' },
			],
			implementation: [
				{ step: 'set_velocity', arguments: { linear: 0, angular: '$angular' } },
				{ step: 'wait', arguments: { seconds: '$duration' } },
				{ step: 'stop_motion', arguments: {} },
			],
		},
		{
			capabilityRef: 'stop',
			label: '停止',
			kind: 'skill',
			parameters: [],
			implementation: [{ step: 'stop_motion', arguments: {} }],
		},
		{
			capabilityRef: 'stop_if_obstacle',
			label: '避障停止',
			kind: 'skill',
			parameters: [
				{ name: 'sensors', label: '传感器', type: 'sensor' },
				{ name: 'distance', label: '距离', type: 'number' },
			],
			implementation: [
				{ step: 'read_scan', arguments: { sensor: '$sensors' } },
				{ step: 'compare_below', arguments: { threshold: '$distance' } },
				{ step: 'brake', arguments: {} },
			],
		},
		{
			capabilityRef: 'get_status',
			label: '读取状态',
			kind: 'skill',
			parameters: [],
			implementation: [{ step: 'read_status', arguments: {} }],
		},
		{
			capabilityRef: 'arm_joint',
			label: '单关节',
			kind: 'skill',
			parameters: [
				{ name: 'joint_id', label: '关节号', type: 'number', integer: true },
				{ name: 'joint', label: '角度', type: 'number' },
				{ name: 'time', label: '时长', type: 'number', integer: true },
			],
			implementation: [
				{
					step: 'drive_joint',
					arguments: { joint_id: '$joint_id', angle: '$joint', time: '$time' },
				},
			],
		},
		{
			capabilityRef: 'arm6_joints',
			label: '六关节',
			kind: 'skill',
			parameters: [
				{ name: 'joint1', label: '关节1', type: 'number' },
				{ name: 'joint2', label: '关节2', type: 'number' },
				{ name: 'joint3', label: '关节3', type: 'number' },
				{ name: 'joint4', label: '关节4', type: 'number' },
				{ name: 'joint5', label: '关节5', type: 'number' },
				{ name: 'joint6', label: '关节6', type: 'number' },
				{ name: 'time', label: '时长', type: 'number', integer: true },
			],
			implementation: [
				{
					step: 'drive_joints',
					arguments: {
						joint1: '$joint1',
						joint2: '$joint2',
						joint3: '$joint3',
						joint4: '$joint4',
						joint5: '$joint5',
						joint6: '$joint6',
						time: '$time',
					},
				},
			],
		},
	],
};
