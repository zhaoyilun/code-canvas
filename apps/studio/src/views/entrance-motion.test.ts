/**
 * 「一步一步长出来」这套动效的验收：换模块时的两处入场，以及**积木一块块拖进来**。
 *
 * 为什么要单独一个文件：这些动画此前一条测试都没有，而它们最容易的写法就是写一句
 * 「看起来有动画」——那种话说不出真假。这里把**能机械核的部分**钉住：
 *   1. **真挂上了**：把组件的 `<style>` 块读出来注入文档，再读 `getComputedStyle().animation`
 *      ——量的是真元素经级联之后拿到的那条声明，不是源码里有没有那行字；
 *   2. **动的是该动的属性**：换模块那两处只动 `opacity`/`transform`（不触发布局）；
 *      积木那块按导演放的纪律：`opacity` + `translate` + `scale`——**且必须收在 identity**，
 *      不许出现 `transform` 简写（Blockly 给每个块的 `<g>` 写着 `transform="translate(x,y)"`，
 *      CSS 的 `transform` 会整个盖掉它，元素会跳到画布原点）；
 *   3. **同一个口径**：换模块那两处的时长/缓动/次数/填充必须一模一样（各写各的数值迟早会漂）；
 *   4. **偏好关掉时一个字都不动**：`prefers-reduced-motion: reduce` 那条把 `animation` 收成 `none`；
 *   5. **接线真的接上了**：`playBlockStepEntrance` / `playBlockTreeEntrance` 挂类、按延迟起手、
 *      收尾摘干净（不留内联的 `transform-origin`）。
 *
 * happy-dom 与 vitest 的三处短处（下面都绕开了，它们不是被测对象的性质）：
 *   - **不拆简写**：`animationName` / `animationDuration` 一律是空串（实测），只有
 *     `getComputedStyle().animation` 拿得到级联结果，所以断言的是简写全文；
 *   - **不认 `@media` 级联**：媒体块里的规则不会自己生效，于是把那个块**单独注入**当
 *     「偏好已开」跑一遍，另有一条断言钉住那个块的查询串就是 `(prefers-reduced-motion: reduce)`；
 *   - **不处理 CSS**：SFC 的 `<style scoped>` 不会自己进文档，所以由本文件读文件 + 注入；
 *     `:deep(...)` 是 Vue 编译期的东西，注入前摊平成里面的选择器（编译产物里也正是这个形状）。
 *
 * 积木那份为什么没有一样地「挂组件再量」：`Blockly.inject` 在 happy-dom 里跑不完
 * （见 `blockly/BlocklyView.test.ts` 的文件头）。所以那一层量两件能分开量的事——
 * 样式表那条规则（手工搭一个同形状的块元素去接级联），以及那两个函数的接线与收尾。
 */
import { mount } from '@vue/test-utils';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setSelectedDevice } from '../shell/devices';
import { loadSampleTask, useStudioDocument } from '../state/document';
import {
	BLOCK_LANDING_STAGGER_MS,
	BLOCK_STEP_ENTER_CLASS,
	BLOCK_STEP_ENTER_MS,
	playBlockStepEntrance,
	playBlockTreeEntrance,
} from './blockly/blockly-canvas';
import CodePanel from './code-panel/CodePanel.vue';
import FlowView from './flow/FlowView.vue';
import { loadTeachingFixture } from '../state/__fixtures__/teaching-spec';

vi.mock('@codecanvas/capabilities', async (importOriginal) => {
	const actual = await importOriginal<typeof import('@codecanvas/capabilities')>();
	const { FIXTURE_CATALOG } = await import('./__fixtures__/catalog');
	return { ...actual, PHASE1_ROBOT_CATALOG: FIXTURE_CATALOG };
});

const doc = useStudioDocument();

/* ───────────────────────── 样式表读取与小解析 ───────────────────────── */

/** 读一个 SFC 的 `<style>` 块原文。vitest 不处理 CSS，SFC 的样式不会自己进文档，只能读出来自己注入。 */
const styleOf = (relative: string): string => {
	const source = readFileSync(resolve(process.cwd(), relative), 'utf8');
	const match = /<style[^>]*>([\s\S]*?)<\/style>/.exec(source);
	const body = match?.[1];
	if (body === undefined) throw new Error(`${relative} 里没有 <style> 块`);
	// 注释里可能有大括号，先摘掉——下面那个配平扫描是按字符数的
	return body.replace(/\/\*[\s\S]*?\*\//g, '');
};

/** `:deep(...)` 摊平成里面的选择器（编译产物里就是「父选择器 空格 里面那个」）。 */
const flattenDeep = (css: string): string => css.replace(/:deep\(([^()]*)\)/g, '$1');

/** 从 `from` 往后的第一个大括号块（含配平），返回块内原文。 */
const blockFrom = (css: string, open: number): string => {
	let depth = 0;
	for (let i = open; i < css.length; i++) {
		if (css[i] === '{') depth += 1;
		else if (css[i] === '}') {
			depth -= 1;
			if (depth === 0) return css.slice(open + 1, i);
		}
	}
	throw new Error('大括号没配平');
};

interface StyleRule {
	/** 选择器原文（`@keyframes` 这类 at-rule 是它自己的头部）。 */
	readonly selector: string;
	readonly body: string;
	/** 外层条件（`@media (...)` 的头部）；不在任何媒体块里就是空串。 */
	readonly condition: string;
}

/** 摊平一张样式表：媒体块里的规则带出查询串，`@keyframes` 也算一条（选择器是它的头部）。 */
const scrapeRules = (css: string, condition = ''): StyleRule[] => {
	const rules: StyleRule[] = [];
	let cursor = 0;
	for (;;) {
		const open = css.indexOf('{', cursor);
		if (open < 0) return rules;
		const selector = css.slice(cursor, open).trim();
		const body = blockFrom(css, open);
		if (selector.startsWith('@media') || selector.startsWith('@supports')) {
			rules.push(...scrapeRules(body, selector));
		} else {
			rules.push({ selector, body, condition });
		}
		cursor = open + body.length + 2;
	}
};

/** 选择器列表里有没有这一条（`a,\n b` 这种写法要拆开比）。 */
const selects = (selector: string, wanted: string): boolean =>
	selector.split(',').some((part) => part.trim() === wanted);

/** 一条规则里声明的某个属性值；没写就是 null。 */
const declared = (body: string, property: string): string | null => {
	const match = new RegExp(`(?:^|;)\\s*${property}\\s*:([^;]+)`).exec(body);
	return match?.[1] === undefined ? null : match[1].trim();
};

/** 把一个块里声明过的属性名收出来（`from { opacity: 0 }` → `opacity`）。 */
const declaredProperties = (block: string): string[] =>
	[...block.matchAll(/(?:^|[{;])\s*([a-z-]+)\s*:/g)].flatMap((match) => (match[1] === undefined ? [] : [match[1]]));

/** 把一段 CSS 注入文档，返回摘掉它的函数。 */
const installCss = (css: string): (() => void) => {
	const style = document.createElement('style');
	style.textContent = css;
	document.head.append(style);
	return () => style.remove();
};

const injected: (() => void)[] = [];
const wrappers: { unmount(): void }[] = [];

afterEach(() => {
	for (const remove of injected.splice(0)) remove();
	for (const wrapper of wrappers.splice(0)) wrapper.unmount();
});

/* ───────────────────────── 共同口径 ───────────────────────── */

interface MotionSite {
	readonly label: string;
	/** 相对 `apps/studio` 的路径。 */
	readonly file: string;
	/** 样式表里那条选择器（`:deep` 摊平之后的形状）。 */
	readonly selector: string;
	/** 命中它的元素要在哪个容器里（积木那些规则挂在 `.canvas-host` 下）。 */
	readonly host?: string;
	/** 造元素用的标签名（默认 `li`；积木在 SVG 里，是 `g`）。 */
	readonly tag?: string;
	/** 有 `host` 时，放进 host 里那个元素带的类。 */
	readonly layerClass?: string;
	/** 元素上还要挂的属性（如 `data-provisional="true"`）。 */
	readonly attributes?: Readonly<Record<string, string>>;
	readonly animation: string;
	readonly animationName: string;
	/** 这段 keyframes 允许动哪些属性。 */
	readonly allowed: readonly string[];
}

/** 换模块那两处：只动 `opacity` 与 `transform`，不碰任何会触发布局的东西。 */
const OPACITY_AND_TRANSFORM = ['opacity', 'transform'] as const;

/**
 * 积木那块允许动的三样：位移、缩放、透明度。
 *
 * 这是导演给的边界（`transform` 从「一律不许」放宽到「入场期间可以用」），但**必须收在 identity**：
 * 动画期间命中区可能对不上（`transform` 一族会挪 `blocklyBlockCanvas` 的坐标系），
 * 收尾之后要与没动过完全一致——下面的断言里「`to` 是 identity」这一条就是它。
 * 注意：实现用的是独立的 `translate` / `scale` 属性（不是 `transform` 简写），见样式注释。
 */
const BLOCK_LANDING_PROPERTIES = ['opacity', 'translate', 'scale'] as const;

const SITES: readonly MotionSite[] = [
	{
		label: '流程图节点',
		file: 'src/views/flow/FlowChart.vue',
		selector: '.flow-node',
		tag: 'g',
		animation: 'cc-flow-node-in 220ms ease-out 1 both',
		animationName: 'cc-flow-node-in',
		allowed: OPACITY_AND_TRANSFORM,
	},
	{
		label: '代码行',
		file: 'src/views/code-panel/CodePanel.vue',
		selector: '.cp-line',
		animation: 'cc-line-in 220ms ease-out 1 both',
		animationName: 'cc-line-in',
		allowed: ['opacity'] as const,
	},
];

/**
 * 流程图的**连线**单独一组：它动的是 `stroke-dashoffset`（一笔一笔画出来），
 * 与「换模块」那两处的淡入不是一回事，所以不并进 `SITES`。
 */
const EDGE_SITE: MotionSite = {
	label: '流程图的一条连线（画出来）',
	file: 'src/views/flow/FlowChart.vue',
	selector: '.flow-edge-line',
	tag: 'path',
	animation: 'cc-flow-draw 280ms ease-out 1 both',
	animationName: 'cc-flow-draw',
	allowed: ['stroke-dashoffset'] as const,
};

/** 积木那块单独一组：它的时长/缓动与上面两处不同（落定的手感用的是 `cubic-bezier`），所以不并进 `SITES`。 */
const BLOCK_SITE: MotionSite = {
	label: '一块积木（拖进来 → 落位）',
	file: 'src/views/blockly/BlocklyView.vue',
	// 选择器不带 `blocklyDraggable`：这块画布是 readOnly 的，Blockly 只给可拖的块挂那个类
	// （真浏览器里量过：readOnly 的块根上没有它）。判据是我们自己挂的 `cc-block-enter`。
	selector: `.canvas-host g.${BLOCK_STEP_ENTER_CLASS}`,
	host: '.canvas-host',
	tag: 'g',
	layerClass: BLOCK_STEP_ENTER_CLASS,
	animation: 'cc-block-land 220ms cubic-bezier(0.22, 0.9, 0.3, 1) 1 both',
	animationName: 'cc-block-land',
	allowed: BLOCK_LANDING_PROPERTIES,
};

const ALL_SITES: readonly MotionSite[] = [...SITES, BLOCK_SITE];

/** 读一次样式表并摊平（各站点各读一次，缓存住）。 */
const styles = new Map<string, string>();
const styleFor = (site: MotionSite): string => {
	const cached = styles.get(site.file);
	if (cached !== undefined) return cached;
	const css = flattenDeep(styleOf(site.file));
	styles.set(site.file, css);
	return css;
};

const rulesFor = (site: MotionSite): StyleRule[] => scrapeRules(styleFor(site));

/**
 * 站点那条**入场**规则：选择器正好是它、且真的声明了 `animation`。
 * 「真的声明了」这个条件是必要的——同一个类名下本来就有别的静态规则
 * （`.node-card` 的边框、`.cp-line` 的间距），先撞上的未必是入场那条。
 */
const baseRule = (site: MotionSite): StyleRule => {
	const rule = rulesFor(site).find(
		(candidate) =>
			candidate.condition === '' &&
			selects(candidate.selector, site.selector) &&
			declared(candidate.body, 'animation') !== null,
	);
	if (rule === undefined) throw new Error(`${site.file} 里没有 ${site.selector} 的入场规则`);
	return rule;
};

const keyframesOf = (site: MotionSite): StyleRule => {
	const rule = rulesFor(site).find(
		(candidate) => candidate.condition === '' && candidate.selector.trim() === `@keyframes ${site.animationName}`,
	);
	if (rule === undefined) throw new Error(`${site.file} 里没有 @keyframes ${site.animationName}`);
	return rule;
};

/** 造一个能接住级联的元素：有 `host` 的装在 host 里（选择器是后代关系）。 */
const elementFor = (site: MotionSite): HTMLElement => {
	if (site.host === undefined) {
		const element = document.createElement(site.tag ?? 'li');
		element.className = site.selector.replace(/^\./, '');
		for (const [name, value] of Object.entries(site.attributes ?? {})) element.setAttribute(name, value);
		document.body.append(element);
		return element;
	}
	const host = document.createElement('div');
	host.className = site.host.replace(/^\./, '');
	const layer = document.createElement(site.tag ?? 'div');
	layer.className = site.layerClass ?? '';
	for (const [name, value] of Object.entries(site.attributes ?? {})) layer.setAttribute(name, value);
	host.append(layer);
	document.body.append(host);
	return layer;
};

describe('换模块时的入场 · 两处同一个口径', () => {
	it('时长/缓动/次数/填充一模一样，只有动画名不同', () => {
		const tails = SITES.map((site) => {
			// 简写全文按空格拆：第一段是动画名，剩下的是时长/缓动/次数/填充
			const value = declared(baseRule(site).body, 'animation');
			expect(value, `${site.label} 那条规则里没写 animation`).not.toBeNull();
			return (value ?? '').split(/\s+/).slice(1);
		});
		expect(tails).toEqual([
			['220ms', 'ease-out', '1', 'both'],
			['220ms', 'ease-out', '1', 'both'],
		]);
	});

	it('两处各自钉住自己的动画名与时长（经级联之后，真元素上读到的就是它）', () => {
		for (const site of SITES) {
			injected.push(installCss(styleFor(site)));
			const element = elementFor(site);
			expect(window.getComputedStyle(element).animation, `${site.label} 没拿到入场动画`).toBe(site.animation);
		}
	});

	it('keyframes 里只动 opacity/transform，不碰任何会触发布局的属性', () => {
		for (const site of SITES) {
			const rule = keyframesOf(site);
			const properties = [...new Set(declaredProperties(rule.body))];
			expect(properties.length, `${site.animationName} 里一个属性都没声明`).toBeGreaterThan(0);
			expect(properties.filter((name) => !site.allowed.includes(name))).toEqual([]);
			// 顺带钉住「淡入」这件事本身：起点必须是全透明
			// （值后面那个 `\s*[;}]` 不能省：写成 `0.4` 也会被 `opacity:\s*0` 放过去）
			expect(rule.body).toMatch(/from\s*\{[^}]*opacity:\s*0\s*[;}]/);
		}
	});
});

describe('流程图的连线 · 一笔一笔画出来（样式表那一侧）', () => {
	it('经级联之后真元素上读到的是那条画线动画', () => {
		injected.push(installCss(styleFor(EDGE_SITE)));
		expect(window.getComputedStyle(elementFor(EDGE_SITE)).animation).toBe(EDGE_SITE.animation);
	});

	it('只动 stroke-dashoffset，而且收在 0（完整的线，不留半截）', () => {
		const body = keyframesOf(EDGE_SITE).body;
		const properties = [...new Set(declaredProperties(body))];
		expect(properties).toEqual(['stroke-dashoffset']);
		expect(body).toMatch(/from\s*\{[^}]*stroke-dashoffset:\s*1\s*[;}]/);
		expect(body).toMatch(/to\s*\{[^}]*stroke-dashoffset:\s*0\s*[;}]/);
	});

	it('长度归一化：`stroke-dasharray: 1` 配合 `pathLength="1"`，与线实际多长无关', () => {
		const rule = baseRule(EDGE_SITE);
		expect(declared(rule.body, 'stroke-dasharray')).toBe('1');
	});

	it('偏好关掉时一个字都不动：媒体块里那条是 animation: none', () => {
		const reduced = rulesFor(EDGE_SITE).filter(
			(candidate) => selects(candidate.selector, EDGE_SITE.selector) && declared(candidate.body, 'animation') === 'none',
		);
		expect(reduced.length).toBeGreaterThan(0);
		expect(reduced.map((rule) => rule.condition)).toEqual(reduced.map(() => '@media (prefers-reduced-motion: reduce)'));
	});
});

describe('积木的入场 · 拖进来 → 落位（样式表那一侧）', () => {
	it('经级联之后真元素上读到的是那条落位动画', () => {
		injected.push(installCss(styleFor(BLOCK_SITE)));
		expect(window.getComputedStyle(elementFor(BLOCK_SITE)).animation).toBe(BLOCK_SITE.animation);
	});

	it('只动 opacity/translate/scale：没有 transform 简写（它会盖掉 Blockly 写的定位）', () => {
		const properties = [...new Set(declaredProperties(keyframesOf(BLOCK_SITE).body))];
		expect(properties.sort()).toEqual(['opacity', 'scale', 'translate']);
	});

	it('起点是「在工具箱那边、小一点、透明」，终点是 identity（不留残留变换）', () => {
		const body = keyframesOf(BLOCK_SITE).body;
		// 起点：从左边（工具箱那一边）滑进来 + 缩小 + 透明
		expect(body).toMatch(/from\s*\{[^}]*opacity:\s*0\s*[;}]/);
		expect(body).toMatch(/from\s*\{[^}]*translate:\s*-\d+px/);
		expect(body).toMatch(/from\s*\{[^}]*scale:\s*0\.\d+/);
		// 终点：identity —— 这两条就是「不许留残留变换」那条纪律的机器判据
		expect(body).toMatch(/to\s*\{[^}]*translate:\s*none\s*[;}]/);
		expect(body).toMatch(/to\s*\{[^}]*scale:\s*none\s*[;}]/);
	});

	it('类名与实现里挂的是同一个（样式表跟代码各写各的就会漏）', () => {
		expect(baseRule(BLOCK_SITE).selector).toBe(`.canvas-host g.${BLOCK_STEP_ENTER_CLASS}`);
	});

	it('时长不超过 250ms（导演给的上限：那段时间里命中区可能对不上）', () => {
		const value = declared(baseRule(BLOCK_SITE).body, 'animation') ?? '';
		const ms = Number(/(\d+)ms/.exec(value)?.[1] ?? '0');
		expect(ms).toBeGreaterThan(0);
		expect(ms).toBeLessThanOrEqual(250);
		// 实现里那条「放完再摘类」的余量必须比动画长，否则最后一帧会被切掉
		expect(BLOCK_STEP_ENTER_MS).toBeLessThanOrEqual(ms);
	});

	it('偏好关掉时一个字都不动：媒体块里那条是 animation: none', () => {
		const reduced = rulesFor(BLOCK_SITE).filter(
			(candidate) => selects(candidate.selector, BLOCK_SITE.selector) && declared(candidate.body, 'animation') === 'none',
		);
		expect(reduced.length).toBeGreaterThan(0);
		expect(reduced.map((rule) => rule.condition)).toEqual(reduced.map(() => '@media (prefers-reduced-motion: reduce)'));

		// happy-dom 不认媒体查询，所以把那个块**里面**的规则单独注入一次，模拟「偏好已开」
		const base = installCss(styleFor(BLOCK_SITE));
		const override = installCss(
			reduced.map((rule) => `${rule.selector} { ${rule.body} }`).join('\n'),
		);
		expect(window.getComputedStyle(elementFor(BLOCK_SITE)).animation).toBe('none');
		override();
		base();
	});
});

describe('换模块时 · 真组件上确实挂着', () => {
	beforeEach(async () => {
		// 两张画布现在画的是**教学规格**（第二次调用的产出），所以先让夹具规格到手。
		await loadTeachingFixture();
		setSelectedDevice('phase1_robot');
		loadSampleTask();
		doc.select(null);
		doc.selectStep(null);
	});

	it('流程图挂出来的节点与连线各自拿到那条入场/画线动画', () => {
		injected.push(installCss(styleFor(SITES[0] as MotionSite)));
		const spec = styleFor(EDGE_SITE);
		injected.push(installCss(spec));
		const wrapper = mount(FlowView, { attachTo: document.body });
		wrappers.push(wrapper);

		const nodes = wrapper.findAll('.flow-node');
		const edges = wrapper.findAll('.flow-edge-line');
		expect(nodes.length).toBeGreaterThan(0);
		expect(edges.length).toBeGreaterThan(0);
		for (const node of nodes) {
			expect(window.getComputedStyle(node.element).animation).toBe('cc-flow-node-in 220ms ease-out 1 both');
		}
		for (const edge of edges) {
			expect(window.getComputedStyle(edge.element).animation).toBe('cc-flow-draw 280ms ease-out 1 both');
		}
	});

	it('代码面板挂出来的每一行都拿到 cc-line-in', () => {
		injected.push(installCss(styleFor(SITES[1] as MotionSite)));
		const wrapper = mount(CodePanel, { attachTo: document.body });
		wrappers.push(wrapper);

		const lines = wrapper.findAll('li.cp-line');
		expect(lines.length).toBeGreaterThan(0);
		for (const line of lines) {
			expect(window.getComputedStyle(line.element).animation).toBe('cc-line-in 220ms ease-out 1 both');
		}
	});
});

/* ───────────────────── 积木入场的接线 ───────────────────── */

/** `prefers-reduced-motion` 打桩：`matches` 只对那一条查询为真（与 `LinkOverlay.test.ts` 同形）。 */
const realMatchMedia = window.matchMedia;

const stubMotion = (reduce: boolean): void => {
	const list = (query: string) => ({
		matches: reduce && query.includes('prefers-reduced-motion'),
		media: query,
		onchange: null,
		addEventListener: () => undefined,
		removeEventListener: () => undefined,
		addListener: () => undefined,
		removeListener: () => undefined,
		dispatchEvent: () => false,
	});
	Object.defineProperty(window, 'matchMedia', { configurable: true, writable: true, value: list });
};

afterEach(() => {
	stubMotion(false);
	if (realMatchMedia === undefined) return;
	Object.defineProperty(window, 'matchMedia', { configurable: true, writable: true, value: realMatchMedia });
	vi.useRealTimers();
});

/** 一个假的块元素：`playBlockStepEntrance` 只用到 `classList`、`style`、`getBBox` 与那次读布局。 */
const fakeBlock = (): { element: Element; has: () => boolean; origin: () => string } => {
	const element = document.createElement('div');
	// `getBBox` 在 happy-dom 里没有：块自己那个框是设置变换原点用的，这里给一个假的
	// （有框才看得出「原点设了、收尾又擦掉了」）。
	Object.defineProperty(element, 'getBBox', {
		configurable: true,
		value: () => ({ x: 0, y: 0, width: 120, height: 40 }),
	});
	document.body.append(element);
	return {
		element,
		has: () => element.classList.contains(BLOCK_STEP_ENTER_CLASS),
		origin: () => element.style.transformOrigin,
	};
};

describe('积木入场 · playBlockStepEntrance（一块）', () => {
	it('挂上类、放完摘掉，并把内联的 transform-origin 擦干净（不留残留）', () => {
		vi.useFakeTimers();
		const block = fakeBlock();
		playBlockStepEntrance(block.element);

		expect(block.has(), '调用之后类没挂上，样式表那段落位就不会跑').toBe(true);
		expect(block.origin(), '缩放的原点该按这一块自己的框设好（不然会拽向画布原点）').toBe('60px 20px');
		vi.advanceTimersByTime(BLOCK_STEP_ENTER_MS + 99);
		expect(block.has(), '还没到收尾就把类摘了，动画会被腰斩').toBe(true);
		vi.advanceTimersByTime(1);
		expect(block.has(), '到点没摘，那个类会越攒越多').toBe(false);
		expect(block.origin(), '收尾之后还留着内联的变换原点——那是残留').toBe('');
		expect(vi.getTimerCount()).toBe(0);
	});

	it('延迟起手：到点之前一块都不动（一棵树按顺序落位靠它）', () => {
		vi.useFakeTimers();
		const block = fakeBlock();
		playBlockStepEntrance(block.element, 90);

		expect(block.has()).toBe(false);
		vi.advanceTimersByTime(89);
		expect(block.has(), '还没到起手时刻就动了').toBe(false);
		vi.advanceTimersByTime(1);
		expect(block.has()).toBe(true);
	});

	it('同一块连着挂两次：只留一条收尾，前一条不许提前把它摘掉', () => {
		vi.useFakeTimers();
		const block = fakeBlock();

		playBlockStepEntrance(block.element); // t=0，收尾排在 320
		vi.advanceTimersByTime(100);
		playBlockStepEntrance(block.element); // t=100，收尾改排到 420
		vi.advanceTimersByTime(221); // t=321：第一条本来到点了
		expect(block.has(), '第一条收尾把第二次的动画摘掉了').toBe(true);
		vi.advanceTimersByTime(99);
		expect(block.has()).toBe(false);
		expect(vi.getTimerCount(), '计时器没收干净').toBe(0);
	});

	it('偏好关掉时一个字都不动：不挂类、也不排计时器', () => {
		vi.useFakeTimers();
		stubMotion(true);
		const block = fakeBlock();
		playBlockStepEntrance(block.element);
		expect(block.has()).toBe(false);
		expect(vi.getTimerCount()).toBe(0);
	});
});

describe('积木入场 · playBlockTreeEntrance（一棵树）', () => {
	it('深度优先一块块落位：先父后子，间隔是那个常量', () => {
		vi.useFakeTimers();
		// 两棵顶层块：第一棵带一个子块（C 形块里嵌着一条语句），第二棵没有子块
		const first = fakeBlock();
		const child = fakeBlock();
		const second = fakeBlock();
		/** 假块：只答这一层用到的两个方法（`getChildren` / `getSvgRoot`）。 */
		const node = (self: ReturnType<typeof fakeBlock>, kids: readonly unknown[]) => ({
			getChildren: () => kids,
			getSvgRoot: () => self.element,
		});
		const workspace = {
			getTopBlocks: () => [node(first, [node(child, [])]), node(second, [])],
		} as unknown as Parameters<typeof playBlockTreeEntrance>[0];

		playBlockTreeEntrance(workspace);
		expect(first.has(), '第一块该立刻起手').toBe(true);
		expect(child.has(), '子块该等一拍').toBe(false);
		expect(second.has()).toBe(false);

		vi.advanceTimersByTime(BLOCK_LANDING_STAGGER_MS);
		expect(child.has(), '顺序该是深度优先：父块之后紧跟着它里面的语句').toBe(true);
		expect(second.has(), '第二棵顶层块该再晚一拍').toBe(false);

		vi.advanceTimersByTime(BLOCK_LANDING_STAGGER_MS);
		expect(second.has()).toBe(true);
	});

	it('偏好关掉时一个字都不动', () => {
		vi.useFakeTimers();
		stubMotion(true);
		const block = fakeBlock();
		const workspace = {
			getTopBlocks: () => [{ getChildren: () => [], getSvgRoot: () => block.element }],
		} as unknown as Parameters<typeof playBlockTreeEntrance>[0];

		playBlockTreeEntrance(workspace);
		expect(block.has()).toBe(false);
		expect(vi.getTimerCount()).toBe(0);
	});

	it('空工作区不炸', () => {
		vi.useFakeTimers();
		const workspace = { getTopBlocks: () => [] } as unknown as Parameters<typeof playBlockTreeEntrance>[0];
		expect(() => playBlockTreeEntrance(workspace)).not.toThrow();
	});
});
