/**
 * 一期设备的能力目录：底盘动作 + 六轴臂动作。
 *
 * ⚠ **这份 `implementation` 是示意，不是设备真实逻辑。** 一期协议（`docs/reference/task_protocol.py`）
 * 只规定「要做什么」和参数范围，没有任何「怎么做」的信息；真实实现在 RoboFrame / 设备侧。
 * 这里手写一份，是为了先把「点一个模块 → 看到它的实现」这条穿透链在演示上跑通。
 * 等 RoboFrame 能给出真正的实现，换掉这个文件即可，数据结构不用动。
 *
 * 实现的形状是**语句树**（见 `@codecanvas/contracts` 的 `capability.ts`）：调用、赋值、条件。
 * 所以 `避障停止` 写出来是「读一次激光 → 如果读数小于阈值就刹停」，而不是三行平铺的调用。
 */
import type { CapabilityCatalog } from '@codecanvas/contracts';

export const PHASE1_ROBOT_CATALOG: CapabilityCatalog = {
	catalogRef: 'phase1_robot',
	displayName: '一期设备（差速底盘 + 六轴臂）',
	revisionRef: 'phase1-robot-catalog-v2',

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
			primitiveRef: 'brake',
			label: '紧急刹停',
			parameters: [],
		},
		{
			primitiveRef: 'read_scan',
			label: '读取激光',
			parameters: [{ name: 'sensors', label: '传感器', type: 'sensor' }],
			returns: 'number',
		},
		{
			primitiveRef: 'read_status',
			label: '读取运行状态',
			parameters: [],
			returns: 'string',
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
				{
					kind: 'call',
					primitiveRef: 'set_velocity',
					arguments: {
						linear: { kind: 'param', name: 'linear' },
						angular: { kind: 'param', name: 'angular' },
					},
				},
				{
					kind: 'call',
					primitiveRef: 'wait',
					arguments: { seconds: { kind: 'param', name: 'duration' } },
				},
				{ kind: 'call', primitiveRef: 'stop_motion', arguments: {} },
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
				{
					kind: 'call',
					primitiveRef: 'set_velocity',
					arguments: { linear: 0, angular: { kind: 'param', name: 'angular' } },
				},
				{
					kind: 'call',
					primitiveRef: 'wait',
					arguments: { seconds: { kind: 'param', name: 'duration' } },
				},
				{ kind: 'call', primitiveRef: 'stop_motion', arguments: {} },
			],
		},
		{
			capabilityRef: 'stop',
			label: '停止',
			kind: 'skill',
			parameters: [],
			implementation: [{ kind: 'call', primitiveRef: 'stop_motion', arguments: {} }],
		},
		{
			capabilityRef: 'stop_if_obstacle',
			label: '避障停止',
			kind: 'skill',
			parameters: [
				{ name: 'sensors', label: '传感器', type: 'sensor' },
				{ name: 'distance', label: '距离', type: 'number' },
			],
			// 读一次激光，读数小于阈值就紧急刹停——这一步是**有条件**的，所以是 if 而不是平铺的调用。
			implementation: [
				{
					kind: 'set',
					target: 'reading',
					value: {
						kind: 'call',
						primitiveRef: 'read_scan',
						arguments: { sensors: { kind: 'param', name: 'sensors' } },
					},
				},
				{
					kind: 'if',
					condition: {
						kind: 'binary',
						operator: 'lt',
						left: { kind: 'param', name: 'reading' },
						right: { kind: 'param', name: 'distance' },
					},
					then: [{ kind: 'call', primitiveRef: 'brake', arguments: {} }],
				},
			],
		},
		{
			capabilityRef: 'get_status',
			label: '读取状态',
			kind: 'skill',
			parameters: [],
			implementation: [
				{
					kind: 'set',
					target: 'status',
					value: { kind: 'call', primitiveRef: 'read_status', arguments: {} },
				},
			],
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
					kind: 'call',
					primitiveRef: 'drive_joint',
					arguments: {
						joint_id: { kind: 'param', name: 'joint_id' },
						angle: { kind: 'param', name: 'joint' },
						time: { kind: 'param', name: 'time' },
					},
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
					kind: 'call',
					primitiveRef: 'drive_joints',
					arguments: {
						joint1: { kind: 'param', name: 'joint1' },
						joint2: { kind: 'param', name: 'joint2' },
						joint3: { kind: 'param', name: 'joint3' },
						joint4: { kind: 'param', name: 'joint4' },
						joint5: { kind: 'param', name: 'joint5' },
						joint6: { kind: 'param', name: 'joint6' },
						time: { kind: 'param', name: 'time' },
					},
				},
			],
		},
	],
};
