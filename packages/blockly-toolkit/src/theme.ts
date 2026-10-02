/**
 * 自有主题（spec §7）：Blockly 12 + `zelos` 渲染器，颜色一律来自 `--cc-*` 变量。
 *
 * 这个文件里没有一个色值——只有「哪个部件读哪个变量」和「哪个能力读哪个变量」。
 * 需要深浅两档时用 Blockly 自己的 `colour.blend` 从变量值算，不另造颜色。
 *
 * 积木的色按**能力**分（一块积木属于哪个模块，就是那个模块的色）：
 * 一个模块的实现全是一个色系，跟流程画布上那张卡是同一个色——跨栏看过去，「这一坨是它内部的」。
 */
import * as Blockly from 'blockly';
import { ALLOWED_ACTIONS, type CapabilityCatalog, type TaskAction } from '@codecanvas/contracts';
import { blockStyleName, registerImplementationBlocks } from './blocks';
import { fontSizeFromVariable, requireCompletePalette, type ThemePalette, type ThemeVariable } from './palette';

export const CODE_CANVAS_THEME_NAME = 'codecanvas';
/** 圆角拼图那一路观感，就是这个渲染器给的（观感要像，名字与人形形象都不沾）。 */
export const CODE_CANVAS_RENDERER = 'zelos';

/**
 * 能力 → 主题变量。只有名字，没有色值。
 *
 * 一期目录里的能力名恰好就是任务协议的动作名，于是每个能力走一个可分辨的色相
 * （cyan / blue / red / amber / steel / green / violet）：一眼能认出「这是转向、那是急停」。
 * 深色底上的对比度由测试钉住（≥ 4.5）。目录里将来出现别的能力时落到强调色上，
 * 不在这里凭空编第八种颜色。
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

const isTaskAction = (value: string): value is TaskAction => (ALLOWED_ACTIONS as readonly string[]).includes(value);

/** 能力引用 → 主题变量：认得的是协议里的七个动作，其余落到强调色。 */
export const capabilityColourVariable = (capabilityRef: string): ThemeVariable =>
	isTaskAction(capabilityRef) ? ACTION_COLOUR_VARIABLE[capabilityRef] : '--cc-accent';

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

/** 目录里每个能力一个 blockStyle（能力实现里的每一步都长这个色）。 */
export const buildBlockStyles = (
	palette: ThemePalette,
	catalog: CapabilityCatalog,
): Record<string, Partial<Blockly.Theme.BlockStyle>> => {
	const shade = palette['--cc-surface-sunken'];
	const styles: Record<string, Partial<Blockly.Theme.BlockStyle>> = {};
	for (const capability of catalog.capabilities) {
		const primary = palette[capabilityColourVariable(capability.capabilityRef)];
		styles[blockStyleName(capability.capabilityRef)] = { colourPrimary: primary, ...shadeOf(primary, shade) };
	}
	return styles;
};

export const createCodeCanvasTheme = (palette: ThemePalette, catalog: CapabilityCatalog): Blockly.Theme => {
	const complete = requireCompletePalette(palette);
	const size = fontSizeFromVariable(complete);

	return Blockly.Theme.defineTheme(CODE_CANVAS_THEME_NAME, {
		name: CODE_CANVAS_THEME_NAME,
		base: Blockly.Themes.Zelos,
		startHats: true,
		blockStyles: buildBlockStyles(complete, catalog),
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

/**
 * 注入选项：渲染器、主题、网格与缩放。DOM 宿主由调用方给。
 *
 * **故意没有工具箱**：画布显示的是目录给的实现，结构只读——
 * 「往里拖一块新积木」在新模型下等于「改实现」，而实现不归画布管（spec §4.1 只给了参数这一条写路径）。
 * 因此也不给垃圾桶：块删不掉。
 */
export const buildInjectOptions = (
	palette: ThemePalette,
	catalog: CapabilityCatalog,
	readOnly = false,
): Blockly.BlocklyOptions => {
	const complete = requireCompletePalette(palette);
	return {
		renderer: CODE_CANVAS_RENDERER,
		theme: createCodeCanvasTheme(complete, catalog),
		trashcan: false,
		sounds: false,
		readOnly,
		grid: { spacing: 24, length: 2, colour: gridColour(complete), snap: false },
		// startScale 只是「还没量到内容之前」的起步比例：装好之后由 fitWorkspaceToContent
		// 按内容算一个能装下整条实现链的比例并居中（见 viewport.ts）。
		// 下限 0.45 留给用户自己缩，初始那一次不会被压到这个数以下（MIN_READABLE_SCALE）。
		zoom: { controls: true, wheel: true, startScale: 0.85, minScale: 0.45, maxScale: 1.6, pinch: true },
		move: { scrollbars: { horizontal: true, vertical: true }, drag: true, wheel: true },
	};
};

/** 建一块可用的画布：先按目录注册实现积木，再注入工作区。 */
export const createCanvasWorkspace = (
	host: Element,
	palette: ThemePalette,
	catalog: CapabilityCatalog,
	readOnly = false,
): Blockly.WorkspaceSvg => {
	registerImplementationBlocks(catalog);
	return Blockly.inject(host, buildInjectOptions(palette, catalog, readOnly));
};
