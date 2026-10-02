/**
 * 主题与调色板：色值只有一个来源（`theme.css` 的 `--cc-*`），本包源码里不许出现字面色值。
 * 这一条用「扫源码找色值字面量」的机械检查守住，不靠人记得。
 */
import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { ALLOWED_ACTIONS } from '@codecanvas/contracts';
import {
	THEME_VARIABLES,
	ThemePaletteError,
	fontSizeFromVariable,
	missingThemeVariables,
	paletteFromCssVariables,
	requireCompletePalette,
} from '../src/palette';
import {
	ACTION_COLOUR_VARIABLE,
	CODE_CANVAS_RENDERER,
	CODE_CANVAS_THEME_NAME,
	buildInjectOptions,
	createCodeCanvasTheme,
} from '../src/theme';
import { actionBlockType, blockStyleName } from '../src/blocks';
import { fixturePalette, fixtureSource, themeCssText, toolboxBlockTypes } from './fixtures';

const SOURCE_DIR = new URL('../src/', import.meta.url);

describe('调色板', () => {
	it('主题变量在 theme.css 里都真实存在', () => {
		const palette = fixturePalette();
		expect(missingThemeVariables(palette)).toEqual([]);
		expect(fixtureSource().getPropertyValue('--cc-accent')).not.toBe('');
		expect(themeCssText()).toContain(':root');
	});

	it('缺变量就抛错，并点名缺了哪些', () => {
		const empty = paletteFromCssVariables({ getPropertyValue: () => '' });
		expect(missingThemeVariables(empty)).toEqual([...THEME_VARIABLES]);
		expect(() => requireCompletePalette(empty)).toThrow(ThemePaletteError);
		try {
			requireCompletePalette(empty);
		} catch (error) {
			expect(error).toBeInstanceOf(ThemePaletteError);
			expect((error as ThemePaletteError).missing).toContain('--cc-accent');
			expect((error as Error).message).toContain('--cc-accent');
		}
	});

	it('读变量会去掉两边空白（getComputedStyle 的值带空格）', () => {
		const palette = paletteFromCssVariables({ getPropertyValue: () => '  #123456  ' });
		expect(palette['--cc-accent']).toBe('#123456');
	});

	it('字号从变量解析，解析不出就不给字号', () => {
		const palette = fixturePalette();
		expect(fontSizeFromVariable(palette)).toBe(13);
		expect(fontSizeFromVariable(paletteFromCssVariables({ getPropertyValue: () => 'auto' }))).toBeNull();
	});
});

describe('主题', () => {
	it('每个动作一个 blockStyle，主色就是对应变量的值', () => {
		const palette = fixturePalette();
		const theme = createCodeCanvasTheme(palette);
		expect(theme.name).toBe(CODE_CANVAS_THEME_NAME);
		for (const action of ALLOWED_ACTIONS) {
			const style = theme.blockStyles[blockStyleName(action)];
			expect(style?.colourPrimary, action).toBe(palette[ACTION_COLOUR_VARIABLE[action]]);
			// 三色齐备，Blockly 画 zelos 路径时不会拿到 undefined。
			expect(style?.colourSecondary, action).toBeTypeOf('string');
			expect(style?.colourTertiary, action).toBeTypeOf('string');
		}
		// 主题叠在 zelos 之上：我们的七个名字都在（zelos 自带的名字也还在）。
		expect(Object.keys(theme.blockStyles)).toEqual(expect.arrayContaining(ALLOWED_ACTIONS.map(blockStyleName)));
	});

	it('副色/第三色是从变量值混出来的，不是另写的色值', () => {
		const palette = fixturePalette();
		const style = createCodeCanvasTheme(palette).blockStyles[blockStyleName('move')];
		expect(style?.colourSecondary).not.toBe(palette['--cc-accent']);
		expect(style?.colourTertiary).not.toBe(style?.colourSecondary);
		// 混色用的是调色板里的底色：把底色换成别的，副色必须跟着变。
		const shifted = createCodeCanvasTheme({ ...palette, '--cc-surface-sunken': '#101010' });
		expect(shifted.blockStyles[blockStyleName('move')]?.colourSecondary).not.toBe(style?.colourSecondary);
	});

	it('工作区与工具箱的底色取自调色板', () => {
		const palette = fixturePalette();
		const theme = createCodeCanvasTheme(palette);
		expect(theme.getComponentStyle('workspaceBackgroundColour')).toBe(palette['--cc-surface-sunken']);
		expect(theme.getComponentStyle('toolboxBackgroundColour')).toBe(palette['--cc-surface']);
		expect(theme.getComponentStyle('flyoutBackgroundColour')).toBe(palette['--cc-surface-raised']);
		expect(theme.getComponentStyle('selectedGlowColour')).toBe(palette['--cc-accent']);
	});

	it('注入选项用 zelos 渲染器，工具箱摆着七块积木', () => {
		const options = buildInjectOptions(fixturePalette());
		expect(options.renderer).toBe(CODE_CANVAS_RENDERER);
		expect(options.renderer).toBe('zelos');
		expect(options.theme).toBeInstanceOf(Object);
		const toolbox = options.toolbox;
		if (typeof toolbox !== 'object' || toolbox === null || !('contents' in toolbox)) {
			throw new Error('工具箱应当是个对象');
		}
		expect(toolboxBlockTypes(toolbox)).toEqual(ALLOWED_ACTIONS.map(actionBlockType));
	});
});

describe('色值纪律', () => {
	it('src 里没有字面色值（一切走 --cc-* 变量）', () => {
		const colourPattern = /#[0-9a-fA-F]{3,8}\b|\brgba?\(|\bhsla?\(/;
		const offenders: string[] = [];
		for (const file of readdirSync(SOURCE_DIR)) {
			if (!file.endsWith('.ts')) continue;
			const text = readFileSync(new URL(file, SOURCE_DIR), 'utf8');
			text.split('\n').forEach((line, index) => {
				if (colourPattern.test(line)) offenders.push(`${file}:${index + 1}: ${line.trim()}`);
			});
		}
		expect(offenders).toEqual([]);
	});
});
