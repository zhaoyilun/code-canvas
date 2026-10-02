/**
 * 积木画布在 studio 这一侧的接线用例。
 *
 * happy-dom 里 `Blockly.inject` 跑不完（它在事件绑定上依赖真实浏览器的事件目标），
 * 所以「画布上真有几块积木、字段打字怎么写回真相」这类断言交给两个地方：
 *   - `packages/blockly-toolkit/test/**`：无头工作区上的完整读写往返；
 *   - 本目录的 `implementation.test.ts`：拿**应用真正用的目录与示例任务**把验收那几条
 *     （画面 = 当前模块的实现、字段值、写回只改参数）在无头工作区上再钉一遍；
 *   - 真实浏览器：字段打字 → 写回 → 非法值被拒（手工验过，结论见交付报告）。
 *
 * 这个文件守住的是画布**起来之前的那个前提**：主题色只从 `--cc-*` 变量来，缺了就不画、并说明原因；
 * 以及顶部那行「现在看的是哪个模块」——它只读声明与目录，所以在这一层就能核对。
 * 主题变量由测试从真实的 `theme.css` 里解析出来再喂给 `getComputedStyle`
 * （happy-dom 不解析自定义属性，所以替换的是那条 API，不是变量本身）。
 */
import { mount } from '@vue/test-utils';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadSampleTask, useStudioDocument } from '../../state/document';
import BlocklyView from './BlocklyView.vue';

const THEME_CSS = (): string => readFileSync(resolve(process.cwd(), 'src/shell/theme.css'), 'utf8');

const themeVariables = (): ReadonlyMap<string, string> => {
	const variables = new Map<string, string>();
	const pattern = /(--cc-[a-z0-9-]+)\s*:\s*([^;]+);/g;
	for (const match of THEME_CSS().matchAll(pattern)) {
		const name = match[1];
		const value = match[2];
		if (name !== undefined && value !== undefined) variables.set(name, value.trim());
	}
	return variables;
};

const realGetComputedStyle = globalThis.getComputedStyle;

const stubComputedStyle = (variables: ReadonlyMap<string, string>): void => {
	globalThis.getComputedStyle = (() => ({
		getPropertyValue: (name: string) => variables.get(name) ?? '',
	})) as unknown as typeof globalThis.getComputedStyle;
};

beforeEach(() => {
	expect(loadSampleTask()).toBe(true);
});

afterEach(() => {
	globalThis.getComputedStyle = realGetComputedStyle;
});

describe('积木画布 · 主题前提', () => {
	it('theme.css 里备齐了积木主题要用的每个变量', () => {
		const variables = themeVariables();
		for (const name of [
			'--cc-surface',
			'--cc-surface-raised',
			'--cc-surface-sunken',
			'--cc-accent',
			'--cc-accent-strong',
			'--cc-accent-dim',
			'--cc-danger',
			'--cc-font-mono',
			'--cc-fs-md',
		]) {
			expect(variables.get(name), name).toBeTruthy();
		}
	});

	it('缺主题变量时画布不画，并把原因摆出来', async () => {
		stubComputedStyle(new Map());
		const wrapper = mount(BlocklyView, { attachTo: document.body });
		await wrapper.vm.$nextTick();

		const failure = wrapper.find('[data-testid="blockly-failure"]');
		expect(failure.exists()).toBe(true);
		expect(failure.text()).toContain('--cc-accent');
		expect(wrapper.find('[data-testid="blockly-block-count"]').text()).toBe('0 块');

		wrapper.unmount();
	});

	/**
	 * 标题只读声明与目录，不依赖画布起没起来——这也是它在这一层可核对的原因
	 * （`Blockly.inject` 在 happy-dom 里跑不完，见文件头）。
	 */
	it('顶部标题写的是当前模块：「<能力的 label> · 实现」，没选中就是第一个模块', async () => {
		stubComputedStyle(themeVariables());
		const wrapper = mount(BlocklyView, { attachTo: document.body });
		await wrapper.vm.$nextTick();

		// 示例任务的第一个模块是「前进」——没选中任何节点时画的就是它。
		expect(wrapper.find('[data-testid="blockly-module-title"]').text()).toBe('前进 · 实现');

		// 流程卡片点过来（store 记下选中）→ 标题换成那个模块的能力名。
		const store = useStudioDocument();
		const obstacle = store.nodes.value.find((node) => node.parameters['step_id'] === 's2');
		if (obstacle === undefined) throw new Error('示例任务里应当有 s2');
		store.select(obstacle.id);
		await wrapper.vm.$nextTick();
		expect(wrapper.find('[data-testid="blockly-module-title"]').text()).toBe('避障停止 · 实现');

		store.select(null);
		wrapper.unmount();
	});
});
