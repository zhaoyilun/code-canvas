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
import { createDeterministicIdFactory, type CapabilityCatalog, type WorkflowDeclaration, type WorkflowNode } from '@codecanvas/contracts';
import { PHASE1_ROBOT_CATALOG } from '@codecanvas/capabilities';
import { importTask } from '@codecanvas/task-import';
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
 * 故意有缺陷的目录：一条实现里塞了三种目录毛病。
 * 每一条都必须在画布上留下可核对的痕迹，而不是被悄悄吞掉。
 */
export const BROKEN_CATALOG: CapabilityCatalog = {
	catalogRef: 'broken_fixture',
	displayName: '缺陷夹具',
	revisionRef: 'broken-fixture-v1',
	primitives: [
		{ primitiveRef: 'wait', label: '等待', parameters: [{ name: 'seconds', label: '时长', type: 'number' }] },
		{ primitiveRef: 'read_scan', label: '读取激光', parameters: [{ name: 'sensor', label: '传感器', type: 'sensor' }] },
	],
	capabilities: [
		{
			capabilityRef: 'move',
			label: '前进',
			kind: 'skill',
			parameters: [{ name: 'duration', label: '时长', type: 'number' }],
			implementation: [
				{ step: 'wait', arguments: { seconds: '$duration' } },
				// 悬空引用：能力参数表里没有 missing。
				{ step: 'wait', arguments: { seconds: '$missing' } },
				// 漏给实参：原语要 seconds，实现里没写。
				{ step: 'wait', arguments: {} },
				// 目录里根本没有这个原语。
				{ step: 'fly', arguments: {} },
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

/** 从主题样式表里把 `--cc-*` 变量读成一张表。 */
export const cssVariablesFromTheme = (): ReadonlyMap<string, string> => {
	const variables = new Map<string, string>();
	const pattern = /(--cc-[a-z0-9-]+)\s*:\s*([^;]+);/g;
	for (const match of themeCssText().matchAll(pattern)) {
		const name = match[1];
		const value = match[2];
		if (name === undefined || value === undefined) continue;
		variables.set(name, value.trim());
	}
	return variables;
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
