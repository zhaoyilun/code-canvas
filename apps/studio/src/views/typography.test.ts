/**
 * 字号纪律：**屏幕上一切字号都从 `--cc-fs-*` 四档里来**，组件里不许写字面像素。
 *
 * 为什么这条要机械守住：字号阶梯最容易在改版里悄悄塌掉。实测过一次——
 * `theme.css` 四档从 10/11/13/15 提到 11/12/14/17 之后，流程画布和右栏还留着
 * 四个写死的 `9px` / `11px` / `13px`（SVG 文本最容易漏，它们不在 DOM 流里，
 * 看起来「不像字」），于是同一屏上同时存在两套阶梯，改了半天还有一半没动。
 *
 * 与 `blockly-toolkit` 的「src 里没有字面色值」同一条纪律，只是那条管色、这条管字。
 */
import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

/*
 * 用 `process.cwd()` 而不是 `import.meta.url`：studio 的测试跑在 happy-dom 里，
 * 那里 `import.meta.url` 是 http 协议，`fileURLToPath` 会直接抛「URL must be of scheme file」。
 * vitest 的工作目录就是这个包根（`apps/studio`），所以 `src` 直接相对它取。
 */
const SRC = join(process.cwd(), 'src');

const sourceFiles = (dir: string): readonly string[] =>
	readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
		const full = join(dir, entry.name);
		if (entry.isDirectory()) return sourceFiles(full);
		if (!/\.(vue|ts)$/.test(entry.name)) return [];
		if (/\.test\.ts$/.test(entry.name)) return [];
		return [full];
	});

/**
 * 两条写法都要扫，值在 JS 里判——不把「是不是 var()」塞进正则。
 *
 * 为什么连 `font:` 简写也扫：字号藏在简写里是**扫不到的盲区**。
 * 实测过一次——`--cc-fs-*` 四档改完之后，右栏还留着一处
 * `font: 10px / 1.2 var(--cc-font-mono)`，只扫 `font-size:` 的话它一声不响，
 * 于是「改完了」这句话是假的。两条都进扫描面，才谈得上「一屏只有一套阶梯」。
 *
 * 第一版正则写成 `(?!var\()([^;]+)` 也是错的：负向断言只作用于它**紧跟的那一个位置**，
 * `[^;]+` 随后照样能把 `var(--cc-fs-xs)` 整段吃掉，98 条合法声明全被报成违规。
 * 判断挪到代码里，规则一眼能读，也不会再被正则的贪婪咬到。
 */
const FONT_SIZE_DECLARATION = /font-size:\s*([^;]+);/g;
const FONT_SHORTHAND = /font:\s*([^;]+);/g;

describe('字号纪律', () => {
	it('组件里的字号只有 var(--cc-fs-*) 一种写法，没有写死的像素', () => {
		const offenders: string[] = [];
		for (const file of sourceFiles(SRC)) {
			const text = readFileSync(file, 'utf8');
			for (const match of text.matchAll(FONT_SIZE_DECLARATION)) {
				const value = (match[1] ?? '').trim();
				// 走变量的、以及 inherit / 0 这类「不设字号」的，都算合规。
				if (value.startsWith('var(--cc-fs-')) continue;
				if (value === 'inherit' || value === '0') continue;
				offenders.push(`${file.slice(SRC.length + 1)}: font-size: ${value}`);
			}
			for (const match of text.matchAll(FONT_SHORTHAND)) {
				const value = (match[1] ?? '').trim();
				// 简写里的第一段是字号（`10px / 1.2 monospace`）；不是像素开头就不是字号简写。
				const [, size = '', lineHeight = ''] = /^([\d.]+px)\s*(?:\/\s*([\d.]+))?/.exec(value) ?? [];
				if (size === '') continue;
				offenders.push(`${file.slice(SRC.length + 1)}: font: ${size}${lineHeight === '' ? '' : ` / ${lineHeight}`}`);
			}
		}
		expect(offenders).toEqual([]);
	});

	it('theme.css 里四档字号齐全，且档差拉得开', () => {
		const css = readFileSync(join(SRC, 'shell/theme.css'), 'utf8');
		const sizes = ['--cc-fs-xs', '--cc-fs-sm', '--cc-fs-md', '--cc-fs-lg'].map((name) => {
			const found = new RegExp(`${name}:\\s*([\\d.]+)px`).exec(css);
			expect(found, `${name} 没定义`).not.toBeNull();
			return Number.parseFloat(found?.[1] ?? '0');
		});
		// 严格递增——四档挤在同一格里，「标签 / 正文 / 标题」在版面上就读不出来。
		for (let index = 1; index < sizes.length; index += 1) {
			expect(sizes[index], `${sizes[index - 1]} → ${sizes[index]} 没有拉开`).toBeGreaterThan(sizes[index - 1] ?? 0);
		}
		// 最小档不低于 11px：10px 的中文在这块屏幕上笔画会糊在一起。
		expect(sizes[0]).toBeGreaterThanOrEqual(11);
	});
});
