/**
 * 测试夹具：一份覆盖七个能力的任务 JSON、一份确定性的声明、一份**夹具能力目录**，
 * 外加一份**故意有缺陷**的目录（悬空引用 / 未知原语 / 漏给实参），以及从真实 `theme.css` 读出的调色板。
 *
 * 调色板刻意**不在这里写色值**——它从 `apps/studio/src/shell/theme.css` 里解析出来，
 * 这样「主题色来自哪」在测试里也是可核对的。
 *
 * **能力目录是夹具，不是 `PHASE1_ROBOT_CATALOG`**：`packages/capabilities/src/phase1-robot.ts` 是示意目录，
 * 等 RoboFrame 给出真实实现就整份替换（数据结构不变）。这里的用例断言的是「积木从目录推导」这条规则，
 * 跟设备写了什么无关——挂到真实目录上，目录一改断言就集体失效。真实目录只留冒烟断言，见 `catalog-smoke.test.ts`。
 *
 * 夹具钉住的是**形状**：四种语句（`call` / `set` / `if`，含 `else` 与嵌套 / `delegate`）、五种表达式
 * （`literal` / `param` / `call` / `binary` / `unary`）、有 `returns` 与没有的原语、标了 `integer` 的字段，
 * 以及一个「三步调用、最后一步是无参数原语」的能力（`move`）。
 *
 * 任务 JSON 仍用协议里的七个动作名与参数名：任务那侧的真值来自 `@codecanvas/contracts` 的协议描述
 * （单位、限值、缺省值都从那儿推），夹具目录要跟它对得上。
 */
import { readFileSync } from 'node:fs';
import type * as Blockly from 'blockly';
import { createDeterministicIdFactory, type CapabilityCatalog, type WorkflowDeclaration, type WorkflowNode } from '@codecanvas/contracts';
import { importTask } from '@codecanvas/task-import';
import { identityOfBlock } from '../src/identity';
import { paletteFromCssVariables, type ThemePalette } from '../src/palette';

/** 七个能力一样一个，顺序按协议；总时长 7s < max_duration 30s。 */
export const FIXTURE_TASK = {
	schema_version: '1.0',
	task_id: 'task-blockly-001',
	description: '前进，避障停止，转向，抬臂',
	steps: [
		{ id: 's1', action: 'move', linear: 0.2, angular: 0, duration: 5.0 },
		{ id: 's2', action: 'stop_if_obstacle', sensors: ['/scan0'], distance: 0.5 },
		{ id: 's3', action: 'turn', angular: 0.8, duration: 2.0 },
		{ id: 's4', action: 'stop' },
		{ id: 's5', action: 'get_status' },
		{ id: 's6', action: 'arm_joint', joint_id: 3, joint: 90, time: 1500 },
		{
			id: 's7',
			action: 'arm6_joints',
			joint1: 0,
			joint2: 10,
			joint3: 20,
			joint4: 30,
			joint5: 40,
			joint6: 50,
			time: 2000,
		},
	],
	limits: { max_linear: 0.3, max_angular: 1.2, max_duration: 30.0, require_confirmation: true },
};

/**
 * 夹具目录：**覆盖语法形态**，不覆盖任何真实设备的内容（理由见文件头）。
 *
 * 原语名与参数名跟一期协议里的动作对齐（`set_velocity` / `wait` / `stop_motion` / `brake` /
 * `read_scan` / `read_status` / `drive_joint` / `drive_joints`），因为积木的单位、限值与缺省值
 * 是从协议描述推出来的——夹具目录不跟它对上，量到的就不是「推导」而是「查不到」。
 */
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
			// 三条语句的链，最后一条是**无参数原语**：三块积木串成一条链靠它。
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
			// 实参里写死的字面量（`linear: 0`，**裸值**不是表达式——画布上它是只读标签）与来自节点参数的引用并存。
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
			// 单步、无参数的原语：零行字段。
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
			// `integer` 字段：关节号与毫秒时长取整，`angle` 照旧可小数。
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
			// 七个参数的原语：一行一个字段（七行）。
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
			 * 一期目录里没有这个形状，但**语法形态必须有地方覆盖**：嵌套分支的 C 形块与 `not` 的写法
			 * 不该只靠「以后真出现了再说」。（这个能力名不在协议里，所以积木不挂协议给的单位与限值。）
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
			 * **委托**：实现在执行侧，模板里只有接口名与交出去的实参
			 * （上游 `pick_object` 的 `executor` 是 `grasp_pipeline`，`primitive_sequence` 是空的）。
			 */
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
		},
		{
			/**
			 * 委托**嵌在 `else` 里**，且能力参数比交出去的实参多一个（`confirm` 由条件用掉）：
			 * 路径（`0.else.0`）、缩进、以及「只把交出去的参数摆成字段」三件事一起钉住。
			 */
			capabilityRef: 'guarded_pick',
			label: '确认后抓取',
			kind: 'skill',
			parameters: [
				{ name: 'target_name', label: '目标物', type: 'string' },
				{ name: 'confirm', label: '已确认', type: 'boolean' },
			],
			implementation: [
				{
					kind: 'if',
					condition: { kind: 'unary', operator: 'not', value: { kind: 'param', name: 'confirm' } },
					then: [{ kind: 'call', primitiveRef: 'brake', arguments: {} }],
					else: [
						{
							kind: 'delegate',
							interfaceRef: '/manipulation/execute_pick',
							arguments: { target_name: { kind: 'param', name: 'target_name' } },
						},
					],
				},
			],
		},
	],
};

/**
 * 故意有缺陷的目录：一条实现里塞了四种目录毛病。
 * 每一条都必须在画布上留下可核对的痕迹，而不是被悄悄吞掉。
 */
export const BROKEN_CATALOG: CapabilityCatalog = {
	catalogRef: 'broken_fixture',
	displayName: '缺陷夹具',
	revisionRef: 'broken-fixture-v1',
	primitives: [
		{ primitiveRef: 'wait', label: '等待', parameters: [{ name: 'seconds', label: '时长', type: 'number' }] },
		{
			primitiveRef: 'read_scan',
			label: '读取激光',
			parameters: [{ name: 'sensors', label: '传感器', type: 'sensor' }],
			returns: 'number',
		},
	],
	capabilities: [
		{
			capabilityRef: 'move',
			label: '前进',
			kind: 'skill',
			parameters: [
				{ name: 'duration', label: '时长', type: 'number' },
				{ name: 'sensors', label: '传感器', type: 'sensor' },
			],
			implementation: [
				// 正常那一步：`{kind:'param'}` 指向能力参数，可写。
				{ kind: 'call', primitiveRef: 'wait', arguments: { seconds: { kind: 'param', name: 'duration' } } },
				// 悬空引用：能力参数表里没有 missing，实现里也没有 set 过它。
				{ kind: 'call', primitiveRef: 'wait', arguments: { seconds: { kind: 'param', name: 'missing' } } },
				// 漏给实参：原语要 seconds，实现里没写。
				{ kind: 'call', primitiveRef: 'wait', arguments: {} },
				// 目录里根本没有这个原语（语句位置）。
				{ kind: 'call', primitiveRef: 'fly', arguments: {} },
				// 同上，但嵌在赋值的值里（表达式位置）。
				{
					kind: 'set',
					target: 'reading',
					value: { kind: 'call', primitiveRef: 'fly', arguments: {} },
				},
				// 类型进不了表达式的参数：`sensors` 是 sensor，契约只认 number / string / boolean。
				{
					kind: 'set',
					target: 'copy',
					value: { kind: 'param', name: 'sensors' },
				},
			],
		},
	],
};

export const FIXTURE_ID_FACTORY = createDeterministicIdFactory({ seed: 'blockly-toolkit' });

export const fixtureDeclaration = (): WorkflowDeclaration => {
	const result = importTask(FIXTURE_TASK, { idFactory: FIXTURE_ID_FACTORY });
	if (!result.ok) throw new Error(`夹具任务应当合法：${result.diagnostics.map((d) => d.message).join('; ')}`);
	return result.declaration;
};

/** 声明里 `step_id === stepId` 的那个节点。 */
export const nodeOfStep = (declaration: WorkflowDeclaration, stepId: string): WorkflowNode => {
	const node = declaration.nodes.find((candidate) => candidate.parameters['step_id'] === stepId);
	if (node === undefined) throw new Error(`声明里没有步骤 ${stepId}`);
	return node;
};

const THEME_CSS_URL = new URL('../../../apps/studio/src/shell/theme.css', import.meta.url);

export const themeCssText = (): string => readFileSync(THEME_CSS_URL, 'utf8');

/**
 * 从主题样式表里把 `--cc-*` 变量读成一张表，并把 `var(--x)` 的间接引用展开。
 *
 * 浏览器里 `getComputedStyle` 给的就是展开后的计算值，所以测试也展开——
 * 否则 `--cc-highlight: var(--cc-accent)` 会被当成一个色值字符串喂给 Blockly。
 */
export const cssVariablesFromTheme = (): ReadonlyMap<string, string> => {
	const raw = new Map<string, string>();
	const pattern = /(--cc-[a-z0-9-]+)\s*:\s*([^;]+);/g;
	for (const match of themeCssText().matchAll(pattern)) {
		const name = match[1];
		const value = match[2];
		if (name === undefined || value === undefined) continue;
		raw.set(name, value.trim());
	}
	const resolved = new Map<string, string>();
	const resolve = (name: string, depth = 0): string => {
		const done = resolved.get(name);
		if (done !== undefined) return done;
		const value = raw.get(name) ?? '';
		const reference = depth < 8 ? /^var\((--cc-[a-z0-9-]+)\)$/.exec(value) : null;
		const final = reference?.[1] === undefined ? value : resolve(reference[1], depth + 1);
		resolved.set(name, final);
		return final;
	};
	for (const name of raw.keys()) resolve(name);
	return resolved;
};

/** 真实主题变量 → 调色板。缺变量这里就会空出来，由 `requireCompletePalette` 拦。 */
export const fixturePalette = (): ThemePalette => {
	const variables = cssVariablesFromTheme();
	return paletteFromCssVariables({ getPropertyValue: (name) => variables.get(name) ?? '' });
};

export const fixtureSource = (): { getPropertyValue: (name: string) => string } => {
	const variables = cssVariablesFromTheme();
	return { getPropertyValue: (name) => variables.get(name) ?? '' };
};

/**
 * 工作区里那一棵树 → 可读的一行行（断言与交付报告共用同一份证据）。
 *
 * 每一行是 `<下标路径> <节点标签> [字段]`，缩进就是嵌进哪个输入：
 * 这正是「积木到底长成了什么形状」最直接的证据，不靠截图认。
 */
export const outlineOf = (workspace: Blockly.Workspace): readonly string[] => {
	const lines: string[] = [];
	const walk = (block: Blockly.Block, depth: number): void => {
		const identity = identityOfBlock(block);
		const fields = block.inputList.flatMap((input) =>
			input.fieldRow.flatMap((field) =>
				field.name === undefined || field.name === null || field.name === ''
					? []
					: [`${field.name}=${String(block.getFieldValue(field.name))}`],
			),
		);
		lines.push(
			`${'  '.repeat(depth)}${identity?.stepPath ?? block.type} ${identity?.nodeTag ?? '?'} [${fields.join(' ')}]`,
		);
		for (const input of block.inputList) {
			const target = input.connection?.targetBlock();
			if (target === null || target === undefined) continue;
			lines.push(`${'  '.repeat(depth + 1)}${input.name}:`);
			walk(target, depth + 2);
		}
		// 下一条语句（`next` 不在 inputList 里，是块自己的连接）。
		const next = block.getNextBlock();
		if (next !== null) walk(next, depth);
	};
	for (const top of workspace.getTopBlocks(true)) walk(top, 0);
	return lines;
};

/** 按 `data.stepPath` 找一块积木（嵌套的也在里面）。 */
export const blockAtPath = (workspace: Blockly.Workspace, stepPath: string): Blockly.Block | null =>
	workspace.getAllBlocks(false).find((block) => identityOfBlock(block)?.stepPath === stepPath) ?? null;
