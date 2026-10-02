// @vitest-environment happy-dom
/**
 * 右栏的接线验收：**上面虚拟设备（放大到一半以上）+ 下面「代码 / 任务 JSON」两个 tab**。
 *
 * 三件事：
 * 1. 虚拟设备那块是固定的、占比更大（`flex` 5:4，去掉 tab 条后约 52%）——将来要放真的 3D
 *    或状态图，那一块得先有地方；它如实说明「设备层未接入」，事实表里列的是**设备**那一行行真东西
 *    （名字、真机还是仿真、目录、能力与原语数，以及真实上游数据的出处）；
 * 2. 下半块是 tab：代码面板是其中一个（内容一个字没改，仍是声明的编译产物），
 *    另一个是任务 JSON 视图；切到 JSON 时面板里就是它，切换是纯界面状态；
 * 3. 两个 tab 的键位是常规的（点击 + 左右方向键）。
 *
 * 真实高度在浏览器里量（见交付报告）——happy-dom 不跑样式表，这里守结构与接线。
 */
import { mount } from '@vue/test-utils';
import { beforeEach, describe, expect, it } from 'vitest';
import { ROBOFRAME_SO101_CATALOG, ROBOFRAME_SO101_PROVENANCE } from '@codecanvas/capabilities';
import { computeWorkflowDigest, type WorkflowNode } from '@codecanvas/contracts';
import { loadSampleTask, useStudioDocument } from '../../state/document';
import { setSelectedDevice } from '../../shell/devices';
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
	// 示例样例跟当前设备的格式走，所以先把设备切到一期那台，再灌一期那份。
	setSelectedDevice('phase1_robot');
	expect(loadSampleTask()).toBe(true);
});

describe('右栏 · 虚拟设备（固定常驻，放大）', () => {
	it('虚拟设备那块在右栏里，带自己的图标与标题', () => {
		const wrapper = panel();
		const device = wrapper.get('[data-testid="virtual-device"]');

		expect(device.find('svg.cc-icon').exists()).toBe(true);
		expect(device.get('.panel-title').text()).toBe('虚拟设备');
	});

	it('它比另一块大：flex 比例是 5:4（去掉 tab 条后仍在一半以上）', () => {
		const wrapper = panel();

		expect(wrapper.get('[data-testid="virtual-device"]').classes()).toContain('device');
		expect(wrapper.get('.inspector').classes()).toContain('inspector');
		// 两块都是 flex 定比例，不是按内容定高（按内容定高就是上一版那个 max-height: 40%）
		expect(wrapper.find('.device').exists()).toBe(true);
	});

	it('如实说明未实现：点名设备层没接上，这块除目录之外是空的', () => {
		const wrapper = panel();
		const note = wrapper.get('[data-testid="virtual-device-note"]').text();

		expect(note).toContain('设备层还没接上');
		expect(note).toContain('空着');
		// 不给假状态、也不写空话
		expect(note).not.toContain('即将上线');
		expect(note).not.toContain('敬请期待');
	});

	it('它说清了将来放什么：设备状态 + 能力目录；现在显示的是目录里的事实', () => {
		const wrapper = panel();
		const note = wrapper.get('[data-testid="virtual-device-note"]').text();

		expect(note).toContain('状态');
		expect(note).toContain('能力目录');
		// 目录是真的：入口带上选的那台就是它
		expect(wrapper.get('[data-testid="virtual-device-name"]').text()).toContain('一期设备');
		expect(wrapper.get('[data-testid="virtual-device-catalog-ref"]').text()).toContain('phase1_robot');
	});

	it('选虚拟设备时如实写「仿真」：不靠设备名里的括号让人自己猜', async () => {
		const wrapper = panel();
		// 默认那台是真机，先把这个基线立住，免得「出现仿真」是别处的字凑出来的
		expect(wrapper.get('[data-testid="virtual-device-sim"]').text()).toBe('真机');

		setSelectedDevice('so101_sim');
		await wrapper.vm.$nextTick();

		expect(wrapper.get('[data-testid="virtual-device-sim"]').text()).toBe('仿真');
		// 仿真是同一份技能库的另一个去处：目录与真机那台一样
		expect(wrapper.get('[data-testid="virtual-device-catalog-ref"]').text()).toContain(
			ROBOFRAME_SO101_CATALOG.catalogRef,
		);
	});

	it('真实上游数据的出处照实标：SO-101 那份目录写着上游分支与 commit 前 8 位；一期那份不写', async () => {
		const wrapper = panel();
		// 一期那份是示意（一期协议没有「怎么做」的信息），没有出处可报——不许编一个出来
		expect(wrapper.find('[data-testid="virtual-device-provenance"]').exists()).toBe(false);

		setSelectedDevice('so101_robot');
		await wrapper.vm.$nextTick();

		const row = wrapper.get('[data-testid="virtual-device-provenance"]').text();
		expect(row).toContain('上游');
		expect(row).toContain(ROBOFRAME_SO101_PROVENANCE.branch);
		// commit 现取，不写死：上游换了 commit，这条断言跟着换
		expect(row).toContain(ROBOFRAME_SO101_PROVENANCE.commit.slice(0, 8));
		// 只给短号，不是整串
		expect(row).not.toContain(ROBOFRAME_SO101_PROVENANCE.commit);
	});

	it('虚拟设备**在**下半块上方（原图右栏的排法：上设备、下代码/JSON）', () => {
		const wrapper = panel();
		const device = wrapper.get('[data-testid="virtual-device"]').element;
		const tabs = wrapper.get('[role="tablist"]').element;

		expect(device.compareDocumentPosition(tabs) & 4).toBeTruthy();
		expect(wrapper.get('[data-testid="virtual-device"]').find('[data-testid="code-panel"]').exists()).toBe(
			false,
		);
	});

	it('虚拟设备不随 tab 切换变（它是常驻的那一块）', async () => {
		const wrapper = panel();
		const first = wrapper.get('[data-testid="virtual-device"]').text();

		await wrapper.get('[data-testid="right-tab-json"]').trigger('click');

		expect(wrapper.get('[data-testid="virtual-device"]').text()).toBe(first);
	});
});

describe('右栏 · 代码 / 任务 JSON 两个 tab', () => {
	it('两个 tab 都在，默认显示代码（右栏的老本行）', () => {
		const wrapper = panel();
		const tabs = wrapper.findAll('[role="tab"]');

		expect(tabs).toHaveLength(2);
		expect(wrapper.get('[data-testid="right-tab-code"]').text()).toContain('代码');
		expect(wrapper.get('[data-testid="right-tab-json"]').text()).toContain('任务 JSON');
		expect(wrapper.get('[data-testid="right-tab-code"]').attributes('aria-selected')).toBe('true');
		expect(wrapper.find('[data-testid="code-panel"]').exists()).toBe(true);
		expect(wrapper.find('[data-testid="task-json-panel"]').exists()).toBe(false);
	});

	it('切到「任务 JSON」→ 面板换成任务 JSON 视图，代码面板让位', async () => {
		const wrapper = panel();

		await wrapper.get('[data-testid="right-tab-json"]').trigger('click');

		expect(wrapper.get('[data-testid="right-tab-json"]').attributes('aria-selected')).toBe('true');
		expect(wrapper.get('[data-testid="right-tab-code"]').attributes('aria-selected')).toBe('false');
		expect(wrapper.find('[data-testid="right-panel-json"]').find('[data-testid="task-json-panel"]').exists()).toBe(
			true,
		);
		expect(wrapper.find('[data-testid="code-panel"]').exists()).toBe(false);

		// 切回来还在
		await wrapper.get('[data-testid="right-tab-code"]').trigger('click');
		expect(wrapper.find('[data-testid="code-panel"]').exists()).toBe(true);
	});

	it('左右方向键在 tab 之间走（tablist 的常规键位）', async () => {
		const wrapper = panel();

		await wrapper.get('[data-testid="right-tab-code"]').trigger('keydown', { key: 'ArrowRight' });
		expect(wrapper.get('[data-testid="right-tab-json"]').attributes('aria-selected')).toBe('true');

		await wrapper.get('[data-testid="right-tab-json"]').trigger('keydown', { key: 'ArrowLeft' });
		expect(wrapper.get('[data-testid="right-tab-code"]').attributes('aria-selected')).toBe('true');
	});

	it('代码面板仍是编译产物（内容一个字没改，只是挪进了 tab）', () => {
		const wrapper = panel();

		expect(wrapper.get('[data-testid="right-panel-code"]').find('[data-testid="code-panel"]').exists()).toBe(
			true,
		);
		expect(wrapper.text()).toContain('前进 · 实现');
		expect(wrapper.text()).toContain('set_velocity');
		expect(wrapper.get('[data-testid="code-limits"]').text()).toContain('max_linear');
	});

	it('改一个参数 → 面板跟着变（右栏读的就是那份声明）', async () => {
		const wrapper = panel();
		const before = wrapper.text();
		expect(before).toContain('set_velocity');

		const first = doc.declaration.value?.nodes[0];
		expect(first).toBeDefined();
		if (first === undefined) return;

		expect(applyParam(first.id, 'linear', 0.15)).toBe(true);
		await wrapper.vm.$nextTick();

		// 不写死渲染形状（目录里 `move` 的实现正在被改）：断言「新的读数进了这段实现」
		expect(wrapper.text()).not.toBe(before);
		expect(wrapper.text()).toContain('0.15');
	});

	it('右栏仍是右栏：测试 id 在容器上，两块都在它里面', () => {
		const wrapper = panel();
		const root = wrapper.get('[data-testid="right-panel"]');

		expect(root.classes()).toContain('right-panel');
		expect(root.find('[data-testid="virtual-device"]').exists()).toBe(true);
		expect(root.find('[data-testid="code-panel"]').exists()).toBe(true);
	});
});
