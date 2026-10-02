/**
 * 流程画布的验收用例：链的条数、连线、共享选中、参数摘要跟着声明变、诊断归属、空状态。
 *
 * 断言尽量落在 DOM 上的 `data-*` 上——那是这一屏对外的可核对面，不是实现细节。
 */
import { mount } from '@vue/test-utils';
import { defineComponent, h } from 'vue';
import { beforeEach, describe, expect, it } from 'vitest';
import { computeWorkflowDigest, describeActionFields, verifyWorkflowDigest, type WorkflowDeclaration } from '@codecanvas/contracts';
import { loadSampleTask, useStudioDocument } from '../../state/document';
import FlowView from './FlowView.vue';

const store = useStudioDocument();

const CARD = '[data-testid="flow-node-card"]';
const CONNECTOR = '[data-testid="flow-connector"]';

const cards = (wrapper: ReturnType<typeof mount>) => wrapper.findAll(CARD);
const connectorCount = (wrapper: ReturnType<typeof mount>) => wrapper.findAll(CONNECTOR).length;

/** 卡片上的参数读数（`data-param` → 显示值），用来核对摘要内容。 */
const paramValues = (card: { findAll: (selector: string) => { attributes: (name: string) => string | undefined }[] }) =>
	Object.fromEntries(
		card
			.findAll('[data-param]')
			.map((node) => [node.attributes('data-param') ?? '', node.attributes('data-value') ?? '']),
	);

const currentDeclaration = (): WorkflowDeclaration => {
	const declaration = store.declaration.value;
	if (declaration === null) throw new Error('sample task did not load');
	return declaration;
};

beforeEach(() => {
	expect(loadSampleTask()).toBe(true);
});

describe('流程画布 · 链与连线', () => {
	it('示例任务的四步渲染成四张卡片与三条连线', () => {
		const wrapper = mount(FlowView);

		expect(cards(wrapper)).toHaveLength(4);
		expect(connectorCount(wrapper)).toBe(3);
		// 卡头上是中文名；协议名退到 data-action，机器对账还认得出来。
		expect(wrapper.findAll('[data-testid="flow-node-action"]').map((node) => node.text())).toEqual([
			'前进',
			'避障停止',
			'转向',
			'停止',
		]);
		expect(wrapper.findAll('[data-testid="flow-node-action"]').map((node) => node.attributes('data-action'))).toEqual([
			'move',
			'stop_if_obstacle',
			'turn',
			'stop',
		]);
		expect(wrapper.findAll('[data-testid="flow-node-index"]').map((node) => node.text())).toEqual(['1', '2', '3', '4']);
		// 徽标是三个视图共用的那个组件（M3）：同一个 class、同一组 --cc-seq-* 变量，
		// 积木那侧画在 SVG 里的徽标也是如此。
		expect(wrapper.findAll('[data-testid="flow-node-index"]').map((node) => node.classes())).toEqual(
			Array.from({ length: 4 }, () => ['cc-seq']),
		);
		expect(wrapper.findAll('[data-testid="flow-node-index"]').map((node) => node.attributes('data-seq'))).toEqual([
			'1',
			'2',
			'3',
			'4',
		]);
		expect(wrapper.find('[data-testid="flow-count"]').text()).toContain('4 步 · 3 条连线');
	});

	it('链是自上而下的：卡片与连线在链里交替出现，连线夹在两张卡片之间', () => {
		const wrapper = mount(FlowView);
		const chain = wrapper.find('[data-testid="flow-chain"]');

		// DOM 顺序就是自上而下的顺序：一条连线前面必有一张卡片，后面必跟着下一张。
		expect(
			chain.findAll('[data-testid="flow-node-card"], [data-testid="flow-connector"]').map((node) => node.attributes('data-testid')),
		).toEqual([
			'flow-node-card',
			'flow-connector',
			'flow-node-card',
			'flow-connector',
			'flow-node-card',
			'flow-connector',
			'flow-node-card',
		]);
	});

	it('每张卡片的参数行就是校验器给的字段（顺序一致，不是手抄的一份）', () => {
		const wrapper = mount(FlowView);
		const [move, obstacle, turn, stop] = cards(wrapper);

		expect(Object.keys(paramValues(move!))).toEqual(describeActionFields('move').map((field) => field.name));
		expect(Object.keys(paramValues(obstacle!))).toEqual(
			describeActionFields('stop_if_obstacle').map((field) => field.name),
		);
		expect(Object.keys(paramValues(turn!))).toEqual(describeActionFields('turn').map((field) => field.name));
		expect(paramValues(stop!)).toEqual({});

		expect(paramValues(move!)).toEqual({ linear: '0.2', angular: '0', duration: '5' });
		expect(paramValues(obstacle!)).toEqual({ sensors: '/scan0', distance: '0.5' });
	});

	it('参数名显示的是描述表里的中文名，一个都没有在视图里另写映射', () => {
		const wrapper = mount(FlowView);
		const [move, obstacle, turn] = cards(wrapper);

		const labels = (card: { findAll: (selector: string) => { text: () => string }[] }) =>
			card.findAll('.param-name').map((node) => node.text());

		expect(labels(move!)).toEqual(describeActionFields('move').map((field) => field.label));
		expect(labels(obstacle!)).toEqual(describeActionFields('stop_if_obstacle').map((field) => field.label));
		expect(labels(turn!)).toEqual(describeActionFields('turn').map((field) => field.label));
		expect(labels(move!)).toEqual(['线速度', '角速度', '时长']);

		// 英文原名只留在 data-* 上，不进画面。
		expect(move!.text()).not.toContain('linear');
		expect(move!.text()).not.toContain('duration');
		expect(move!.find('[data-label="linear"]').attributes('data-label')).toBe('linear');
	});

	it('七种动作都能渲染，字段多寡都来自校验器', async () => {
		const declaration = currentDeclaration();
		const cases: Record<string, Record<string, unknown>> = {
			move: { linear: 0.2, angular: 0, duration: 5 },
			turn: { angular: 0.8, duration: 2 },
			stop: {},
			stop_if_obstacle: { sensors: ['/scan0'], distance: 0.5 },
			get_status: {},
			arm_joint: { joint_id: 3, joint: 90, time: 1500 },
			arm6_joints: { joint1: 10, joint2: 20, joint3: 30, joint4: 40, joint5: 50, joint6: 60, time: 1500 },
		};
		const nodes = Object.entries(cases).map(([action, parameters], index) => ({
			...declaration.nodes[0]!,
			id: `nd_case_${index}`,
			name: `${index + 1}. ${action}`,
			parameters: { step_id: `s${index}`, action, ...parameters },
		}));
		const connections = Object.fromEntries(
			nodes.slice(0, -1).map((node, index) => [node.id, { main: [[{ node: nodes[index + 1]!.id, input: 0 }]] }]),
		);
		const { digest: _stale, ...draft } = { ...declaration, nodes, connections };
		expect(store.applyDeclaration({ ...draft, digest: computeWorkflowDigest(draft) })).toBe(true);

		const wrapper = mount(FlowView);
		expect(cards(wrapper)).toHaveLength(7);
		expect(connectorCount(wrapper)).toBe(6);
		nodes.forEach((node, index) => {
			const expected = describeActionFields(node.parameters.action as never).map((field) => field.name);
			expect(Object.keys(paramValues(cards(wrapper)[index]!))).toEqual(expected);
		});
		// 没有字段的动作给出说明，而不是一片空白。
		expect(cards(wrapper)[2]!.text()).toContain('这个动作没有参数');
		expect(cards(wrapper)[4]!.text()).toContain('这个动作没有参数');
		// 默认值/单位都从校验器推导：time 的单位是 ms，duration 是 s，角度的单位是度。
		expect(cards(wrapper)[0]!.find('[data-param="duration"]').text()).toBe('5s');
		expect(cards(wrapper)[5]!.find('[data-param="time"]').text()).toBe('1500ms');
		expect(cards(wrapper)[5]!.find('[data-param="joint"]').text()).toBe('90度');
		expect(cards(wrapper)[6]!.find('[data-param="joint6"]').text()).toBe('60度');
	});

	it('限值类的上界从声明的 meta 来，不在视图里重写一遍', () => {
		const wrapper = mount(FlowView);
		const [move] = cards(wrapper);
		const ranges = move!.findAll('.param-range').map((node) => node.text());

		// max_linear / max_angular 走的是「绝对值」那两条（协议里方向的符号单独表达），> 0 来自校验器。
		expect(ranges).toEqual(['|值| ≤ 0.3', '|值| ≤ 1.2', '> 0']);
	});

	it('脚注的限值 chip 用中文名，数字仍来自声明', () => {
		const chips = mount(FlowView)
			.findAll('.footer-chip')
			.map((node) => node.text());

		expect(chips).toEqual(['最大线速度 ≤ 0.3', '最大角速度 ≤ 1.2', '总时长上限 ≤ 30']);
	});
});

describe('流程画布 · 选中是共享状态', () => {
	it('点卡片 → selectedNodeId 变成那个节点，卡片高亮', async () => {
		const wrapper = mount(FlowView);
		const target = currentDeclaration().nodes[2]!;

		await cards(wrapper)[2]!.trigger('click');

		expect(store.selectedNodeId.value).toBe(target.id);
		expect(cards(wrapper)[2]!.classes()).toContain('selected');
		expect(cards(wrapper)[2]!.attributes('data-selected')).toBe('true');
		expect(cards(wrapper).filter((card) => card.classes().includes('selected'))).toHaveLength(1);
	});

	it('换一张卡片，高亮跟着换（同时只有一张亮）', async () => {
		const wrapper = mount(FlowView);

		await cards(wrapper)[0]!.trigger('click');
		await cards(wrapper)[3]!.trigger('click');

		expect(store.selectedNodeId.value).toBe(currentDeclaration().nodes[3]!.id);
		const selected = cards(wrapper).filter((card) => card.classes().includes('selected'));
		expect(selected).toHaveLength(1);
		expect(selected[0]!.attributes('data-node-id')).toBe(currentDeclaration().nodes[3]!.id);
	});

	it('选中的那张卡片，序号徽标也进选中态（三处同一套视觉，不是只有卡片边框变）', async () => {
		const wrapper = mount(FlowView);

		await cards(wrapper)[2]!.trigger('click');

		const activeBadges = wrapper.findAll('[data-testid="flow-node-index"][data-active="true"]');
		expect(activeBadges).toHaveLength(1);
		expect(activeBadges[0]!.text()).toBe('3');
		expect(activeBadges[0]!.classes()).toContain('is-active');
		// 它就在被选中的那张卡片里
		expect(cards(wrapper)[2]!.find('[data-testid="flow-node-index"]').attributes('data-active')).toBe('true');
	});

	it('从积木那边选块（只推 selectedNodeId）→ 对应卡片跟着高亮', async () => {		const wrapper = mount(FlowView);
		const target = currentDeclaration().nodes[1]!;

		// 积木画布写选中的方式：同一个 store，推 nodeId + blockId。
		store.select(target.id, 'blk-demo');

		await wrapper.vm.$nextTick();

		const highlighted = cards(wrapper).filter((card) => card.classes().includes('selected'));
		expect(highlighted).toHaveLength(1);
		expect(highlighted[0]!.attributes('data-node-id')).toBe(target.id);
		expect(cards(wrapper)[1]!.attributes('data-selected')).toBe('true');
	});

	it('两个视图同时挂着，一边推选中另一边就跟着亮（同一个 selectedNodeId）', async () => {
		// 积木那边的替身：它只做一件事——按 nodeId + blockId 调 store.select。
		const BlocklyLike = defineComponent({
			props: { nodeId: { type: String, required: true } },
			setup: (props) => {
				const doc = useStudioDocument();
				doc.select(props.nodeId, `blk-${props.nodeId}`);
				return () => h('div', { 'data-testid': 'blockly-like' });
			},
		});

		const world = mount({
			components: { FlowView, BlocklyLike },
			setup: () => ({ nodes: currentDeclaration().nodes }),
			template: '<div><BlocklyLike :node-id="nodes[2].id" /><FlowView /></div>',
		});

		await world.vm.$nextTick();

		const flow = world.findAll(CARD);
		expect(flow).toHaveLength(4);
		expect(flow.filter((card) => card.classes().includes('selected'))).toHaveLength(1);
		expect(flow[2]!.attributes('data-node-id')).toBe(currentDeclaration().nodes[2]!.id);

		// 反过来：在流程画布点第 1 张，共享的那一个值变成它，积木那边读到的也是它。
		await flow[0]!.trigger('click');
		expect(useStudioDocument().selectedNodeId.value).toBe(currentDeclaration().nodes[0]!.id);
		expect(useStudioDocument().selectedBlockId.value).toBeNull();
	});

	it('清空选中时没有卡片保持高亮', async () => {
		const wrapper = mount(FlowView);

		await cards(wrapper)[0]!.trigger('click');
		store.select(null);
		await wrapper.vm.$nextTick();

		expect(cards(wrapper).filter((card) => card.classes().includes('selected'))).toHaveLength(0);
	});
});

describe('流程画布 · 参数摘要跟着声明走', () => {
	it('改积木参数（走 applyDeclaration）→ 卡片上的读数跟着变', async () => {
		const wrapper = mount(FlowView);
		expect(paramValues(cards(wrapper)[0]!).duration).toBe('5');

		const declaration = currentDeclaration();
		const edited: WorkflowDeclaration = {
			...declaration,
			nodes: declaration.nodes.map((node, index) =>
				index === 0 ? { ...node, parameters: { ...node.parameters, duration: 7.5, linear: 0.11 } } : node,
			),
		};
		// 走真实写回通道：digest 是内容指纹，改了内容就得重算（这里用契约里那一个算法）。
		const { digest: _stale, ...draft } = edited;
		const next: WorkflowDeclaration = { ...draft, digest: computeWorkflowDigest(draft) };

		expect(store.applyDeclaration(next)).toBe(true);
		await wrapper.vm.$nextTick();

		expect(paramValues(cards(wrapper)[0]!)).toEqual({ linear: '0.11', angular: '0', duration: '7.5' });
		expect(cards(wrapper)).toHaveLength(4);
	});

	it('写回非法声明被拒时，卡片继续显示原值（不静默修正）', async () => {
		const wrapper = mount(FlowView);
		const declaration = currentDeclaration();
		// 声明层能判的非法：节点 id 重复（validateWorkflowDeclaration 抓这个）。
		const edited: WorkflowDeclaration = {
			...declaration,
			nodes: declaration.nodes.map((node, index) =>
				index === 1 ? { ...node, id: declaration.nodes[0]!.id } : node,
			),
		};
		const { digest: _stale, ...draft } = edited;
		const illegal: WorkflowDeclaration = { ...draft, digest: computeWorkflowDigest(draft) };

		expect(store.applyDeclaration(illegal)).toBe(false);
		await wrapper.vm.$nextTick();

		expect(store.declaration.value).toBe(declaration);
		expect(paramValues(cards(wrapper)[1]!).distance).toBe('0.5');
		expect(cards(wrapper)[1]!.attributes('data-node-id')).toBe(declaration.nodes[1]!.id);
	});

	it('这个视图不许写回声明：点一圈卡片后声明与 digest 原样', async () => {
		const wrapper = mount(FlowView);
		const before = currentDeclaration();
		const snapshot = JSON.stringify(before);

		for (const card of cards(wrapper)) await card.trigger('click');
		await cards(wrapper)[0]!.trigger('keydown', { key: 'Enter' });

		expect(store.declaration.value).toBe(before);
		expect(JSON.stringify(store.declaration.value)).toBe(snapshot);
		expect(verifyWorkflowDigest(currentDeclaration())).toBe(true);
	});
});

describe('流程画布 · 诊断与空状态', () => {
	it('只有指向该节点/该步骤的诊断才挂到那张卡片上', async () => {
		const wrapper = mount(FlowView);
		const nodes = currentDeclaration().nodes;

		store.diagnostics.value = [
			{ code: 'task.step.range', severity: 'error', message: 'distance must be between 0 and 2 meters', path: 'steps[1].distance', ref: 's2' },
			{ code: 'workflow.node.id.duplicate', severity: 'error', message: 'duplicate node id', path: `nodes[2].id`, ref: nodes[2]!.id },
			{ code: 'task.limits.relaxed', severity: 'warning', message: 'max_linear must not exceed 0.3', path: 'limits.max_linear' },
		];
		await wrapper.vm.$nextTick();

		const blocks = wrapper.findAll('[data-testid="flow-node-diagnostics"]');
		expect(blocks).toHaveLength(2);
		// 第一块挂在第 2 张卡片（step_id 命中），第二块挂在第 3 张（节点 id 命中）。
		expect(cards(wrapper)[1]!.find('[data-testid="flow-node-diagnostics"]').text()).toContain('distance');
		expect(cards(wrapper)[2]!.find('[data-testid="flow-node-diagnostics"]').text()).toContain('duplicate node id');
		// 指向 limits 的那条不挂在任何卡片上。
		expect(cards(wrapper)[0]!.find('[data-testid="flow-node-diagnostics"]').exists()).toBe(false);
		expect(cards(wrapper)[3]!.find('[data-testid="flow-node-diagnostics"]').exists()).toBe(false);
	});

	it('写回被拒时留下的诊断，落在出错的那张卡片上', async () => {
		const wrapper = mount(FlowView);
		const declaration = currentDeclaration();
		const edited: WorkflowDeclaration = {
			...declaration,
			nodes: declaration.nodes.map((node, index) => (index === 2 ? { ...node, id: 'bad id!' } : node)),
		};
		const { digest: _stale, ...draft } = edited;
		expect(store.applyDeclaration({ ...draft, digest: computeWorkflowDigest(draft) })).toBe(false);
		await wrapper.vm.$nextTick();

		// schema 层给的路径是点号写法（nodes.2.id），不是下标写法——两种都得认得出来。
		expect(store.diagnostics.value[0]!.path).toBe('nodes.2.id');
		const onThird = cards(wrapper)[2]!.find('[data-testid="flow-node-diagnostics"]');
		expect(onThird.exists()).toBe(true);
		expect(onThird.text()).toContain('workflow.schema');
		expect(cards(wrapper)[0]!.find('[data-testid="flow-node-diagnostics"]').exists()).toBe(false);
	});

	it('没有声明时给一句说明，不留空白', () => {
		store.declaration.value = null;
		store.selectedNodeId.value = null;

		const wrapper = mount(FlowView);

		expect(wrapper.find('[data-testid="flow-empty"]').exists()).toBe(true);
		expect(wrapper.find('[data-testid="flow-empty"]').text()).toContain('导入一份任务 JSON');
		expect(cards(wrapper)).toHaveLength(0);
		expect(connectorCount(wrapper)).toBe(0);
	});
});
