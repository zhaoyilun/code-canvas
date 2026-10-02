/**
 * 测试夹具目录：**覆盖语法形态**，不覆盖任何真实设备的内容。
 *
 * 为什么不直接用 `@codecanvas/capabilities` 的 `PHASE1_ROBOT_CATALOG`：
 * `packages/capabilities/src/phase1-robot.ts` 是**示意目录**，等 RoboFrame 给出真实实现就整份替换
 * （数据结构不变）。这里的用例断言的是「界面把一棵语句树显示成什么」，跟设备写了什么无关——
 * 挂到真实目录上，目录一改断言就集体失效，那不是测试该有的耦合。
 *
 * 用法（源码里那个常量是写死的，只能从模块边界换掉）：
 *
 * ```ts
 * vi.mock('@codecanvas/capabilities', async (importOriginal) => ({
 *   ...(await importOriginal<typeof import('@codecanvas/capabilities')>()),
 *   PHASE1_ROBOT_CATALOG: FIXTURE_CATALOG,
 * }));
 * ```
 *
 * 夹具钉住的是**形状**：三种语句（`call` / `set` / `if`，含 `else` 与嵌套）、五种表达式
 * （`literal` / `param` / `call` / `binary` / `unary`）、有 `returns` 与没有的原语、标了 `integer` 的字段，
 * 以及一个「三步调用、最后一步是无参数原语」的能力（`move`）。
 *
 * 能力名与参数名跟协议里的动作对齐（`move` / `stop_if_obstacle` / `turn` / `stop` …）：示例任务用的是那些名字，
 * 而积木的单位、限值与缺省值是从协议描述推出来的，夹具目录不跟它对上，量到的就不是「推导」而是「查不到」。
 *
 * 真实目录自己只留冒烟断言，见 `../catalog-smoke.test.ts`。
 */
import type { CapabilityCatalog } from '@codecanvas/contracts';

export const FIXTURE_CATALOG: CapabilityCatalog = {
	catalogRef: 'fixture_robot',
	displayName: '夹具设备（语法形态齐全）',
	revisionRef: 'fixture-robot-v1',

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
		{ primitiveRef: 'stop_motion', label: '停止运动', parameters: [] },
		{ primitiveRef: 'brake', label: '紧急刹停', parameters: [] },
		{
			primitiveRef: 'read_scan',
			label: '读取激光',
			parameters: [{ name: 'sensors', label: '传感器', type: 'sensor' }],
			returns: 'number',
		},
		{ primitiveRef: 'read_status', label: '读取运行状态', parameters: [], returns: 'string' },
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
			// 三条语句的链，最后一条是**无参数原语**：界面上「三块积木 / 三行代码」靠它。
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
				{ kind: 'call', primitiveRef: 'wait', arguments: { seconds: { kind: 'param', name: 'duration' } } },
				{ kind: 'call', primitiveRef: 'stop_motion', arguments: {} },
			],
		},
		{
			// 实参里写死的字面量（`linear: 0`，**裸值**——画布上它是只读标签）与来自节点参数的引用并存。
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
				{ kind: 'call', primitiveRef: 'wait', arguments: { seconds: { kind: 'param', name: 'duration' } } },
				{ kind: 'call', primitiveRef: 'stop_motion', arguments: {} },
			],
		},
		{
			// 单步、无参数的原语：`stop_motion()` 一行、一块。
			capabilityRef: 'stop',
			label: '停止',
			kind: 'skill',
			parameters: [],
			implementation: [{ kind: 'call', primitiveRef: 'stop_motion', arguments: {} }],
		},
		{
			// `set` + `if`：赋值右边是**有返回值的原语调用**，条件里是比较（引用 vs 节点参数）。
			capabilityRef: 'stop_if_obstacle',
			label: '避障停止',
			kind: 'skill',
			parameters: [
				{ name: 'sensors', label: '传感器', type: 'sensor' },
				{ name: 'distance', label: '距离', type: 'number' },
			],
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
			// 赋值右边是一个**无参数**的有返回值原语：`status = read_status()`。
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
			// `integer` 字段：关节号与毫秒时长不带小数，`angle` 照旧带。
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
			// 七个参数的原语：一行一个字段。
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
		{
			/**
			 * 嵌套 `if` + `else` + `unary`：没确认过、或关节号越界就别动，否则正常驱动。
			 *
			 * 一期目录里没有这个形状，但**语法形态必须有地方覆盖**：嵌套分支与 `not` 在界面上长什么样
			 * 不该只靠「以后真出现了再说」。
			 */
			capabilityRef: 'arm_guard',
			label: '臂越界保护',
			kind: 'skill',
			parameters: [
				{ name: 'joint_id', label: '关节号', type: 'number', integer: true },
				{ name: 'angle', label: '角度', type: 'number' },
				{ name: 'time', label: '时长', type: 'number', integer: true },
				{ name: 'confirm', label: '已确认', type: 'boolean' },
			],
			implementation: [
				{
					kind: 'if',
					condition: {
						kind: 'binary',
						operator: 'or',
						left: { kind: 'unary', operator: 'not', value: { kind: 'param', name: 'confirm' } },
						right: {
							kind: 'binary',
							operator: 'lt',
							left: { kind: 'param', name: 'joint_id' },
							right: { kind: 'literal', value: 1 },
						},
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
							then: [{ kind: 'call', primitiveRef: 'stop_motion', arguments: {} }],
							else: [
								{
									kind: 'call',
									primitiveRef: 'drive_joint',
									arguments: {
										joint_id: { kind: 'param', name: 'joint_id' },
										angle: { kind: 'param', name: 'angle' },
										time: { kind: 'param', name: 'time' },
									},
								},
							],
						},
					],
				},
			],
		},
	],
};
