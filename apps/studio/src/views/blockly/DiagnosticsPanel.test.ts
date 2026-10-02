// @vitest-environment happy-dom
/**
 * 诊断面板的**显隐**：没有诊断时整块不画，有诊断时照旧画出来（连同「诊断 N」那行头）。
 *
 * 为什么单开一条：这个显隐是组件自己的判据（`rows.length > 0`），不靠调用方记得加 `v-if`；
 * 而 `BlocklyView.test.ts` 那边量的是标题与选中步，量不到这条。诊断的产生方式与
 * `CodePanel.test.ts` 一致——改一个越界参数，写回被拦下，store 里留下一份声明诊断。
 */
import { mount } from '@vue/test-utils';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { computeWorkflowDigest, type WorkflowNode } from '@codecanvas/contracts';
import { setSelectedDevice } from '../../shell/devices';
import { loadSampleTask, useStudioDocument } from '../../state/document';
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

const realGetComputedStyle = globalThis.getComputedStyle;

beforeEach(() => {
	const variables = themeVariables();
	globalThis.getComputedStyle = (() => ({
		getPropertyValue: (name: string) => variables.get(name) ?? '',
	})) as unknown as typeof globalThis.getComputedStyle;
	setSelectedDevice('phase1_robot');
	expect(loadSampleTask()).toBe(true);
});

afterEach(() => {
	globalThis.getComputedStyle = realGetComputedStyle;
});

describe('积木画布 · 诊断面板的显隐', () => {
	it('没有诊断时整块不画（连头带列表都没有）', async () => {
		const wrapper = mount(BlocklyView, { attachTo: document.body });
		await wrapper.vm.$nextTick();

		expect(useStudioDocument().diagnostics.value).toHaveLength(0);
		expect(wrapper.find('[data-testid="blockly-diagnostics"]').exists()).toBe(false);
		expect(wrapper.text()).not.toContain('没有诊断');

		wrapper.unmount();
	});

	it('有一条诊断就照旧画：头、计数、那一条都在', async () => {
		const wrapper = mount(BlocklyView, { attachTo: document.body });
		await wrapper.vm.$nextTick();

		// 越界值被写回通道拦下（与 CodePanel.test.ts 同一条路），store 里留下一份声明诊断。
		const doc = useStudioDocument();
		const current = doc.declaration.value;
		if (current === null) throw new Error('sample task must be loaded');
		const nodes: WorkflowNode[] = current.nodes.map((node, index) =>
			index === 0 ? { ...node, parameters: { ...node.parameters, linear: 1.5 } } : node,
		);
		const draft = { ...current, nodes };
		expect(doc.applyDeclaration({ ...draft, digest: computeWorkflowDigest(draft) })).toBe(false);
		await wrapper.vm.$nextTick();

		const panel = wrapper.find('[data-testid="blockly-diagnostics"]');
		expect(panel.exists()).toBe(true);
		expect(panel.text()).toContain('诊断');
		expect(panel.text()).toContain(String(doc.diagnostics.value.length));
		expect(wrapper.findAll('[data-testid="blockly-diagnostic"]').length).toBeGreaterThan(0);

		wrapper.unmount();
	});
});
