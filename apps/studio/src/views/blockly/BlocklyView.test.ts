// @vitest-environment happy-dom
/**
 * 积木画布（真组件）：能在这台测试环境里量的三件事，量到底；量不了的，说清楚在哪儿量。
 *
 * ⚠ **`Blockly.inject` 在 happy-dom 里跑不完**（这一条从上一版就写着，实测依旧：
 * Blockly 12 的 `FocusManager` 在 happy-dom 的 `EventTarget` 上抛
 * `Cannot read properties of undefined (reading 'Symbol(listeners)')`）。
 * 所以「块真的画进了工作区、一块块落位」这件事**不在这一组里量**——
 * 它在真浏览器里量（dev server + CDP 截图，见交付说明）。这里量的是围绕它的两件事：
 *
 * 1. **不静默**：画布起不来时要把原因摆在画布上（Blockly 缺主题变量会画成一片黑，那比不画坏得多）；
 * 2. **状态与画布无关地正确**：页脚那行「积木 N 块（讲到第 M 块 / 共 K 块）」读的是规格与播放队列
 *    ——即使画布没建起来，这两个数也是对的（它们是规格的事实，不是画布的产物）。
 */
import { mount, type VueWrapper } from '@vue/test-utils';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { teachingBlockCount, flattenedBlockAnchors } from '@codecanvas/contracts';
import { loadTeachingFixture, TEACHING_SPEC_FIXTURE } from '../../state/__fixtures__/teaching-spec';
import { clearRunningPlanPath, setRunningPlanPath } from '../../shell/device-run';
import { useTeachingLinkage } from '../../state/teaching';
import BlocklyView from './BlocklyView.vue';

/** 主题变量从真实的 `theme.css` 里解析出来喂给 `getComputedStyle`（happy-dom 不解析自定义属性）。 */
const themeVariables = (): ReadonlyMap<string, string> => {
	const variables = new Map<string, string>();
	const pattern = /(--cc-[a-z0-9-]+)\s*:\s*([^;]+);/g;
	const css = readFileSync(resolve(process.cwd(), 'src/shell/theme.css'), 'utf8');
	for (const match of css.matchAll(pattern)) {
		const name = match[1];
		const value = match[2];
		if (name !== undefined && value !== undefined) variables.set(name, value.trim());
	}
	return variables;
};

const stubComputedStyle = (variables: ReadonlyMap<string, string>): void => {
	globalThis.getComputedStyle = (() => ({
		getPropertyValue: (name: string) => variables.get(name) ?? '',
	})) as unknown as typeof globalThis.getComputedStyle;
};

const realGetComputedStyle = globalThis.getComputedStyle;
const realMatchMedia = window.matchMedia;
const wrappers: VueWrapper[] = [];

/** 动效偏好关掉：播放队列一次推满，页脚那两个数立刻是最终值。 */
const stubReducedMotion = (): void => {
	Object.defineProperty(window, 'matchMedia', {
		configurable: true,
		writable: true,
		value: (query: string) => ({
			matches: query.includes('prefers-reduced-motion'),
			media: query,
			onchange: null,
			addEventListener: () => undefined,
			removeEventListener: () => undefined,
			addListener: () => undefined,
			removeListener: () => undefined,
			dispatchEvent: () => false,
		}),
	});
};

const mountView = async (): Promise<VueWrapper> => {
	const wrapper = mount(BlocklyView, { attachTo: document.body });
	wrappers.push(wrapper);
	await wrapper.vm.$nextTick();
	await new Promise((resolve) => setTimeout(resolve, 0));
	return wrapper;
};

beforeEach(async () => {
	stubReducedMotion();
	await loadTeachingFixture();
});

afterEach(() => {
	for (const wrapper of wrappers.splice(0)) wrapper.unmount();
	globalThis.getComputedStyle = realGetComputedStyle;
	vi.unstubAllGlobals();
	Object.defineProperty(window, 'matchMedia', { configurable: true, writable: true, value: realMatchMedia });
});

describe('积木画布 · 状态与画布无关地正确', () => {
	it('页脚说得出规格里有几块、讲到第几块（这两个数读的是规格与播放队列）', async () => {
		stubComputedStyle(themeVariables());
		const wrapper = await mountView();

		const expected = teachingBlockCount(TEACHING_SPEC_FIXTURE.blocks);
		const footer = wrapper.get('[data-testid="blockly-block-count"]').text();
		expect(footer).toContain(`共 ${String(expected)} 块`);
		expect(footer).toContain(`讲到了第 ${String(expected)} 块`);
		expect(wrapper.get('[data-testid="blockly-title"]').text()).toBe(TEACHING_SPEC_FIXTURE.title);
	});

	it('规格还没到手时画布不空着：说清「还没有积木可画」', async () => {
		stubComputedStyle(themeVariables());
		// 一份新规格进来时会把上一份撤下来（见 `state/teaching.ts`），此刻就是那一段空档。
		const teaching = (await import('../../state/teaching')).useTeaching();
		const spec = teaching.spec.value;
		teaching.spec.value = null;
		try {
			const wrapper = await mountView();
			expect(wrapper.get('[data-testid="blockly-empty"]').text()).toContain('还没有积木可画');
		} finally {
			teaching.spec.value = spec;
		}
	});
});

describe('积木画布 · 起不来时不许静默', () => {
	it('缺主题变量：把原因摆在画布上（Blockly 缺样式会画成黑的，那比不画坏得多）', async () => {
		stubComputedStyle(new Map());
		const wrapper = await mountView();

		const failure = wrapper.get('[data-testid="blockly-failure"]');
		expect(failure.text()).toContain('--cc-accent');
		// 页脚照旧说得出规格里有几块——状态是规格的事实，不是画布的产物。
		const footer = wrapper.get('[data-testid="blockly-block-count"]').text();
		expect(footer).toContain(`共 ${String(teachingBlockCount(TEACHING_SPEC_FIXTURE.blocks))} 块`);
		// 而「画布上几块」这一句在画布没起来时**一个字都不说**（报 0 会被读成规格是空的）。
		expect(footer).not.toContain('画布上');
	});

	it('主题齐时不会摆出失败提示（这一台环境里失败的原因是 happy-dom 跑不完 Blockly.inject，原因照样有字）', async () => {
		stubComputedStyle(themeVariables());
		const wrapper = await mountView();

		// happy-dom 里 Blockly 起不来是**环境**的限制（见文件头），但它必须带上原因，不许留空白。
		const failure = wrapper.find('[data-testid="blockly-failure"]');
		if (failure.exists()) expect(failure.text().length).toBeGreaterThan(0);
		else expect(wrapper.find('[data-testid="blockly-canvas"]').exists()).toBe(true);
	});
});

/**
 * 联动：**设备执行到哪一步，积木切到那几块**。
 *
 * ⚠ `Blockly.inject` 在 happy-dom 里起不来（见文件头），所以「画布上真的切过去了」那件事
 * **不在这里量**——它在真浏览器里量（CDP 读数 + 连拍帧）。这里量的是**接线本身**：
 * 归属表与当前步有没有真的交给画布、以及「没有归属时照实说」那句话在不在。
 * 归属表那一条尤其要量：它一旦断了，画布上就永远切不动，而屏幕上不会有任何报错。
 */
describe('积木画布 · 执行到哪一步，切到那几块', () => {
	afterEach(() => clearRunningPlanPath());

	it('归属表与当前步都交给了画布（值块跟着它那个调用块，一格都不缺）', () => {
		stubComputedStyle(themeVariables());
		const linkage = useTeachingLinkage();
		const anchors = linkage.blockAnchorsOf.value;
		expect(anchors).toHaveLength(flattenedBlockAnchors(TEACHING_SPEC_FIXTURE.blocks).length);
		expect(anchors.every((anchor) => anchor !== undefined)).toBe(true);
		// 值块（插进槽里那块）跟着它那个调用块，所以里面那个 `observe_table` 也是 `observe`。
		expect(anchors.filter((anchor) => anchor === 'observe').length).toBeGreaterThan(1);

		setRunningPlanPath('0');
		expect(linkage.currentNodeId.value).toBe('observe');
	});

	it('积木那一条对应关系缺失时：画布照画，页脚说「当前步切到：没有」，并且照实说一句', async () => {
		stubComputedStyle(themeVariables());
		const { loadTeachingFixture, NO_BLOCK_LINKAGE_SPEC } = await import('../../state/__fixtures__/teaching-spec');
		await loadTeachingFixture(NO_BLOCK_LINKAGE_SPEC);
		setRunningPlanPath('0');

		const wrapper = await mountView();
		expect(wrapper.get('[data-testid="blockly-current-blocks"]').text()).toContain('当前步切到：没有');
		expect(wrapper.get('[data-testid="blockly-linkage-note"]').text()).toContain('跟不了设备的当前步');
	});

	it('切过去只用不吃布局的手段：**不碰 `transform`**（Blockly 靠它定位与命中）', () => {
		/*
		 * 这条量的是那一条纪律：块的定位写在块根元素的 `transform` 属性上，
		 * CSS 的 `transform` 会整个盖掉它（块会跳到画布原点，命中区也跟着错）。
		 * 所以「切过去」只能用不吃布局的手段（挂属性 + `filter` 画辉光），这一条钉住它。
		 */
		const css = readFileSync(resolve(process.cwd(), 'src/views/blockly/BlocklyView.vue'), 'utf8');
		expect(css).toContain('data-cc-current-block');
		expect(css).toContain('drop-shadow');
		// 「当前块」那一条样式里不许出现 `transform`（入场动画那几条另算，它们是独立属性）。
		const currentRules = css.split('data-cc-current-block')[1]?.split('}')[0] ?? '';
		expect(currentRules).not.toContain('transform');
	});
});
