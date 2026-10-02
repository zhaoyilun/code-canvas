// @vitest-environment happy-dom
/**
 * 右栏的接线验收：**上面虚拟设备（占大头，里面是真的 3D）+ 下面「代码 / 任务 JSON」两个 tab**。
 *
 * 四件事：
 * 1. 虚拟设备那块是固定的、占比更大（`flex` 8:3，去掉 tab 条后约七成）——里面装的是
 *    `@codecanvas/robot3d` 的挂载入口（见文件尾那组用例）；里面只列**设备**那一行行真东西
 *    （名字、真机还是仿真、目录、能力与原语数，以及真实上游数据的出处）；
 * 2. 下半块是 tab：代码面板是其中一个（内容一个字没改，仍是声明的编译产物），
 *    另一个是任务 JSON 视图；切到 JSON 时面板里就是它，切换是纯界面状态；
 * 3. 两个 tab 的键位是常规的（点击 + 左右方向键）。
 *
 * 真实高度在浏览器里量（见交付报告）——happy-dom 不跑样式表，这里守结构与接线。
 */
import { mount } from '@vue/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ROBOFRAME_SO101_CATALOG, ROBOFRAME_SO101_PROVENANCE } from '@codecanvas/capabilities';
import { computeWorkflowDigest, type SkillPlanStep, type WorkflowNode } from '@codecanvas/contracts';
import type { BranchArm, PlanStepReport } from '@codecanvas/robot3d';
import { SAMPLE_SKILL_PLAN_JSON } from '../../state/sample-skill-plan';
import { loadSampleTask, useStudioDocument } from '../../state/document';
import { clearRunningPlanPath, runningPlanPath } from '../../shell/device-run';
import { setSelectedDevice } from '../../shell/devices';
import { BRANCH_PLAN_JSON, NESTED_NO_ELSE_PLAN_JSON } from '../flow/__fixtures__/branch-plan';
import RightPanel from './RightPanel.vue';

/**
 * 3D 那一层**必须打桩**：真的 `mountVirtualDevice` 会建 WebGL 上下文，happy-dom 里起不来
 * （就算起得来，单测也不该去跑渲染循环）。这里只钉接线：虚拟设备时挂、真机时不挂、卸载时 dispose。
 * 真正的挂载 / 跑一步 / 卸载契约在 `apps/robot3d/src/mount.test.ts` 里，那边用假舞台跑真执行器。
 */
const mountVirtualDevice = vi.fn((_host: HTMLElement) => ({
	// 形状照真的 `PlanRunOutcome` 给全：状态行要用 completed/total 说话，
	// 少一个字段就会把「跑通了 2 步」写成 undefined。
	run: vi.fn().mockResolvedValue({ ok: true, completed: 1, total: 1 }),
	reset: vi.fn(),
	onStep: vi.fn(() => () => {}),
	onPlanStep: vi.fn(() => () => {}),
	dispose: vi.fn(),
	size: { width: 0, height: 0 },
}));

vi.mock('@codecanvas/robot3d', () => ({
	mountVirtualDevice: (...args: unknown[]) => mountVirtualDevice(...(args as [HTMLElement])),
}));

type FakeDevice = {
	run: ReturnType<typeof vi.fn>;
	reset: ReturnType<typeof vi.fn>;
	onStep: ReturnType<typeof vi.fn>;
	onPlanStep: ReturnType<typeof vi.fn>;
	dispose: ReturnType<typeof vi.fn>;
	size: { width: number; height: number };
};

/**
 * 最近一次挂载拿到的假设备。
 *
 * 为什么不是 `results[0]`：这个测试文件里各用例共用一个模块级设备状态，
 * 前面的用例切换设备时会把还开着的组件也带着重挂一次（它们没 unmount），
 * 于是调用次数不止一次。**最后**一次才是当前这个组件挂上去的那个。
 */
const lastMount = (): FakeDevice => {
	const result = mountVirtualDevice.mock.results.at(-1);
	if (result === undefined) throw new Error('mountVirtualDevice 还没被调用过');
	return result.value as FakeDevice;
};

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
	mountVirtualDevice.mockClear();
	// 示例样例跟当前设备的格式走，所以先把设备切到一期那台，再灌一期那份。
	setSelectedDevice('phase1_robot');
	expect(loadSampleTask()).toBe(true);
});

/**
 * 灌一份**技能计划格式**的声明。
 *
 * 走 `loadTaskJson` 而不是 `applyDeclaration`：只有前者会把 `declarationFormatRef` 记成
 * 导入时那台设备的格式（这里先把设备切成虚拟那台 = `skill_plan`），而那正是右栏还原用的尺子。
 * `applyDeclaration` 是「改内容」的通道，它按出生格式量——拿它灌一份别的格式，会被一期协议那套判据拒掉。
 */
const loadSkillPlanDeclaration = (): boolean => doc.loadTaskJson(SAMPLE_SKILL_PLAN_JSON);

describe('右栏 · 虚拟设备（固定常驻，放大）', () => {
	it('虚拟设备那块在右栏里，带自己的图标与标题', () => {
		const wrapper = panel();
		const device = wrapper.get('[data-testid="virtual-device"]');

		expect(device.find('svg.cc-icon').exists()).toBe(true);
		expect(device.get('.panel-title').text()).toBe('虚拟设备');
	});

	it('它比另一块大：两块都是 flex 定比例，不是按内容定高', () => {
		const wrapper = panel();

		expect(wrapper.get('[data-testid="virtual-device"]').classes()).toContain('device');
		expect(wrapper.get('.inspector').classes()).toContain('inspector');
		// 两块都是 flex 定比例，不是按内容定高（按内容定高就是上一版那个 max-height: 40%）
		expect(wrapper.find('.device').exists()).toBe(true);
		expect(wrapper.get('.inspector').classes()).toContain('inspector');
	});

	it('事实表是真的：入口带上选的那台就是它', () => {
		const wrapper = panel();

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

/**
 * 3D 与执行：右栏上半现在装的是**真的虚拟设备**（`@codecanvas/robot3d` 的挂载入口）。
 * 这里钉接线与判断，画面的真实尺寸在浏览器里量（见交付报告）。
 */
describe('右栏 · 虚拟设备的 3D 与运行按钮', () => {
	it('选虚拟设备 → 有 3D 宿主，也有明确的运行按钮', async () => {
		const wrapper = panel();
		setSelectedDevice('so101_sim');
		await wrapper.vm.$nextTick();

		expect(wrapper.find('[data-testid="virtual-device-stage"]').exists()).toBe(true);
		expect(wrapper.get('[data-testid="virtual-device-run"]').text()).toContain('运行');
		// 挂载入口拿到的是这个组件渲染出来的那个宿主元素（不是随便一个 div）
		expect(mountVirtualDevice).toHaveBeenCalled();
		expect(mountVirtualDevice.mock.calls.at(-1)?.[0]).toBe(
			wrapper.get('[data-testid="virtual-device-stage"]').element,
		);
		wrapper.unmount();
	});

	it('选真机 → 没有 3D 宿主、没有运行按钮，并如实说明为什么', async () => {
		const wrapper = panel();
		setSelectedDevice('so101_robot');
		await wrapper.vm.$nextTick();

		expect(wrapper.find('[data-testid="virtual-device-stage"]').exists()).toBe(false);
		expect(wrapper.find('[data-testid="virtual-device-run"]').exists()).toBe(false);
		expect(wrapper.find('[data-testid="virtual-device-canvas"]').exists()).toBe(false);
		// 什么都不画，但要说明白「3D 只在虚拟设备上有」——不说就是让人对着空白猜
		const absent = wrapper.get('[data-testid="virtual-device-absent"]').text();
		expect(absent).toContain('真机');
		expect(absent).toContain('虚拟设备');
		expect(absent).not.toContain('正在仿真');
		wrapper.unmount();
	});

	it('虚拟 → 真机：老的 3D 被 dispose，不留第二个上下文', async () => {
		const wrapper = panel();
		setSelectedDevice('so101_sim');
		await wrapper.vm.$nextTick();
		const instance = lastMount();

		setSelectedDevice('so101_robot');
		await wrapper.vm.$nextTick();

		expect(instance.dispose).toHaveBeenCalled();
		expect(wrapper.find('[data-testid="virtual-device-stage"]').exists()).toBe(false);
		wrapper.unmount();
	});

	it('组件卸载 → dispose 被调用（不把渲染循环留在后台）', async () => {
		const wrapper = panel();
		setSelectedDevice('so101_sim');
		await wrapper.vm.$nextTick();
		const instance = lastMount();

		wrapper.unmount();

		expect(instance.dispose).toHaveBeenCalledTimes(1);
	});

	it('声明不是技能计划格式 → 给出诊断、解释，并且一步都不跑', async () => {
		// 默认那台是一期设备，灌的是一期任务：出生格式 phase1_task ≠ skill_plan
		const wrapper = panel();
		setSelectedDevice('so101_sim');
		await wrapper.vm.$nextTick();
		const instance = lastMount();

		expect(doc.declarationFormatRef.value).toBe('phase1_task');
		const blocked = wrapper.get('[data-testid="virtual-device-blocked"]').text();
		expect(blocked).toContain('一期任务协议');
		expect(blocked).toContain('技能计划');

		const button = wrapper.get('[data-testid="virtual-device-run"]');
		expect(button.attributes('disabled')).toBeDefined();
		await button.trigger('click');
		expect(instance.run).not.toHaveBeenCalled();
		wrapper.unmount();
	});

	it('没导入任何声明 → 运行按钮禁用，并说明为什么', async () => {
		const wrapper = panel();
		setSelectedDevice('so101_sim');
		await wrapper.vm.$nextTick();
		// 撤掉声明：按钮该禁用且给理由，而不是按下去什么也不发生
		const before = doc.declaration.value;
		doc.declaration.value = null;
		await wrapper.vm.$nextTick();

		expect(wrapper.get('[data-testid="virtual-device-run"]').attributes('disabled')).toBeDefined();
		expect(wrapper.get('[data-testid="virtual-device-blocked"]').text()).toContain('还没有导入');

		wrapper.unmount();
		if (before !== null) doc.applyDeclaration(before);
	});

	it('出生格式是技能计划时：按钮可用，按下就是把还原出来的计划交给设备', async () => {
		const wrapper = panel();
		setSelectedDevice('so101_sim');
		await wrapper.vm.$nextTick();
		expect(loadSkillPlanDeclaration()).toBe(true);
		await wrapper.vm.$nextTick();

		const instance = lastMount();
		// 挂载时就订了「每一步」——面板上那几行「第 N 步 · …」靠它
		// （计划步那种一步：分支步没有原语事件，只有它说得清走了哪条臂）
		expect(instance.onPlanStep).toHaveBeenCalled();

		const button = wrapper.get('[data-testid="virtual-device-run"]');
		expect(button.attributes('disabled')).toBeUndefined();
		await button.trigger('click');
		await wrapper.vm.$nextTick();

		expect(instance.run).toHaveBeenCalledTimes(1);
		const plan = instance.run.mock.calls[0]?.[0] as { robot: string; plan: unknown[] };
		expect(plan.robot).toBe('so101_single_arm');
		expect(plan.plan).toHaveLength(3);
		wrapper.unmount();
	});
});

/**
 * 步骤行：面板说的是**计划步**（技能步与分支步各一行）。
 *
 * 事件的来路是挂载时订的那个 `onPlanStep`（真身见 `apps/robot3d/src/mount.ts`：
 * `runPlan` 的每一步照原样推出来，`running` 也推）。这里直接喂事件，
 * 钉的是面板怎么把那几条事件画成行——分支说清走了哪条臂、臂里的步带路径与层级。
 */
describe('右栏 · 步骤行（分支走哪条臂、臂里的步在第几层）', () => {
	/** 一步计划步事件。默认是终态，需要时改 `state`（`running` 与 `done` 写的是同一行）。 */
	const stepEvent = (
		path: string,
		index: number,
		arm: BranchArm,
		step: SkillPlanStep,
		state: 'running' | 'done' | 'failed' = 'done',
	): PlanStepReport => ({ kind: 'plan-step', path, index, total: 3, arm, step, taskId: `t-${path}`, state });

	const IF_STEP: SkillPlanStep = {
		step: 'if',
		condition: { field: 'last.success', op: '==', value: true },
		then: [{ step: 'skill', skill: 'wave_hello' }],
	};

	/** 面板挂载时订的那个监听器——面板上的步骤行就是它写出来的。 */
	const pushPlanStep = (instance: FakeDevice, event: PlanStepReport): void => {
		const listener = instance.onPlanStep.mock.calls.at(-1)?.[0] as ((e: PlanStepReport) => void) | undefined;
		if (listener === undefined) throw new Error('面板没有订 onPlanStep');
		listener(event);
	};

	/** 面板上的步骤行（空白压成一个空格：模板里的换行与缩进不该进断言）。 */
	const rows = (wrapper: ReturnType<typeof panel>): string[] =>
		wrapper
			.findAll('[data-testid="virtual-device-steps"] li')
			.map((item) => item.text().replace(/\s+/g, ' ').trim());

	const mountedPanel = async (): Promise<{ wrapper: ReturnType<typeof panel>; instance: FakeDevice }> => {
		const wrapper = panel();
		setSelectedDevice('so101_sim');
		await wrapper.vm.$nextTick();
		const instance = lastMount();
		// 挂上来的那一刻还没有任何步骤行（行是事件写出来的）
		expect(wrapper.find('[data-testid="virtual-device-steps"]').exists()).toBe(false);
		return { wrapper, instance };
	};

	const stepPathRows = (wrapper: ReturnType<typeof panel>) =>
		wrapper.findAll('[data-testid="virtual-device-steps"] li');

	it('分支步那一行说清走了哪条臂（then / else / 没有否则各一种说法）', async () => {
		const { wrapper, instance } = await mountedPanel();

		pushPlanStep(instance, stepEvent('0', 1, 'then', IF_STEP));
		pushPlanStep(instance, stepEvent('1', 2, 'else', IF_STEP));
		// 条件不成立又没有 else：`arm` 是 null，面板要把「什么也不做」这句话说出来，不留白
		pushPlanStep(instance, stepEvent('2', 3, null, IF_STEP));
		await wrapper.vm.$nextTick();

		expect(rows(wrapper)).toEqual([
			'第 1 步 · 分支 · 走 then · done',
			'第 2 步 · 分支 · 走 else · done',
			'第 3 步 · 分支 · 条件不成立，没有否则 · done',
		]);
		wrapper.unmount();
	});

	it('臂里的步显示层级：缩进按路径的层数、行首带路径，且 running → done 改的是同一行', async () => {
		const { wrapper, instance } = await mountedPanel();

		// 顶层分支（第 1 层），臂里一步（第 2 层），再嵌一层臂里的一步（第 3 层）
		pushPlanStep(instance, stepEvent('1', 2, 'then', IF_STEP, 'running'));
		pushPlanStep(instance, stepEvent('1.then.0', 2, null, { step: 'skill', skill: 'wave_hello' }, 'running'));
		pushPlanStep(instance, stepEvent('1.then.0', 2, null, { step: 'skill', skill: 'wave_hello' }, 'done'));
		pushPlanStep(instance, stepEvent('1.then.0.else.1', 2, null, { step: 'skill', skill: 'inspect_scene' }));
		await wrapper.vm.$nextTick();

		// 同一格的两条事件（running / done）写的是同一行——不是重复两行
		expect(rows(wrapper)).toEqual([
			'第 2 步 · 分支 · 走 then · running',
			'1.then.0 第 2 步 · wave_hello · done',
			'1.then.0.else.1 第 2 步 · inspect_scene · done',
		]);

		const items = stepPathRows(wrapper);
		// 层级：缩进靠这个数算（CSS 里 `calc(var(--step-depth) * var(--cc-space-3))`），深度本身也能读
		expect(items.map((item) => item.attributes('data-depth'))).toEqual(['0', '1', '2']);
		// 缩进真的挂在这一行上（CSS 里 `calc(var(--step-depth) * var(--cc-space-3))`），不只是个属性
		expect(items.map((item) => (item.element as HTMLElement).style.getPropertyValue('--step-depth'))).toEqual([
			'0',
			'1',
			'2',
		]);
		// 路径进 `data-path`：面板上的行与代码/积木两侧说的是同一格
		expect(items.map((item) => item.attributes('data-path'))).toEqual(['1', '1.then.0', '1.then.0.else.1']);
		expect(items.map((item) => item.attributes('data-state'))).toEqual(['running', 'done', 'done']);
		wrapper.unmount();
	});
});

describe('右栏 · 运行按钮的校验闸', () => {
	it('格式对但计划过不了校验：诊断原样显示，一步都不跑', async () => {
		const wrapper = panel();
		setSelectedDevice('so101_sim');
		await wrapper.vm.$nextTick();
		const instance = lastMount();
		// 出生格式记成技能计划，但这份声明里一个动作节点都没有
		// → 还原出来的计划是 `plan: []`，`validateSkillPlan` 会拒（计划至少要有一个步骤）
		expect(doc.loadTaskJson(SAMPLE_SKILL_PLAN_JSON)).toBe(true);

		const base = doc.declaration.value;
		expect(base).not.toBeNull();
		if (base === null) return;
		doc.declaration.value = { ...base, nodes: [] };
		await wrapper.vm.$nextTick();

		const button = wrapper.get('[data-testid="virtual-device-run"]');
		expect(button.attributes('disabled')).toBeUndefined();
		await button.trigger('click');
		await wrapper.vm.$nextTick();

		expect(instance.run).not.toHaveBeenCalled();
		const diags = wrapper.get('[data-testid="virtual-device-diagnostics"]').text();
		expect(diags).toContain('plan.');
		expect(wrapper.get('[data-testid="virtual-device-status"]').text()).toContain('一步没跑');

		wrapper.unmount();
	});
});

describe('跑完之后那句话不许撒谎', () => {
	/**
	 * 装一块面板 + 切到虚拟设备 + 按下运行，返回挂载出来的那台假设备。
	 * 这三步每一条用例都要走，抄一遍就会有四种写法。
	 */
	const runOnVirtualDevice = async (): Promise<{ instance: FakeDevice; status: string }> => {
		const wrapper = panel();
		setSelectedDevice('so101_sim');
		await wrapper.vm.$nextTick();
		const instance = lastMount();
		expect(doc.loadTaskJson(SAMPLE_SKILL_PLAN_JSON)).toBe(true);
		await wrapper.vm.$nextTick();
		await wrapper.get('[data-testid="virtual-device-run"]').trigger('click');
		await wrapper.vm.$nextTick();
		const status = wrapper.get('[data-testid="virtual-device-status"]').text();
		return { instance, status };
	};

	it('全部走通 → 「N 步都走通了」（N 是走通的步数）', async () => {
		const { instance, status } = await runOnVirtualDevice();
		expect(instance.run).toHaveBeenCalled();
		expect(status).toContain('计划完成');
		expect(status).toContain('都走通了');
	});

	it('有一步失败但被 onFailure 容忍 → 说清有几步失败，不许说「都走通了」', async () => {
		// `ok: true` 但过程中有一步行是 failed：计划跑完了，其中一步失败了。
		// 早先这里写的是「N 步都走通了」（N 取的是计划长度）——那是句假话，
		// 屏幕上那行红色 failed 会直接跟它打架。
		const wrapper = panel();
		setSelectedDevice('so101_sim');
		await wrapper.vm.$nextTick();
		const instance = lastMount();
		const emit = instance.onPlanStep.mock.calls[0]?.[0] as ((event: unknown) => void) | undefined;
		expect(emit).toBeTypeOf('function');

		// 真执行器是在跑的过程中推事件的，跑完 `run()` 才 resolve——
		// 所以这里也让失败那一行在 resolve **之前**推出去。
		instance.run.mockImplementation(async () => {
			emit?.({
				kind: 'plan-step',
				path: '0',
				index: 1,
				total: 3,
				state: 'failed',
				arm: null,
				taskId: 't1',
				step: { step: 'skill', skill: 'x' },
			});
			return { ok: true, steps: [] };
		});

		expect(doc.loadTaskJson(SAMPLE_SKILL_PLAN_JSON)).toBe(true);
		await wrapper.vm.$nextTick();
		await wrapper.get('[data-testid="virtual-device-run"]').trigger('click');
		await wrapper.vm.$nextTick();

		const status = wrapper.get('[data-testid="virtual-device-status"]').text();
		expect(status).toContain('失败');
		expect(status).not.toContain('都走通了');
	});
});
/**
 * 跟随与步骤行：**跑到哪一步就选中那一步**，积木与代码面板因此跟着走。
 *
 * 事件用 `running` 触发（每一步都先报 running 再报 done/failed）——等 done 才动就成了跳着走。
 * 关掉跟随之后**只是没人替用户改选中**：步骤行照旧写、画布上的运行标记照旧跟着设备走，
 * 用户手点（流程画布、积木、步骤行）一个字都不受影响。这一组钉的就是这条分工。
 */
describe('右栏 · 跟随运行与可点的步骤行', () => {
	const stepEvent = (
		path: string,
		index: number,
		arm: BranchArm,
		step: SkillPlanStep,
		state: 'running' | 'done' | 'failed' = 'running',
	): PlanStepReport => ({ kind: 'plan-step', path, index, total: 3, arm, step, taskId: `t-${path}`, state });

	const IF_STEP: SkillPlanStep = {
		step: 'if',
		condition: { field: 'last.success', op: '==', value: false },
		then: [{ step: 'skill', skill: 'close_gripper_skill' }],
	};
	const SKILL_STEP: SkillPlanStep = { step: 'skill', skill: 'close_gripper_skill' };

	const pushPlanStep = (instance: FakeDevice, event: PlanStepReport): void => {
		const listener = instance.onPlanStep.mock.calls.at(-1)?.[0] as ((e: PlanStepReport) => void) | undefined;
		if (listener === undefined) throw new Error('面板没有订 onPlanStep');
		listener(event);
	};

	/** 挂上面板、切到虚拟设备、灌一份带分支的计划（跟随要认得出路径 → 节点）。 */
	const panelWithPlan = async (json: string): Promise<{ wrapper: ReturnType<typeof panel>; instance: FakeDevice }> => {
		const wrapper = panel();
		setSelectedDevice('so101_sim');
		await wrapper.vm.$nextTick();
		const instance = lastMount();
		expect(doc.loadTaskJson(json)).toBe(true);
		await wrapper.vm.$nextTick();
		return { wrapper, instance };
	};

	/** 声明里那一步（按名字找：断言读起来是「哪一步」而不是一串 id）。 */
	const nodeNamed = (name: string): string => {
		const node = doc.declaration.value?.nodes.find((candidate) => candidate.name === name);
		if (node === undefined) throw new Error(`声明里没有「${name}」这一步`);
		return node.id;
	};

	beforeEach(() => {
		clearRunningPlanPath();
	});

	afterEach(() => {
		// 这个 ref 是模块级单例，跨用例活着：不清掉，下一个用例开局就带着上一个的运行标记。
		clearRunningPlanPath();
	});

	it('收到 running 事件 → 选中那一步的节点（臂里的步也认得出来）', async () => {
		const { instance } = await panelWithPlan(BRANCH_PLAN_JSON);

		pushPlanStep(instance, stepEvent('1', 2, 'then', IF_STEP, 'running'));
		expect(doc.selectedNodeId.value).toBe(nodeNamed('2. 分支'));

		pushPlanStep(instance, stepEvent('1.then.0', 2, null, SKILL_STEP, 'running'));
		expect(doc.selectedNodeId.value).toBe(nodeNamed('3. 关闭夹爪'));
		// 画布上的运行标记读的就是这个值（右栏是唯一的写入者）
		expect(runningPlanPath.value).toBe('1.then.0');

		// done 不改选中：最后停在哪一步就停在哪一步
		pushPlanStep(instance, stepEvent('1.then.0', 2, null, SKILL_STEP, 'done'));
		expect(doc.selectedNodeId.value).toBe(nodeNamed('3. 关闭夹爪'));
	});

	it('跟随默认开着，可以关掉；关掉之后事件不改选中，手点步骤行仍然改', async () => {
		const { wrapper, instance } = await panelWithPlan(BRANCH_PLAN_JSON);
		const follow = wrapper.get('[data-testid="virtual-device-follow"]');
		expect((follow.element as HTMLInputElement).checked).toBe(true);

		await follow.setValue(false);
		const before = nodeNamed('1. 观察桌面');
		doc.select(before);

		pushPlanStep(instance, stepEvent('1.then.0', 2, null, SKILL_STEP, 'running'));
		await wrapper.vm.$nextTick();

		// 没人替用户改选中了……
		expect(doc.selectedNodeId.value).toBe(before);
		// ……但设备在哪儿照旧看得出来（运行标记与跟随无关）
		expect(runningPlanPath.value).toBe('1.then.0');

		// 手点照常：点那一行 → 选中那一步的节点
		await wrapper.get('[data-testid="virtual-device-steps"] li[data-path="1.then.0"]').trigger('click');
		expect(doc.selectedNodeId.value).toBe(nodeNamed('3. 关闭夹爪'));
	});

	it('点步骤行 → 选中那一行对应的节点（嵌套路径那一行也一样）', async () => {
		const { wrapper, instance } = await panelWithPlan(NESTED_NO_ELSE_PLAN_JSON);
		pushPlanStep(instance, stepEvent('1.then.1.else.0', 2, 'else', SKILL_STEP, 'done'));
		await wrapper.vm.$nextTick();

		await wrapper.get('[data-testid="virtual-device-steps"] li[data-path="1.then.1.else.0"]').trigger('click');

		// 嵌套路径说的是 then 臂里那个分支的 else 臂第一步，不是声明里第 5 个节点、也不是顶层任何一步
		expect(doc.selectedNodeId.value).toBe(nodeNamed('6. 摇头'));
	});

	it('跑完之后运行标记灭，但选中留在最后一步（不复位）', async () => {
		const { wrapper, instance } = await panelWithPlan(BRANCH_PLAN_JSON);
		pushPlanStep(instance, stepEvent('1.then.0', 2, null, SKILL_STEP, 'running'));
		expect(runningPlanPath.value).toBe('1.then.0');

		await wrapper.get('[data-testid="virtual-device-run"]').trigger('click');
		await wrapper.vm.$nextTick();

		expect(instance.run).toHaveBeenCalled();
		// 没有「正在跑的那一步」了，画布上的运行标记该灭
		expect(runningPlanPath.value).toBeNull();
		// 选中一动不动：用户跟到最后一步，正是为了看它
		expect(doc.selectedNodeId.value).toBe(nodeNamed('3. 关闭夹爪'));
	});
});
