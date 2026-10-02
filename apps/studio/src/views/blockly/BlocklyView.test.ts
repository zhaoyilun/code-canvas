/**
 * 积木画布在 studio 这一侧的接线用例。
 *
 * happy-dom 里 `Blockly.inject` 跑不完（它在事件绑定上依赖真实浏览器的事件目标），
 * 所以「画布上真有几块积木、字段打字怎么写回真相」这类断言交给两个地方：
 *   - `packages/blockly-toolkit/test/**`：无头工作区上的完整读写往返；
 *   - 本目录的 `implementation.test.ts`：拿**应用真正用的目录与示例任务**把验收那几条
 *     （画面 = 当前模块的实现、字段值、写回只改参数）在无头工作区上再钉一遍；
 *   - 真实浏览器：字段打字 → 写回 → 非法值被拒（手工验过，结论见交付报告）。
 *
 * 这个文件守住的是画布**起来之前的那个前提**：主题色只从 `--cc-*` 变量来，缺了就不画、并说明原因；
 * 以及顶部那行「现在看的是哪个模块」——它只读声明与目录，所以在这一层就能核对。
 * 主题变量由测试从真实的 `theme.css` 里解析出来再喂给 `getComputedStyle`
 * （happy-dom 不解析自定义属性，所以替换的是那条 API，不是变量本身）。
 */
import { mount } from '@vue/test-utils';
import * as Blockly from 'blockly';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ROBOFRAME_SO101_CATALOG } from '@codecanvas/capabilities';
import {
	ELSE_INPUT_NAME,
	THEN_INPUT_NAME,
	collectImplementationBlocks,
	identityOfBlock,
} from '@codecanvas/blockly-toolkit';
import { findCapability, type WorkflowDeclaration } from '@codecanvas/contracts';
import { TASK_BRANCH_NODE_TYPE, TASK_WAIT_NODE_TYPE, importSkillPlan } from '@codecanvas/task-import';
import { setSelectedDevice } from '../../shell/devices';
import { loadSampleTask, useStudioDocument } from '../../state/document';
import {
	BRANCH_PLAN_JSON,
	BRANCH_PLAN_SKILLS,
	BRANCH_WAIT_PLAN_JSON,
	NESTED_NO_ELSE_PLAN_JSON,
	WAIT_PLAN_JSON,
} from '../flow/__fixtures__/branch-plan';
import {
	PLAN_BLOCK_DEFINITIONS,
	PLAN_BRANCH_BLOCK_TYPE,
	PLAN_BRANCH_NO_ELSE_BLOCK_TYPE,
	PLAN_BRANCH_NODE_TAG,
	PLAN_CONDITION_FIELD,
	PLAN_STEP_BLOCK_TYPE,
	PLAN_STEP_FIELD,
	PLAN_STEP_NODE_TAG,
	PLAN_WAIT_BLOCK_TYPE,
	PLAN_WAIT_FIELD,
	renderPlanInto,
} from './blockly-canvas';
import BlocklyView from './BlocklyView.vue';

const THEME_CSS = (): string => readFileSync(resolve(process.cwd(), 'src/shell/theme.css'), 'utf8');

const themeVariables = (): ReadonlyMap<string, string> => {
	const variables = new Map<string, string>();
	const pattern = /(--cc-[a-z0-9-]+)\s*:\s*([^;]+);/g;
	for (const match of THEME_CSS().matchAll(pattern)) {
		const name = match[1];
		const value = match[2];
		if (name !== undefined && value !== undefined) variables.set(name, value.trim());
	}
	return variables;
};

const realGetComputedStyle = globalThis.getComputedStyle;

const stubComputedStyle = (variables: ReadonlyMap<string, string>): void => {
	globalThis.getComputedStyle = (() => ({
		getPropertyValue: (name: string) => variables.get(name) ?? '',
	})) as unknown as typeof globalThis.getComputedStyle;
};

beforeEach(() => {
	// 样例跟着**设备格式**走（默认那台说的是技能计划），而这里量的是这份一期样例的积木，
	// 所以先站到一期那台设备上。
	setSelectedDevice('phase1_robot');
	expect(loadSampleTask()).toBe(true);
});

afterEach(() => {
	globalThis.getComputedStyle = realGetComputedStyle;
});

describe('积木画布 · 主题前提', () => {
	it('theme.css 里备齐了积木主题要用的每个变量', () => {
		const variables = themeVariables();
		for (const name of [
			'--cc-surface',
			'--cc-surface-raised',
			'--cc-surface-sunken',
			'--cc-accent',
			'--cc-accent-strong',
			'--cc-accent-dim',
			'--cc-danger',
			'--cc-font-mono',
			'--cc-fs-md',
		]) {
			expect(variables.get(name), name).toBeTruthy();
		}
	});

	it('缺主题变量时画布不画，并把原因摆出来', async () => {
		stubComputedStyle(new Map());
		const wrapper = mount(BlocklyView, { attachTo: document.body });
		await wrapper.vm.$nextTick();

		const failure = wrapper.find('[data-testid="blockly-failure"]');
		expect(failure.exists()).toBe(true);
		expect(failure.text()).toContain('--cc-accent');

		wrapper.unmount();
	});

	/**
	 * 标题只读声明与目录，不依赖画布起没起来——这也是它在这一层可核对的原因
	 * （`Blockly.inject` 在 happy-dom 里跑不完，见文件头）。
	 */
	it('顶部标题写的是当前模块：「<能力的 label> · 实现」，没选中就是第一个模块', async () => {
		stubComputedStyle(themeVariables());
		const wrapper = mount(BlocklyView, { attachTo: document.body });
		await wrapper.vm.$nextTick();

		// 示例任务的第一个模块是「前进」——没选中任何节点时画的就是它。
		expect(wrapper.find('[data-testid="blockly-module-title"]').text()).toBe('前进 · 实现');

		// 流程卡片点过来（store 记下选中）→ 标题换成那个模块的能力名。
		const store = useStudioDocument();
		const obstacle = store.nodes.value.find((node) => node.parameters['step_id'] === 's2');
		if (obstacle === undefined) throw new Error('示例任务里应当有 s2');
		store.select(obstacle.id);
		await wrapper.vm.$nextTick();
		expect(wrapper.find('[data-testid="blockly-module-title"]').text()).toBe('避障停止 · 实现');

		store.select(null);
		wrapper.unmount();
	});

	/**
	 * 选中步（`selectedStepIndex`）是积木与代码面板共用的那根线：代码面板点某一行 → 这里亮出「第几步」，
	 * 反之点积木也推同一个数（组件里由 `applySelection` 做）。这一层不依赖画布起没起来就能核对。
	 */
	it('选中步变了，画布顶部那一行就跟着说「第几步」（与代码面板同一个数）', async () => {
		stubComputedStyle(themeVariables());
		const wrapper = mount(BlocklyView, { attachTo: document.body });
		await wrapper.vm.$nextTick();

		const store = useStudioDocument();
		expect(wrapper.find('[data-testid="blockly-selected-step"]').exists()).toBe(false);

		// 代码面板点第 2 行（顶层语句下标 1）——它调的就是这一句。
		store.selectStep(1);
		await wrapper.vm.$nextTick();
		expect(wrapper.find('[data-testid="blockly-selected-step"]').text()).toBe('选中第 2 步');

		// 换模块 → 选中步清空（跨模块谈「第几步」没有意义）。
		store.select(store.nodes.value[0]?.id ?? null);
		await wrapper.vm.$nextTick();
		expect(wrapper.find('[data-testid="blockly-selected-step"]').exists()).toBe(false);

		store.selectStep(null);
		store.select(null);
		wrapper.unmount();
	});
});

// ---------------------------------------------------------------------------
// 分支节点：画布画的是**计划**（如果…那么…否则），不是「查不到能力的实现」
// ---------------------------------------------------------------------------

/** 载入一份带分支的技能计划，返回那个分支节点（外层的或嵌套的那一个）。 */
const loadBranchPlan = (json: string, pick: 'outer' | 'inner' = 'outer') => {
	setSelectedDevice('so101_robot');
	const store = useStudioDocument();
	expect(store.loadTaskJson(json)).toBe(true);
	const declaration = store.declaration.value;
	if (declaration === null) throw new Error('分支素材没载入');
	const branches = declaration.nodes.filter((node) => node.type === TASK_BRANCH_NODE_TYPE);
	const branch = pick === 'inner' ? (branches[1] ?? branches[0]) : branches[0];
	if (branch === undefined) throw new Error('素材里应当有分支节点');
	return { store, declaration, branch };
};

/**
 * 计划视图画出来的工作区。
 *
 * 走的是 `blockly-canvas.ts` 里 `render()` 用的**同一个入口**（`renderPlanInto`）：
 * `Blockly.inject` 在这套 DOM 环境里起不来（见文件头），但计划块是不是长成
 * 「如果…那么…否则」、两臂里装着什么，在**无头工作区**上就能逐块核对——那是同一份积木。
 */
const planWorkspaceOf = (json: string, pick: 'outer' | 'inner' = 'outer') => {
	const result = importSkillPlan(JSON.parse(json), { catalog: ROBOFRAME_SO101_CATALOG });
	if (!result.ok) throw new Error(`素材不是合法计划：${JSON.stringify(result.diagnostics)}`);
	const declaration = result.declaration;
	const branches = declaration.nodes.filter((node) => node.type === TASK_BRANCH_NODE_TYPE);
	const branch = pick === 'inner' ? (branches[1] ?? branches[0]) : branches[0];
	if (branch === undefined) throw new Error('素材里应当有分支节点');
	const workspace = new Blockly.Workspace();
	const rendered = renderPlanInto({
		workspace,
		declaration,
		catalog: ROBOFRAME_SO101_CATALOG,
		planNodeId: branch.id,
	});
	if (rendered === null) throw new Error('这个节点不是分支节点');
	return { workspace, declaration, branch, rendered };
};

/**
 * 计划块的定义（注册与画出来的块读的是同一份）：
 * `message0` 是「这块积木看起来像什么」的权威——它在运行时读不回来（Blockly 烘进了 init），
 * 所以断言对着定义说，再把定义里的字段/语句口与画出来的块对一遍。
 */
const definitionOf = (blockType: string): { message0?: string; args0?: { name?: string }[] } =>
	(PLAN_BLOCK_DEFINITIONS.find((definition) => definition['type'] === blockType) ?? {}) as {
		message0?: string;
		args0?: { name?: string }[];
	};

describe('积木画布 · 分支节点的标题与页脚', () => {
	afterEach(() => {
		const store = useStudioDocument();
		store.selectStep(null);
		store.select(null);
	});

	it('顶部标题说「计划」，不是「未知模块 · 实现」', async () => {
		stubComputedStyle(themeVariables());
		const { store, branch } = loadBranchPlan(BRANCH_PLAN_JSON);
		store.select(branch.id);
		const wrapper = mount(BlocklyView, { attachTo: document.body });
		await wrapper.vm.$nextTick();

		expect(wrapper.find('[data-testid="blockly-module-title"]').text()).toBe('2. 分支 · 计划');
		wrapper.unmount();
	});

	it('页脚的步号在计划视图里说「计划第几步」（与流程卡片同一个数）', async () => {
		stubComputedStyle(themeVariables());
		const { store, branch } = loadBranchPlan(BRANCH_PLAN_JSON);
		store.select(branch.id);
		const wrapper = mount(BlocklyView, { attachTo: document.body });
		await wrapper.vm.$nextTick();

		store.selectStep(1);
		await wrapper.vm.$nextTick();
		const hint = wrapper.get('[data-testid="blockly-selected-step"]');
		expect(hint.text()).toBe('选中计划第 2 步');
		expect(hint.attributes('data-plan')).toBe('true');

		// 换回实现层的模块：口径跟着换回「实现里的第几步」
		store.select(store.nodes.value[0]?.id ?? null);
		store.selectStep(1);
		await wrapper.vm.$nextTick();
		expect(wrapper.get('[data-testid="blockly-selected-step"]').text()).toBe('选中第 2 步');
		wrapper.unmount();
	});
});

describe('积木画布 · 计划块的结构（无头工作区）', () => {
	it('素材里的技能都是真实目录里的（没有编出来的假技能名）', () => {
		for (const ref of BRANCH_PLAN_SKILLS) {
			expect(findCapability(ROBOFRAME_SO101_CATALOG, ref), ref).toBeDefined();
		}
	});

	it('分支块就是「如果 % 那么 % 否则 %」，两臂里各是臂内步骤的块', () => {
		const { workspace } = planWorkspaceOf(BRANCH_PLAN_JSON);
		const tops = workspace.getTopBlocks(true);
		expect(tops).toHaveLength(1);
		const branch = tops[0];
		if (branch === null || branch === undefined) throw new Error('没有画出分支块');

		expect(branch.type).toBe(PLAN_BRANCH_BLOCK_TYPE);
		// 这句话只存在于定义里（见 definitionOf 的说明）：它说的就是「如果…那么…否则」
		const definition = definitionOf(PLAN_BRANCH_BLOCK_TYPE);
		expect(definition.message0).toBe('如果 %1 那么 %2 否则 %3');
		// 定义里那三格，就是画出来的块上真实存在的那三格（条件 + 两个语句口）
		expect(definition.args0?.map((arg) => arg.name)).toEqual([
			PLAN_CONDITION_FIELD,
			THEN_INPUT_NAME,
			ELSE_INPUT_NAME,
		]);
		// 块上的语句口就是定义里那两个（条件的字段行不进 inputList 的命名，它是块面上的一格字）
		expect(branch.inputList.map((input) => input.name)).toEqual([THEN_INPUT_NAME, ELSE_INPUT_NAME]);
		// 条件是只读的一格，写的是人话——**不带「如果」**：那两个字在 message0 里，
		// 两边都写就念成「如果 如果 上一步成功 == 假」（真机上就是这么念出来的）。
		expect(branch.getFieldValue(PLAN_CONDITION_FIELD)).toBe('上一步成功 == 假');
		// 两条臂各一块：写的就是那一步的调用（与代码面板同一个口径）
		const then = branch.getInputTargetBlock(THEN_INPUT_NAME);
		const otherwise = branch.getInputTargetBlock(ELSE_INPUT_NAME);
		expect(then?.type).toBe(PLAN_STEP_BLOCK_TYPE);
		expect(then?.getFieldValue(PLAN_STEP_FIELD)).toBe('关闭夹爪 close_gripper_skill()');
		expect(otherwise?.getFieldValue(PLAN_STEP_FIELD)).toBe('打开夹爪 open_gripper_skill()');
	});

	it('没有否则：块型不一样，消息里直接写着「（没有否则）」，也不留一只空手', () => {
		const { workspace } = planWorkspaceOf(NESTED_NO_ELSE_PLAN_JSON);
		const branch = workspace.getTopBlocks(true)[0];
		if (branch === null || branch === undefined) throw new Error('没有画出分支块');

		expect(branch.type).toBe(PLAN_BRANCH_NO_ELSE_BLOCK_TYPE);
		expect(definitionOf(PLAN_BRANCH_NO_ELSE_BLOCK_TYPE).message0).toContain('（没有否则）');
		// 定义里没有那一格，画出来的块上也就没有：不是留一只空手
		expect(definitionOf(PLAN_BRANCH_NO_ELSE_BLOCK_TYPE).args0?.map((arg) => arg.name)).toEqual([
			PLAN_CONDITION_FIELD,
			THEN_INPUT_NAME,
		]);
		expect(branch.getInput(ELSE_INPUT_NAME)).toBeFalsy();
	});

	it('嵌套分支递归下去：臂里那块还是分支块，它自己的两条臂也在', () => {
		const { workspace } = planWorkspaceOf(NESTED_NO_ELSE_PLAN_JSON);
		const outer = workspace.getTopBlocks(true)[0];
		if (outer === null || outer === undefined) throw new Error('没有画出分支块');

		expect(outer.getInputTargetBlock(THEN_INPUT_NAME)?.getFieldValue(PLAN_STEP_FIELD)).toBe(
			'关闭夹爪 close_gripper_skill()',
		);
		const inner = outer.getInputTargetBlock(THEN_INPUT_NAME)?.getNextBlock();
		expect(inner?.type).toBe(PLAN_BRANCH_BLOCK_TYPE);
		expect(inner?.getFieldValue(PLAN_CONDITION_FIELD)).toBe('上一步成功 == 真');
		expect(inner?.getInputTargetBlock(THEN_INPUT_NAME)?.getFieldValue(PLAN_STEP_FIELD)).toBe('点头 nod_yes()');
		expect(inner?.getInputTargetBlock(ELSE_INPUT_NAME)?.getFieldValue(PLAN_STEP_FIELD)).toBe('摇头 shake_no()');
	});

	it('只读：一个可写字段都没有（分支没有参数），块也删不掉', () => {
		const { workspace } = planWorkspaceOf(BRANCH_PLAN_JSON);
		const blocks = workspace.getAllBlocks(false);
		const fields = blocks.flatMap((block) => block.inputList.flatMap((input) => input.fieldRow));
		expect(blocks).toHaveLength(3);
		expect(fields.length).toBeGreaterThan(0);
		for (const field of fields) expect(field).toBeInstanceOf(Blockly.FieldLabel);
		for (const block of blocks) expect(block.isDeletable()).toBe(false);
	});

	it('每块都写着它说的是哪一步：前序顺序与声明里那三步一一对上', () => {
		const { workspace, declaration } = planWorkspaceOf(BRANCH_PLAN_JSON);
		const identities = collectImplementationBlocks(workspace)
			.map((block) => identityOfBlock(block))
			.filter((identity) => identity !== null);

		expect(identities.map((identity) => identity.nodeTag)).toEqual([
			PLAN_BRANCH_NODE_TAG,
			PLAN_STEP_NODE_TAG,
			PLAN_STEP_NODE_TAG,
		]);
		// 分支自己 + then 臂那一步 + else 臂那一步（声明里的 2 / 3 / 4）
		expect(identities.map((identity) => identity.nodeId)).toEqual([
			declaration.nodes[1]?.id,
			declaration.nodes[2]?.id,
			declaration.nodes[3]?.id,
		]);
		// `stepPath` 是它在**声明里**的位置：徽标上的数与流程卡片、代码行是同一个
		expect(identities.map((identity) => identity.stepPath)).toEqual(['1', '2', '3']);
		expect(identities.map((identity) => identity.stepIndex)).toEqual([1, 2, 3]);
	});

	it('不是分支节点 → null（调用方据此走「能力实现」那条路，判据只有一处）', () => {
		const { workspace, declaration } = planWorkspaceOf(BRANCH_PLAN_JSON);
		const first = declaration.nodes[0];
		if (first === undefined) throw new Error('素材里应当有第一步');
		expect(
			renderPlanInto({
				workspace,
				declaration,
				catalog: ROBOFRAME_SO101_CATALOG,
				planNodeId: first.id,
			}),
		).toBeNull();
	});

	it('臂里的连线指丢了：照画能画的部分，问题作为诊断交出去', () => {
		const { declaration, branch } = planWorkspaceOf(BRANCH_PLAN_JSON);
		const broken: WorkflowDeclaration = {
			...declaration,
			connections: { ...declaration.connections, [branch.id]: { main: [[{ node: 'nd_missing', input: 0 }], [], []] } },
		};
		const workspace = new Blockly.Workspace();
		const rendered = renderPlanInto({
			workspace,
			declaration: broken,
			catalog: ROBOFRAME_SO101_CATALOG,
			planNodeId: branch.id,
		});

		// 「那么」那一边指丢了，于是它也是空的——两条诊断都说出来，图照画。
		expect(rendered?.diagnostics.map((diagnostic) => diagnostic.code)).toEqual([
			'flow.graph.dangling_reference',
			'flow.graph.empty_then_arm',
		]);
		// 分支块自己还在（条件照旧看得见），只是「那么」那一边没有块
		const top = workspace.getTopBlocks(true)[0];
		expect(top?.type).toBe(PLAN_BRANCH_NO_ELSE_BLOCK_TYPE);
		expect(top?.getFieldValue(PLAN_CONDITION_FIELD)).toBe('上一步成功 == 假');
		expect(top?.getInputTargetBlock(THEN_INPUT_NAME)).toBeFalsy();
	});
});

// ---------------------------------------------------------------------------
// 等待步：计划层的另一块只读积木（`等待 2 秒 wait(2.0)`）
// ---------------------------------------------------------------------------

/** 一份带等待的计划 → 声明 + 那个等待节点（技能名照真实目录写）。 */
const waitDeclarationOf = (json: string): { declaration: WorkflowDeclaration; waitId: string } => {
	const result = importSkillPlan(JSON.parse(json), { catalog: ROBOFRAME_SO101_CATALOG });
	if (!result.ok) throw new Error(`素材不是合法计划：${JSON.stringify(result.diagnostics)}`);
	const wait = result.declaration.nodes.find((node) => node.type === TASK_WAIT_NODE_TYPE);
	if (wait === undefined) throw new Error('素材里应当有等待节点');
	return { declaration: result.declaration, waitId: wait.id };
};

describe('积木画布 · 等待步的计划块', () => {
	it('选中等待节点：一块只读的「等待 2 秒 wait(2.0)」，没有可写字段、删不掉', () => {
		const { declaration, waitId } = waitDeclarationOf(WAIT_PLAN_JSON);
		const workspace = new Blockly.Workspace();
		const rendered = renderPlanInto({
			workspace,
			declaration,
			catalog: ROBOFRAME_SO101_CATALOG,
			planNodeId: waitId,
		});
		expect(rendered).not.toBeNull();

		const tops = workspace.getTopBlocks(true);
		expect(tops).toHaveLength(1);
		const block = tops[0];
		if (block === null || block === undefined) throw new Error('没有画出等待块');
		expect(block.type).toBe(PLAN_WAIT_BLOCK_TYPE);
		expect(definitionOf(PLAN_WAIT_BLOCK_TYPE).args0?.map((arg) => arg.name)).toEqual([PLAN_WAIT_FIELD]);
		// 块上那句话：人话（卡片上那句）在前，代码写法（代码面板那一行）在后
		expect(block.getFieldValue(PLAN_WAIT_FIELD)).toBe('等待 2 秒 wait(2.0)');

		const fields = block.inputList.flatMap((input) => input.fieldRow);
		for (const field of fields) expect(field).toBeInstanceOf(Blockly.FieldLabel);
		expect(block.isDeletable()).toBe(false);
	});

	it('等待在臂里：跟着技能块串成链，两块各自是各自的种类', () => {
		const { declaration } = waitDeclarationOf(BRANCH_WAIT_PLAN_JSON);
		const branches = declaration.nodes.filter((node) => node.type === TASK_BRANCH_NODE_TYPE);
		const branch = branches[0];
		if (branch === undefined) throw new Error('素材里应当有分支节点');
		const workspace = new Blockly.Workspace();
		renderPlanInto({ workspace, declaration, catalog: ROBOFRAME_SO101_CATALOG, planNodeId: branch.id });

		const top = workspace.getTopBlocks(true)[0];
		if (top === null || top === undefined) throw new Error('没有画出分支块');
		const thenFirst = top.getInputTargetBlock(THEN_INPUT_NAME);
		expect(thenFirst?.getFieldValue(PLAN_STEP_FIELD)).toBe('关闭夹爪 close_gripper_skill()');
		const thenWait = thenFirst?.getNextBlock();
		expect(thenWait?.type).toBe(PLAN_WAIT_BLOCK_TYPE);
		expect(thenWait?.getFieldValue(PLAN_WAIT_FIELD)).toBe('等待 2 秒 wait(2.0)');
		// 等待块后面没有东西：臂的链尾就是它（臂不接回主干）
		expect(thenWait?.getNextBlock()).toBeFalsy();
		expect(top.getInputTargetBlock(ELSE_INPUT_NAME)?.getFieldValue(PLAN_WAIT_FIELD)).toBe('等待 0.5 秒 wait(0.5)');
	});

	it('选中等待节点时顶部标题与页脚都说「计划」：它没有实现可看', async () => {
		stubComputedStyle(themeVariables());
		setSelectedDevice('so101_robot');
		const store = useStudioDocument();
		expect(store.loadTaskJson(WAIT_PLAN_JSON)).toBe(true);
		const wait = store.nodes.value.find((node) => node.type === TASK_WAIT_NODE_TYPE);
		if (wait === undefined) throw new Error('素材里应当有等待节点');
		store.select(wait.id);
		const wrapper = mount(BlocklyView, { attachTo: document.body });
		await wrapper.vm.$nextTick();

		expect(wrapper.find('[data-testid="blockly-module-title"]').text()).toBe('2. 等待 2 秒 · 计划');
		store.selectStep(1);
		await wrapper.vm.$nextTick();
		const hint = wrapper.get('[data-testid="blockly-selected-step"]');
		expect(hint.text()).toBe('选中计划第 2 步');
		expect(hint.attributes('data-plan')).toBe('true');
		// 收尾：别把选中留给下一个用例
		store.selectStep(null);
		store.select(null);
		wrapper.unmount();
	});
});
