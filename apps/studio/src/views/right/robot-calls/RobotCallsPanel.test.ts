// @vitest-environment happy-dom
/**
 * 「发给机器人」视图的验收：**这一句话编出来会变成哪些请求，以及哪一步送不出去**。
 *
 * 三组断言，对着这件东西的三半：
 *
 * 1. **数据**（`robot-calls.ts`，纯函数）：三种 call 各渲染成什么行；原语那一步的诊断出现在
 *    **它本来的顺序位置上**（不是被悄悄省掉的一行）；摘要那三个数对得上；一期声明返回
 *    「编译不了」而不是硬套一份计划。用一份**合成的目录**来测，不依赖 SO-101 目录的具体内容
 *    （那边会增删技能，判据的口径不该跟着抖）。
 * 2. **接线**（组件）：切到第三个 tab 能显示；没有声明时的空状态；一期设备下的如实说明。
 * 3. **不编造**：编不出来的东西一次都不许出现在屏幕上——没有目录的技能、送不出去的原语，
 *    屏幕上都不该有一条请求。
 *
 * 一条纪律：技能名、原语名、参数名与那个 `task_id` **一个都不手写**——全部从合成目录与
 * 编译结果里现取。写死一个 id 就等于把「编译期生成的」这件事偷偷改成「界面自己拼的」。
 */
import { mount } from '@vue/test-utils';
import type { VueWrapper } from '@vue/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ROBOFRAME_SO101_CATALOG } from '@codecanvas/capabilities';
import {
	SKILL_PLAN_SCHEMA_VERSION,
	createDeterministicIdFactory,
	type CapabilityCatalog,
	type SkillPlan,
	type WorkflowDeclaration,
} from '@codecanvas/contracts';
import {
	BRIDGE_PLAN_DIAGNOSTIC_CODES,
	DEFAULT_POLL_SPEC,
	STEP_ROUTING,
	compilePlanToCalls,
} from '@codecanvas/robot-bridge';
import { importSkillPlan } from '@codecanvas/task-import';
import { loadSampleTask, useStudioDocument } from '../../../state/document';
import { setSelectedDevice } from '../../../shell/devices';
import RightPanel from '../RightPanel.vue';
import RobotCallsPanel from './RobotCallsPanel.vue';
import {
	ROUTING_FACE,
	buildPlanFromDeclaration,
	compileDeclarationToCalls,
	robotCallsView,
	type RobotCallRow,
} from './robot-calls';

/**
 * 挂整块 `RightPanel` 时上半那块 3D **必须打桩**：真的 `mountVirtualDevice` 会建 WebGL 上下文，
 * happy-dom 里起不来（见 `RightPanel.test.ts` 同一处）。这一条用例要的是「第三个 tab 切得过去」，
 * 不是 3D 能不能画——3D 的契约在 `apps/robot3d/src/mount.test.ts` 里。
 */
vi.mock('@codecanvas/robot3d', () => ({
	mountVirtualDevice: () => ({
		run: vi.fn().mockResolvedValue({ ok: true, completed: 1, total: 1 }),
		reset: vi.fn(),
		onStep: vi.fn(() => () => {}),
		onPlanStep: vi.fn(() => () => {}),
		dispose: vi.fn(),
		size: { width: 0, height: 0 },
	}),
}));

const doc = useStudioDocument();

// ---------------------------------------------------------------------------
// 合成目录 + 一份四类步都有的计划：用具里的名字全部现取，不写死
// ---------------------------------------------------------------------------

const DEMO_PRIMITIVE = 'demo_primitive';
const DEMO_SKILL = 'demo_skill';
const DEMO_PARAM = 'demo_param';
const DEMO_ROBOT = 'demo_robot';
/** 目录里**没有**的技能名：用来测「编译器不发它，只出诊断」。 */
const UNKNOWN_SKILL = 'not_in_the_catalog';

/** 一份能自洽的目录：一个原语 + 一个技能（技能的实现里用了那个参数）。 */
const DEMO_CATALOG: CapabilityCatalog = {
	catalogRef: 'demo_catalog',
	displayName: '演示设备',
	robotName: DEMO_ROBOT,
	revisionRef: 'demo-v1',
	primitives: [
		{
			primitiveRef: DEMO_PRIMITIVE,
			label: '演示原语',
			parameters: [{ name: DEMO_PARAM, label: '演示参数', type: 'number' }],
		},
	],
	capabilities: [
		{
			capabilityRef: DEMO_SKILL,
			label: '演示技能',
			kind: 'skill',
			parameters: [{ name: DEMO_PARAM, label: '演示参数', type: 'number' }],
			implementation: [{ kind: 'call', primitiveRef: DEMO_PRIMITIVE, arguments: {} }],
		},
	],
};

/**
 * 四类步各一步，且顺序**刻意**让每一种「不发请求」都排在两条请求中间：
 * `skill → if(then: skill, else: primitive) → wait → skill`。
 *
 * 于是「少一行」这件事藏不住：原语那一步丢掉的话，`else` 臂里就只剩一条 `then` 的请求，
 * 而它在行号上也看得出来（第二步与第三步之间空了一格）。
 */
const buildPlan = (): SkillPlan => ({
	schemaVersion: SKILL_PLAN_SCHEMA_VERSION,
	robot: DEMO_ROBOT,
	description: '演示：四类步都走一遍',
	plan: [
		{ step: 'skill', skill: DEMO_SKILL, params: { [DEMO_PARAM]: 1 }, timeoutSec: 7 },
		{
			step: 'if',
			condition: { field: 'last.success', op: '==', value: false },
			then: [{ step: 'skill', skill: DEMO_SKILL }],
			else: [{ step: 'primitive', primitive: DEMO_PRIMITIVE }],
		},
		{ step: 'wait', seconds: 3 },
		{ step: 'skill', skill: DEMO_SKILL },
	],
});

/**
 * 计划 → 声明。走**导入那条真通道**（`buildDeclarationFromPlan`），不是手拼节点：
 * 手拼要自己摆三格出边，而「臂接在哪一格」正是这一屏顺序的来源——测自己拼的东西没有意义。
 * id 用确定性工厂，于是同一份计划两次导入的声明逐字相同。
 */
const declarationOf = (plan: SkillPlan): WorkflowDeclaration => {
	const result = importSkillPlan(plan, { catalog: DEMO_CATALOG, idFactory: createDeterministicIdFactory() });
	if (!result.ok) throw new Error('合成计划应当导得进来');
	return result.declaration;
};

const compileDemo = (plan: SkillPlan = buildPlan()) =>
	compileDeclarationToCalls({
		declaration: declarationOf(plan),
		formatRef: 'skill_plan',
		catalog: DEMO_CATALOG,
		deviceRef: 'demo_device',
	});

/** 编译成功，拿视图。失败就是这条用例的前提不成立，直接抛。 */
const viewOf = (plan: SkillPlan = buildPlan()) => {
	const result = compileDemo(plan);
	if (!result.ok) throw new Error(`这份计划应当编得出来，却给了 ${result.reason}`);
	return result.view;
};

/** 行 → 一行可读的字，断言读起来像「屏幕上那一行」。 */
const labelOf = (row: RobotCallRow): string => `${row.stepPath} ${row.kind} ${ROUTING_FACE[row.routing.where]}`;

const rowsOfKind = (rows: readonly RobotCallRow[], kind: RobotCallRow['kind']): readonly RobotCallRow[] =>
	rows.filter((row) => row.kind === kind);

// ---------------------------------------------------------------------------
// 数据一侧：纯函数
// ---------------------------------------------------------------------------

describe('发给机器人 · 三种 call 各渲染成什么行（纯函数）', () => {
	it('一串计划步 → 一行一步，顺序就是计划里的顺序，路径与顶层序号都对得上', () => {
		const view = viewOf();

		expect(view.rows.map(labelOf)).toEqual([
			'0 execute 发给 bridge',
			'1 branch 本地',
			'1.then.0 execute 发给 bridge',
			'1.else.0 blocked 送不出去',
			'2 wait 本地',
			'3 execute 发给 bridge',
		]);
		// 行号连续、从 1 起（它就是屏幕上第几行）
		expect(view.rows.map((row) => row.line)).toEqual([1, 2, 3, 4, 5, 6]);
		/*
		 * 「节点 N」是这一步在**声明里的次序**（`planStructureOf` 给的那一个数），
		 * 于是臂里的步各有各的号——它不折成顶层那一步的号（那是流程卡上「第 N 步」的用法，
		 * 在这一屏里会让臂里三行都写「第 2 步」）。号与路径一起看：路径说层级，号说次序。
		 */
		expect(view.rows.map((row) => row.nodeOrdinal)).toEqual([1, 2, 3, 4, 5, 6]);
	});

	it('execute 行：方法 + 路径 + 请求体四栏（timeout_sec 只在计划写了的时候出现）', () => {
		const view = viewOf();
		const first = view.rows[0];
		expect(first?.kind).toBe('execute');
		if (first?.kind !== 'execute') return;

		expect(first.method).toBe('POST');
		expect(first.path).toBe('/v1/skills/execute');
		// 字段名逐字照 bridge 的 `ExecuteRequest`（python 那边是 timeout_sec）
		expect(first.body.map((field) => field.field)).toEqual(['task_id', 'skill', 'params', 'timeout_sec']);
		// 取值全部来自编译结果，不在这里拼
		const body = Object.fromEntries(first.body.map((field) => [field.field, field.value]));
		expect(body['skill']).toBe(JSON.stringify(DEMO_SKILL));
		expect(body['params']).toBe(JSON.stringify({ [DEMO_PARAM]: 1 }));
		expect(body['timeout_sec']).toBe('7');
		// task_id 是编译期生成的（带计划摘要与这一步的路径），所以只断言「它非空且是字符串」
		expect(typeof body['task_id']).toBe('string');
		expect(body['task_id']).not.toBe('');

		// 计划没写 timeoutSec 的那一步**不显示这一栏**：0 秒的超时不是一个超时
		const third = view.rows[2];
		expect(third?.kind).toBe('execute');
		if (third?.kind !== 'execute') return;
		expect(third.body.map((field) => field.field)).toEqual(['task_id', 'skill', 'params']);
	});

	it('execute 后面紧跟轮询那一行，间隔与余量来自编译期的轮询口径', () => {
		const view = viewOf();
		const first = view.rows[0];
		expect(first?.kind).toBe('execute');
		if (first?.kind !== 'execute') return;

		expect(first.poll.path).toBe(`/v1/tasks/${encodeURIComponent(first.body[0]?.value.replace(/"/g, '') ?? '')}`);
		expect(first.poll.intervalMs).toBe(DEFAULT_POLL_SPEC.intervalMs);
		expect(first.poll.marginSec).toBe(DEFAULT_POLL_SPEC.marginSec);
		// 截止 = 计划里的 timeoutSec + 余量（15 是第 4 步那个没写超时的：缺省 30 + 30）
		expect(first.poll.deadlineSec).toBe(7 + DEFAULT_POLL_SPEC.marginSec);
		const last = view.rows[5];
		expect(last?.kind).toBe('execute');
		if (last?.kind !== 'execute') return;
		expect(last.poll.deadlineSec).toBe(DEFAULT_POLL_SPEC.defaultTimeoutSec + DEFAULT_POLL_SPEC.marginSec);
	});

	it('wait 与 branch 是本地步：没有请求、没有路径，形状上就不带那两栏', () => {
		const view = viewOf();
		const wait = view.rows.find((row) => row.kind === 'wait');
		const branch = view.rows.find((row) => row.kind === 'branch');

		expect(wait).toEqual(expect.objectContaining({ kind: 'wait', seconds: 3 }));
		expect(branch).toEqual(expect.objectContaining({ kind: 'branch', conditionText: '上一步成功 == 假' }));
		// 它们连 `method` / `path` 这两个字段都没有——不是「有但是空」
		for (const row of [wait, branch]) {
			expect(row !== undefined && 'method' in row).toBe(false);
			expect(row !== undefined && 'path' in row).toBe(false);
		}
	});

	it('去向那一栏读的就是 STEP_ROUTING：三类步各自的 note 与 where 一字不改', () => {
		const view = viewOf();
		const byStep = new Map(STEP_ROUTING.map((entry) => [entry.step, entry]));

		// 技能步 → bridge；分支/等待 → client；原语 → nowhere。判据全在编译包那份清单里
		expect(view.rows[0]?.routing).toEqual(byStep.get('skill'));
		expect(view.rows[1]?.routing).toEqual(byStep.get('if'));
		expect(view.rows[4]?.routing).toEqual(byStep.get('wait'));
		expect(view.rows[3]?.routing).toEqual(byStep.get('primitive'));
	});
});

describe('发给机器人 · 送不出去的那一步在它本来的位置上', () => {
	it('原语步：诊断扮成一行，夹在 `then` 臂与 `wait` 之间——不是被省掉', () => {
		const view = viewOf();
		const blocked = rowsOfKind(view.rows, 'blocked');

		expect(blocked).toHaveLength(1);
		const row = blocked[0];
		expect(row).toBeDefined();
		if (row?.kind !== 'blocked') return;

		// 位置：`if` 那一步的 else 臂第一步（两条臂都编出来了，走哪条等运行时才知道）
		expect(row.stepPath).toBe('1.else.0');
		expect(row.line).toBe(4);
		// 码与文案**原样**来自 bridge 的诊断，界面不改写一个字
		const diagnostic = view.diagnostics.find((item) => item.code === row.code);
		expect(row.code).toBe(BRIDGE_PLAN_DIAGNOSTIC_CODES.primitiveUnsupported);
		expect(row.message).toBe(diagnostic?.message);
		expect(row.message).toContain(DEMO_PRIMITIVE);
		// 它前后那两行确实在（位置真的是「中间」，不是被挪到末尾去了）
		expect(view.rows[2]?.kind).toBe('execute');
		expect(view.rows[4]?.kind).toBe('wait');
	});

	it('目录里没有的技能：编译器不发它，只在它那个位置留一条诊断', () => {
		/*
		 * 技能名不在目录里时，**契约那道闸就该拦住它**（`buildPlanFromDeclaration` 会报 `plan_invalid`），
		 * 所以这条路正常走不到编译器（下面那条用例钉的就是这个）。这里要测的是编译器的另一半：
		 * 万一有一份计划绕过了那道闸，编译期仍旧**不编请求、只出诊断**——诊断的判据在编译包里，
		 * 不在界面上。所以这条直接拿**计划**去编，不从声明反推。
		 */
		const plan = buildPlan();
		const tampered: SkillPlan = {
			...plan,
			plan: [{ step: 'skill', skill: UNKNOWN_SKILL }, ...plan.plan.slice(1)],
		};
		const compiled = compilePlanToCalls(tampered, { catalog: DEMO_CATALOG, deviceRef: 'demo_device' });
		const view = robotCallsView({ declaration: declarationOf(plan), compiled });

		const first = view.rows[0];
		expect(first?.kind).toBe('blocked');
		if (first?.kind !== 'blocked') return;
		// 位置：还是第 0 个位置（不是被挪到末尾，也不是被省掉）
		expect(first.stepPath).toBe('0');
		expect(first.code).toBe(BRIDGE_PLAN_DIAGNOSTIC_CODES.skillUnknown);
		expect(first.message).toContain(UNKNOWN_SKILL);
		// 它**没有**编出一条请求来（不发出去换 404），别的请求照编
		expect(view.calls.some((call) => call.kind === 'execute' && call.request.skill === UNKNOWN_SKILL)).toBe(false);
		expect(view.summary.requests).toBeGreaterThan(0);
		// 送不出去的两步：这条改坏了的技能，加上原计划里那个原语（它本来就送不出去）
		expect(view.summary.blocked).toBe(2);
		expect(view.rows.filter((row) => row.kind === 'blocked').map((row) => row.code)).toEqual([
			BRIDGE_PLAN_DIAGNOSTIC_CODES.skillUnknown,
			BRIDGE_PLAN_DIAGNOSTIC_CODES.primitiveUnsupported,
		]);
	});

	it('送不出去的步数就是诊断条数：一条诊断一行，一条都不丢', () => {
		const plan = buildPlan();
		const view = viewOf({
			...plan,
			plan: [{ step: 'primitive', primitive: DEMO_PRIMITIVE }, ...plan.plan],
		});

		expect(view.summary.blocked).toBe(view.diagnostics.length);
		expect(rowsOfKind(view.rows, 'blocked')).toHaveLength(view.diagnostics.length);
		expect(view.floatingDiagnostics).toEqual([]);
	});
});

describe('发给机器人 · 摘要那三个数', () => {
	it('从实际编译结果数出来：请求 / 本地 / 送不出去', () => {
		const view = viewOf();

		expect(view.summary).toEqual({
			requests: view.calls.filter((call) => call.kind === 'execute').length,
			local: 2,
			blocked: 1,
		});
		// 与屏幕上那几行对账：请求 = execute 行数，本地 = wait + branch 行数
		expect(view.summary.requests).toBe(rowsOfKind(view.rows, 'execute').length);
		expect(view.summary.local).toBe(rowsOfKind(view.rows, 'wait').length + rowsOfKind(view.rows, 'branch').length);
		expect(view.summary.blocked).toBe(rowsOfKind(view.rows, 'blocked').length);
	});

	it('一条请求都发不出去时，说清为什么（那就是这类计划的样子）', () => {
		const plan = buildPlan();
		const view = viewOf({
			...plan,
			plan: [
				{ step: 'primitive', primitive: DEMO_PRIMITIVE },
				{ step: 'wait', seconds: 1 },
			],
		});

		expect(view.summary.requests).toBe(0);
		expect(view.emptyReason).toContain('一条请求都发不出去');
		expect(view.emptyReason).toContain(String(view.summary.blocked));
	});

	it('有请求可发时没有那句「为什么」——它没有对象', () => {
		expect(viewOf().emptyReason).toBeNull();
	});
});

describe('发给机器人 · 编不出来的时候如实说', () => {
	it('一期声明：返回「编译不了」，不硬套一份技能计划出来', () => {
		// 一期那份声明不是这台设备产出的，`fromDeclaration` 拿它当技能计划读只会读出空计划
		const declaration = declarationOf(buildPlan());
		const result = compileDeclarationToCalls({
			declaration,
			formatRef: 'phase1_task',
			catalog: DEMO_CATALOG,
			deviceRef: 'demo_device',
		});

		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.reason).toBe('format_mismatch');
		// 一条诊断都不编：这不是「计划有问题」，是「这份声明不是这种东西」
		expect(result.diagnostics).toEqual([]);
	});

	it('格式对但计划过不了校验：诊断原样带出来，一条请求都不编', () => {
		/*
		 * 造一份「还原出来是空计划」的声明：节点还在，但两件事都拆了——
		 * 连线的出边清空、指名那一栏清空。于是还原出来的计划里，步骤名是空的，`validateSkillPlan` 会拒
		 * （技能名不在目录里）。这正是面板要如实说「没有请求可编」的那一档，而不是摆一个空列表。
		 */
		const declaration = declarationOf(buildPlan());
		const broken: WorkflowDeclaration = {
			...declaration,
			nodes: declaration.nodes.map((node) => ({ ...node, parameters: {} })),
			connections: {},
		};

		const result = compileDeclarationToCalls({
			declaration: broken,
			formatRef: 'skill_plan',
			catalog: DEMO_CATALOG,
			deviceRef: 'demo_device',
		});

		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.reason).toBe('plan_invalid');
		expect(result.diagnostics.length).toBeGreaterThan(0);
	});

	it('技能名不在目录里：`buildPlanFromDeclaration` 管「还原」，送不送得出去归编译管', () => {
		// 一份绕过契约那道闸的声明（技能不在目录里）：**还原这一步就该拒**，
		// 而不是把一份「一条请求都发不出去」的东西送到界面上当正常结果显示
		const declaration = declarationOf(buildPlan());
		const tampered: WorkflowDeclaration = {
			...declaration,
			nodes: declaration.nodes.map((node) =>
				node.parameters['action'] === DEMO_SKILL
					? { ...node, parameters: { ...node.parameters, action: UNKNOWN_SKILL } }
					: node,
			),
		};

		const built = buildPlanFromDeclaration({
			declaration: tampered,
			formatRef: 'skill_plan',
			catalog: DEMO_CATALOG,
			deviceRef: 'demo_device',
		});

		expect(built.ok).toBe(false);
		if (built.ok) return;
		expect(built.reason).toBe('plan_invalid');
		expect(built.diagnostics.some((item) => item.message.includes(UNKNOWN_SKILL))).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// 界面一侧：组件
// ---------------------------------------------------------------------------

describe('发给机器人 · 面板接线（组件）', () => {
	beforeEach(() => {
		// 示例样例跟当前设备的格式走：先切到一期那台，再灌一期那份（与右栏另一个测试同一套起手）
		setSelectedDevice('phase1_robot');
		expect(loadSampleTask()).toBe(true);
	});

	it('切到第三个 tab：显示的是请求序列面板，另两块让位', async () => {
		setSelectedDevice('so101_sim');
		const wrapper = mount(RightPanel);
		await wrapper.vm.$nextTick();
		expect(doc.loadTaskJson(SAMPLE_PLAN_TEXT)).toBe(true);
		await wrapper.vm.$nextTick();

		await wrapper.get('[data-testid="right-tab-calls"]').trigger('click');

		// `get` 拿不到就会抛，所以这一行本身就是「面板真的在」
		expect(wrapper.get('[data-testid="robot-calls-panel"]').attributes('class')).toContain('robot-calls-panel');
		expect(wrapper.find('[data-testid="code-panel"]').exists()).toBe(false);
		expect(wrapper.find('[data-testid="task-json-panel"]').exists()).toBe(false);
		// 摘要在，且三个数与编译结果对得上（数字从面板上读，不写死）
		const summary = wrapper.get('[data-testid="robot-calls-summary"]').text();
		expect(summary).toMatch(/\d+ 条请求 · \d+ 步在本地 · \d+ 步送不出去/);
		expect(wrapper.findAll('[data-testid="robot-call-execute"]').length).toBeGreaterThan(0);
		wrapper.unmount();
	});

	it('面板上的每一行都带自己的位置与去向：`data-step-path` / `data-kind` / `data-where`', async () => {
		const wrapper = await mountedWithPlan();

		const rows = wrapper.findAll('[data-testid="robot-calls-rows"] > li');
		expect(rows.length).toBeGreaterThan(0);
		const kinds = rows.map((row) => row.attributes('data-kind'));
		// 四类步在屏幕上各占一行，且**原语那一步在它本来的位置上**（第 5 步，第 5 行）
		expect(kinds).toEqual(['execute', 'branch', 'execute', 'wait', 'blocked', 'execute']);
		expect(rows.map((row) => row.attributes('data-step-path'))).toEqual([
			'0',
			'1',
			'1.then.0',
			'2',
			'3',
			'4',
		]);
		// 去向那一栏是编译包给的三个取值之一
		expect(rows.map((row) => row.attributes('data-where'))).toEqual([
			'bridge',
			'client',
			'bridge',
			'client',
			'nowhere',
			'bridge',
		]);
		wrapper.unmount();
	});

	it('execute 那一条把方法、路径、请求体与轮询都摆出来了', async () => {
		const wrapper = await mountedWithPlan();

		const line = wrapper.get('[data-testid="robot-call-execute-line"]').text();
		expect(line).toContain('POST');
		expect(line).toContain('/v1/skills/execute');

		const body = wrapper.get('[data-testid="robot-call-body"]').text();
		for (const field of ['task_id=', 'skill=', 'params=']) expect(body).toContain(field);
		expect(body).toContain(SO101_SKILL);

		const poll = wrapper.get('[data-testid="robot-call-poll"]').text();
		expect(poll).toContain('GET /v1/tasks/');
		expect(poll).toContain(`${String(DEFAULT_POLL_SPEC.intervalMs)}ms`);
		wrapper.unmount();
	});

	it('本地那两步明写「不发请求」：画成请求就是编', async () => {
		const wrapper = await mountedWithPlan();

		expect(wrapper.get('[data-testid="robot-call-wait-line"]').text()).toContain('不发请求');
		expect(wrapper.get('[data-testid="robot-call-branch-line"]').text()).toContain('不发请求');
		expect(wrapper.get('[data-testid="robot-call-branch-line"]').text()).toContain('上一步成功');
		wrapper.unmount();
	});

	it('去向那句话说清为什么：徽标给结论，编译包那份 note 挂在 `title` 上等人问', async () => {
		const wrapper = await mountedWithPlan();

		const skillRow = wrapper.get('[data-testid="robot-call-execute"]');
		expect(skillRow.get('.rc-badge').text()).toBe(ROUTING_FACE.bridge);
		// note 是**全句照抄**编译包那份清单，界面不改写一个标点——只是改成问它才说
		const skillNote = STEP_ROUTING.find((entry) => entry.step === 'skill')?.note ?? '';
		expect(skillRow.attributes('title')).toContain(skillNote);

		const blockedRow = wrapper.get('[data-testid="robot-call-blocked"]');
		expect(blockedRow.get('.rc-badge').text()).toBe(ROUTING_FACE.nowhere);
		expect(blockedRow.attributes('title')).toContain(
			STEP_ROUTING.find((entry) => entry.step === 'primitive')?.note ?? '',
		);
		wrapper.unmount();
	});

	it('送不出去那一条是危险色的一块，并且写着 bridge 那句诊断', async () => {
		const wrapper = await mountedWithPlan();

		const row = wrapper.get('[data-testid="robot-call-blocked"]');
		expect(row.classes()).toContain('is-blocked');
		const text = wrapper.get('[data-testid="robot-call-blocked-line"]').text();
		expect(text).toContain(BRIDGE_PLAN_DIAGNOSTIC_CODES.primitiveUnsupported);
		expect(text).toContain('open_gripper');
		// 底部再说一句这是上游边界（不是我们还没做）
		expect(wrapper.get('[data-testid="robot-calls-footer"]').text()).toContain('发不出去');
		wrapper.unmount();
	});

	it('没有声明时是空状态，说清先做什么', async () => {
		const wrapper = mount(RobotCallsPanel);
		const before = doc.declaration.value;
		doc.declaration.value = null;
		await wrapper.vm.$nextTick();

		expect(wrapper.get('[data-testid="robot-calls-empty"]').text()).toContain('先在上面写一句话生成任务');
		expect(wrapper.find('[data-testid="robot-calls-rows"]').exists()).toBe(false);
		expect(wrapper.find('[data-testid="robot-calls-summary"]').exists()).toBe(false);

		wrapper.unmount();
		if (before !== null) doc.applyDeclaration(before);
	});

	it('一期设备下的声明：如实说「编译不出请求」，不硬套', async () => {
		// 起手灌的就是一期那份，出生格式因此是 phase1_task
		expect(doc.declarationFormatRef.value).toBe('phase1_task');
		const wrapper = mount(RobotCallsPanel);

		const block = wrapper.get('[data-testid="robot-calls-format"]').text();
		expect(block).toContain('一期任务协议');
		expect(block).toContain('不是技能计划');
		expect(wrapper.find('[data-testid="robot-calls-rows"]').exists()).toBe(false);
		wrapper.unmount();
	});

	it('全都在本地做的计划：零条请求，但要说明白为什么', async () => {
		setSelectedDevice('so101_sim');
		const wrapper = mount(RobotCallsPanel);
		await wrapper.vm.$nextTick();
		expect(doc.loadTaskJson(ONLY_LOCAL_PLAN_TEXT)).toBe(true);
		await wrapper.vm.$nextTick();

		expect(wrapper.get('[data-testid="robot-calls-summary"]').text()).toContain('0 条请求');
		expect(wrapper.get('[data-testid="robot-calls-nothing"]').text()).toContain('本地');
		expect(wrapper.findAll('[data-testid="robot-call-execute"]')).toHaveLength(0);
		wrapper.unmount();
	});
});

// ---------------------------------------------------------------------------
// 组件那几条用例的用具：技能名与参数名从 SO-101 真目录里挑，不手写
// ---------------------------------------------------------------------------

/** SO-101 目录里第一个真技能（技能名不写死：目录增删之后这条测试不该跟着坏）。 */
const SO101_SKILL = ROBOFRAME_SO101_CATALOG.capabilities[0]?.capabilityRef ?? '';
const SO101_ROBOT = ROBOFRAME_SO101_CATALOG.robotName ?? '';

/** 四类步都有的计划：技能（真名）、分支、等待、原语（真名，且执行侧没有这条通路）。 */
const SAMPLE_PLAN_TEXT = JSON.stringify({
	schemaVersion: SKILL_PLAN_SCHEMA_VERSION,
	robot: SO101_ROBOT,
	description: '看一眼；不行就补一下；等一下；然后张开夹爪',
	plan: [
		{ step: 'skill', skill: SO101_SKILL },
		{
			step: 'if',
			condition: { field: 'last.success', op: '==', value: false },
			then: [{ step: 'skill', skill: SO101_SKILL }],
		},
		{ step: 'wait', seconds: 2 },
		{ step: 'primitive', primitive: 'open_gripper' },
		{ step: 'skill', skill: SO101_SKILL },
	],
});

/** 一条请求都发不出来的计划：全在本地（等与判断）。 */
const ONLY_LOCAL_PLAN_TEXT = JSON.stringify({
	schemaVersion: SKILL_PLAN_SCHEMA_VERSION,
	robot: SO101_ROBOT,
	description: '等一下，再判断一下',
	plan: [
		{ step: 'wait', seconds: 2 },
		{ step: 'if', condition: { field: 'last.success', op: '==', value: true }, then: [{ step: 'wait', seconds: 1 }] },
	],
});

/** 挂一块面板 + 切到虚拟设备 + 灌那份四类步都有的计划（这一组用例每条都要走）。 */
const mountedWithPlan = async (): Promise<VueWrapper> => {
	setSelectedDevice('so101_sim');
	const wrapper = mount(RobotCallsPanel);
	await wrapper.vm.$nextTick();
	expect(doc.loadTaskJson(SAMPLE_PLAN_TEXT)).toBe(true);
	await wrapper.vm.$nextTick();
	return wrapper;
};

afterEach(() => {
	// 真相是模块级单例，跨用例活着：跑完把设备摆回默认那台，免得下一条用例起手就是技能计划格式。
	setSelectedDevice('phase1_robot');
});
