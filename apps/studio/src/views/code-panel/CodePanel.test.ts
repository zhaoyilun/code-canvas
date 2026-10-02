// @vitest-environment happy-dom
/**
 * 代码面板的界面验收：
 * 1. 示例任务 → 四行调用，带行号；
 * 2. 安全限值看得见；
 * 3. **改一个参数 → 面板那行的数字跟着变**（这条联动是 M2 的核心）；
 * 4. `selectedNodeId` 变化 → 对应行高亮；
 * 5. M3 的第三个入口：**点一行就是选那一步**（推共享状态，另两栏据此高亮），
 *    且序号徽标只落在调用行上、与流程卡片同一个组件；
 * 6. 它在右栏里常驻——右栏是固定分区，它总被挂上（接线测试）。
 */
import { mount } from '@vue/test-utils';
import { beforeEach, describe, expect, it } from 'vitest';
import { renderDeclaration } from '@codecanvas/code-render';
import { computeWorkflowDigest, type WorkflowDeclaration, type WorkflowNode } from '@codecanvas/contracts';
import { loadSampleTask, useStudioDocument } from '../../state/document';
import RightPanel from '../right/RightPanel.vue';
import CodePanel from './CodePanel.vue';

const doc = useStudioDocument();

const declaration = (): WorkflowDeclaration => {
	const current = doc.declaration.value;
	if (current === null) throw new Error('sample task must be loaded');
	return current;
};

/** 模拟积木侧写回：改一个参数，重算摘要，走唯一的写入口 `applyDeclaration`。 */
const applyParam = (nodeId: string, name: string, value: number): boolean => {
	const current = declaration();
	const nodes: WorkflowNode[] = current.nodes.map((node) =>
		node.id === nodeId ? { ...node, parameters: { ...node.parameters, [name]: value } } : node,
	);
	const draft = { ...current, nodes };
	return doc.applyDeclaration({ ...draft, digest: computeWorkflowDigest(draft) });
};

const lineTexts = (wrapper: ReturnType<typeof mount>): string[] =>
	wrapper.findAll('li.cp-line .cp-src').map((cell) => cell.text());

const activeLines = (wrapper: ReturnType<typeof mount>): string[] =>
	wrapper
		.findAll('li.cp-line.is-active')
		.map((line) => line.attributes('data-line') ?? '')
		.filter((line) => line !== '');

beforeEach(() => {
	loadSampleTask();
});

describe('CodePanel', () => {
	it('示例任务渲染出四行调用，且每行带行号', () => {
		const wrapper = mount(CodePanel);
		const lines = wrapper.findAll('li.cp-line');

		expect(lines).toHaveLength(5); // 1 行头部注释 + 4 个调用
		expect(wrapper.findAll('li.cp-line .cp-ln').map((cell) => cell.text())).toEqual([
			'1',
			'2',
			'3',
			'4',
			'5',
		]);
		expect(lineTexts(wrapper)).toEqual([
			'# 前进，遇障停止后转向 · task-demo-001',
			'move(linear=0.2, angular=0.0, duration=5.0)',
			'stop_if_obstacle(sensors=["/scan0"], distance=0.5)',
			'turn(angular=0.8, duration=2.0)',
			'stop()',
		]);
		expect(wrapper.findAll('li.cp-line.is-call')).toHaveLength(4);
		expect(wrapper.text()).toContain('4 个调用');
	});

	it('序号徽标只落在调用行上，且按声明顺序是 1/2/3/4（首行注释没有徽标）', () => {
		const wrapper = mount(CodePanel);

		// 徽标总数 = 调用行数（注释行不属于任何步骤）
		const badges = wrapper.findAll('[data-testid="code-line-index"]');
		expect(badges).toHaveLength(4);
		expect(badges.map((badge) => badge.text())).toEqual(['1', '2', '3', '4']);

		// 每个徽标都落在带 nodeId 的调用行里
		expect(badges.map((badge) => badge.attributes('data-seq'))).toEqual(['1', '2', '3', '4']);
		expect(wrapper.find('li.cp-line[data-kind="comment"] [data-testid="code-line-index"]').exists()).toBe(false);

		// 徽标是共享组件：与流程卡片同一个 class，色值来自同一组 --cc-seq-* 变量
		expect(badges[0]!.classes()).toContain('cc-seq');

		// 行 → 步骤序数：第 2 个调用行是第 2 步
		const callLines = wrapper.findAll('[data-testid="code-call-line"]');
		expect(callLines.map((line) => line.attributes('data-step'))).toEqual(['1', '2', '3', '4']);
	});

	it('行与 nodeId 的对应写在 DOM 上（界面高亮与测试共用同一份映射）', () => {
		const wrapper = mount(CodePanel);
		const nodes = declaration().nodes;
		const ids = wrapper.findAll('li.cp-line').map((line) => line.attributes('data-node-id') ?? null);

		expect(ids[0]).toBeNull();
		expect(ids.slice(1)).toEqual(nodes.map((node) => node.id));
	});

	it('安全限值显示出来，不是躺在 JSON 里', () => {
		const wrapper = mount(CodePanel);
		const limits = wrapper.get('[data-testid="code-limits"]');
		expect(limits.text()).toContain('max_linear');
		expect(limits.text()).toContain('0.3 m/s');
		expect(limits.text()).toContain('1.2 rad/s');
		expect(limits.text()).toContain('30 s');
		expect(limits.text()).toContain('运行前需确认：是');
	});

	it('改一个数字 → 面板对应那行的数字跟着变', async () => {
		const wrapper = mount(CodePanel);
		const moveNode = declaration().nodes[0];
		expect(moveNode).toBeDefined();
		if (moveNode === undefined) return;

		expect(lineTexts(wrapper)[1]).toBe('move(linear=0.2, angular=0.0, duration=5.0)');

		expect(applyParam(moveNode.id, 'linear', 0.15)).toBe(true);
		await wrapper.vm.$nextTick();

		expect(lineTexts(wrapper)[1]).toBe('move(linear=0.15, angular=0.0, duration=5.0)');
		// 其它行不动
		expect(lineTexts(wrapper)[3]).toBe('turn(angular=0.8, duration=2.0)');
	});

	it('面板是声明的纯函数：同一份声明 → 同一份文本，且与渲染包的输出逐字一致', () => {
		const first = mount(CodePanel);
		const second = mount(CodePanel);
		const expected = renderDeclaration(declaration());

		expect(lineTexts(first)).toEqual(lineTexts(second));
		expect(lineTexts(first)).toEqual(expected.lines.map((line) => line.text));
		expect(first.text()).toContain(`${expected.callCount} 个调用`);
	});

	it('越界值被写回通道拦下：真相不动，面板跟着不动（面板不自己修正，也不自己校验）', async () => {
		const wrapper = mount(CodePanel);
		const moveNode = declaration().nodes[0];
		if (moveNode === undefined) return;
		const before = lineTexts(wrapper);

		// linear=1.5 超过任务限值 0.3：声明层看不见（parameters 是不透明载荷），
		// 任务协议那道闸拦住它 → 真相不变，面板也就没得变。
		expect(applyParam(moveNode.id, 'linear', 1.5)).toBe(false);
		await wrapper.vm.$nextTick();

		expect(lineTexts(wrapper)).toEqual(before);
		expect(doc.diagnostics.value.length).toBeGreaterThan(0);
	});

	it('selectedNodeId 变化 → 它渲染出的那几行高亮，别的行不亮', async () => {
		const wrapper = mount(CodePanel);
		expect(activeLines(wrapper)).toEqual([]);

		const second = declaration().nodes[1];
		if (second === undefined) return;
		doc.select(second.id);
		await wrapper.vm.$nextTick();
		expect(activeLines(wrapper)).toEqual(['3']);

		doc.select(declaration().nodes[0]?.id ?? null);
		await wrapper.vm.$nextTick();
		expect(activeLines(wrapper)).toEqual(['2']);

		doc.select(null);
		await wrapper.vm.$nextTick();
		expect(activeLines(wrapper)).toEqual([]);
		expect(wrapper.text()).toContain('在积木那侧改一个参数，这里跟着变');
	});

	it('选中时那一行的徽标也进选中态（三处同一个徽标状态，不只换个底色）', async () => {
		const wrapper = mount(CodePanel);
		expect(wrapper.findAll('[data-testid="code-line-index"][data-active="true"]')).toHaveLength(0);

		doc.select(declaration().nodes[1]!.id);
		await wrapper.vm.$nextTick();

		const activeBadges = wrapper.findAll('[data-testid="code-line-index"][data-active="true"]');
		expect(activeBadges).toHaveLength(1);
		expect(activeBadges[0]!.text()).toBe('2');
		expect(activeBadges[0]!.classes()).toContain('is-active');
	});

	it('点第 2 个调用行 → 选中推给共享状态，另两栏据此高亮（代码行是联动的第三个入口）', async () => {
		const wrapper = mount(CodePanel);
		const nodes = declaration().nodes;

		await wrapper.findAll('[data-testid="code-call-line"]')[1]!.trigger('click');

		expect(doc.selectedNodeId.value).toBe(nodes[1]!.id);
		expect(activeLines(wrapper)).toEqual(['3']);
		// 推的是 nodeId；blockId 由积木那侧按映射表解析（与流程卡片同一条路）。
		expect(doc.selectedBlockId.value).toBeNull();
	});

	it('键盘也能选（行是按钮语义，Enter / Space 与点击同义）', async () => {
		const wrapper = mount(CodePanel);
		const nodes = declaration().nodes;
		const second = wrapper.findAll('[data-testid="code-call-line"]')[1]!;

		await second.trigger('keydown', { key: 'Enter' });
		expect(doc.selectedNodeId.value).toBe(nodes[1]!.id);

		doc.select(null);
		await wrapper.vm.$nextTick();
		await wrapper.findAll('[data-testid="code-call-line"]')[3]!.trigger('keydown', { key: ' ' });
		expect(doc.selectedNodeId.value).toBe(nodes[3]!.id);
	});

	it('注释行不属于任何步骤：不是按钮，点了也不改选中', async () => {
		const wrapper = mount(CodePanel);
		const comment = wrapper.find('li.cp-line[data-kind="comment"]');

		expect(comment.find('button').exists()).toBe(false);
		expect(comment.attributes('data-node-id')).toBeUndefined();
		await comment.trigger('click');
		expect(doc.selectedNodeId.value).toBeNull();
	});
});

// 右栏改成固定分区（上虚拟设备、下代码面板）之后，这条接线断言随之反过来：它总在。
// 右栏自身的布局与顺序另见 `views/right/RightPanel.test.ts`。
describe('接线：代码面板在右栏常驻（固定布局，不挑状态）', () => {
	it('右栏里挂的就是代码面板', () => {
		const wrapper = mount(RightPanel);
		expect(wrapper.find('.code-panel').exists()).toBe(true);
		expect(wrapper.text()).toContain('move(linear=0.2, angular=0.0, duration=5.0)');
	});

	it('右栏仍是右栏：测试 id 在容器上，代码面板在它里面', () => {
		const wrapper = mount(RightPanel);
		const root = wrapper.get('[data-testid="right-panel"]');
		expect(root.classes()).toContain('right-panel');
		expect(root.find('.code-panel').exists()).toBe(true);
	});
});
