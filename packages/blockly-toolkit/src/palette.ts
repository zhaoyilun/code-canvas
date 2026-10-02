/**
 * 主题调色板（spec §7）：积木要的是圆角拼图那一路观感，但**色值只有一个来源**——
 * `apps/studio/src/shell/theme.css` 里的 `--cc-*` 变量。
 *
 * 本包不写任何字面色值：运行时从 CSS 变量读出来，缺变量就抛错。
 * 响亮地失败比静默换一套颜色好——那样「主题从哪来」就没法核对了。
 */

/** 积木主题用到的全部变量（每一行都必须在 `theme.css` 里真实存在）。 */
export const THEME_VARIABLES = [
	'--cc-surface',
	'--cc-surface-raised',
	'--cc-surface-sunken',
	'--cc-line',
	'--cc-line-strong',
	'--cc-text',
	'--cc-text-dim',
	'--cc-text-faint',
	'--cc-accent',
	'--cc-accent-strong',
	'--cc-accent-dim',
	'--cc-danger',
	/* 动作色：turn / stop_if_obstacle / arm_joint / arm6_joints 用（见 theme.css 末尾）。 */
	'--cc-block-turn',
	'--cc-block-guard',
	'--cc-block-arm',
	'--cc-block-arm6',
	'--cc-font-mono',
	'--cc-fs-md',
] as const;

export type ThemeVariable = (typeof THEME_VARIABLES)[number];
export type ThemePalette = Readonly<Record<ThemeVariable, string>>;

/** `getComputedStyle(...)` 与 `CSSStyleDeclaration` 都满足这个形状，测试可以给个假的。 */
export interface CssVariableSource {
	getPropertyValue(name: string): string;
}

export class ThemePaletteError extends Error {
	readonly missing: readonly ThemeVariable[];

	constructor(missing: readonly ThemeVariable[]) {
		super(`theme.css 缺少变量：${missing.join(', ')}——积木主题只从 --cc-* 取色，不回退到别的色值`);
		this.name = 'ThemePaletteError';
		this.missing = missing;
	}
}

/** 读一组变量（不判缺，缺的留空串）。 */
export const paletteFromCssVariables = (source: CssVariableSource): ThemePalette => {
	const palette: Record<ThemeVariable, string> = {} as Record<ThemeVariable, string>;
	for (const name of THEME_VARIABLES) palette[name] = source.getPropertyValue(name).trim();
	return palette;
};

export const missingThemeVariables = (palette: ThemePalette): readonly ThemeVariable[] =>
	THEME_VARIABLES.filter((name) => (palette[name] ?? '').length === 0);

/** 缺变量即抛：宁可画不出积木，也不要画出一套来路不明的颜色。 */
export const requireCompletePalette = (palette: ThemePalette): ThemePalette => {
	const missing = missingThemeVariables(palette);
	if (missing.length > 0) throw new ThemePaletteError(missing);
	return palette;
};

/** 从文档根节点的计算样式里取调色板（浏览器路径）。 */
export const paletteFromDocument = (
	root: Element | null = typeof document === 'undefined' ? null : document.documentElement,
): ThemePalette => {
	if (root === null) throw new Error('blockly-toolkit: 调色板需要 DOM（theme.css 挂在 :root 上）');
	return requireCompletePalette(paletteFromCssVariables(getComputedStyle(root)));
};

/** `13px` → `13`；解析不出数字返回 null（不猜一个字号）。 */
export const fontSizeFromVariable = (palette: ThemePalette): number | null => {
	const parsed = Number.parseFloat(palette['--cc-fs-md'] ?? '');
	return Number.isFinite(parsed) ? parsed : null;
};

/** 十六进制色值（三位或六位，带不带井号都行）→ 0-255 三通道；解析不出返回 null（不猜一个颜色）。 */
const rgbOf = (colour: string): readonly [number, number, number] | null => {
	const hex = colour.trim().replace(/^#/, '');
	const full =
		hex.length === 3
			? hex
					.split('')
					.map((char) => `${char}${char}`)
					.join('')
			: hex;
	if (!/^[0-9a-fA-F]{6}$/.test(full)) return null;
	return [
		Number.parseInt(full.slice(0, 2), 16),
		Number.parseInt(full.slice(2, 4), 16),
		Number.parseInt(full.slice(4, 6), 16),
	];
};

/** WCAG 口径的相对亮度。 */
const relativeLuminance = (colour: string): number | null => {
	const rgb = rgbOf(colour);
	if (rgb === null) return null;
	const [r, g, b] = rgb.map((channel) => {
		const value = channel / 255;
		return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
	}) as [number, number, number];
	return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};

/**
 * 两个色值的对比度（WCAG，1..21）。用来把「积木在底色上看得清」变成可核对的数：
 * 光靠眼睛看截图说「更清楚了」不算证据。
 */
export const contrastRatio = (foreground: string, background: string): number | null => {
	const front = relativeLuminance(foreground);
	const back = relativeLuminance(background);
	if (front === null || back === null) return null;
	const lighter = Math.max(front, back);
	const darker = Math.min(front, back);
	return (lighter + 0.05) / (darker + 0.05);
};

/**
 * 两个色值在 RGB 空间里差多远（0..约 441）。给「七个动作色两两分得开」当机械口径：
 * 换标签、换变量名都骗不过它，只有真换了色值距离才动。
 */
export const colourDistance = (first: string, second: string): number | null => {
	const a = rgbOf(first);
	const b = rgbOf(second);
	if (a === null || b === null) return null;
	return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
};
