/**
 * 代码面板的界面验收（**语句树 → 带缩进的代码 + 选中步双向联动**）：
 * 1. 加载后（还没选）退到第一个模块——前进的实现三行；
 * 2. **点流程画布的卡片 → 面板换成那个模块的实现**，避障停止那三行带缩进；
 * 3. 改一个参数 → 面板那个数字跟着变；
 * 4. 行 ↔ 步骤的映射写在 DOM 上（`data-line` / `data-step` / `data-path`），不在视图里重算；
 * 5. **点某一行 → `selectStep(顶层下标)`**；`selectedStepIndex` 变了 → 那一步的所有行全亮；
 * 6. 面板是只读的派生（退档不改共享选中状态，也不自己校验）。
 *
 * **面板读哪份目录**：`CodePanel.vue` 里那个 `PHASE1_ROBOT_CATALOG` 是写死的，只能从模块边界换掉——
 * 下面 `vi.mock` 把它换成夹具目录（`views/__fixtures__/catalog.ts`）。理由：示意目录会被真实实现整份替换，
 * 而这里断言的是界面（行、缩进、徽标、联动），跟设备写了什么无关；挂到真实目录上，目录一改就集体失效。
 * 真实目录只留冒烟断言，见 `views/catalog-smoke.test.ts`。
 */
import { mount } from '@vue/test-utils';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { computeWorkflowDigest, type WorkflowDeclaration, type WorkflowNode } from '@codecanvas/contracts';
import { TASK_BRANCH_NODE_TYPE } from '@codecanvas/task-import';
import { setSelectedDevice } from '../../shell/devices';
import { loadSampleTask, useStudioDocument } from '../../state/document';
import FlowView from '../flow/FlowView.vue';
import { ARM_PARAMS_PLAN_JSON, BRANCH_PLAN_JSON, NESTED_NO_ELSE_PLAN_JSON } from '../flow/__fixtures__/branch-plan';
import { normalizeRenderedHtml, readBaseline } from '../flow/__fixtures__/normalize-html';
import RightPanel from '../right/RightPanel.vue';
import CodePanel from './CodePanel.vue';

vi.mock('@codecanvas/capabilities', async (importOriginal) => {
	const actual = await importOriginal<typeof import('@codecanvas/capabilities')>();
	const { FIXTURE_CATALOG } = await import('../__fixtures__/catalog');
	return { ...actual, PHASE1_ROBOT_CATALOG: FIXTURE_CATALOG };
});

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

/**
 * 面板上每一行的**渲染文本**——读真实 DOM 的 `textContent`，不是 VTU 的 `.text()`。
 *
 * 为什么较真：行首缩进就在 `<code>` 里（`INDENT_UNIT` = 4 个空格），
 * 而 `.text()` 会把它折掉（VTU 读的是 vdom 归一化过的文本）。
 * 缩进是这段程序的一部分，测试就必须从 DOM 里逐字读出来，而不是从别处拼回来。
 */
const lineTexts = (wrapper: ReturnType<typeof mount>): string[] =>
	wrapper
		.findAll('li.cp-line .cp-src')
		.map((cell) => (cell.element as HTMLElement).textContent ?? '');

const indents = (wrapper: ReturnType<typeof mount>): string[] =>
	wrapper.findAll('li.cp-line').map((line) => line.attributes('data-indent') ?? '');

const lineNumbers = (wrapper: ReturnType<typeof mount>): (string | undefined)[] =>
	wrapper.findAll('li.cp-line').map((line) => line.attributes('data-line'));

const stepIndexes = (wrapper: ReturnType<typeof mount>): (string | undefined)[] =>
	wrapper.findAll('li.cp-line').map((line) => line.attributes('data-step'));

const stepPaths = (wrapper: ReturnType<typeof mount>): (string | undefined)[] =>
	wrapper.findAll('li.cp-line').map((line) => line.attributes('data-path'));

const selectedLines = (wrapper: ReturnType<typeof mount>): number[] =>
	wrapper
		.findAll('li.cp-line')
		.filter((line) => line.attributes('data-selected') === 'true')
		.map((line) => Number(line.attributes('data-line')));

/** 流程画布上点某张卡（「避障停止」这类），走界面那条路选中模块。 */
const clickFlowCard = async (flow: ReturnType<typeof mount>, label: string): Promise<void> => {
	const card = flow
		.findAll('[data-testid="flow-node-card"]')
		.find((node) => node.get('[data-testid="flow-node-action"]').text() === label);
	expect(card).toBeDefined();
	await card?.trigger('click');
};

beforeEach(() => {
	// 样例跟着**设备格式**走（默认那台说的是技能计划），而这里量的是这份一期样例的代码行，
	// 所以先站到一期那台设备上。
	setSelectedDevice('phase1_robot');
	loadSampleTask();
	// 顺带清掉步选中：`select(null)` 只在**节点真的变了**时才清（它自己的守卫），
	// 上一个用例可能刚好把节点留在 null 上。这里把两件事都摆平，用例之间才互不干扰。
	doc.select(null);
	doc.selectStep(null);
});

describe('CodePanel · 当前模块的实现', () => {
	it('页面加载后（还没选中）显示第一个模块「前进」的实现', () => {
		const wrapper = mount(CodePanel);

		expect(wrapper.get('[data-testid="code-title"]').text()).toBe('前进 · 实现');
		expect(lineTexts(wrapper)).toEqual([
			'set_velocity(linear=0.2, angular=0.0)',
			'wait(seconds=5.0)',
			'stop_motion()',
		]);
		expect(lineNumbers(wrapper)).toEqual(['1', '2', '3']);
	});

	it('退档只是显示，不去改写共享的选中状态', () => {
		mount(CodePanel);
		expect(doc.selectedNodeId.value).toBeNull();
		expect(doc.selectedBlockId.value).toBeNull();
		expect(doc.selectedStepIndex.value).toBeNull();
	});

	it('点流程画布的「避障停止」卡 → 面板渲染出带缩进的三行（赋值 + if + 缩进的 brake）', async () => {
		const flow = mount(FlowView);
		const panel = mount(CodePanel);

		await clickFlowCard(flow, '避障停止');

		expect(panel.get('[data-testid="code-title"]').text()).toBe('避障停止 · 实现');
		// 三行：一行赋值、一行分支头、一行**缩进一档**的子语句（缩进写在文本里）
		expect(lineTexts(panel)).toEqual([
			'reading = read_scan(sensors=["/scan0"])',
			'if reading < 0.5:',
			'    brake()',
		]);
		expect(indents(panel)).toEqual(['0', '0', '1']);
		expect(
			panel.findAll('li.cp-line').map((line) => line.attributes('data-kind')),
		).toEqual(['set', 'if', 'call']);
		// 选中态是共享的：面板显示的正是流程卡片上那张卡
		expect(doc.selectedNodeId.value).toBe(declaration().nodes[1]?.id);
	});

	it('选中别的模块，标题与实现整块换掉（不是叠一份上去）', async () => {
		const wrapper = mount(CodePanel);
		doc.select(declaration().nodes[3]?.id ?? null);
		await wrapper.vm.$nextTick();

		expect(wrapper.get('[data-testid="code-title"]').text()).toBe('停止 · 实现');
		expect(lineTexts(wrapper)).toEqual(['stop_motion()']);
	});

	it('选中项清空 → 回到退档的第一模块', async () => {
		const wrapper = mount(CodePanel);
		doc.select(declaration().nodes[2]?.id ?? null);
		await wrapper.vm.$nextTick();
		expect(wrapper.get('[data-testid="code-title"]').text()).toBe('转向 · 实现');

		doc.select(null);
		await wrapper.vm.$nextTick();
		expect(wrapper.get('[data-testid="code-title"]').text()).toBe('前进 · 实现');
	});

	it('行 ↔ 步骤的映射在 DOM 上：行号 1 起、顶层步骤号 0 起、路径精确到分支', () => {
		const wrapper = mount(CodePanel);

		expect(stepIndexes(wrapper)).toEqual(['0', '1', '2']);
		expect(stepPaths(wrapper)).toEqual(['0', '1', '2']);
		expect(wrapper.findAll('li.cp-line').map((line) => line.attributes('data-primitive'))).toEqual([
			'set_velocity',
			'wait',
			'stop_motion',
		]);
		// 行首徽标是「模块内部的第几条顶层语句」，与 data-step 同一口径
		const badges = wrapper.findAll('[data-testid="code-step-index"]');
		expect(badges.map((badge) => badge.text())).toEqual(['1', '2', '3']);
		expect(badges.map((badge) => badge.attributes('data-seq'))).toEqual(['1', '2', '3']);
		expect(badges[0]?.classes()).toContain('cc-seq');
	});

	it('一个 if 展开的多行共享同一个顶层步骤号，徽标只挂在分支头上（不重复三次）', async () => {
		const wrapper = mount(CodePanel);
		doc.select(declaration().nodes[1]?.id ?? null);
		await wrapper.vm.$nextTick();

		expect(stepIndexes(wrapper)).toEqual(['0', '1', '1']);
		expect(stepPaths(wrapper)).toEqual(['0', '1', '1.then.0']);
		// 三行只有两枚徽标：第 1 步（赋值）与第 2 步（if）
		expect(wrapper.findAll('[data-testid="code-step-index"]').map((badge) => badge.text())).toEqual([
			'1',
			'2',
		]);
		// 分支头带 data-step-head，用来把整步滚进视野
		expect(wrapper.findAll('[data-step-head]').map((line) => line.attributes('data-step-head'))).toEqual([
			'0',
			'1',
		]);
	});

	it('改一个数字 → 面板那个数字跟着变，其它行不动', async () => {
		const wrapper = mount(CodePanel);
		const moveNode = declaration().nodes[0];
		expect(moveNode).toBeDefined();
		if (moveNode === undefined) return;

		expect(lineTexts(wrapper)[0]).toBe('set_velocity(linear=0.2, angular=0.0)');

		expect(applyParam(moveNode.id, 'linear', 0.15)).toBe(true);
		await wrapper.vm.$nextTick();

		expect(lineTexts(wrapper)[0]).toBe('set_velocity(linear=0.15, angular=0.0)');
		expect(lineTexts(wrapper)[1]).toBe('wait(seconds=5.0)');
	});

	it('改实现里被引用的那个参数（避障阈值）→ if 条件里的数字跟着变', async () => {
		const wrapper = mount(CodePanel);
		const obstacle = declaration().nodes[1];
		if (obstacle === undefined) return;

		doc.select(obstacle.id);
		await wrapper.vm.$nextTick();
		expect(lineTexts(wrapper)[1]).toBe('if reading < 0.5:');

		expect(applyParam(obstacle.id, 'distance', 1.5)).toBe(true);
		await wrapper.vm.$nextTick();
		expect(lineTexts(wrapper)[1]).toBe('if reading < 1.5:');
		// 结构没变：还是三行、还是那三条语句
		expect(lineTexts(wrapper)[0]).toBe('reading = read_scan(sensors=["/scan0"])');
		expect(lineTexts(wrapper)[2]).toBe('    brake()');
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

	it('只读：面板里没有任何写入口（没有输入框、没有按钮）', () => {
		const wrapper = mount(CodePanel);
		expect(wrapper.findAll('input, textarea, select, button')).toHaveLength(0);
	});

	it('面板是声明的纯函数：同一份声明 + 同一个选中 → 同一份文本', () => {
		const first = mount(CodePanel);
		const second = mount(CodePanel);
		expect(lineTexts(first)).toEqual(lineTexts(second));
	});

	it('面板碰不到「目录里没有的能力」：写回通道只放协议里的七种动作进来', async () => {
		const current = declaration();
		const nodes: WorkflowNode[] = current.nodes.map((node, index) =>
			index === 0 ? { ...node, parameters: { ...node.parameters, action: 'publish_to_hardware' } } : node,
		);
		const draft = { ...current, nodes };

		// 声明层看不见参数语义（spec §1.2 的不透明载荷），但写回通道还有第二道闸：任务协议校验器。
		// 于是流程/积木能产生的节点，action 一定是七种动作之一——而一期目录覆盖了全部七种，
		// 所以「查不到能力」那条分支在界面上走不到（渲染包里另有单测覆盖它）。
		expect(doc.applyDeclaration({ ...draft, digest: computeWorkflowDigest(draft) })).toBe(false);
		await Promise.resolve();

		expect(doc.declaration.value?.nodes[0]?.parameters['action']).toBe('move');
		expect(mount(CodePanel).get('[data-testid="code-title"]').text()).toBe('前进 · 实现');
	});
});

// ---------------------------------------------------------------------------
// 选中步：点代码 → selectStep；selectedStepIndex → 高亮（两边共用的那根线）
// ---------------------------------------------------------------------------

describe('CodePanel · 选中步（与积木共用 selectedStepIndex）', () => {
	it('点代码第 2 行 → selectStep(1)（顶层下标，0 基）', async () => {
		const wrapper = mount(CodePanel);
		expect(doc.selectedStepIndex.value).toBeNull();

		await wrapper.findAll('li.cp-line')[1]?.trigger('click');

		expect(doc.selectedStepIndex.value).toBe(1);
		expect(selectedLines(wrapper)).toEqual([2]);
	});

	it('selectedStepIndex 变化 → 属于那一步的行全部高亮（一个 if 会是多行）', async () => {
		const wrapper = mount(CodePanel);
		doc.select(declaration().nodes[1]?.id ?? null);
		await wrapper.vm.$nextTick();

		doc.selectStep(1);
		await wrapper.vm.$nextTick();

		// 第 1 步是那个 `if`：分支头与缩进的 brake 一起亮
		expect(selectedLines(wrapper)).toEqual([2, 3]);
		expect(
			wrapper.findAll('li.cp-line.is-selected').map((line) => line.attributes('data-path')),
		).toEqual(['1', '1.then.0']);
		// 徽标也跟着进选中态（三处联动里最稳的那条线索）
		const badges = wrapper.findAll('[data-testid="code-step-index"]');
		expect(badges.map((badge) => badge.attributes('data-active'))).toEqual(['false', 'true']);
	});

	it('点第 1 行（赋值那步）→ 只有它亮', async () => {
		const wrapper = mount(CodePanel);
		doc.select(declaration().nodes[1]?.id ?? null);
		await wrapper.vm.$nextTick();

		await wrapper.findAll('li.cp-line')[0]?.trigger('click');

		expect(doc.selectedStepIndex.value).toBe(0);
		expect(selectedLines(wrapper)).toEqual([1]);
	});

	it('再点同一行 → 收回选中（不然没法取消）', async () => {
		const wrapper = mount(CodePanel);
		const line = wrapper.findAll('li.cp-line')[1];
		await line?.trigger('click');
		expect(doc.selectedStepIndex.value).toBe(1);

		await line?.trigger('click');
		expect(doc.selectedStepIndex.value).toBeNull();
		expect(selectedLines(wrapper)).toEqual([]);
	});

	it('换模块时选中步清空：跨模块谈「第几步」没有意义', async () => {
		const wrapper = mount(CodePanel);
		await wrapper.findAll('li.cp-line')[1]?.trigger('click');
		expect(doc.selectedStepIndex.value).toBe(1);

		doc.select(declaration().nodes[1]?.id ?? null);
		await wrapper.vm.$nextTick();

		expect(doc.selectedStepIndex.value).toBeNull();
		expect(selectedLines(wrapper)).toEqual([]);
	});

	it('键盘走同一条路：回车选中那一行所属的步', async () => {
		const wrapper = mount(CodePanel);
		const line = wrapper.findAll('li.cp-line')[1];
		expect(line?.attributes('role')).toBe('button');
		expect(line?.attributes('tabindex')).toBe('0');

		await line?.trigger('keydown', { key: 'Enter' });

		expect(doc.selectedStepIndex.value).toBe(1);
		expect(selectedLines(wrapper)).toEqual([2]);
	});

	it('注释行不可点（它不占步骤号）——没有 role/tabindex，点了也不改选中', async () => {
		const wrapper = mount(CodePanel);
		const current = declaration();
		const nodes: WorkflowNode[] = current.nodes.map((node, index) =>
			index === 0 ? { ...node, disabled: true } : node,
		);
		const draft = { ...current, nodes };
		expect(doc.applyDeclaration({ ...draft, digest: computeWorkflowDigest(draft) })).toBe(true);
		await wrapper.vm.$nextTick();

		const first = wrapper.findAll('li.cp-line')[0];
		expect(first?.attributes('data-kind')).toBe('comment');
		expect(first?.classes()).not.toContain('is-clickable');
		expect(first?.attributes('tabindex')).toBeUndefined();
		expect(doc.selectedStepIndex.value).toBeNull();
		await first?.trigger('click');
		// 注释行不占步骤号 → 点了也不改选中（它没有 role / tabindex，也不该有）
		expect(doc.selectedStepIndex.value).toBeNull();
	});
});

// 右栏改成固定分区（上虚拟设备、下代码面板）之后，这条接线断言随之反过来：它总在。
// 右栏自身的布局与顺序另见 `views/right/RightPanel.test.ts`。
describe('接线：代码面板在右栏常驻（固定布局，不挑状态）', () => {
	it('右栏里挂的就是代码面板，显示的是第一个模块的实现', () => {
		const wrapper = mount(RightPanel);
		expect(wrapper.find('.code-panel').exists()).toBe(true);
		expect(wrapper.text()).toContain('前进 · 实现');
		expect(wrapper.text()).toContain('set_velocity(linear=0.2, angular=0.0)');
	});

	it('右栏仍是右栏：测试 id 在容器上，代码面板在它里面', () => {
		const wrapper = mount(RightPanel);
		const root = wrapper.get('[data-testid="right-panel"]');
		expect(root.classes()).toContain('right-panel');
		expect(root.find('.code-panel').exists()).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// 分支节点：**计划层**的代码（臂里是技能调用），与「某个能力的实现」是两件事
// ---------------------------------------------------------------------------

/** 载入一份带分支的技能计划，并选中那个分支节点（面板就是靠共享选中切过去的）。 */
const selectBranch = (json: string, pick: 'outer' | 'inner' = 'outer'): WorkflowNode => {
	setSelectedDevice('so101_robot');
	expect(doc.loadTaskJson(json)).toBe(true);
	const current = declaration();
	const branches = current.nodes.filter((node) => node.type === TASK_BRANCH_NODE_TYPE);
	const branch = pick === 'inner' ? (branches[1] ?? branches[0]) : branches[0];
	if (branch === undefined) throw new Error('这份素材里应当有分支节点');
	doc.select(branch.id);
	return branch;
};

describe('CodePanel · 分支节点显示的是计划层的代码', () => {
	it('两条臂都写出来：if / 缩进的 then 臂 / else / 缩进的 else 臂', async () => {
		selectBranch(BRANCH_PLAN_JSON);
		const panel = mount(CodePanel);
		await panel.vm.$nextTick();

		expect(panel.get('[data-testid="code-title"]').text()).toBe('2. 分支 · 计划');
		expect(lineTexts(panel)).toEqual([
			'if last.success == False:',
			'    close_gripper_skill()',
			'else:',
			'    open_gripper_skill()',
		]);
		expect(indents(panel)).toEqual(['0', '1', '0', '1']);
		expect(panel.findAll('li.cp-line').map((line) => line.attributes('data-kind'))).toEqual([
			'if',
			'call',
			'else',
			'call',
		]);
		expect(stepPaths(panel)).toEqual(['0', '0.then.0', '0.else', '0.else.0']);
		// 这一层只有一条顶层语句（那条 if），所以只有它挂步徽标
		expect(panel.findAll('[data-testid="code-step-index"]').map((badge) => badge.text())).toEqual(['1']);
		// 模块序号徽标仍是声明里的序数（与流程卡片同一个数）
		expect(panel.get('[data-testid="code-node-index"]').text()).toBe('2');
	});

	it('说清这是计划层：注记在，且没有「查不到能力」那条红字', async () => {
		selectBranch(BRANCH_PLAN_JSON);
		const panel = mount(CodePanel);
		await panel.vm.$nextTick();

		const note = panel.get('[data-testid="code-plan-note"]');
		expect(note.text()).toContain('计划层');
		expect(note.text()).toContain('技能调用');
		expect(note.text()).toContain('不是那个能力的实现');
		// 从前这里走的是「按 action 查能力」那条路，于是分支节点显示一句「查不到能力」——
		// 那是把「这是个判断」说成「这个能力不存在」。现在一个字都不该有。
		expect(panel.text()).not.toContain('查不到能力');
		expect(panel.find('[data-testid="code-warnings"]').exists()).toBe(false);
	});

	it('臂里那一步按技能名调用，技能参数照计划写出来（timeoutSec 不是技能参数，不进调用）', async () => {
		selectBranch(ARM_PARAMS_PLAN_JSON);
		const panel = mount(CodePanel);
		await panel.vm.$nextTick();

		expect(lineTexts(panel)).toEqual([
			'if last.success == False:',
			'    move_relative_ee(motion_direction="forward", motion_distance=0.03)',
			'else:',
			'    rotate_gripper_cw(motion_distance=90.0)',
		]);
		// 超时留在流程卡片上（那一步的参数摘要里有），这里不冒充技能参数
		expect(lineTexts(panel).join('\n')).not.toContain('timeoutSec');
	});

	it('没有否则：写一行说明，且那一行是注释（不可点、不占步号）', async () => {
		selectBranch(NESTED_NO_ELSE_PLAN_JSON);
		const panel = mount(CodePanel);
		await panel.vm.$nextTick();

		expect(lineTexts(panel)).toEqual([
			'if last.success == False:',
			'    close_gripper_skill()',
			'    if last.success == True:',
			'        nod_yes()',
			'    else:',
			'        shake_no()',
			'    # 没有否则：条件不成立时这一步什么都不做',
		]);
		expect(indents(panel)).toEqual(['0', '1', '1', '2', '1', '2', '1']);
		expect(panel.findAll('li.cp-line').map((line) => line.attributes('data-kind'))).toEqual([
			'if',
			'call',
			'if',
			'call',
			'else',
			'call',
			'comment',
		]);
		const note = panel.findAll('li.cp-line').at(-1);
		expect(note?.attributes('tabindex')).toBeUndefined();
		expect(note?.classes()).not.toContain('is-clickable');
	});

	it('嵌套分支自己也是一个模块：选中它，面板写的是它那一层', async () => {
		selectBranch(NESTED_NO_ELSE_PLAN_JSON, 'inner');
		const panel = mount(CodePanel);
		await panel.vm.$nextTick();

		expect(panel.get('[data-testid="code-title"]').text()).toBe('4. 分支 · 计划');
		expect(lineTexts(panel)).toEqual([
			'if last.success == True:',
			'    nod_yes()',
			'else:',
			'    shake_no()',
		]);
		expect(indents(panel)).toEqual(['0', '1', '0', '1']);
	});

	it('臂里每一行写着它说的是哪一步（跨栏连线认的那个 data-node-id）', async () => {
		const branch = selectBranch(BRANCH_PLAN_JSON);
		const current = declaration();
		const panel = mount(CodePanel);
		await panel.vm.$nextTick();

		const lines = panel.findAll('li.cp-line');
		// 分支头两行说的是分支自己；臂里的两行各说那一步——于是流程卡片、代码行与积木说得上是同一步。
		expect(lines.map((line) => line.attributes('data-node-id'))).toEqual([
			branch.id,
			current.nodes[2]?.id,
			branch.id,
			current.nodes[3]?.id,
		]);
	});
});

describe('CodePanel · 计划层与实现层的联动', () => {
	it('点臂里那一行 → 进那一步（选中的节点换成它，面板换成它的实现）', async () => {
		selectBranch(BRANCH_PLAN_JSON);
		const current = declaration();
		const panel = mount(CodePanel);
		await panel.vm.$nextTick();

		await panel.findAll('li.cp-line')[1]?.trigger('click');
		await panel.vm.$nextTick();

		expect(doc.selectedNodeId.value).toBe(current.nodes[2]?.id);
		// 换到实现层：标题换成能力的中文名，那句计划层注记随之消失（两件事不混）
		expect(panel.get('[data-testid="code-title"]').text()).toContain('实现');
		expect(panel.find('[data-testid="code-plan-note"]').exists()).toBe(false);
		// 选中的那一步的实现画出来了（非空）
		expect(panel.findAll('li.cp-line').length).toBeGreaterThan(0);
		// 「进另一步」不推步号：跨模块谈第几步没有意义
		expect(doc.selectedStepIndex.value).toBeNull();
	});

	it('点分支头那一行 → 选中的是这一步（模块不换，整段 if 都跟着亮）', async () => {
		const branch = selectBranch(BRANCH_PLAN_JSON);
		const panel = mount(CodePanel);
		await panel.vm.$nextTick();

		await panel.findAll('li.cp-line')[0]?.trigger('click');

		expect(doc.selectedStepIndex.value).toBe(0);
		expect(doc.selectedNodeId.value).toBe(branch.id);
		// 一个 if 展开的四行是同一步：一起亮
		expect(selectedLines(panel)).toEqual([1, 2, 3, 4]);
	});

	it('从流程卡片点分支 → 面板显示它的计划层代码（共享选中的那条老路）', async () => {
		setSelectedDevice('so101_robot');
		expect(doc.loadTaskJson(BRANCH_PLAN_JSON)).toBe(true);
		doc.select(null);
		const flow = mount(FlowView);
		const panel = mount(CodePanel);

		await clickFlowCard(flow, '分支');

		expect(panel.get('[data-testid="code-title"]').text()).toBe('2. 分支 · 计划');
		expect(lineTexts(panel)[0]).toBe('if last.success == False:');
	});
});

// ---------------------------------------------------------------------------
// 没有分支时一个像素都不许变：与改动前那一版的渲染逐字比一遍
// ---------------------------------------------------------------------------

describe('CodePanel · 没有分支时 渲染与从前逐字相同', () => {
	it('一期样例的第一个模块：整棵 DOM 与改动前的基准一致', () => {
		const panel = mount(CodePanel);
		expect(normalizeRenderedHtml(panel.html())).toBe(
			readBaseline('src/views/code-panel/__fixtures__/code-panel-baseline.html'),
		);
	});
});
