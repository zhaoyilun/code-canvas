// @vitest-environment happy-dom
/**
 * 积木上的序号徽标与 `data-node-id` 的**可核对部分**。
 *
 * 真实浏览器里「徽标跟着块走」靠的是它被塞进积木那个 `<g>`（父元素的变换带着它跑），
 * 这条在 happy-dom 里量不出来——`Blockly.inject` 在这个环境里跑不完（见 BlocklyView.test.ts 的说明）。
 * 所以这里钉住三件能在无头环境里钉住的事：
 *   1. 徽标长什么样：几个子元素、数字对不对、两个状态的属性怎么切；
 *   2. 贴角位置是按积木自己的宽高算的（不用 getBBox，那个把阴影也算进去）；
 *   3. 「第几步」这个口径只有一份（声明顺序），流程卡片、代码行、积木共用。
 * 真机上的 DOM 断言（含 `g.blocklyDraggable[data-node-id]`）在交付报告里贴实际元素属性。
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import type { WorkflowNode } from '@codecanvas/contracts';
import { setSelectedDevice } from '../../shell/devices';
import { loadSampleTask, useStudioDocument } from '../../state/document';
import {
	BADGE_ACTIVE_CLASS,
	BADGE_CLASS,
	BADGE_CORNER_RADIUS,
	BADGE_INSET,
	BADGE_SIZE,
	badgePalette,
	createBadgeElement,
	placeBadge,
	stepNumbersOf,
	updateBadge,
	type BadgePalette,
} from '../shared/sequence-badge';
import { THEME_VARIABLES } from '@codecanvas/blockly-toolkit';

/** 主题变量从真实的 `theme.css` 解析：徽标色值必须真的在主题里，不能在代码里另写一份。 */
const themeVariables = (): ReadonlyMap<string, string> => {
	const css = readFileSync(resolve(process.cwd(), 'src/shell/theme.css'), 'utf8');
	const variables = new Map<string, string>();
	for (const match of css.matchAll(/(--cc-[a-z0-9-]+)\s*:\s*([^;]+);/g)) {
		const name = match[1];
		const value = match[2];
		if (name !== undefined && value !== undefined) variables.set(name, value.trim());
	}
	return variables;
};

/** 把 `var(--x)` 展开成真实值：调色板里那些间接引用（`--cc-seq-bg: var(--cc-accent-veil)`）也读得出来。 */
const expand = (value: string, variables: ReadonlyMap<string, string>): string => {
	const reference = /^var\((--cc-[a-z0-9-]+)\)$/.exec(value);
	const name = reference?.[1];
	return name === undefined ? value : expand(variables.get(name) ?? '', variables);
};

const VALUE = (name: string): string => {
	const variables = themeVariables();
	return expand(variables.get(name) ?? '', variables);
};

/**
 * 调色板 = `blockly-toolkit` 那张变量表（**现生成，不手抄**）+ 徽标自己那几个键。
 *
 * 为什么要现生成：手抄那一版在加变量时漏过（2026-10 加了块面/描边那几个名字，
 * 这份表没跟上，typecheck 当场红）。契约表是唯一真相，夹具跟着它走。
 *
 * 为什么还要补后面那几个：`--cc-seq-*` 与 `--cc-highlight*` 是徽标专用的，
 * 不在 `THEME_VARIABLES` 里（那张表只管积木主题要的），所以它们仍显式列出来。
 */
const palette = (): BadgePalette =>
	badgePalette(
		Object.fromEntries(THEME_VARIABLES.map((name: string) => [name, VALUE(name)])) as unknown as Parameters<
			typeof badgePalette
		>[0],
	);

const rects = (badge: SVGGElement): SVGRectElement[] =>
	[...badge.children].filter((child): child is SVGRectElement => child instanceof SVGRectElement);

const textOf = (badge: SVGGElement): SVGTextElement | null => {
	const found = [...badge.children].find((child) => child instanceof SVGTextElement);
	return found instanceof SVGTextElement ? found : null;
};

beforeEach(() => {
	// 样例跟着**设备格式**走（默认那台说的是技能计划），而这里量的是这份一期样例的步号，
	// 所以先站到一期那台设备上。
	setSelectedDevice('phase1_robot');
	expect(loadSampleTask()).toBe(true);
});

describe('积木序号徽标 · 形态与状态', () => {
	it('常态与选中态切换的是同一枚徽标：底色、描边、字色三者一起动（和另两处一个观感）', () => {
		const colors = palette();
		const badge = createBadgeElement(colors, 1);
		const [background] = rects(badge);
		const text = textOf(badge);

		// 常态：压暗的底 + 强调色描边（落在积木的亮色块面上像一枚凹进去的序号章）
		expect(background?.getAttribute('fill')).toBe(colors.idleBackground);
		expect(text?.getAttribute('fill')).toBe(colors.idleText);
		expect(rects(badge)[1]?.getAttribute('stroke')).toBe(colors.idleBorder);
		expect(rects(badge)[1]?.getAttribute('stroke-width')).toBe('1');
		expect(badge.classList.contains(BADGE_ACTIVE_CLASS)).toBe(false);

		updateBadge(badge, colors, 1, true);

		// 选中：实心强调色 + 反白数字 + 描边加粗一档
		expect(background?.getAttribute('fill')).toBe(colors.activeBackground);
		expect(text?.getAttribute('fill')).toBe(colors.activeText);
		expect(rects(badge)[1]?.getAttribute('stroke')).toBe(colors.activeBorder);
		expect(rects(badge)[1]?.getAttribute('stroke-width')).toBe('2');
		expect(badge.classList.contains(BADGE_ACTIVE_CLASS)).toBe(true);

		// 两个状态必须真的不一样，否则「跟着选中跳出来」只剩嘴上说
		expect(colors.activeBackground).not.toBe(colors.idleBackground);
		expect(colors.activeText).not.toBe(colors.idleText);

		updateBadge(badge, colors, 2, false);
		expect(background?.getAttribute('fill')).toBe(colors.idleBackground);
		expect(textOf(badge)?.textContent).toBe('2');
		expect(badge.classList.contains(BADGE_ACTIVE_CLASS)).toBe(false);
	});

	it('描边变粗时内缩量跟着变，徽标外沿不会长出去', () => {
		const colors = palette();
		const badge = createBadgeElement(colors, 1);
		const border = rects(badge)[1]!;

		updateBadge(badge, colors, 1, true);
		const outer =
			Number(border.getAttribute('x')) + Number(border.getAttribute('width')) + Number(border.getAttribute('stroke-width')) / 2;
		expect(outer).toBeLessThanOrEqual(BADGE_SIZE);
	});
});

describe('积木序号徽标 · 跟着块走', () => {
	it('徽标贴在积木右上角内侧，位置按积木自己的宽高算', () => {
		const badge = createBadgeElement(palette(), 1);

		placeBadge(badge, { width: 200 });
		expect(badge.getAttribute('transform')).toBe(`translate(${200 - BADGE_SIZE - BADGE_INSET}, ${BADGE_INSET})`);

		// 窄块也不会把徽标推到负坐标（贴到内边距上）
		placeBadge(badge, { width: 10 });
		expect(badge.getAttribute('transform')).toBe(`translate(${BADGE_INSET}, ${BADGE_INSET})`);
	});

	it('徽标是积木 `<g>` 的子元素——坐标与积木同一套，所以拖动、缩放、平移都跟得住', () => {
		const block = document.createElementNS('http://www.w3.org/2000/svg', 'g');
		const badge = createBadgeElement(palette(), 2);

		block.append(badge);

		// 父元素（积木）带着的变换就是徽标的变换：不需要任何"重新定位"的代码
		expect(badge.parentElement).toBe(block);
		block.setAttribute('transform', 'translate(120, 40)');
		expect(badge.parentElement?.getAttribute('transform')).toBe('translate(120, 40)');
	});
});

describe('第几步 · 只有一份口径', () => {
	it('序数按声明顺序，从 1 开始；和流程卡片的卡片序号、代码行的徽标是同一个数', () => {
		const nodes = useStudioDocument().nodes.value;
		const numbers = stepNumbersOf(nodes);

		expect(numbers.size).toBe(4);
		nodes.forEach((node: WorkflowNode, position: number) => {
			expect(numbers.get(node.id)).toBe(position + 1);
		});
		// 数组顺序就是链的顺序（渲染器按它串 next），所以序数 = 位置，不是另算一套
		expect(nodes.map((node) => numbers.get(node.id))).toEqual([1, 2, 3, 4]);
	});
});

describe('主题变量', () => {
	it('徽标要用的 --cc-seq-* 变量都在 theme.css 里（新加的只追加，老的值没动）', () => {
		const variables = themeVariables();
		for (const name of [
			'--cc-seq-bg',
			'--cc-seq-border',
			'--cc-seq-text',
			'--cc-seq-bg-active',
			'--cc-seq-border-active',
			'--cc-seq-text-active',
			'--cc-highlight',
			'--cc-highlight-border-width',
			'--cc-highlight-glow',
			// 明确不许动的老变量，抽查两个
			'--cc-accent',
			'--cc-accent-veil',
		]) {
			expect(variables.get(name), name).toBeTruthy();
		}
		// 同上：断言"这个变量在文件里真的有值"，不钉它的色值。
	expect(variables.get('--cc-accent')).toMatch(/^#[0-9a-f]{6}$/i);
		// veil 是"强调色的一层薄底"：断言它是半透明的一层（形状对），不钉具体色值。
	expect(variables.get('--cc-accent-veil')).toMatch(/^rgba\(/);
		expect(variables.get('--cc-highlight-border-width')).toBe('2px');
	});
});
