/**
 * 测试夹具目录：**覆盖语法形态**，不覆盖任何真实设备的内容。
 *
 * 为什么不直接用 `PHASE1_ROBOT_CATALOG`：`packages/capabilities/src/phase1-robot.ts` 是**示意目录**，
 * 等 RoboFrame 给出真实实现就整份替换（数据结构不变）。这里的用例断言的是「渲染器怎么处理一棵语句树」，
 * 不是「一期设备的实现写了什么」——挂到真实目录上，目录一改断言就集体失效，那不是测试该有的耦合。
 *
 * 夹具钉住的是**形状**（这是它存在的理由）：
 * - 三种语句：`call` / `set` / `if`，其中 `if` 有带 `else` 的、也有嵌套的（`arm_guard`）；
 * - 五种表达式：`literal` / `param` / `call` / `binary` / `unary`；
 * - 有 `returns` 的原语（`read_scan` / `read_status`）与没有的（`set_velocity` / `wait` / `stop_motion` / `brake` / `drive_*`）；
 * - 标了 `integer` 的字段（`drive_joint.joint_id` / `drive_joint.time` / `drive_joints.time`）；
 * - 一个「三步调用、最后一步是无参数原语」的能力（`move`，多条断言依赖这个形态）。
 *
 * 真实目录自己只留冒烟断言（见 `catalog-smoke.test.ts`）：内容对不对归
 * `packages/capabilities/test/catalog.test.ts` 那份自检，不归这里。
 */
import {
	computeWorkflowDigest,
	DEFAULT_LIMITS,
	WORKFLOW_FORMAT_VERSION,
	type CapabilityCatalog,
	type JsonObject,
	type WorkflowDeclaration,
	type WorkflowDeclarationDraft,
	type WorkflowNode,
} from '@codecanvas/contracts';

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
			// 三条语句的链，最后一条是**无参数原语**——面板上「三步：下发速度 → 等待 → 停止运动」靠它。
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
			// 实参里写死的字面量（`linear: 0`，**裸值**）与来自节点参数的引用并存：改节点参数不动前者。
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
			// 单步、无参数的原语：`stop_motion()`（空括号里不留空格）。
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
			 * 一期目录里没有这个形状（它的实现里只有一个能力用到了 `else`），但**语法形态必须有地方覆盖**：
			 * 嵌套分支与 `not` 的缩进/括号规则不该只靠「以后真出现了再说」。
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
		{
			/**
			 * 实参位置引用**局部变量**：先把参数夹一次限速，再拿夹过的值当下发速度的实参。
			 *
			 * 这条形态曾经漏掉过——渲染器当时认为「实参位置写不出变量名」，于是回退去查节点字段，
			 * 把 `speed` 渲染成了 `null`。夹具里必须有它，否则这条路没人守。
			 */
			capabilityRef: 'clamped_move',
			label: '限速前进',
			kind: 'skill',
			parameters: [
				{ name: 'linear', label: '线速度', type: 'number' },
				{ name: 'duration', label: '时长', type: 'number' },
			],
			implementation: [
				{ kind: 'set', target: 'speed', value: { kind: 'param', name: 'linear' } },
				{
					kind: 'if',
					condition: {
						kind: 'binary',
						operator: 'gt',
						left: { kind: 'param', name: 'speed' },
						right: { kind: 'literal', value: 0.3 },
					},
					then: [{ kind: 'set', target: 'speed', value: { kind: 'literal', value: 0.3 } }],
				},
				{
					kind: 'call',
					primitiveRef: 'set_velocity',
					arguments: {
						linear: { kind: 'param', name: 'speed' },
						angular: { kind: 'literal', value: 0 },
					},
				},
				{
					kind: 'call',
					primitiveRef: 'wait',
					arguments: { seconds: { kind: 'param', name: 'duration' } },
				},
			],
		},
	],
};

// ---------------------------------------------------------------------------
// 造输入的两个小工具（渲染用例与冒烟用例共用，免得「怎么造一个节点」有两份口径）
// ---------------------------------------------------------------------------

/** 手工造一个动作节点；`parameters` 是不透明载荷，节点身份给个默认值。 */
export const fixtureNode = (parameters: JsonObject, overrides: Partial<WorkflowNode> = {}): WorkflowNode => ({
	id: overrides.id ?? 'nd_1',
	name: overrides.name ?? '测试节点',
	type: 'task.action',
	typeVersion: 1,
	parameters,
	position: { x: 0, y: 0 },
	disabled: false,
	...overrides,
});

/** 手工造的声明默认带一份协议缺省限值，免得每条用例都吃一条 limits 缺失的诊断。 */
export const META_WITH_LIMITS: JsonObject = { limits: { ...DEFAULT_LIMITS } };

export const fixtureDeclarationOf = (
	nodes: readonly WorkflowNode[],
	meta: JsonObject = META_WITH_LIMITS,
): WorkflowDeclaration => {
	const draft: WorkflowDeclarationDraft = {
		formatVersion: WORKFLOW_FORMAT_VERSION,
		id: 'wf_test',
		name: '测试声明',
		nodes: [...nodes],
		connections: {},
		meta,
	};
	return { ...draft, digest: computeWorkflowDigest(draft) };
};
