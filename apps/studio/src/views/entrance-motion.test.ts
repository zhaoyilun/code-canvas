/**
 * 「换模块时画面淡入一下」这三处的验收：流程卡与连线、代码行、积木层。
 *
 * 为什么要单独一个文件：这三条动画此前一条测试都没有，而它们最容易的写法就是写一句
 * 「看起来有动画」——那种话说不出真假。这里把**能机械核的部分**钉住四件：
 *   1. **真挂上了**：把组件的 `<style>` 块读出来注入文档，再读 `getComputedStyle().animation`
 *      ——量的是真元素经级联之后拿到的那条声明，不是源码里有没有那行字；
 *   2. **只动 opacity/transform**：这两样不触发布局。映射栏那条动线逐帧量的是
 *      `getBoundingClientRect`，动画里改 `width`/`left` 会让线在动画期间指错地方；
 *      积木层更严——`transform` 会挪动 `blocklyBlockCanvas` 的坐标系，而 Blockly 按内部坐标
 *      算命中区与连线，所以那边连 `transform` 都不许有（下面按站点分别钉）。
 *   3. **三处同一个口径**：除了动画名，时长/缓动/次数/填充必须一模一样。三处各写各的数值，
 *      迟早会有一处跟不上——而这一屏上那三块是同时到位的，快慢不一就等于在说「它们不是一件事」。
 *   4. **偏好关掉时一个字都不动**：`prefers-reduced-motion: reduce` 那条把 `animation` 收成 `none`。
 *
 * happy-dom 与 vitest 的三处短处（下面都绕开了，它们不是被测对象的性质）：
 *   - **不拆简写**：`animationName` / `animationDuration` 一律是空串（实测），只有
 *     `getComputedStyle().animation` 拿得到级联结果，所以断言的是简写全文；
 *   - **不认 `@media` 级联**：媒体块里的规则不会自己生效，于是把那个块**单独注入**当
 *     「偏好已开」跑一遍，另有一条断言钉住那个块的查询串就是 `(prefers-reduced-motion: reduce)`；
 *   - **不处理 CSS**：SFC 的 `<style scoped>` 不会自己进文档，所以由本文件读文件 + 注入；
 *     `:deep(...)` 是 Vue 编译期的东西，注入前摊平成里面的选择器（编译产物里也正是这个形状）。
 *
 * 积木层那份为什么没有一样地「挂组件再量」：`Blockly.inject` 在 happy-dom 里跑不完
 * （见 `blockly/BlocklyView.test.ts` 的文件头）。所以那一层量两件能分开量的事——
 * 样式表那条规则（手工搭一个同形状的块层去接级联），以及 `playBlockEntrance` 的接线与收尾。
 */
import { mount } from '@vue/test-utils';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setSelectedDevice } from '../shell/devices';
import { loadSampleTask, useStudioDocument } from '../state/document';
import { BLOCKS_ENTER_CLASS, playBlockEntrance } from './blockly/blockly-canvas';
import CodePanel from './code-panel/CodePanel.vue';
import FlowView from './flow/FlowView.vue';

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

/* ───────────────────────── 三处的共同口径 ───────────────────────── */

interface MotionSite {
	readonly label: string;
	/** 相对 `apps/studio` 的路径。 */
	readonly file: string;
	/** 样式表里那条选择器（`:deep` 摊平之后的形状）。 */
	readonly selector: string;
	/** 命中它的元素要在哪个容器里（积木层的规则挂在 `.canvas-host` 下）。 */
	readonly host?: string;
	readonly animation: string;
	readonly animationName: string;
	/** 这段 keyframes 允许动哪些属性。 */
	readonly allowed: readonly string[];
}

/** 只动 `opacity`：不触发布局，也不碰坐标。 */
const OPACITY_ONLY = ['opacity'] as const;
/** 流程卡与连线多一个 `translateY`：上面那条动线量的是 `getBoundingClientRect`，它会跟着走。 */
const OPACITY_AND_TRANSFORM = ['opacity', 'transform'] as const;

const SITES: readonly MotionSite[] = [
	{
		label: '流程卡与连线',
		file: 'src/views/flow/FlowSequence.vue',
		selector: '.node-card',
		animation: 'cc-node-in 220ms ease-out 1 both',
		animationName: 'cc-node-in',
		allowed: OPACITY_AND_TRANSFORM,
	},
	{
		label: '代码行',
		file: 'src/views/code-panel/CodePanel.vue',
		selector: '.cp-line',
		animation: 'cc-line-in 220ms ease-out 1 both',
		animationName: 'cc-line-in',
		allowed: OPACITY_ONLY,
	},
	{
		label: '积木层',
		file: 'src/views/blockly/BlocklyView.vue',
		selector: '.canvas-host .blocklyBlockCanvas.cc-blocks-enter',
		host: '<div class="canvas-host"></div>',
		animation: 'cc-blocks-in 220ms ease-out 1 both',
		animationName: 'cc-blocks-in',
		// 积木层不许有 transform：它会挪动 blocklyBlockCanvas 的坐标系，而 Blockly 自己按
		// 内部坐标算命中区与连线——动画那两百毫秒里点下去会落空。
		allowed: OPACITY_ONLY,
	},
];

/** 读一次样式表并摊平（三个站点各读一次，缓存住）。 */
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

/** 造一个能接住级联的元素：积木层要装在那个 host 里（选择器是后代关系）。 */
const elementFor = (site: MotionSite): HTMLElement => {
	if (site.host === undefined) {
		const element = document.createElement('li');
		element.className = site.selector.replace(/^\./, '');
		document.body.append(element);
		return element;
	}
	const host = document.createElement('div');
	host.className = 'canvas-host';
	const layer = document.createElement('div');
	layer.className = 'blocklyBlockCanvas cc-blocks-enter';
	host.append(layer);
	document.body.append(host);
	return layer;
};

describe('入场动画 · 三处同一个口径', () => {
	it('三处的时长/缓动/次数/填充一模一样，只有动画名不同', () => {
		const tails = SITES.map((site) => {
			// 简写全文按空格拆：第一段是动画名，剩下的是时长/缓动/次数/填充
			const value = declared(baseRule(site).body, 'animation');
			expect(value, `${site.label} 那条规则里没写 animation`).not.toBeNull();
			return (value ?? '').split(/\s+/).slice(1);
		});
		expect(tails).toEqual([
			['220ms', 'ease-out', '1', 'both'],
			['220ms', 'ease-out', '1', 'both'],
			['220ms', 'ease-out', '1', 'both'],
		]);
	});

	it('三处各自钉住自己的动画名与时长（经级联之后，真元素上读到的就是它）', () => {
		for (const site of SITES) {
			injected.push(installCss(styleFor(site)));
			const element = elementFor(site);
			expect(window.getComputedStyle(element).animation, `${site.label} 没拿到入场动画`).toBe(site.animation);
		}
	});

	it('keyframes 里只动 opacity/transform，不碰任何会触发布局的属性', () => {
		for (const site of SITES) {
			const rule = rulesFor(site).find(
				(candidate) => candidate.condition === '' && candidate.selector.trim() === `@keyframes ${site.animationName}`,
			);
			expect(rule, `${site.file} 里没有 @keyframes ${site.animationName}`).toBeDefined();
			const properties = [...new Set(declaredProperties(rule?.body ?? ''))];
			expect(properties.length, `${site.animationName} 里一个属性都没声明`).toBeGreaterThan(0);
			expect(properties.filter((name) => !site.allowed.includes(name))).toEqual([]);
			// 顺带钉住「淡入」这件事本身：起点必须是全透明
			// （值后面那个 `\s*[;}]` 不能省：写成 `0.4` 也会被 `opacity:\s*0` 放过去）
			expect(rule?.body ?? '').toMatch(/from\s*\{[^}]*opacity:\s*0\s*[;}]/);
		}
	});

	it('积木层那个类名与实现里挂的类名是同一个（样式表跟代码各写各的就会漏）', () => {
		expect(baseRule(SITES[2] as MotionSite).selector).toBe(`.canvas-host .blocklyBlockCanvas.${BLOCKS_ENTER_CLASS}`);
	});
});

describe('入场动画 · 真组件上确实挂着', () => {
	beforeEach(() => {
		setSelectedDevice('phase1_robot');
		loadSampleTask();
		doc.select(null);
		doc.selectStep(null);
	});

	it('流程画布挂出来的卡片与连线都拿到 cc-node-in', () => {
		injected.push(installCss(styleFor(SITES[0] as MotionSite)));
		const wrapper = mount(FlowView, { attachTo: document.body });
		wrappers.push(wrapper);

		const cards = wrapper.findAll('[data-testid="flow-node-card"]');
		const connectors = wrapper.findAll('[data-testid="flow-connector"]');
		expect(cards.length).toBeGreaterThan(0);
		expect(connectors.length).toBeGreaterThan(0);
		for (const element of [...cards, ...connectors]) {
			expect(window.getComputedStyle(element.element).animation).toBe('cc-node-in 220ms ease-out 1 both');
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

describe('入场动画 · 偏好关掉时一个字都不动', () => {
	it('三处那条降级都写在 (prefers-reduced-motion: reduce) 里，且都是 animation: none', () => {
		for (const site of SITES) {
			const rules = rulesFor(site).filter(
				(candidate) => selects(candidate.selector, site.selector) && declared(candidate.body, 'animation') === 'none',
			);
			expect(rules.length, `${site.label} 没有动画降级`).toBeGreaterThan(0);
			// 降级必须挂在媒体查询下——不然它会把常态那条也一起关掉
			expect(rules.map((rule) => rule.condition)).toEqual(rules.map(() => '@media (prefers-reduced-motion: reduce)'));
		}
	});

	it('把媒体块里的规则当「偏好已开」跑一遍级联，三处都收到 none', () => {
		for (const site of SITES) {
			const base = installCss(styleFor(site));
			// happy-dom 不认媒体查询，所以把那个块**里面**的规则单独注入一次，模拟「偏好已开」
			const reduced = rulesFor(site)
				.filter((rule) => rule.condition === '@media (prefers-reduced-motion: reduce)' && selects(rule.selector, site.selector))
				.map((rule) => `${rule.selector} { ${rule.body} }`)
				.join('\n');
			expect(reduced, `${site.label} 的媒体块里没有它那条降级`).not.toBe('');
			const override = installCss(reduced);
			const element = elementFor(site);
			expect(window.getComputedStyle(element).animation, `${site.label} 偏好关掉后还在动`).toBe('none');
			override();
			base();
		}
	});
});

/* ───────────────────────── 积木层入场的接线 ───────────────────────── */

interface FakeLayer {
	readonly classList: { add(name: string): void; remove(name: string): void };
	getBoundingClientRect(): DOMRect;
	/** 此刻类还在不在（假的 classList 也记着这件事，好断言「挂了/摘了」） */
	readonly has: () => boolean;
	readonly added: number;
	readonly removed: number;
	readonly measured: number;
}

/** 假块层：`playBlockEntrance` 只用到 `classList` 与那一次读布局。 */
const fakeLayer = (): FakeLayer => {
	const live = new Set<string>();
	const layer = {
		classList: {
			add: (name: string) => {
				live.add(name);
				counts.added += 1;
			},
			remove: (name: string) => {
				live.delete(name);
				counts.removed += 1;
			},
		},
		getBoundingClientRect: () => {
			counts.measured += 1;
			return {} as DOMRect;
		},
	};
	const counts = { added: 0, removed: 0, measured: 0 };
	return {
		...layer,
		has: () => live.has(BLOCKS_ENTER_CLASS),
		get added() {
			return counts.added;
		},
		get removed() {
			return counts.removed;
		},
		get measured() {
			return counts.measured;
		},
	};
};

/** 一个只答 `getCanvas()` 的假工作区——这个函数就用到这一处。 */
const fakeWorkspace = (layer: unknown): Parameters<typeof playBlockEntrance>[0] =>
	({ getCanvas: () => layer }) as unknown as Parameters<typeof playBlockEntrance>[0];

const realMatchMedia = window.matchMedia;

/** `prefers-reduced-motion` 打桩：`matches` 只对那一条查询为真（与 `LinkOverlay.test.ts` 同形）。 */
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

describe('积木层入场 · playBlockEntrance', () => {
	it('挂上类、到点摘掉（时长之外留的收尾余量算在一起）', () => {
		vi.useFakeTimers();
		const layer = fakeLayer();
		playBlockEntrance(fakeWorkspace(layer));

		expect(layer.has(), '调用之后类没挂上，样式表那段淡入就不会跑').toBe(true);
		vi.advanceTimersByTime(319);
		expect(layer.has(), '还没到 320ms 就把类摘了，动画会被腰斩').toBe(true);
		vi.advanceTimersByTime(1);
		expect(layer.has(), '到点没摘，那个类会越攒越多、下次换模块就不重放了').toBe(false);
		expect(layer.removed).toBe(2); // 一次是开头「先摘掉再加」，一次是收尾
	});

	it('连着换两个模块：第二次照样重放，且上一次那条收尾不许提前摘', () => {
		vi.useFakeTimers();
		const layer = fakeLayer();

		playBlockEntrance(fakeWorkspace(layer)); // 换第一个模块，t=0，收尾排在 320
		vi.advanceTimersByTime(100);
		playBlockEntrance(fakeWorkspace(layer)); // 还没到点就换第二个模块，t=100，收尾该改排到 420

		expect(layer.added, '第二次没重新挂类——同一个类连着挂两次不会重放动画').toBe(2);
		expect(layer.measured, '第二次没读一次布局，浏览器会把两次合成一次、动画不重放').toBe(2);

		vi.advanceTimersByTime(221); // t=321：第一次那条本来排在 320，早该到点了
		expect(layer.has(), '第一次那条收尾把第二次的类摘掉了——第二次的淡入半路消失').toBe(true);
		vi.advanceTimersByTime(99); // t=420：第二次自己那条到点
		expect(layer.has()).toBe(false);
	});

	it('偏好关掉时一个字都不动：不挂类、也不排计时器', () => {
		vi.useFakeTimers();
		stubMotion(true);
		const layer = fakeLayer();
		playBlockEntrance(fakeWorkspace(layer));

		expect(layer.has()).toBe(false);
		expect(layer.added).toBe(0);
		expect(vi.getTimerCount()).toBe(0);
	});

	it('工作区给不出块层时不炸（拿不到画布 / 拿到的不是元素）', () => {
		vi.useFakeTimers();
		expect(() => playBlockEntrance(fakeWorkspace(null))).not.toThrow();
		expect(() => playBlockEntrance(fakeWorkspace({}))).not.toThrow();
		expect(vi.getTimerCount()).toBe(0);
	});

	it('挂在真元素上也一样：类真的落到 classList 上，到点真的没了', () => {
		vi.useFakeTimers();
		const layer = document.createElement('div');
		layer.className = 'blocklyBlockCanvas';
		document.body.append(layer);

		playBlockEntrance(fakeWorkspace(layer));
		expect(layer.classList.contains(BLOCKS_ENTER_CLASS)).toBe(true);
		vi.advanceTimersByTime(320);
		expect(layer.classList.contains(BLOCKS_ENTER_CLASS)).toBe(false);
	});
});
