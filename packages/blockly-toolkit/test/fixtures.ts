/**
 * 测试夹具：一份覆盖七种动作的任务 JSON、一份确定性的声明、一份从真实 `theme.css` 读出的调色板。
 *
 * 调色板刻意**不在这里写色值**——它从 `apps/studio/src/shell/theme.css` 里解析出来，
 * 这样「主题色来自哪」在测试里也是可核对的。
 */
import { readFileSync } from 'node:fs';
import type * as Blockly from 'blockly';
import { createDeterministicIdFactory, type WorkflowDeclaration } from '@codecanvas/contracts';
import { importTask } from '@codecanvas/task-import';
import { paletteFromCssVariables, type ThemePalette } from '../src/palette';

/** 七个动作一样一个，顺序按协议；总时长 7s < max_duration 30s。 */
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

export const FIXTURE_ID_FACTORY = createDeterministicIdFactory({ seed: 'blockly-toolkit' });

export const fixtureDeclaration = (): WorkflowDeclaration => {
	const result = importTask(FIXTURE_TASK, { idFactory: FIXTURE_ID_FACTORY });
	if (!result.ok) throw new Error(`夹具任务应当合法：${result.diagnostics.map((d) => d.message).join('; ')}`);
	return result.declaration;
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

/** 工具箱里第一个静态分类（测试用；Blockly 的联合类型要收窄一次）。 */
export const firstToolboxCategory = (
	toolbox: Blockly.utils.toolbox.ToolboxInfo,
): Blockly.utils.toolbox.StaticCategoryInfo | null => {
	const first = toolbox.contents[0];
	if (first === undefined || first.kind !== 'category' || !('contents' in first)) return null;
	return first;
};

/** 分类里的积木类型，顺序即摆放顺序。 */
export const toolboxBlockTypes = (toolbox: Blockly.utils.toolbox.ToolboxInfo): readonly (string | undefined)[] => {
	const category = firstToolboxCategory(toolbox);
	if (category === null) return [];
	return category.contents.map((item) => (item.kind === 'block' && 'type' in item ? item.type : undefined));
};
