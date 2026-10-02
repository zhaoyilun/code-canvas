/**
 * 自有主题（spec §7）：Blockly 12 + `zelos` 渲染器，颜色一律来自 `--cc-*` 变量。
 *
 * 这个文件里没有一个色值——只有「哪个部件读哪个变量」和「哪个动作读哪个变量」。
 * 需要深浅两档时用 Blockly 自己的 `colour.blend` 从变量值算，不另造颜色。
 */
import * as Blockly from 'blockly';
import type { TaskAction } from '@codecanvas/contracts';
import { ACTION_BLOCK_SHAPES, buildActionToolbox, registerActionBlocks } from './blocks';
import { fontSizeFromVariable, requireCompletePalette, type ThemePalette, type ThemeVariable } from './palette';

export const CODE_CANVAS_THEME_NAME = 'codecanvas';
/** 圆角拼图那一路观感，就是这个渲染器给的（观感要像，名字与人形形象都不沾）。 */
export const CODE_CANVAS_RENDERER = 'zelos';
export const ACTION_TOOLBOX_CATEGORY_STYLE = 'cc_task_actions';

/**
 * 动作 → 主题变量。只有名字，没有色值。
 *
 * 七个动作走七个可分辨的色相（cyan / blue / red / amber / steel / green / violet）：
 * 一眼能认出「这是转向、那是急停」，而不是一片青。深色底上的对比度由测试钉住（≥ 4.5）。
 * `get_status` 是只读查询，故意用中性的钢蓝：它在链上不表示任何动作意图。
 */
export const ACTION_COLOUR_VARIABLE: Readonly<Record<TaskAction, ThemeVariable>> = {
	move: '--cc-accent',
	turn: '--cc-block-turn',
	stop: '--cc-danger',
	stop_if_obstacle: '--cc-block-guard',
	get_status: '--cc-text-dim',
	arm_joint: '--cc-block-arm',
	arm6_joints: '--cc-block-arm6',
};

/** 副色/第三色从主色与底色混出来，不引入新色值。 */
const shadeOf = (
	primary: string,
	shade: string,
): { colourSecondary: string; colourTertiary: string } => ({
	colourSecondary: Blockly.utils.colour.blend(primary, shade, 0.35) ?? primary,
	colourTertiary: Blockly.utils.colour.blend(primary, shade, 0.55) ?? primary,
});

/** 混两个调色板里的色值（结果不外泄成新色值，只是这两个的中间态）。 */
const mix = (from: string, to: string, factor: number, fallback: string): string =>
	Blockly.utils.colour.blend(from, to, factor) ?? fallback;

/**
 * 点阵网格：在底色的方向上再压暗一档（`--cc-line` 往 `--cc-surface-sunken` 里混）。
 * 先前直接用 `--cc-line-strong`，网格比积木还抢眼；网格是坐标参考，不是主角。
 */
export const gridColour = (palette: ThemePalette): string =>
	mix(palette['--cc-line'], palette['--cc-surface-sunken'], 0.5, palette['--cc-surface-sunken']);

export const buildBlockStyles = (palette: ThemePalette): Record<string, Partial<Blockly.Theme.BlockStyle>> => {
	const shade = palette['--cc-surface-sunken'];
	const styles: Record<string, Partial<Blockly.Theme.BlockStyle>> = {};
	for (const shape of ACTION_BLOCK_SHAPES) {
		const primary = palette[ACTION_COLOUR_VARIABLE[shape.action]];
		styles[shape.style] = { colourPrimary: primary, ...shadeOf(primary, shade) };
	}
	return styles;
};

export const createCodeCanvasTheme = (palette: ThemePalette): Blockly.Theme => {
	const complete = requireCompletePalette(palette);
	const size = fontSizeFromVariable(complete);

	return Blockly.Theme.defineTheme(CODE_CANVAS_THEME_NAME, {
		name: CODE_CANVAS_THEME_NAME,
		base: Blockly.Themes.Zelos,
		startHats: true,
		blockStyles: buildBlockStyles(complete),
		categoryStyles: { [ACTION_TOOLBOX_CATEGORY_STYLE]: { colour: complete['--cc-accent'] } },
		componentStyles: {
			workspaceBackgroundColour: complete['--cc-surface-sunken'],
			toolboxBackgroundColour: complete['--cc-surface'],
			toolboxForegroundColour: complete['--cc-text'],
			flyoutBackgroundColour: complete['--cc-surface-raised'],
			flyoutForegroundColour: complete['--cc-text-dim'],
			flyoutOpacity: 1,
			scrollbarColour: complete['--cc-line-strong'],
			scrollbarOpacity: 0.65,
			insertionMarkerColour: complete['--cc-surface-raised'],
			insertionMarkerOpacity: 0.5,
			markerColour: complete['--cc-accent'],
			cursorColour: complete['--cc-accent'],
			selectedGlowColour: complete['--cc-accent'],
			selectedGlowOpacity: 0.7,
			replacementGlowColour: complete['--cc-accent-strong'],
			replacementGlowOpacity: 0.7,
		},
		fontStyle: size === null ? { family: complete['--cc-font-mono'] } : { family: complete['--cc-font-mono'], size },
	});
};

/** 注入选项：渲染器、主题、工具箱、网格与缩放。DOM 宿主由调用方给。 */
export const buildInjectOptions = (palette: ThemePalette, readOnly = false): Blockly.BlocklyOptions => {
	const complete = requireCompletePalette(palette);
	return {
		renderer: CODE_CANVAS_RENDERER,
		theme: createCodeCanvasTheme(complete),
		toolbox: buildActionToolbox(),
		trashcan: true,
		sounds: false,
		readOnly,
		grid: { spacing: 24, length: 2, colour: gridColour(complete), snap: false },
		// startScale 只是「还没量到内容之前」的起步比例：装好之后由 fitWorkspaceToContent
		// 按内容算一个能装下整条链的比例并居中（见 viewport.ts）。
		// 下限 0.45 留给用户自己缩，初始那一次不会被压到这个数以下（MIN_READABLE_SCALE）。
		zoom: { controls: true, wheel: true, startScale: 0.85, minScale: 0.45, maxScale: 1.6, pinch: true },
		move: { scrollbars: { horizontal: true, vertical: true }, drag: true, wheel: true },
	};
};

/** 建一块可用的画布：先注册七块积木，再注入工作区。 */
export const createCanvasWorkspace = (host: Element, palette: ThemePalette, readOnly = false): Blockly.WorkspaceSvg => {
	registerActionBlocks();
	return Blockly.inject(host, buildInjectOptions(palette, readOnly));
};
