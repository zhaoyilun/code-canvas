// @vitest-environment happy-dom
/**
 * 外壳的摆放验收：上层输入带插在顶部条与三栏之间，三栏是固定分区。
 *
 * 这里只守**位置与接线**——输入带真的挂在外壳上、真的在顶部条下面三栏上面、
 * 外壳里没有任何分区切换控件（tab 条与图标栏都已去掉）。
 * 真实观感（88px 的高度、转译链的胶囊、右栏铺满）在浏览器里量，见交付报告。
 */
import { mount } from '@vue/test-utils';
import { beforeEach, describe, expect, it } from 'vitest';
import { loadSampleTask, useStudioDocument } from '../state/document';
import StudioShell from './StudioShell.vue';
import TaskInputBand from './TaskInputBand.vue';

const doc = useStudioDocument();

/** DOM 顺序：a 在 b 之前。 */
const before = (a: Element, b: Element): boolean => (a.compareDocumentPosition(b) & 4) !== 0;

beforeEach(() => {
	expect(loadSampleTask()).toBe(true);
});

describe('外壳 · 上层输入带', () => {
	it('挂在顶部条之下、三栏之上（原图里上层区域的位置）', () => {
		const wrapper = mount(StudioShell);

		const topbar = wrapper.get('.topbar').element;
		const band = wrapper.get('[data-testid="task-input-band"]').element;
		const body = wrapper.get('.studio-body').element;

		expect(band.compareDocumentPosition(topbar) & 2).toBeTruthy(); // 带子在顶部条之后
		expect(before(band, body)).toBe(true); // 带子在三栏之前
		expect(wrapper.findComponent(TaskInputBand).exists()).toBe(true);
	});

	it('带子带的是真入口：输入框与转换按钮都在，外壳里没有分区切换控件', () => {
		const wrapper = mount(StudioShell);

		expect(wrapper.find('[data-testid="task-json-input"]').exists()).toBe(true);
		expect(wrapper.find('[data-testid="task-convert"]').exists()).toBe(true);
		expect(wrapper.find('[data-testid="translation-chain"]').exists()).toBe(true);

		// 固定布局：tab 条与图标栏都已去掉，不留点了没用的控件
		expect(wrapper.find('[role="tablist"]').exists()).toBe(false);
		expect(wrapper.find('nav.rail').exists()).toBe(false);
		expect(wrapper.findAll('button[data-testid^="tab-"]')).toHaveLength(0);
		expect(wrapper.find('[data-testid="virtual-device"]').exists()).toBe(true);
	});

	it('外壳里的输入带就是那个能换真相的入口（同一份 store）', async () => {
		const wrapper = mount(StudioShell);
		const before = doc.declaration.value;

		const textarea = wrapper.get<HTMLTextAreaElement>('[data-testid="task-json-input"]');
		const task = JSON.parse(textarea.element.value) as Record<string, unknown>;
		task.description = '从外壳里换掉的描述';
		await textarea.setValue(JSON.stringify(task));
		await wrapper.get('[data-testid="task-convert"]').trigger('click');

		expect(doc.declaration.value).not.toBe(before);
		expect(doc.declaration.value?.meta.description).toBe('从外壳里换掉的描述');
		// 右栏的代码面板跟着变——「一份声明，三个视图」在真链路上成立
		expect(wrapper.get('[data-testid="code-panel"]').text()).toContain('从外壳里换掉的描述');
	});
});
