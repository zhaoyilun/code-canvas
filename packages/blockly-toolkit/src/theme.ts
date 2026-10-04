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
import {
	fontSizeFromVariable,
	paletteFromDocument,
	requireCompletePalette,
	type ThemePalette,
	type ThemeVariable,
} from './palette';

export const CODE_CANVAS_THEME_NAME = 'codecanvas';
/** 圆角拼图那一路观感，就是这个渲染器给的（观感要像，名字与人形形象都不沾）。 */
export const CODE_CANVAS_RENDERER = 'zelos';

/**
 * 能力的**描边色**变量：一眼认出「这是转向、那是急停」靠的是它。
 *
 * 为什么是描边而不是块面：块面铺满时，亮色会把字吃掉（白字压满饱和青只有 1.57:1）。
 * 现在块面统一走 `--cc-block-fill`（深宝石），色相身份交给这一圈描边——
 * 深色底上描边 4.9–7.6 : 1、字压块面 5.97–7.66 : 1，两边都过。
 *
 * 一期目录里的能力名恰好就是任务协议的动作名，于是每个能力走一个可分辨的色相；
 * 目录里将来出现别的能力时落到 `--cc-block-edge` 上，不在这里凭空编第八种颜色。
 */
export const ACTION_COLOUR_VARIABLE: Readonly<Record<TaskAction, ThemeVariable>> = {
	move: '--cc-block-edge',
	turn: '--cc-block-turn',
	stop: '--cc-block-stop-edge',
	stop_if_obstacle: '--cc-block-guard',
	get_status: '--cc-text-dim',
	arm_joint: '--cc-block-arm',
	arm6_joints: '--cc-block-arm6',
};

const isTaskAction = (value: string): value is TaskAction => (ALLOWED_ACTIONS as readonly string[]).includes(value);

/** 能力引用 → 描边色变量：认得的是协议里的七个动作，其余落到通用描边上。 */
export const capabilityColourVariable = (capabilityRef: string): ThemeVariable =>
	isTaskAction(capabilityRef) ? ACTION_COLOUR_VARIABLE[capabilityRef] : '--cc-block-edge';

/** 块面与描边成对：块面永远退到深宝石，描边带色相。 */
const STYLE_COLOURS: Readonly<Record<string, { fill: ThemeVariable; edge: ThemeVariable }>> = {
	move: { fill: '--cc-block-fill', edge: '--cc-block-edge' },
	turn: { fill: '--cc-block-fill', edge: '--cc-block-turn' },
	stop: { fill: '--cc-block-stop', edge: '--cc-block-stop-edge' },
	stop_if_obstacle: { fill: '--cc-block-fill', edge: '--cc-block-guard' },
	get_status: { fill: '--cc-block-value', edge: '--cc-text-dim' },
	arm_joint: { fill: '--cc-block-fill', edge: '--cc-block-arm' },
	arm6_joints: { fill: '--cc-block-fill', edge: '--cc-block-arm6' },
};

/**
 * 教学规格块树用的那几类块，原先借用的是 Blockly 自带主题的样式名
 * （`spec-canvas.ts` 里写的就是这五个），而自有主题从没覆写它们——
 * 于是画布上冒出原生橄榄黄、番茄红、砖红、深绿，与全站色系无关，字还压在亮面上。
 * 这里把五个名字接管过来，指向我们自己的块面色。
 */
export const SPEC_BLOCK_STYLE_VARIABLE: Readonly<Record<string, ThemeVariable>> = {
	logic_blocks: '--cc-block-logic',
	loop_blocks: '--cc-block-loop',
	procedure_blocks: '--cc-block-wait',
	math_blocks: '--cc-block-value',
	text_blocks: '--cc-block-value',
};

/**
 * 动作能力各自的**块面色**。
 *
 * 与 `ACTION_COLOUR_VARIABLE`（描边色）成对：描边要**在画布底上看得见**，块面要**让块上的字读得出来**。
 * 浅色主题下这两件事的方向相反（底浅→描边要深；字深→面要浅），所以必须分成两个变量。
 * 实现块（`cc_cap_*`）目前不渲染，但契约是完整的——将来接回来时不用再改这里。
 */
export const ACTION_FILL_VARIABLE: Readonly<Record<TaskAction, ThemeVariable>> = {
	move: '--cc-block-fill',
	turn: '--cc-block-turn-fill',
	stop: '--cc-block-stop',
	stop_if_obstacle: '--cc-block-guard-fill',
	get_status: '--cc-block-value',
	arm_joint: '--cc-block-arm-fill',
	arm6_joints: '--cc-block-arm6-fill',
};

/**
 * 副色 / 第三色。
 *
 * zelos 拿 `colourTertiary` 画**描边**、`colourPrimary` 画块面（见 Blockly 的
 * `applyColour`），所以这里不能像上一版那样「往底色方向混暗」——那样描边会比块面还暗，
 * 深宝石面上就看不见轮廓了。现在两个副色都**往白里混**（Blockly 自带主题的口径也是这个）：
 * 块面深、描边亮，字压在块面上，三样各司其职。
 */
const highlightOf = (
	primary: string,
	white: string,
): { colourSecondary: string; colourTertiary: string } => ({
	colourSecondary: Blockly.utils.colour.blend(primary, white, 0.16) ?? primary,
	colourTertiary: Blockly.utils.colour.blend(primary, white, 0.42) ?? primary,
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
/**
 * 块色：**所有可能上画的目录**都要覆盖到。
 *
 * 为什么收一串目录而不是一份：主题是在**建画布那一刻**定下来的，而画布上会出现的块
 * 随着「当前声明是哪台设备的」变。只按建画布那一刻的目录推，换设备之后再画另一种块，
 * 那些块在主题里找不到样式——Blockly 不报错，直接画成黑的。
 * 所以这里按登记表里的全部目录推一遍，块色与「现在选的是谁」解耦。
 */
export const buildBlockStyles = (
	palette: ThemePalette,
	catalogs: readonly CapabilityCatalog[],
): Record<string, Partial<Blockly.Theme.BlockStyle>> => {
	const styles: Record<string, Partial<Blockly.Theme.BlockStyle>> = {};
	for (const catalog of catalogs) {
		for (const capability of catalog.capabilities) {
			const ref = capability.capabilityRef;
			const pair =
				STYLE_COLOURS[ref] ??
				({
					fill: isTaskAction(ref) ? ACTION_FILL_VARIABLE[ref] : ('--cc-block-fill' as ThemeVariable),
					edge: '--cc-block-edge' as ThemeVariable,
				} as const);
			const fill = palette[pair.fill];
			// 描边取色相色；副色从块面混出来（zelos 不用副色画轮廓，但契约要求三色齐备）。
			styles[blockStyleName(ref)] = {
				colourPrimary: fill,
				...highlightOf(fill, palette['--cc-text-inverse']),
				colourTertiary: palette[pair.edge],
			};
		}
	}
	// 教学规格那几类块：接管 Blockly 自带的五个样式名，色相与块面同源。
	for (const [styleName, variable] of Object.entries(SPEC_BLOCK_STYLE_VARIABLE)) {
		const fill = palette[variable];
		styles[styleName] = {
			colourPrimary: fill,
			...highlightOf(fill, palette['--cc-text-inverse']),
			colourTertiary: palette['--cc-block-edge'],
		};
	}
	return styles;
};

export const createCodeCanvasTheme = (
	palette: ThemePalette,
	catalogs: readonly CapabilityCatalog[],
): Blockly.Theme => {
	const complete = requireCompletePalette(palette);
	const size = fontSizeFromVariable(complete);

	return Blockly.Theme.defineTheme(CODE_CANVAS_THEME_NAME, {
		name: CODE_CANVAS_THEME_NAME,
		base: Blockly.Themes.Zelos,
		startHats: true,
		blockStyles: buildBlockStyles(complete, catalogs),
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
			// 选中辉光与另外两栏同一个变量：`--cc-highlight`（theme.css 里它派生自强调色）。
			selectedGlowColour: complete['--cc-highlight'],
			selectedGlowOpacity: 0.7,
			replacementGlowColour: complete['--cc-highlight'],
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
	catalogs: readonly CapabilityCatalog[],
	readOnly = false,
): Blockly.BlocklyOptions => {
	const complete = requireCompletePalette(palette);
	return {
		renderer: CODE_CANVAS_RENDERER,
		theme: createCodeCanvasTheme(complete, catalogs),
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

/** 建一块可用的画布：先按目录注册实现积木（可能有多份），再注入工作区。 */
export const createCanvasWorkspace = (
	host: Element,
	palette: ThemePalette,
	catalogs: readonly CapabilityCatalog[],
	readOnly = false,
): Blockly.WorkspaceSvg => {
	for (const catalog of catalogs) registerImplementationBlocks(catalog);
	return Blockly.inject(host, buildInjectOptions(palette, catalogs, readOnly));
};

/**
 * 把「整块都是输入格的块」的底色换掉。
 *
 * 为什么需要这一步：`text` / `number` 这两种块只有一个可编辑字段，Blockly 会把它们
 * 画成**一整块输入格**——那时它不走字段那层 CSS，而是直接给自己的路径写
 * `fill = FIELD_BORDER_RECT_COLOUR`（常量表里是纯白），并且绕开了主题：
 * `Blockly.Theme` 里没有「字段底」这个槽位。于是画布上会出现一排纯白块，
 * 压在深宝石块面上把轮廓切得七零八落。
 *
 * CSS 也压不住它：那是写在 SVG 元素上的**行内属性**（实测第一版就是栽在这里，
 * 样式表怎么加都不生效）。所以只能改常量表——`getConstants()` 返回的就是渲染器
 * 在用的那一份，改了立刻生效，且不需要重建工作区。
 *
 * 只改这一格；其余（块的实参、下拉）走 CSS，见 `theme.css` 的 `.blocklyEditableField > rect`。
 */
export const applyFieldSurfaceColour = (workspace: Blockly.WorkspaceSvg): string | null => {
	const surface = paletteFromDocument()['--cc-block-field'];
	if (surface === '') return null;
	const constants = workspace.getRenderer().getConstants() as unknown as Record<string, unknown>;
	constants['FIELD_BORDER_RECT_COLOUR'] = surface;
	return surface;
};
