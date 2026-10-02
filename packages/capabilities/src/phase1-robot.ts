/**
 * 一期设备的能力目录：底盘动作 + 六轴臂动作。
 *
 * ⚠ **这份 `implementation` 是示意，不是设备真实逻辑。** 一期协议（`docs/reference/task_protocol.py`）
 * 只规定「要做什么」和参数范围，没有任何「怎么做」的信息；真实实现在 RoboFrame / 设备侧。
 * 这里手写一份，是为了让「点一个模块 → 看到它的实现」在演示上像那么回事：
 * 限速保护、条件刹停、参数兜底这些真实控制器里会有的动作，都写进去。
 * 等 RoboFrame 能给出真正的实现，换掉这个文件即可，数据结构不用动。
 *
 * 实现的形状是**语句树**（见 `@codecanvas/contracts` 的 `capability.ts`）。
 */
import type { CapabilityCatalog } from '@codecanvas/contracts';

/** 安全上限：线速度 0.3 m/s、角速度 1.2 rad/s —— 与协议 DEFAULT_LIMITS 一致。 */
const MAX_LINEAR = 0.3;
const MAX_ANGULAR = 1.2;

export const PHASE1_ROBOT_CATALOG: CapabilityCatalog = {
	catalogRef: 'phase1_robot',
	displayName: '一期设备（差速底盘 + 六轴臂）',
	revisionRef: 'phase1-robot-catalog-v3',

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
			// 先把速度夹到安全上限，再下发、走满时长、收尾停住。
			implementation: [
				{
					kind: 'set',
					target: 'speed',
					value: { kind: 'param', name: 'linear' },
				},
				{
					kind: 'if',
					condition: {
						kind: 'binary',
						operator: 'gt',
						left: { kind: 'param', name: 'speed' },
						right: { kind: 'literal', value: MAX_LINEAR },
					},
					then: [
						{ kind: 'set', target: 'speed', value: { kind: 'literal', value: MAX_LINEAR } },
					],
				},
				{
					kind: 'call',
					primitiveRef: 'set_velocity',
					arguments: {
						linear: { kind: 'param', name: 'speed' },
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
			// 原地转：线速度恒为 0，角速度同样要先夹上限。
			implementation: [
				{ kind: 'set', target: 'rate', value: { kind: 'param', name: 'angular' } },
				{
					kind: 'if',
					condition: {
						kind: 'binary',
						operator: 'gt',
						left: { kind: 'param', name: 'rate' },
						right: { kind: 'literal', value: MAX_ANGULAR },
					},
					then: [
						{ kind: 'set', target: 'rate', value: { kind: 'literal', value: MAX_ANGULAR } },
					],
				},
				{
					kind: 'call',
					primitiveRef: 'set_velocity',
					arguments: { linear: { kind: 'literal', value: 0 }, angular: { kind: 'param', name: 'rate' } },
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
			implementation: [
				{ kind: 'call', primitiveRef: 'stop_motion', arguments: {} },
				{ kind: 'call', primitiveRef: 'brake', arguments: {} },
			],
		},
		{
			capabilityRef: 'stop_if_obstacle',
			label: '避障停止',
			kind: 'skill',
			parameters: [
				{ name: 'sensors', label: '传感器', type: 'sensor' },
				{ name: 'distance', label: '距离', type: 'number' },
			],
			// 读一次激光；读数小于阈值就刹停并收尾。
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
					then: [
						{ kind: 'call', primitiveRef: 'brake', arguments: {} },
						{ kind: 'call', primitiveRef: 'stop_motion', arguments: {} },
					],
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
				{
					kind: 'if',
					condition: {
						kind: 'binary',
						operator: 'eq',
						left: { kind: 'param', name: 'status' },
						right: { kind: 'literal', value: 'error' },
					},
					then: [{ kind: 'call', primitiveRef: 'stop_motion', arguments: {} }],
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
			// 关节号越界就别动，免得把臂送到不该去的地方；否则正常驱动。
			implementation: [
				{
					kind: 'if',
					condition: {
						kind: 'binary',
						operator: 'lt',
						left: { kind: 'param', name: 'joint_id' },
						right: { kind: 'literal', value: 1 },
					},
					then: [{ kind: 'call', primitiveRef: 'brake', arguments: {} }],
					else: [
						{
							kind: 'if',
							condition: {
								kind: 'binary',
								operator: 'gt',
								left: { kind: 'param', name: 'joint_id' },
								right: { kind: 'literal', value: 6 },
							},
							then: [{ kind: 'call', primitiveRef: 'brake', arguments: {} }],
							else: [
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
					],
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
			// 动作时长有下限（太短会让电机跟不上），先兜住再下发六个角度。
			implementation: [
				{
					kind: 'set',
					target: 'duration',
					value: { kind: 'param', name: 'time' },
				},
				{
					kind: 'if',
					condition: {
						kind: 'binary',
						operator: 'lt',
						left: { kind: 'param', name: 'duration' },
						right: { kind: 'literal', value: 100 },
					},
					then: [{ kind: 'set', target: 'duration', value: { kind: 'literal', value: 100 } }],
				},
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
						time: { kind: 'param', name: 'duration' },
					},
				},
			],
		},
	],
};
