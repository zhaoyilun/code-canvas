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
	'--cc-line-strong',
	'--cc-text',
	'--cc-text-dim',
	'--cc-text-faint',
	'--cc-accent',
	'--cc-accent-strong',
	'--cc-accent-dim',
	'--cc-danger',
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
