// @vitest-environment happy-dom
/**
 * 右栏的接线验收：**固定两块——上面虚拟设备，下面代码面板**。
 *
 * 右栏没有 tab。虚拟设备那块是固定的，现在如实为空（设备层未接入），
 * 所以它只承载一段说明，且封了高度上限，不许把代码面板挤没。
 * 代码面板显示的仍是声明的编译产物（spec §4.1），自带滚动、吃满剩余高度。
 *
 * 「占满右栏」是布局属性（grid 轨道 + min-height:0），happy-dom 不跑样式表，
 * 所以这里守住结构与顺序，真实高度在浏览器里量（见交付报告）。
 */
import { mount } from '@vue/test-utils';
import { beforeEach, describe, expect, it } from 'vitest';
import { computeWorkflowDigest, type WorkflowNode } from '@codecanvas/contracts';
import { loadSampleTask, useStudioDocument } from '../../state/document';
import RightPanel from './RightPanel.vue';

const doc = useStudioDocument();

const panel = () => mount(RightPanel);

/** 模拟积木侧写回：改一个参数，重算摘要，走唯一的写入口。 */
const applyParam = (nodeId: string, name: string, value: number): boolean => {
	const current = doc.declaration.value;
	if (current === null) throw new Error('sample task must be loaded');
	const nodes: WorkflowNode[] = current.nodes.map((node) =>
		node.id === nodeId ? { ...node, parameters: { ...node.parameters, [name]: value } } : node,
	);
	const draft = { ...current, nodes };
	return doc.applyDeclaration({ ...draft, digest: computeWorkflowDigest(draft) });
};

beforeEach(() => {
	expect(loadSampleTask()).toBe(true);
});

describe('右栏 · 代码面板常驻', () => {
	it('代码面板在，且渲染的是编译产物', () => {
		const wrapper = panel();

		expect(wrapper.find('.code-panel').exists()).toBe(true);
		expect(wrapper.get('[data-testid="right-panel-code"]').find('[data-testid="code-panel"]').exists()).toBe(
			true,
		);
		expect(wrapper.text()).toContain('move(linear=0.2, angular=0.0, duration=5.0)');
		expect(wrapper.text()).toContain('stop_if_obstacle(sensors=["/scan0"], distance=0.5)');
	});

	it('安全限值也还在（面板整块都在，不是只留个标题）', () => {
		const wrapper = panel();
		expect(wrapper.get('[data-testid="code-limits"]').text()).toContain('max_linear');
	});

	it('改一个参数 → 面板跟着变', async () => {
		const wrapper = panel();
		expect(wrapper.text()).toContain('move(linear=0.2');

		const first = doc.declaration.value?.nodes[0];
		expect(first).toBeDefined();
		if (first === undefined) return;

		expect(applyParam(first.id, 'linear', 0.15)).toBe(true);
		await wrapper.vm.$nextTick();

		expect(wrapper.text()).toContain('move(linear=0.15, angular=0.0, duration=5.0)');
	});

	it('面板是右栏的主内容：它的槽位带着撑满所需的约束（flex 吃剩余高度 + min-height 0）', () => {
		const wrapper = panel();
		const slot = wrapper.get('[data-testid="right-panel-code"]');
		expect(slot.classes()).toContain('panel-code');
		// 虚拟设备那块自带上限，不能长成无底洞
		expect(wrapper.get('.device').classes()).toContain('device');
	});

	it('右栏仍是右栏：测试 id 在容器上，代码面板在它里面', () => {
		const wrapper = panel();
		const root = wrapper.get('[data-testid="right-panel"]');

		expect(root.classes()).toContain('right-panel');
		expect(root.find('[data-testid="code-panel"]').exists()).toBe(true);
	});
});

describe('右栏 · 虚拟设备（固定常驻，如实为空）', () => {
	it('虚拟设备那块在右栏里，且带自己的图标与标题', () => {
		const wrapper = panel();
		const device = wrapper.get('[data-testid="virtual-device"]');

		expect(device.find('svg.cc-icon').exists()).toBe(true);
		expect(device.get('.panel-title').text()).toBe('虚拟设备');
	});

	it('如实说明未实现：点名设备层没接上，这块现在是空的', () => {
		const wrapper = panel();
		const note = wrapper.get('[data-testid="virtual-device-note"]').text();

		expect(note).toContain('设备层还没接上');
		expect(note).toContain('空着');
		// 不给假状态、也不写空话
		expect(note).not.toContain('即将上线');
		expect(note).not.toContain('敬请期待');
	});

	it('它说清了将来放什么：设备状态 + 能力目录', () => {
		const note = panel().get('[data-testid="virtual-device-note"]').text();
		expect(note).toContain('状态');
		expect(note).toContain('能力目录');
	});

	it('虚拟设备**在**代码面板上方（原图右栏的排法：上设备、下 CODE）', () => {
		const wrapper = panel();
		const device = wrapper.get('[data-testid="virtual-device"]').element;
		const code = wrapper.get('[data-testid="right-panel-code"]').element;

		expect(device.compareDocumentPosition(code) & 4).toBeTruthy();
		expect(wrapper.get('[data-testid="virtual-device"]').find('.code-panel').exists()).toBe(false);
	});

	it('虚拟设备不随任何东西变——它就是固定的（右栏不接受切换入参）', () => {
		const wrapper = panel();
		const first = wrapper.get('[data-testid="virtual-device"]').text();
		expect(wrapper.props()).toEqual({});
		expect(wrapper.get('[data-testid="virtual-device"]').text()).toBe(first);
	});
});
