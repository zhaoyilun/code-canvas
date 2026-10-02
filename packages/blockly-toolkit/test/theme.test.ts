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
	colourDistance,
	contrastRatio,
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
	capabilityColourVariable,
	createCodeCanvasTheme,
	gridColour,
} from '../src/theme';
import { blockStyleName, describeCatalogImplementations } from '../src/blocks';
import { MIN_READABLE_SCALE } from '../src/viewport';
import { FIXTURE_CATALOG, fixturePalette, fixtureSource, themeCssText } from './fixtures';

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
	it('目录里每个能力一个 blockStyle，主色就是对应变量的值', () => {
		const palette = fixturePalette();
		const theme = createCodeCanvasTheme(palette, FIXTURE_CATALOG);
		expect(theme.name).toBe(CODE_CANVAS_THEME_NAME);
		for (const capability of FIXTURE_CATALOG.capabilities) {
			const ref = capability.capabilityRef;
			const style = theme.blockStyles[blockStyleName(ref)];
			expect(style?.colourPrimary, ref).toBe(palette[capabilityColourVariable(ref)]);
			// 三色齐备，Blockly 画 zelos 路径时不会拿到 undefined。
			expect(style?.colourSecondary, ref).toBeTypeOf('string');
			expect(style?.colourTertiary, ref).toBeTypeOf('string');
		}
		// 一期目录里的能力名就是协议里的七个动作，所以这张表仍是那七个名字。
		for (const action of ALLOWED_ACTIONS) {
			expect(theme.blockStyles[blockStyleName(action)]?.colourPrimary, action).toBe(
				palette[ACTION_COLOUR_VARIABLE[action]],
			);
		}
		// 主题叠在 zelos 之上：我们的七个名字都在（zelos 自带的名字也还在）。
		expect(Object.keys(theme.blockStyles)).toEqual(expect.arrayContaining(ALLOWED_ACTIONS.map(blockStyleName)));
	});

	it('副色/第三色是从变量值混出来的，不是另写的色值', () => {
		const palette = fixturePalette();
		const style = createCodeCanvasTheme(palette, FIXTURE_CATALOG).blockStyles[blockStyleName('move')];
		expect(style?.colourSecondary).not.toBe(palette['--cc-accent']);
		expect(style?.colourTertiary).not.toBe(style?.colourSecondary);
		// 混色用的是调色板里的底色：把底色换成别的，副色必须跟着变。
		const shifted = createCodeCanvasTheme({ ...palette, '--cc-surface-sunken': '#101010' }, FIXTURE_CATALOG);
		expect(shifted.blockStyles[blockStyleName('move')]?.colourSecondary).not.toBe(style?.colourSecondary);
	});

	it('工作区与工具箱的底色取自调色板', () => {
		const palette = fixturePalette();
		const theme = createCodeCanvasTheme(palette, FIXTURE_CATALOG);
		expect(theme.getComponentStyle('workspaceBackgroundColour')).toBe(palette['--cc-surface-sunken']);
		expect(theme.getComponentStyle('toolboxBackgroundColour')).toBe(palette['--cc-surface']);
		expect(theme.getComponentStyle('flyoutBackgroundColour')).toBe(palette['--cc-surface-raised']);
		expect(theme.getComponentStyle('selectedGlowColour')).toBe(palette['--cc-accent']);
	});

	it('注入选项用 zelos 渲染器，且**不带工具箱**：实现来自目录，结构只读', () => {
		const options = buildInjectOptions(fixturePalette(), FIXTURE_CATALOG);
		expect(options.renderer).toBe(CODE_CANVAS_RENDERER);
		expect(options.renderer).toBe('zelos');
		expect(options.theme).toBeInstanceOf(Object);
		// 没有工具箱可拖：往里拖一块新积木等于改实现，而实现不归画布管（spec §4.1 只给了参数这条写路径）。
		expect(options.toolbox).toBeUndefined();
		// 同理不给垃圾桶：块删不掉（结构只读由渲染侧再钉一道，见 roundtrip.test.ts）。
		expect(options.trashcan).toBe(false);
		// 目录里每个「能力 × 原语」都注册成了积木类型——这才是画布能画出实现的前提。
		expect(describeCatalogImplementations(FIXTURE_CATALOG).length).toBeGreaterThan(0);
	});
});

describe('配色对比与网格', () => {
	/** 七个动作的主色：一眼要能认出不同动作，且在深色底上看得清。 */
	const primaries = (): readonly { action: string; colour: string }[] => {
		const palette = fixturePalette();
		return ALLOWED_ACTIONS.map((action) => ({ action, colour: palette[ACTION_COLOUR_VARIABLE[action]] }));
	};

	it('每个动作色与工作区底色的对比度都过 4.5', () => {
		const background = fixturePalette()['--cc-surface-sunken'];
		for (const { action, colour } of primaries()) {
			const ratio = contrastRatio(colour, background);
			expect(ratio, `${action} 的对比度算不出来`).not.toBeNull();
			expect(ratio ?? 0, `${action} (${colour}) 与底色的对比度`).toBeGreaterThanOrEqual(4.5);
		}
	});

	it('七个动作色两两分得开（不是一片青）', () => {
		const colours = primaries();
		for (const first of colours) {
			for (const second of colours) {
				if (first.action === second.action) continue;
				const distance = colourDistance(first.colour, second.colour);
				expect(distance, `${first.action} vs ${second.action}`).not.toBeNull();
				// 换标签、换变量名都骗不过它：只有真换了色值距离才动。
				expect(distance ?? 0, `${first.action} 与 ${second.action} 太像了`).toBeGreaterThanOrEqual(32);
			}
		}
	});

	it('点阵网格往底色方向压暗：比原来淡，但还看得见', () => {
		const palette = fixturePalette();
		const background = palette['--cc-surface-sunken'];
		const grid = gridColour(palette);
		// 还在——网格是坐标参考，不能抹掉。
		expect(grid).not.toBe(background);
		const dimmed = contrastRatio(grid, background) ?? 0;
		const before = contrastRatio(palette['--cc-line-strong'], background) ?? 0;
		expect(dimmed).toBeLessThan(before);
		expect(dimmed).toBeLessThan(1.6);
	});

	it('注入选项里的网格色就是混出来的那个，不另写色值', () => {
		const palette = fixturePalette();
		expect(buildInjectOptions(palette, FIXTURE_CATALOG).grid?.colour).toBe(gridColour(palette));
	});

	it('初始缩放的下限留在可读范围，不靠 startScale 硬撑', () => {
		const options = buildInjectOptions(fixturePalette(), FIXTURE_CATALOG);
		expect(options.zoom?.startScale).toBeGreaterThanOrEqual(MIN_READABLE_SCALE);
		expect(options.zoom?.minScale ?? 0).toBeLessThanOrEqual(MIN_READABLE_SCALE);
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
