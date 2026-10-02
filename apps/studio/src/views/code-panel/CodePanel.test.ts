// @vitest-environment happy-dom
/**
 * 代码面板的界面验收：
 * 1. 示例任务 → 四行调用，带行号；
 * 2. 安全限值看得见；
 * 3. **改一个参数 → 面板那行的数字跟着变**（这条联动是 M2 的核心）；
 * 4. `selectedNodeId` 变化 → 对应行高亮；
 * 5. 它在 blockly / workflow 两个 tab 下真的被挂上了（接线测试）。
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
});

describe('接线：代码面板在 blockly / workflow 两个 tab 下都在', () => {
	it.each(['blockly', 'workflow'] as const)('%s tab 下挂的是代码面板', (tab) => {
		const wrapper = mount(RightPanel, { props: { tab } });
		expect(wrapper.find('.code-panel').exists()).toBe(true);
		expect(wrapper.text()).toContain('move(linear=0.2, angular=0.0, duration=5.0)');
	});

	it.each(['plan', 'simulation', 'hardware'] as const)('%s tab 下不是代码面板', (tab) => {
		const wrapper = mount(RightPanel, { props: { tab } });
		expect(wrapper.find('.code-panel').exists()).toBe(false);
	});

	it('右栏仍是右栏：代码面板接住了 right-panel 的测试 id、类与宽度约束', () => {
		const wrapper = mount(RightPanel, { props: { tab: 'workflow' } });
		const root = wrapper.get('[data-testid="right-panel"]');
		expect(root.classes()).toContain('code-panel');
		expect(root.classes()).toContain('right-panel');
	});
});
