/**
 * 流程画布的验收用例：链的条数、连线、共享选中、参数摘要跟着声明变、诊断归属、空状态，
 * 以及**分支**（`task.branch`）——结构从 `connections` 推，两条臂各自成链，
 * `main[2]` 的后续回到分支那一层。
 *
 * 断言尽量落在 DOM 上的 `data-*` 上——那是这一屏对外的可核对面，不是实现细节。
 */
import { mount } from '@vue/test-utils';
import { defineComponent, h } from 'vue';
import { beforeEach, describe, expect, it } from 'vitest';
import {
	computeWorkflowDigest,
	describeActionFields,
	verifyWorkflowDigest,
	type WorkflowDeclaration,
	type WorkflowNode,
} from '@codecanvas/contracts';
import { ROBOFRAME_SO101_CATALOG } from '@codecanvas/capabilities';
import { TASK_BRANCH_NODE_TYPE } from '@codecanvas/task-import';
import { setSelectedDevice } from '../../shell/devices';
import { loadSampleTask, useStudioDocument } from '../../state/document';
import FlowView from './FlowView.vue';
import { planStructureOf } from '../shared/plan-structure';
import { BRANCH_PLAN_JSON, NESTED_NO_ELSE_PLAN_JSON } from './__fixtures__/branch-plan';
import { normalizeRenderedHtml, readBaseline } from './__fixtures__/normalize-html';

const store = useStudioDocument();

const CARD = '[data-testid="flow-node-card"]';
const CONNECTOR = '[data-testid="flow-connector"]';

const cards = (wrapper: ReturnType<typeof mount>) => wrapper.findAll(CARD);
const connectorCount = (wrapper: ReturnType<typeof mount>) => wrapper.findAll(CONNECTOR).length;

/** 改动前那份渲染的基准（一期样例，没有分支）；比对口径见 `__fixtures__/normalize-html.ts`。 */
const FLOW_BASELINE = readBaseline('src/views/flow/__fixtures__/flow-baseline.html');

/** 卡片的结构读数：卡头文字、属于哪条臂（不在臂里就是 null）、臂的嵌套层数。 */
const structureOf = (
	wrapper: ReturnType<typeof mount>,
): { action: string; nodeId: string; arm: string | null; depth: string | null }[] =>
	cards(wrapper).map((card) => {
		const arm = card.element.closest('[data-testid="flow-arm"]');
		return {
			action: card.get('[data-testid="flow-node-action"]').text(),
			nodeId: card.attributes('data-node-id') ?? '',
			arm: arm?.getAttribute('data-arm') ?? null,
			depth: arm?.getAttribute('data-depth') ?? null,
		};
	});

/**
 * 最外层那一串的构成（只取直接子元素，臂里的卡片不算）：`arm:then` 这种写法比 testid 好读，
 * 也正是「分支卡之后是它的臂、臂收口之后才轮到后续」要核实的东西。
 */
const topLevelChainOf = (wrapper: ReturnType<typeof mount>): string[] =>
	Array.from(wrapper.get('[data-testid="flow-chain"]').element.children).map((element) => {
		const testid = element.getAttribute('data-testid');
		if (testid === 'flow-arm') return `arm:${element.getAttribute('data-arm') ?? '?'}`;
		return testid ?? element.tagName.toLowerCase();
	});

/** 节点 id → 声明里的名字（`3. 关闭夹爪`）：断言读起来是步骤，不是一串 id。 */
const nameOf = (declaration: WorkflowDeclaration, nodeId: string): string =>
	declaration.nodes.find((node) => node.id === nodeId)?.name ?? nodeId;

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
	// 样例跟着**设备格式**走（默认那台说的是技能计划），而这里量的是这份一期样例的四步，
	// 所以先站到一期那台设备上。
	setSelectedDevice('phase1_robot');
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

// ---------------------------------------------------------------------------
// 分支（task.branch）：结构从 `connections` 推，不从声明顺序猜
// ---------------------------------------------------------------------------

/** 载入一份带分支的技能计划（技能名照真实目录写，见 `__fixtures__/branch-plan.ts`）。 */
const loadPlan = (json: string): void => {
	// 分支素材说的是技能话；先站到那台设备上，格式与目录才是对的。
	setSelectedDevice('so101_robot');
	expect(useStudioDocument().loadTaskJson(json)).toBe(true);
};

const branchNodeOf = (declaration: WorkflowDeclaration): WorkflowNode => {
	const branch = declaration.nodes.find((node) => node.type === TASK_BRANCH_NODE_TYPE);
	if (branch === undefined) throw new Error('这份素材里应当有分支节点');
	return branch;
};

describe('流程画布 · 分支的两条臂与后续', () => {
	beforeEach(() => {
		loadPlan(BRANCH_PLAN_JSON);
	});

	it('按图推结构：链头 → 分支卡 → 两条臂 → main[2] 的后续回到分支那一层', () => {
		const declaration = currentDeclaration();
		const branch = branchNodeOf(declaration);
		const wrapper = mount(FlowView);

		// DOM 顺序就是画布上的顺序：分支卡之后是它的两条臂，臂收口之后才轮到 `if` 之后的步骤。
		expect(topLevelChainOf(wrapper)).toEqual([
			'flow-node-card',
			'flow-connector',
			'flow-node-card',
			'arm:then',
			'arm:else',
			'flow-connector',
			'flow-node-card',
		]);

		// 声明顺序（导入时的创建序）：观察 / 分支 / then / else / 后续——臂里的两步在声明里排在分支后面。
		const structure = structureOf(wrapper);
		expect(structure.map((row) => nameOf(declaration, row.nodeId))).toEqual([
			'1. 观察桌面',
			'2. 分支',
			'3. 关闭夹爪',
			'4. 打开夹爪',
			'5. 往前一点',
		]);
		expect(structure.map((row) => row.arm)).toEqual([null, null, 'then', 'else', null]);

		// 两条臂各自装着自己的那一步：卡片上的节点 id 一一对上声明里的节点。
		expect(structure[2]?.nodeId).toBe(declaration.nodes[2]?.id);
		expect(structure[3]?.nodeId).toBe(declaration.nodes[3]?.id);
		// `main[2]` 的后续与分支同级：都不在任何臂里，且臂的嵌套层数都是最外层。
		expect(structure[4]?.nodeId).toBe(declaration.nodes[4]?.id);
		expect(structure[1]?.arm).toBeNull();
		expect(structure[4]?.arm).toBeNull();
		expect(wrapper.findAll('[data-testid="flow-arm"]').map((arm) => arm.attributes('data-depth'))).toEqual(['0', '0']);
		// 分支卡带着它自己的序号：与从前一样是声明里的序数。
		expect(cards(wrapper)[1]?.find('[data-testid="flow-node-index"]').text()).toBe('2');
		expect(branch.name).toBe('2. 分支');
	});

	it('分支卡显示条件的人话与三个原值，不显示「这个动作没有参数」', () => {
		const wrapper = mount(FlowView);
		const branchCard = cards(wrapper)[1];
		if (branchCard === undefined) throw new Error('没有分支卡');

		const condition = branchCard.get('[data-testid="flow-node-condition"]');
		expect(condition.text()).toBe('如果 上一步成功 == 假');
		expect(condition.attributes('data-field')).toBe('last.success');
		expect(condition.attributes('data-op')).toBe('==');
		expect(condition.attributes('data-value')).toBe('false');
		expect(condition.attributes('data-readable')).toBe('true');
		// 卡头写的是「分支」，协议名一栏放的是**节点类型**（它没有动作，不编一个动作名顶上）。
		expect(branchCard.get('[data-testid="flow-node-action"]').text()).toBe('分支');
		expect(branchCard.get('[data-testid="flow-node-action"]').attributes('data-action')).toBe(TASK_BRANCH_NODE_TYPE);
		// 它不是动作，也就谈不上「这个动作没有参数」——那句话会把人带偏。
		expect(branchCard.text()).not.toContain('这个动作没有参数');
		expect(branchCard.find('[data-testid="flow-node-params"]').exists()).toBe(false);
		// 臂里那两步是普通动作卡：参数摘要照旧（技能没有参数时照旧说「没有参数」）。
		expect(cards(wrapper)[2]?.text()).toContain('这个动作没有参数');
	});

	it('臂里的卡片也点得动：点它推的是同一个 selectedNodeId', async () => {
		const declaration = currentDeclaration();
		const wrapper = mount(FlowView);

		await cards(wrapper)[2]?.trigger('click');
		expect(store.selectedNodeId.value).toBe(declaration.nodes[2]?.id);
		expect(cards(wrapper)[2]?.classes()).toContain('selected');
		expect(cards(wrapper)[2]?.attributes('data-selected')).toBe('true');

		// 键盘走同一条路
		await cards(wrapper)[3]?.trigger('keydown', { key: 'Enter' });
		expect(store.selectedNodeId.value).toBe(declaration.nodes[3]?.id);
		expect(cards(wrapper).filter((card) => card.classes().includes('selected'))).toHaveLength(1);
	});

	it('臂里的节点挂着的诊断照旧落在它自己那张卡片上', async () => {
		const declaration = currentDeclaration();
		const armNode = declaration.nodes[2];
		if (armNode === undefined) throw new Error('素材里应当有 then 臂那一步');
		store.diagnostics.value = [
			{ code: 'plan.step.param.missing', severity: 'warning', message: '技能没给参数', ref: armNode.id },
		];
		const wrapper = mount(FlowView);
		await wrapper.vm.$nextTick();

		expect(cards(wrapper)[2]?.find('[data-testid="flow-node-diagnostics"]').text()).toContain('技能没给参数');
		expect(cards(wrapper)[1]?.find('[data-testid="flow-node-diagnostics"]').exists()).toBe(false);
	});
});

describe('流程画布 · 没有否则与嵌套分支', () => {
	beforeEach(() => {
		loadPlan(NESTED_NO_ELSE_PLAN_JSON);
	});

	it('没有 else：不画 else 臂，但明说没有否则', () => {
		const wrapper = mount(FlowView);

		// 只画了「那么」一条臂：`data-arm` 是「这里真有一条臂」的机器可读的说法，
		// 所以 else 那一边不该出现这个属性——空的那一格只留一句说明。
		expect(wrapper.findAll('[data-testid="flow-arm"][data-depth="0"]').map((arm) => arm.attributes('data-arm'))).toEqual([
			'then',
		]);
		expect(wrapper.findAll('[data-testid="flow-arm"][data-depth="0"]')).toHaveLength(1);
		const note = wrapper.findAll('[data-testid="flow-arm-empty"]');
		expect(note).toHaveLength(1);
		expect(note[0]?.text()).toBe('没有否则：条件不成立时这一步什么都不做');
		expect(note[0]?.attributes('data-arm')).toBe('else');
		// 「那么」那一条臂里装着它的那一步
		expect(cards(wrapper)[2]?.element.closest('[data-testid="flow-arm"]')?.getAttribute('data-arm')).toBe('then');
	});

	it('嵌套分支在自己的臂里再展开两条臂（层数深一级）', () => {
		const declaration = currentDeclaration();
		const wrapper = mount(FlowView);

		// 内层那两条臂都在「那么」里面：closest 直接给出外层臂，这就是「缩进一级」的证据。
		const inner = wrapper.findAll('[data-testid="flow-arm"][data-depth="1"]');
		expect(inner.map((arm) => arm.attributes('data-arm'))).toEqual(['then', 'else']);
		for (const arm of inner) {
			expect(arm.element.closest('[data-testid="flow-arm"][data-depth="0"]')).not.toBeNull();
		}

		// 层数按 DOM 里的臂算：内层的两步比外层深一级，`if` 之后的庆祝与最外层分支同级。
		const structure = structureOf(wrapper);
		expect(structure.map((row) => `${nameOf(declaration, row.nodeId)}@${row.arm ?? '顶层'}/${row.depth ?? '-'}`)).toEqual([
			'1. 跳舞@顶层/-',
			'2. 分支@顶层/-',
			'3. 关闭夹爪@then/0',
			'4. 分支@then/0',
			'5. 点头@then/1',
			'6. 摇头@else/1',
			'7. 庆祝@顶层/-',
		]);
		// 内层分支卡的节点就是声明里那个嵌套的分支节点（它在 then 臂里）
		const innerBranch = declaration.nodes.find(
			(node) => node.type === TASK_BRANCH_NODE_TYPE && node.id !== declaration.nodes[1]?.id,
		);
		expect(structure[3]?.nodeId).toBe(innerBranch?.id);
		// 最外层的后续在臂外面：缩进与分支同级
		expect(structure[6]?.arm).toBeNull();
	});
});

describe('流程画布 · 图推不出来时给诊断，不崩也不静默少画', () => {
	it('多个链头：说出来，两条支路照画', () => {
		loadPlan(BRANCH_PLAN_JSON);
		const declaration = currentDeclaration();
		// 掐掉链头那条出边：观察与分支于是都没有入边，成了两个链头。
		const { [declaration.nodes[0]?.id ?? '']: _dropped, ...connections } = declaration.connections;
		const draft = { ...declaration, connections };
		expect(store.applyDeclaration({ ...draft, digest: computeWorkflowDigest(draft) })).toBe(true);

		const wrapper = mount(FlowView);

		const strip = wrapper.get('[data-testid="flow-graph-diagnostics"]');
		expect(strip.findAll('.graph-row').map((row) => row.attributes('data-code'))).toEqual(['flow.graph.multiple_heads']);
		expect(strip.text()).toContain('2 个链头');
		// 能画的照画：两支都在（观察自己一步 + 分支那一条带两条臂）
		expect(structureOf(wrapper).map((row) => nameOf(declaration, row.nodeId))).toEqual([
			'1. 观察桌面',
			'2. 分支',
			'3. 关闭夹爪',
			'4. 打开夹爪',
			'5. 往前一点',
		]);
	});

	it('环：说到那一步上，并且不会无限展开', () => {
		setSelectedDevice('phase1_robot');
		expect(loadSampleTask()).toBe(true);
		const declaration = currentDeclaration();
		const [first, second] = declaration.nodes;
		if (first === undefined || second === undefined) throw new Error('样例里应当有四步');
		// 前两步互相指着：谁都不是链头，后两步反而成了链头（它们没有入边）。
		const connections = {
			[first.id]: { main: [[{ node: second.id, input: 0 }]] },
			[second.id]: { main: [[{ node: first.id, input: 0 }]] },
		};
		const draft = { ...declaration, connections };
		expect(store.applyDeclaration({ ...draft, digest: computeWorkflowDigest(draft) })).toBe(true);

		const wrapper = mount(FlowView);

		const codes = wrapper.findAll('.graph-row').map((row) => row.attributes('data-code'));
		expect(codes).toContain('flow.graph.unreachable_node');
		expect(codes).toContain('flow.graph.cycle');
		// 四张卡片一张不少：后两步从链头画出来，环里那两步补在最后，环只画一次。
		expect(cards(wrapper)).toHaveLength(4);
		expect(cards(wrapper).filter((card) => card.attributes('data-node-id') === first.id)).toHaveLength(1);
		expect(wrapper.find('[data-testid="flow-graph-diagnostics"]').text()).toContain('又被指回来了');
	});

	it('悬空引用：连线指向的节点不在声明里时说清楚（这一条走图本身——悬空引用过不了结构校验，进不了真相）', () => {
		setSelectedDevice('phase1_robot');
		expect(loadSampleTask()).toBe(true);
		const declaration = currentDeclaration();
		const [first] = declaration.nodes;
		if (first === undefined) throw new Error('样例里应当有四步');
		const broken: WorkflowDeclaration = {
			...declaration,
			connections: { [first.id]: { main: [[{ node: 'nd_missing', input: 0 }]] } },
		};

		const plan = planStructureOf(broken);

		// 四步都没有入边（那个悬空目标不算节点），所以先报一句「多个链头」，再报悬空引用。
		expect(plan.diagnostics.map((diagnostic) => diagnostic.code)).toEqual([
			'flow.graph.multiple_heads',
			'flow.graph.dangling_reference',
		]);
		// 能画的照画：四步都在，顺序退回声明顺序（每一支各自从链头走）。
		expect(plan.steps.map((step) => step.node.id)).toEqual(declaration.nodes.map((node) => node.id));
	});

	it('分支没有出边：两条臂画不出来，但分支卡与别的步骤照画', () => {
		loadPlan(BRANCH_PLAN_JSON);
		const declaration = currentDeclaration();
		const branch = branchNodeOf(declaration);
		const { [branch.id]: _dropped, ...connections } = declaration.connections;
		const plan = planStructureOf({ ...declaration, connections });

		// 分支的出边整条不见了，两条臂的入边也就跟着没了——它们各自成了链头，照画。
		expect(plan.diagnostics.map((diagnostic) => diagnostic.code)).toContain('flow.graph.branch_unlinked');
		const branchStep = plan.steps.find((candidate) => candidate.node.id === branch.id);
		expect(branchStep?.isBranch).toBe(true);
		expect(branchStep?.arms).toEqual([]);
		expect(plan.steps.map((step) => step.index)).toEqual([0, 1, 2, 3, 4]);
	});
});

describe('流程画布 · 没有分支的声明与改动前逐字相同', () => {
	it('一期样例：整棵 DOM 与改动前的基准逐字一致', () => {
		const wrapper = mount(FlowView);

		expect(normalizeRenderedHtml(wrapper.html())).toBe(FLOW_BASELINE);
		// 顺带把「一个字都没变」这句话落在可读的几处：四张卡、三条连线、没有臂、没有图诊断。
		expect(cards(wrapper)).toHaveLength(4);
		expect(connectorCount(wrapper)).toBe(3);
		expect(wrapper.findAll('[data-testid="flow-arm"]')).toHaveLength(0);
		expect(wrapper.find('[data-testid="flow-graph-diagnostics"]').exists()).toBe(false);
		expect(wrapper.find('[data-testid="flow-node-condition"]').exists()).toBe(false);
	});

	it('技能计划的样例（没有分支）也走同一条老路：卡片数、连线数与声明一一对上', () => {
		loadPlan(JSON.stringify({
			schemaVersion: 1,
			robot: 'so101_single_arm',
			description: '看一眼桌面，往前挪一点，打开夹爪',
			plan: [
				{ step: 'skill', skill: 'inspect_scene' },
				{ step: 'skill', skill: 'move_relative_ee', params: { motion_direction: 'forward', motion_distance: 0.03 } },
				{ step: 'skill', skill: 'open_gripper_skill' },
			],
		}));
		const wrapper = mount(FlowView);

		expect(cards(wrapper)).toHaveLength(3);
		expect(connectorCount(wrapper)).toBe(2);
		// 卡头写中文名——协议那张字段表不认识技能名，所以这一路问的是**当前设备的目录**
		// （`ROBOFRAME_SO101_CATALOG` 里 `inspect_scene` 的 label 就是「观察桌面」）。
		// 早先这里照出的是标识符：一期那台显示中文、换成 SO-101 就成了英文，同一份界面两种样子。
		// 名字仍然只有目录一个来源——视图里没有第二份映射表。
		expect(structureOf(wrapper).map((row) => row.action)).toEqual([
			ROBOFRAME_SO101_CATALOG.capabilities.find((c) => c.capabilityRef === 'inspect_scene')?.label,
			ROBOFRAME_SO101_CATALOG.capabilities.find((c) => c.capabilityRef === 'move_relative_ee')?.label,
			ROBOFRAME_SO101_CATALOG.capabilities.find((c) => c.capabilityRef === 'open_gripper_skill')?.label,
		]);
		expect(structureOf(wrapper).map((row) => nameOf(currentDeclaration(), row.nodeId))).toEqual([
			'1. 观察桌面',
			'2. 往前一点',
			'3. 打开夹爪',
		]);
		expect(wrapper.findAll('[data-testid="flow-arm"]')).toHaveLength(0);
		// 参数照旧落在卡上（`motion_distance` 是技能自己声明的参数，不是协议字段）
		expect(paramValues(cards(wrapper)[1]!)).toEqual({ motion_direction: 'forward', motion_distance: '0.03' });
	});
});
