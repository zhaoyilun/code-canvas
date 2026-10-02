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

/** 动作 → 主题变量。只有名字，没有色值。 */
export const ACTION_COLOUR_VARIABLE: Readonly<Record<TaskAction, ThemeVariable>> = {
	move: '--cc-accent',
	turn: '--cc-accent-strong',
	stop: '--cc-danger',
	stop_if_obstacle: '--cc-line-strong',
	get_status: '--cc-text-faint',
	arm_joint: '--cc-accent-dim',
	arm6_joints: '--cc-accent-dim',
};

/** 副色/第三色从主色与底色混出来，不引入新色值。 */
const shadeOf = (
	primary: string,
	shade: string,
): { colourSecondary: string; colourTertiary: string } => ({
	colourSecondary: Blockly.utils.colour.blend(primary, shade, 0.35) ?? primary,
	colourTertiary: Blockly.utils.colour.blend(primary, shade, 0.55) ?? primary,
});

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
		grid: { spacing: 24, length: 3, colour: complete['--cc-line-strong'], snap: false },
		zoom: { controls: true, wheel: true, startScale: 0.7, minScale: 0.4, maxScale: 1.6, pinch: true },
		move: { scrollbars: { horizontal: true, vertical: true }, drag: true, wheel: true },
	};
};

/** 建一块可用的画布：先注册七块积木，再注入工作区。 */
export const createCanvasWorkspace = (host: Element, palette: ThemePalette, readOnly = false): Blockly.WorkspaceSvg => {
	registerActionBlocks();
	return Blockly.inject(host, buildInjectOptions(palette, readOnly));
};
