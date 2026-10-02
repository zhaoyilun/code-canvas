/**
 * 测试夹具：一份覆盖七个能力的任务 JSON、一份确定性的声明、真实的一期设备目录，
 * 外加一份**故意有缺陷**的目录（悬空引用 / 未知原语 / 漏给实参），以及从真实 `theme.css` 读出的调色板。
 *
 * 调色板刻意**不在这里写色值**——它从 `apps/studio/src/shell/theme.css` 里解析出来，
 * 这样「主题色来自哪」在测试里也是可核对的。
 *
 * 能力目录直接用 `packages/capabilities` 的那一份（应用用的就是它）：
 * 「积木从目录推导」这条如果只对一个自造的迷你目录成立，就不算数。
 */
import { readFileSync } from 'node:fs';
import type * as Blockly from 'blockly';
import { createDeterministicIdFactory, type CapabilityCatalog, type WorkflowDeclaration, type WorkflowNode } from '@codecanvas/contracts';
import { PHASE1_ROBOT_CATALOG } from '@codecanvas/capabilities';
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

/** 应用里用的那份目录（`packages/capabilities`）。 */
export const FIXTURE_CATALOG: CapabilityCatalog = PHASE1_ROBOT_CATALOG;

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
