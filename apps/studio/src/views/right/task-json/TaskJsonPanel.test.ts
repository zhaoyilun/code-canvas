// @vitest-environment happy-dom
/**
 * 任务 JSON 视图的验收：**按出生时的格式还原** + **指向**。
 *
 * 三组断言，对着这件东西的三半：
 * 1. 数据（`task-json.ts`，纯函数）：从声明还原出**那个格式**的任务 JSON，并且
 *    **参数 → 实现里第几步**那条映射是从目录的实现树扫出来的——用一份合成目录来测，
 *    不依赖 `PHASE1_ROBOT_CATALOG` 的具体内容（那边正在改，映射的口径不该跟着抖）。
 * 2. 界面（组件）：点 JSON 里的一段 → `store.select(nodeId)`（流程卡片 / 积木 / 代码面板一起跳），
 *    点参数行再叠一个 `store.selectStep(index)`；反过来选中模块时那一段也带标记。
 * 3. 格式（组件）：还原用的是**声明出生时那台设备的格式**（`declarationFormatRef`），
 *    不是当前选中的设备——同一份声明换设备后，原文不许被硬套成另一种格式。
 *    技能计划那条也不手写技能名：技能与参数都从 `ROBOFRAME_SO101_CATALOG` 里挑。
 */
import { mount } from '@vue/test-utils';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CapabilityCatalog, CapabilitySpec, WorkflowDeclaration, WorkflowNode } from '@codecanvas/contracts';
import { SKILL_PLAN_SCHEMA_VERSION, computeWorkflowDigest } from '@codecanvas/contracts';
import { ROBOFRAME_SO101_CATALOG } from '@codecanvas/capabilities';
import { TASK_ACTION_NODE_TYPE, findTaskFormat } from '@codecanvas/task-import';
import { loadSampleTask, useStudioDocument } from '../../../state/document';
import { setSelectedDevice } from '../../../shell/devices';
import TaskJsonPanel from './TaskJsonPanel.vue';
import {
	buildTaskJson,
	capabilityOf,
	referencedStepIndex,
	renderTaskJson,
} from './task-json';

const doc = useStudioDocument();

const node = (id: string, parameters: Record<string, unknown>): WorkflowNode => ({
	id,
	name: `节点 ${id}`,
	type: TASK_ACTION_NODE_TYPE,
	typeVersion: 1,
	parameters: parameters as WorkflowNode['parameters'],
	position: { x: 0, y: 0 },
	disabled: false,
});

/** 一份合成目录：`demo` 的实现里，`distance` 用在第 2 条顶层语句上（0 基是 1）。 */
const DEMO_CATALOG: CapabilityCatalog = {
	catalogRef: 'demo',
	displayName: '演示设备',
	revisionRef: 'demo-v1',
	primitives: [
		{ primitiveRef: 'go', label: '走', parameters: [{ name: 'speed', label: '速度', type: 'number' }] },
	],
	capabilities: [
		{
			capabilityRef: 'move',
			label: '前进',
			kind: 'skill',
			parameters: [
				{ name: 'speed', label: '速度', type: 'number' },
				{ name: 'unused', label: '没用到的参数', type: 'number' },
			],
			implementation: [
				{ kind: 'call', primitiveRef: 'go', arguments: { speed: { kind: 'param', name: 'speed' } } },
				{
					kind: 'if',
					condition: {
						kind: 'binary',
						operator: 'lt',
						left: { kind: 'literal', value: 1 },
						right: { kind: 'param', name: 'distance' },
					},
					then: [{ kind: 'call', primitiveRef: 'go', arguments: { speed: 0 } }],
				},
			],
		},
	],
};

/** 解析器收到的是**能力引用**（`move`），目录里有没有这个能力由 `findCapability` 判。 */
const resolveDemo = (): CapabilityCatalog => DEMO_CATALOG;

const declaration = (nodes: readonly WorkflowNode[]): WorkflowDeclaration => {
	const draft = {
		formatVersion: 1 as const,
		id: 'wf_demo',
		name: '演示任务',
		nodes: [...nodes],
		connections: {},
		meta: {
			schema_version: '1.0',
			task_id: 'task-demo-9',
			description: '演示一句话',
			limits: { max_linear: 0.3, max_duration: 30 },
		},
	};
	return { ...draft, digest: computeWorkflowDigest(draft) };
};

beforeEach(() => {
	// 示例任务是**一期协议**的样例，所以先把设备切到那台再灌：
	// 还原用的是「声明出生时那台设备的格式」，测试也得从那个出生点开始。
	setSelectedDevice('phase1_robot');
	expect(loadSampleTask()).toBe(true);
});

// ---------------------------------------------------------------------------
// 技能计划那条路的用具：**不手写技能名与参数名**，全部从 SO-101 目录里挑
// ---------------------------------------------------------------------------

interface SkillPlanFixture {
	readonly capability: CapabilitySpec;
	/** 目录里声明的参数名——「点参数行点亮实现某一步」这条测试要的就是它。 */
	readonly parameterName: string;
	/** 这个参数在实现里第一次被用的顶层语句下标（从目录扫出来的，不是写死的）。 */
	readonly implStepIndex: number;
}

/**
 * 挑一个「参数真的用在实现里」的技能。随便挑的技能可能压根没用参数，
 * 那样这条测试就只能验证 null，验证不了联动。
 */
const skillPlanFixture = (): SkillPlanFixture => {
	for (const capability of ROBOFRAME_SO101_CATALOG.capabilities) {
		for (const parameter of capability.parameters) {
			const index = referencedStepIndex(capability, parameter.name);
			if (index !== null) return { capability, parameterName: parameter.name, implStepIndex: index };
		}
	}
	throw new Error('SO-101 目录里得有一个「参数用在实现里」的技能，这条测试才有意义');
};

/** 参数值按目录声明的类型给（整数用整数，别让校验器的 type 判据替我兜底）。 */
const paramValue = (parameter: CapabilitySpec['parameters'][number]): unknown => {
	switch (parameter.type) {
		case 'number':
			return 1;
		case 'boolean':
			return true;
		case 'sensor':
			return ['/scan0'];
		case 'json':
			return {};
		default:
			return 'demo';
	}
};

const skillPlanText = (fixture: SkillPlanFixture): string => {
	const params: Record<string, unknown> = {};
	for (const parameter of fixture.capability.parameters) params[parameter.name] = paramValue(parameter);
	return JSON.stringify({
		schemaVersion: SKILL_PLAN_SCHEMA_VERSION,
		robot: ROBOFRAME_SO101_CATALOG.robotName ?? '',
		description: '演示技能计划',
		plan: [{ step: 'skill', skill: fixture.capability.capabilityRef, params }],
	});
};

interface LoadedSkillPlan extends SkillPlanFixture {
	readonly nodeId: string;
}

/**
 * 把一份技能计划灌进真相。**设备得先切到 SO-101 那台**——格式是设备属性，
 * 用一期设备去收技能计划是收不下的；声明则记住自己是技能计划产出的。
 */
const loadSkillPlan = (): LoadedSkillPlan => {
	const fixture = skillPlanFixture();
	setSelectedDevice('so101_robot');
	expect(doc.loadTaskJson(skillPlanText(fixture))).toBe(true);

	const node = doc.declaration.value?.nodes.find(
		(item) => item.parameters['action'] === fixture.capability.capabilityRef,
	);
	if (node === undefined) throw new Error('技能计划里的技能应该落成一个节点');
	return { ...fixture, nodeId: node.id };
};

describe('任务 JSON · 从声明还原（纯函数）', () => {
	it('step 从节点参数还原：`step_id` 变回协议里的 `id`', () => {
		/*
		 * 还原这件事现在**归格式管**（`findTaskFormat('phase1_task').fromDeclaration`），
		 * 所以从这里进——视图不再自己拼一遍协议键，否则它和写回通道迟早是两份东西。
		 * 键序也归格式定（`id` 落在末尾），所以断言的是内容，不再是「`id` 排第一个」。
		 */
		const task = buildTaskJson(
			declaration([node('nd_1', { step_id: 's1', action: 'move', linear: 0.2, angular: 0 })]),
			'phase1_task',
		);

		expect(task['steps']).toEqual([{ id: 's1', action: 'move', linear: 0.2, angular: 0 }]);
	});

	it('整份任务：schema_version / task_id / description / steps / limits 都来自声明', () => {
		const task = buildTaskJson(
			declaration([node('nd_1', { step_id: 's1', action: 'move', linear: 0.2 })]),
			'phase1_task',
		);

		expect(task['schema_version']).toBe('1.0');
		expect(task['task_id']).toBe('task-demo-9');
		expect(task['description']).toBe('演示一句话');
		expect(task['steps']).toEqual([{ id: 's1', action: 'move', linear: 0.2 }]);
		expect(task['limits']).toEqual({ max_linear: 0.3, max_duration: 30 });
	});

	it('参数 → 实现里第几步：从目录的实现树扫出来，扫不到就是 null', () => {
		const capability = capabilityOf(node('nd_1', { action: 'move' }), resolveDemo);

		// `speed` 在第 0 条顶层语句里被用到
		expect(referencedStepIndex(capability, 'speed')).toBe(0);
		// `distance` 只在第 1 条（那个 if 的条件里）被用到——嵌套里的引用也算
		expect(referencedStepIndex(capability, 'distance')).toBe(1);
		// 目录里没这个参数 → 不点亮任何一步
		expect(referencedStepIndex(capability, 'unused')).toBeNull();
		// 目录里没有这个能力 → 同样 null（不编）
		expect(referencedStepIndex(null, 'speed')).toBeNull();
	});

	it('渲染成行：行号连续、缩进写进文本、每行都记着它指向谁', () => {
		const view = renderTaskJson(
			declaration([
				node('nd_1', { step_id: 's1', action: 'move', speed: 0.2 }),
				node('nd_2', { step_id: 's2', action: 'stop' }),
			]),
			resolveDemo,
			'phase1_task',
		);

		expect(view.stepCount).toBe(2);
		// 行号从 1 起、连续
		expect(view.lines.map((line) => line.line)).toEqual(view.lines.map((_, index) => index + 1));
		// 首行是 `{`，末行是 `}`
		expect(view.lines[0]?.text).toBe('{');
		expect(view.lines.at(-1)?.text).toBe('}');
		// 缩进在文本里（不是靠 CSS）
		expect(view.lines[1]?.text.startsWith('  "')).toBe(true);
		// 每一行拼起来就是一份合法 JSON
		expect(JSON.parse(view.lines.map((line) => line.text).join('\n'))).toEqual(view.task);

		// 第二步那一段的每一行都挂着它的 nodeId 与序数
		const second = view.lines.filter((line) => line.nodeId === 'nd_2');
		expect(second.length).toBeGreaterThan(0);
		expect(second.every((line) => line.stepOrdinal === 2)).toBe(true);

		// 任务级那几行没有「哪一步」可选
		const meta = view.lines.find((line) => line.text.includes('task_id'));
		expect(meta?.nodeId).toBeNull();
		expect(meta?.section).toBe('meta');

		// 参数行带参数名与映射；`action` / `id` 行不带
		const speed = view.lines.find((line) => line.text.includes('"speed"'));
		expect(speed?.parameter).toBe('speed');
		expect(speed?.implStepIndex).toBe(0);
		expect(speed?.nodeId).toBe('nd_1');
		const action = view.lines.find((line) => line.text.includes('"action"'));
		expect(action?.parameter).toBeNull();
		expect(action?.implStepIndex).toBeNull();
	});
});

describe('任务 JSON · 点一段就跟着跳（组件）', () => {
	/** 找到 JSON 里属于某个节点的、带某个参数名的那一行。 */
	const paramLine = (wrapper: ReturnType<typeof mount>, nodeId: string, parameter: string) =>
		wrapper.get(`[data-tj-node="${nodeId}"][data-tj-param="${parameter}"]`);

	it('显示的是当前声明还原出来的任务 JSON：格式化、带行号、只读', () => {
		const wrapper = mount(TaskJsonPanel);
		const text = wrapper.get('[data-testid="task-json-scroll"]').text();

		expect(text).toContain('"schema_version": "1.0"');
		expect(text).toContain('"task_id": "task-demo-001"');
		expect(text).toContain('"description": "前进，遇障停止后转向"');
		expect(text).toContain('"steps": [');
		expect(text).toContain('"max_duration": 30');
		// 行号在
		expect(wrapper.findAll('.tj-line').length).toBeGreaterThan(10);
		expect(wrapper.get('[data-testid="task-json-step-count"]').text()).toContain('4 步');
		// 只读：这面板里没有任何可编辑控件
		expect(wrapper.findAll('textarea')).toHaveLength(0);
		expect(wrapper.findAll('input')).toHaveLength(0);
		expect(wrapper.find('[contenteditable="true"]').exists()).toBe(false);
	});

	it('点某一步的结构行 → 选中那个节点（流程卡片 / 积木 / 代码面板读的是同一个状态）', async () => {
		const wrapper = mount(TaskJsonPanel);
		const first = doc.declaration.value?.nodes[1];
		expect(first).toBeDefined();
		if (first === undefined) return;

		const line = wrapper.get(`[data-tj-node="${first.id}"]`);
		await line.trigger('click');

		expect(doc.selectedNodeId.value).toBe(first.id);
		// 那一段整体带标记（与另外三处同一条 --cc-highlight）
		expect(line.attributes('data-selected')).toBe('true');
	});

	it('点参数行 → 除了选中节点，还点亮实现里用到这个参数的那一步（selectStep）', async () => {
		const wrapper = mount(TaskJsonPanel);
		const first = doc.declaration.value?.nodes[0];
		expect(first).toBeDefined();
		if (first === undefined) return;

		const line = paramLine(wrapper, first.id, 'linear');
		await line.trigger('click');

		expect(doc.selectedNodeId.value).toBe(first.id);
		/*
		 * 映射是**从目录扫出来的**，所以这里不写死数字（目录内容正在被改）：
		 * 断言的是「拿到的那个下标确实是个数，且真的推给了共享状态」。
		 * 映射本身的正确性在上面那组纯函数测试里用合成目录钉死。
		 */
		const mapped = line.attributes('data-tj-impl-step');
		expect(mapped).toBeDefined();
		expect(Number.isInteger(Number(mapped))).toBe(true);
		expect(doc.selectedStepIndex.value).toBe(Number(mapped));
		expect(line.attributes('data-selected-step')).toBe('true');
	});

	it('再点同一个参数行 → 收回「第几步」的选中（节点选中留着）', async () => {
		const wrapper = mount(TaskJsonPanel);
		const first = doc.declaration.value?.nodes[0];
		expect(first).toBeDefined();
		if (first === undefined) return;

		const line = paramLine(wrapper, first.id, 'linear');
		await line.trigger('click');
		const mapped = Number(line.attributes('data-tj-impl-step'));
		expect(doc.selectedStepIndex.value).toBe(mapped);

		await line.trigger('click');
		expect(doc.selectedStepIndex.value).toBeNull();
		expect(doc.selectedNodeId.value).toBe(first.id);
	});

	it('反过来：别处选中模块 → JSON 里对应的那一段带标记', async () => {
		const wrapper = mount(TaskJsonPanel);
		const third = doc.declaration.value?.nodes[2];
		expect(third).toBeDefined();
		if (third === undefined) return;

		doc.select(third.id);
		await wrapper.vm.$nextTick();

		const mine = wrapper.findAll(`[data-tj-node="${third.id}"]`);
		expect(mine.length).toBeGreaterThan(0);
		expect(mine.every((line) => line.attributes('data-selected') === 'true')).toBe(true);
		// 别的段没有被误标（按 DOM 元素比，Wrapper 每次都是新对象）
		const myElements = mine.map((line) => line.element);
		const others = wrapper.findAll('[data-tj-node]').filter((line) => !myElements.includes(line.element));
		expect(others.length).toBeGreaterThan(0);
		expect(others.every((line) => line.attributes('data-selected') === 'false')).toBe(true);
	});

	it('键盘走同一件事：回车选中那一段', async () => {
		const wrapper = mount(TaskJsonPanel);
		const first = doc.declaration.value?.nodes[0];
		expect(first).toBeDefined();
		if (first === undefined) return;

		const line = paramLine(wrapper, first.id, 'linear');
		await line.trigger('keydown', { key: 'Enter' });

		expect(doc.selectedNodeId.value).toBe(first.id);
		expect(doc.selectedStepIndex.value).toBe(Number(line.attributes('data-tj-impl-step')));
	});

	it('技能计划里点一个参数行 → 同样选出对应的实现步骤（两种格式共用同一条联动）', async () => {
		// 技能与参数都从目录里挑（见 `skillPlanFixture`），这里不写死名字。
		const plan = loadSkillPlan();
		const wrapper = mount(TaskJsonPanel);

		const line = paramLine(wrapper, plan.nodeId, plan.parameterName);
		await line.trigger('click');

		expect(doc.selectedNodeId.value).toBe(plan.nodeId);
		// 下标是从目录的实现树扫出来的：拿它与独立扫出来的那个数对账
		expect(line.attributes('data-tj-impl-step')).toBe(String(plan.implStepIndex));
		expect(doc.selectedStepIndex.value).toBe(plan.implStepIndex);
		expect(line.attributes('data-selected-step')).toBe('true');
	});

	it('任务级那几行不可点（「第几步」对它们没有意义）', () => {
		const wrapper = mount(TaskJsonPanel);
		const meta = wrapper.findAll('[data-section="meta"]');

		expect(meta.length).toBeGreaterThan(0);
		expect(meta.every((line) => line.attributes('role') === undefined)).toBe(true);
		expect(wrapper.find('[data-tj-node]').exists()).toBe(true);
	});

	it('还没有声明时是空状态，不是半截 JSON', async () => {
		// 真相是模块级单例：换一套全新的模块图才拿得到「还没导入」那一刻
		vi.resetModules();
		const freshPanel = await import('./TaskJsonPanel.vue');
		const freshDoc = await import('../../../state/document');

		expect(freshDoc.useStudioDocument().hasDeclaration.value).toBe(false);
		const wrapper = mount(freshPanel.default);
		expect(wrapper.find('[data-testid="task-json-empty"]').exists()).toBe(true);
		expect(wrapper.findAll('.tj-line')).toHaveLength(0);
	});
});

describe('任务 JSON · 按出生时的格式还原', () => {
	it('技能计划格式下还原出来的是技能计划的原文（schemaVersion / step: "skill"）', () => {
		const plan = loadSkillPlan();
		const wrapper = mount(TaskJsonPanel);
		const text = wrapper.get('[data-testid="task-json-scroll"]').text();

		expect(text).toContain(`"schemaVersion": ${String(SKILL_PLAN_SCHEMA_VERSION)}`);
		expect(text).toContain('"step": "skill"');
		// 技能名来自目录（这条测试没有一处手写的技能名），参数收在 `params` 里
		expect(text).toContain(`"skill": "${plan.capability.capabilityRef}"`);
		expect(text).toContain('"params": {');
		expect(text).toContain(`"${plan.parameterName}"`);

		// 标题必须说清这是哪种格式：同一份声明在两种设备下还原出来的原文完全不一样
		const expected = findTaskFormat('skill_plan');
		expect(wrapper.get('[data-testid="task-json-format"]').text()).toContain(expected.label);
		expect(wrapper.get('[data-testid="task-json-format-note"]').text()).toContain(expected.describe);
	});

	it('切到一期设备后，同一份声明不会被硬套成技能计划（给的是它出生时那种格式）', async () => {
		loadSkillPlan();
		const wrapper = mount(TaskJsonPanel);
		const before = wrapper.get('[data-testid="task-json-scroll"]').text();

		setSelectedDevice('phase1_robot');
		await wrapper.vm.$nextTick();

		// 换设备只改「下一条指令发给谁」，不改写已经产出的声明——原文一个字节都不动
		expect(wrapper.get('[data-testid="task-json-scroll"]').text()).toBe(before);
		expect(wrapper.get('[data-testid="task-json-format"]').text()).toContain(
			findTaskFormat('skill_plan').label,
		);
		expect(wrapper.get('[data-testid="task-json-scroll"]').text()).not.toContain('"schema_version"');
	});

	it('反过来也一样：一期声明在 SO-101 设备下仍是它出生时那份一期原文', async () => {
		const wrapper = mount(TaskJsonPanel);
		const before = wrapper.get('[data-testid="task-json-scroll"]').text();
		expect(before).toContain('"schema_version": "1.0"');

		setSelectedDevice('so101_robot');
		await wrapper.vm.$nextTick();

		const text = wrapper.get('[data-testid="task-json-scroll"]').text();
		expect(text).toBe(before);
		expect(text).toContain('"schema_version": "1.0"');
		expect(text).not.toContain('"step": "skill"');
		expect(wrapper.get('[data-testid="task-json-format"]').text()).toContain(
			findTaskFormat('phase1_task').label,
		);
	});
});

describe('带分支的计划：步数按**顶层步骤**数，不是按动作节点数', () => {
	/** 一份真技能、带一个 if 和一条同层后续的计划——两臂里的步骤嵌在 if 那一格里。 */
	const BRANCH_PLAN = {
		schemaVersion: SKILL_PLAN_SCHEMA_VERSION,
		robot: 'so101_single_arm',
		description: '看一眼；不行就回安全位，行就闭爪；然后往前挪一点',
		plan: [
			{ step: 'skill', skill: 'inspect_scene' },
			{
				step: 'if',
				condition: { field: 'last.success', op: '==', value: false },
				then: [{ step: 'skill', skill: 'recover_safe_pose' }],
				else: [{ step: 'skill', skill: 'close_gripper_skill' }],
			},
			{ step: 'skill', skill: 'move_relative_ee', params: { motion_direction: 'forward', motion_distance: 0.03 } },
		],
	};

	/**
	 * 解析器：这个视图只关心「参数 → 实现里第几步」，所以一律拿 SO-101 那份真目录去查。
	 * 注意别把 `task-json.ts` 自己的 `capabilityOf` 当解析器传进来——它要两个参数（节点 + 解析器）。
	 */
	const resolveCatalog = () => ROBOFRAME_SO101_CATALOG;

	const declarationOf = (): WorkflowDeclaration => {
		setSelectedDevice('so101_robot');
		expect(doc.loadTaskJson(JSON.stringify(BRANCH_PLAN))).toBe(true);
		const declaration = doc.declaration.value;
		if (declaration === null) throw new Error('应当有声明');
		return declaration;
	};

	it('顶层三格就是三步（早先这里数的是动作节点，带分支时会显示成 0 步）', () => {
		const view = renderTaskJson(declarationOf(), resolveCatalog, 'skill_plan');
		expect(view.stepCount).toBe(3);
	});

	it('第 2 格（那个 if）指向的是**分支节点**，不是两臂里的任何一个技能', () => {
		const declaration = declarationOf();
		const view = renderTaskJson(declaration, resolveCatalog, 'skill_plan');
		const branchNode = declaration.nodes.find((candidate) => candidate.type !== TASK_ACTION_NODE_TYPE);
		expect(branchNode).toBeDefined();
		const stepLines = view.lines.filter((line) => line.section === 'step' && line.stepOrdinal === 2);
		expect(stepLines.map((line) => line.nodeId)).toContain(branchNode?.id ?? null);
		expect(stepLines.map((line) => line.nodeId)).not.toContain(null);
	});

	it('第 3 格是同层后续那一步（if 之后的步骤不许丢）', () => {
		const declaration = declarationOf();
		const view = renderTaskJson(declaration, resolveCatalog, 'skill_plan');
		const third = view.lines.filter((line) => line.section === 'step' && line.stepOrdinal === 3);
		const ids = new Set(third.map((line) => line.nodeId));
		const move = declaration.nodes.find((candidate) => candidate.parameters['action'] === 'move_relative_ee');
		expect(ids.has(move?.id ?? null)).toBe(true);
	});
});
