// @vitest-environment happy-dom
/**
 * 外壳的摆放验收：上层**入口带**插在顶部条与三栏之间，三栏是固定分区。
 *
 * 这里只守**位置与接线**——入口带真的挂在外壳上、真的在顶部条下面三栏上面；
 * 入口带上的三样（设备下拉 / 一句话 / 生成）就是那个能换真相的入口；
 * 三栏本身没有分区切换控件（唯一的 tab 条在右栏**里面**，切的是「代码 / 任务 JSON」，
 * 跟「切哪一栏显示」不是一回事）。
 *
 * 真实观感（入口带的高度、转译链的胶囊、右栏比例）在浏览器里量，见交付报告。
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
	window.localStorage.clear();
});

describe('外壳 · 上层入口带', () => {
	it('挂在顶部条之下、三栏之上（原图里上层区域的位置）', () => {
		const wrapper = mount(StudioShell);

		const topbar = wrapper.get('.topbar').element;
		const band = wrapper.get('[data-testid="task-input-band"]').element;
		const body = wrapper.get('.studio-body').element;

		expect(band.compareDocumentPosition(topbar) & 2).toBeTruthy(); // 带子在顶部条之后
		expect(before(band, body)).toBe(true); // 带子在三栏之前
		expect(wrapper.findComponent(TaskInputBand).exists()).toBe(true);
	});

	it('带子带的是真入口：设备下拉 / 一句话 / 生成都在，粘贴兜底折着', () => {
		const wrapper = mount(StudioShell);

		expect(wrapper.find('[data-testid="device-select"]').exists()).toBe(true);
		expect(wrapper.find('[data-testid="instruction-input"]').exists()).toBe(true);
		expect(wrapper.find('[data-testid="task-generate"]').exists()).toBe(true);
		expect(wrapper.find('[data-testid="translation-chain"]').exists()).toBe(true);
		// 旧的形态没了：不再有占掉小半屏的任务 JSON 文本框
		expect(wrapper.find('[data-testid="task-json-input"]').exists()).toBe(false);

		// 三栏之外没有「切哪一栏」的控件（图标栏与顶层 tab 条都已去掉）
		expect(wrapper.find('nav.rail').exists()).toBe(false);
		expect(wrapper.findAll('button[data-testid^="tab-"]')).toHaveLength(0);
		expect(wrapper.find('[data-testid="virtual-device"]').exists()).toBe(true);
	});

	it('唯一的 tab 条在右栏**里面**：切的是「代码 / 任务 JSON」，不是切三栏', () => {
		const wrapper = mount(StudioShell);
		const tablists = wrapper.findAll('[role="tablist"]');

		expect(tablists).toHaveLength(1);
		// 三栏还都在（tab 不改变三栏的布局）
		expect(wrapper.find('[data-testid="view-blockly"]').exists()).toBe(true);
		expect(wrapper.find('[data-testid="view-flow"]').exists()).toBe(true);
		expect(wrapper.find('[data-testid="right-panel"]').exists()).toBe(true);
		// 那个 tab 条属于右栏
		expect(wrapper.get('[data-testid="right-panel"]').find('[role="tablist"]').exists()).toBe(true);
	});

	it('外壳里的入口带就是那个能换真相的入口（同一份 store）', async () => {
		const wrapper = mount(StudioShell);
		const beforeDeclaration = doc.declaration.value;

		// 折起粘贴兜底，灌一份改过的任务
		await wrapper.get('[data-testid="task-paste-toggle"]').trigger('click');
		const area = wrapper.get<HTMLTextAreaElement>('[data-testid="task-json-input"]');
		const task: Record<string, unknown> = {
			schema_version: '1.0',
			task_id: 'task-shell-1',
			description: '从外壳里换掉的描述',
			steps: [{ id: 's1', action: 'stop' }],
			limits: { max_linear: 0.3, max_angular: 1.2, max_duration: 30, require_confirmation: true },
		};
		await area.setValue(JSON.stringify(task));
		await wrapper.get('[data-testid="task-convert"]').trigger('click');

		expect(doc.declaration.value).not.toBe(beforeDeclaration);
		expect(doc.declaration.value?.meta.description).toBe('从外壳里换掉的描述');
		// 右栏的代码面板跟着变——「一份声明，三个视图」在真链路上成立
		expect(wrapper.get('[data-testid="code-panel"]').text()).toContain('从外壳里换掉的描述');
	});

	it('切到任务 JSON tab：同一份声明在右栏那边以 JSON 呈现', async () => {
		const wrapper = mount(StudioShell);

		await wrapper.get('[data-testid="right-tab-json"]').trigger('click');

		const json = wrapper.get('[data-testid="task-json-panel"]').text();
		expect(json).toContain('"task_id": "task-demo-001"');
		expect(json).toContain('"action": "move"');
	});
});
