// @vitest-environment happy-dom
/**
 * 「发给机器人」视图的验收：**这一句话编出来会变成哪些请求，以及哪一步送不出去**。
 *
 * 四组断言，对着这件东西的四半：
 *
 * 1. **数据**（`robot-calls.ts`，纯函数）：三种 call 各渲染成什么行；原语那一步的诊断出现在
 *    **它本来的顺序位置上**（不是被悄悄省掉的一行）；摘要那三个数对得上；一期声明返回
 *    「编译不了」而不是硬套一份计划。用一份**合成的目录**来测，不依赖 SO-101 目录的具体内容
 *    （那边会增删技能，判据的口径不该跟着抖）。
 * 2. **接线**（组件）：切到第三个 tab 能显示；没有声明时的空状态；一期设备下的如实说明。
 * 3. **不编造**：编不出来的东西一次都不许出现在屏幕上——没有目录的技能、送不出去的原语，
 *    屏幕上都不该有一条请求。
 * 4. **下发**（`plan-run.ts` 纯函数 + 组件）：事件按 `stepPath` 落在**它自己那一行**上；
 *    `unreachable` 与 `failed` 文案与观感都不同；取消后如实；基地址进 localStorage；
 *    按不动时按钮禁用并说明。这一组的 `runCompiledPlan` **打桩**——单测里一条 HTTP 都不发。
 *
 * 一条纪律：技能名、原语名、参数名与那个 `task_id` **一个都不手写**——全部从合成目录与
 * 编译结果里现取。写死一个 id 就等于把「编译期生成的」这件事偷偷改成「界面自己拼的」。
 */
import { flushPromises, mount } from '@vue/test-utils';
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
import type { CompiledPlan, PlanRunEvent, PlanRunResult, RunOverHttpOptions } from '@codecanvas/robot-bridge';
import { importSkillPlan } from '@codecanvas/task-import';
import { loadSampleTask, useStudioDocument } from '../../../state/document';
import { setSelectedDevice } from '../../../shell/devices';
import RightPanel from '../RightPanel.vue';
import RobotCallsPanel from './RobotCallsPanel.vue';
import {
	BLOCKED_ROW_RUN_NOTE,
	BRIDGE_BASE_URL_STORAGE_KEY,
	DEFAULT_BRIDGE_BASE_URL,
	DISPATCH_PATH_NOTE,
	DISPATCH_PATH_SHORT,
	RUN_STATE_FACE,
	RUN_STATE_MEANING,
	RUN_STATE_TONE,
	compiledOf,
	dispatchGateOf,
	orphanRunPaths,
	readBridgeBaseUrl,
	runStatesByStepPath,
	runVerdictOf,
	writeBridgeBaseUrl,
} from './plan-run';
import {
	ROUTING_FACE,
	buildPlanFromDeclaration,
	compileDeclarationToCalls,
	robotCallsView,
	type RobotCallRow,
} from './robot-calls';

/**
 * 这一份用例的桩：`runCompiledPlan` 换成下面这个实现，**一条 HTTP 都不发**。
 *
 * 为什么放在 `let` 里而不是直接 `vi.fn()`：每条用例要的东西不一样（成功 / 失败 / 取消），
 * 而 `vi.mock` 的工厂会被提到文件顶部——所以工厂里**只包一层**，真正读这个变量的时机是
 * 「执行器被调用时」（那时的 `let` 早就初始化好了）。
 */
let runnerImpl: ((plan: CompiledPlan, options: RunOverHttpOptions) => Promise<PlanRunResult>) | null = null;

vi.mock('@codecanvas/robot-bridge', async (importOriginal) => {
	const actual = await importOriginal<typeof import('@codecanvas/robot-bridge')>();
	return {
		...actual,
		// 只换掉执行器：编译、路由清单、诊断码那几样是真的（这套断言靠它们做判据）
		runCompiledPlan: (plan: CompiledPlan, options: RunOverHttpOptions): Promise<PlanRunResult> =>
			runnerImpl === null
				? Promise.reject(new Error('这一条用例没有摆好 runCompiledPlan 的桩'))
				: runnerImpl(plan, options),
	};
});

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
/**
 * 抓取那台的计划：`pick_object` 只在那份目录里，所以这一份必须配抓取那台设备导入。
 * 它比 `SAMPLE_PLAN_TEXT` 短——正是「换了一份更短的声明」那条用例要的形状。
 */
const GRASP_PLAN_TEXT = JSON.stringify({
	schemaVersion: SKILL_PLAN_SCHEMA_VERSION,
	robot: 'so101_handeye_realsense_grasp',
	description: '看一眼桌面，把红色方块抓起来',
	plan: [
		{ step: 'skill', skill: 'inspect_scene' },
		{ step: 'skill', skill: 'pick_object', params: { target_name: '红色方块' } },
	],
});

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

// ---------------------------------------------------------------------------
// 下发 · 纯函数那一半（这一步的真实结果怎么对回它自己那一行）
// ---------------------------------------------------------------------------

/** 一条事件：字段与执行器给的一样，`detail` 缺省是空串（执行器允许不给）。 */
const event = (
	stepPath: string,
	state: PlanRunEvent['state'],
	detail?: string,
): PlanRunEvent => (detail === undefined ? { stepPath, state } : { stepPath, state, detail });

describe('发给机器人 · 事件按 stepPath 对号（纯函数）', () => {
	it('一步一个键；同一个路径后到的覆盖先到的（execute 先 running 再终态）', () => {
		const states = runStatesByStepPath([
			event('0', 'running', 'POST /v1/skills/execute skill=demo'),
			event('0', 'completed', '终态 state=completed success=true'),
			event('1', 'completed', '条件 last.success == false 不成立 → 走 else 臂'),
		]);

		// 行上留的是**此刻**的状态，不是流水账——流水账是事件的完整列表
		expect(states.get('0')).toEqual({
			state: 'completed',
			detail: '终态 state=completed success=true',
			taskId: null,
		});
		expect(states.get('1')?.state).toBe('completed');
		// 没走过的步压根没有键（不是「有一个空状态」）
		expect(states.has('2')).toBe(false);
	});

	it('诊断原文一个字都不改：`detail` 就是执行器给的那句', () => {
		const detail = 'POST /v1/skills/execute 回了 404：{"detail":"unknown skill: x"}';
		const states = runStatesByStepPath([event('0', 'unreachable', detail)]);

		expect(states.get('0')?.detail).toBe(detail);
	});

	it('对不上任何一行的事件不咽掉：orphanRunPaths 说得出来是哪几条', () => {
		const events = [event('0', 'completed'), event('3.then.0', 'failed'), event('0', 'completed')];
		// 屏幕上那几行（第二份声明）：没有 3.then.0，也没有别的
		expect(orphanRunPaths(events, ['0', '1', '2'])).toEqual(['3.then.0']);
		// 全对得上就是空的——正常情况
		expect(orphanRunPaths(events, ['0', '3.then.0'])).toEqual([]);
	});
});

describe('发给机器人 · unreachable 与 failed 是两件事（纯函数）', () => {
	it('两档的读法、观感、那句话都不同——混起来就是编造一次成败', () => {
		expect(RUN_STATE_FACE.unreachable).not.toBe(RUN_STATE_FACE.failed);
		expect(RUN_STATE_TONE.unreachable).not.toBe(RUN_STATE_TONE.failed);
		expect(RUN_STATE_MEANING.unreachable).not.toBe(RUN_STATE_MEANING.failed);

		// 各自那句话说的正是它那一件事：一个「没到」、一个「到了没成」
		expect(RUN_STATE_MEANING.unreachable).toContain('没到设备');
		expect(RUN_STATE_MEANING.unreachable).toContain('不是业务失败');
		expect(RUN_STATE_MEANING.failed).toContain('业务失败');
		// 「发不出去」那三个字里不许出现「失败」——它就不是失败
		expect(RUN_STATE_FACE.unreachable).not.toContain('失败');
	});

	it('五档各有各的读法：执行器定的那些取值一个都不漏', () => {
		const states: readonly PlanRunEvent['state'][] = [
			'running',
			'completed',
			'failed',
			'unreachable',
			'skipped',
		];
		for (const state of states) {
			expect(RUN_STATE_FACE[state]).not.toBe('');
			expect(RUN_STATE_MEANING[state]).not.toBe('');
		}
	});
});

describe('发给机器人 · 按不按得动（纯函数）', () => {
	it('编得出来、有请求、地址也填了：按得动，且没有那句「为什么」', () => {
		const gate = dispatchGateOf({ hasDeclaration: true, result: compileDemo(), baseUrl: 'http://127.0.0.1:8788' });

		expect(gate.allowed).toBe(true);
		expect(gate.reason).toBeNull();
	});

	it('没有声明：按不动，并说清先做什么', () => {
		const gate = dispatchGateOf({ hasDeclaration: false, result: null, baseUrl: DEFAULT_BRIDGE_BASE_URL });

		expect(gate.allowed).toBe(false);
		expect(gate.reason).toContain('还没有声明');
	});

	it('一期声明（编译不出请求）：按不动，理由说的是「出生格式不是技能计划」', () => {
		const result = compileDeclarationToCalls({
			declaration: declarationOf(buildPlan()),
			formatRef: 'phase1_task',
			catalog: DEMO_CATALOG,
			deviceRef: 'demo_device',
		});
		const gate = dispatchGateOf({ hasDeclaration: true, result, baseUrl: DEFAULT_BRIDGE_BASE_URL });

		expect(gate.allowed).toBe(false);
		expect(gate.reason).toContain('出生格式不是技能计划');
	});

	it('计划过不了校验：按不动，并把诊断条数说出来（去改计划，不是去按按钮）', () => {
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

		const gate = dispatchGateOf({ hasDeclaration: true, result, baseUrl: DEFAULT_BRIDGE_BASE_URL });
		expect(gate.allowed).toBe(false);
		expect(gate.reason).toContain('过不了校验');
	});

	it('一条请求都没有的计划：按不动，三个数原样说出来', () => {
		const plan = buildPlan();
		const result = compileDemo({
			...plan,
			plan: [
				{ step: 'primitive', primitive: DEMO_PRIMITIVE },
				{ step: 'wait', seconds: 1 },
			],
		});
		const gate = dispatchGateOf({ hasDeclaration: true, result, baseUrl: DEFAULT_BRIDGE_BASE_URL });

		expect(gate.allowed).toBe(false);
		expect(gate.reason).toContain('一条请求都没有');
		expect(gate.reason).toContain('bridge 一个字节都收不到');
	});

	it('地址是空的：按不动——不知道发给谁，就没有「下发」这件事', () => {
		const gate = dispatchGateOf({ hasDeclaration: true, result: compileDemo(), baseUrl: '   ' });

		expect(gate.allowed).toBe(false);
		expect(gate.reason).toContain('基地址');
	});

	it('`compiledOf` 给的就是这一屏摊开的那一份：calls 与 diagnostics 原样取出，不重编', () => {
		const result = compileDemo();
		expect(result.ok).toBe(true);
		if (!result.ok) return;

		const compiled = compiledOf(result);
		expect(compiled?.calls).toBe(result.view.calls);
		expect(compiled?.diagnostics).toBe(result.view.diagnostics);
		// 编不出来时没有「要发的那一份」——不是一份空计划
		expect(compiledOf({ ok: false, reason: 'format_mismatch', diagnostics: [] })).toBeNull();
		expect(compiledOf(null)).toBeNull();
	});
});

describe('发给机器人 · 基地址的存与取（照 LLM 地址输入的做法）', () => {
	beforeEach(() => {
		window.localStorage.removeItem(BRIDGE_BASE_URL_STORAGE_KEY);
	});

	afterEach(() => {
		window.localStorage.removeItem(BRIDGE_BASE_URL_STORAGE_KEY);
	});

	it('没存过就是缺省那个地址；写一次读得回来；空串当没填', () => {
		expect(readBridgeBaseUrl()).toBe(DEFAULT_BRIDGE_BASE_URL);

		writeBridgeBaseUrl('http://127.0.0.1:9');
		expect(readBridgeBaseUrl()).toBe('http://127.0.0.1:9');

		// 清空输入框不该让面板从此记着一个空地址：空串＝没填，退回缺省
		writeBridgeBaseUrl('   ');
		expect(readBridgeBaseUrl()).toBe(DEFAULT_BRIDGE_BASE_URL);
	});

	it('隐私模式下 localStorage 会直接抛：读得出缺省，写得进去不抛——面板不许因此挂掉', () => {
		const boom = (): never => {
			throw new Error('localStorage 被禁了（隐私模式）');
		};
		const original = window.localStorage;
		Object.defineProperty(window, 'localStorage', {
			configurable: true,
			value: { getItem: boom, setItem: boom },
		});

		try {
			expect(() => readBridgeBaseUrl()).not.toThrow();
			expect(readBridgeBaseUrl()).toBe(DEFAULT_BRIDGE_BASE_URL);
			expect(() => writeBridgeBaseUrl('http://127.0.0.1:9999')).not.toThrow();
		} finally {
			Object.defineProperty(window, 'localStorage', { configurable: true, value: original });
		}
	});
});

describe('发给机器人 · 一次下发的结论（纯函数）', () => {
	it('取消是**请求**不是结论：说已请求取消，执行器那句原话一字不改', () => {
		const reason =
			'运行被取消（AbortSignal）：第 0 步的请求已经发出去了，设备那边可能还在跑——我们不替它下结论';
		const verdict = runVerdictOf({
			outcome: { ok: false, events: [], reason },
			cancelRequested: true,
		});

		expect(verdict.face).toBe('已请求取消');
		expect(verdict.detail).toBe(reason);
	});

	it('没按取消而停下来：说停在当下，原因还是执行器那句', () => {
		const reason = '第 0 步发不出去（这与「这一步跑失败了」不是一回事）：连不上 bridge';
		const verdict = runVerdictOf({ outcome: { ok: false, events: [], reason }, cancelRequested: false });

		expect(verdict.face).toBe('停在当下');
		expect(verdict.detail).toBe(reason);
	});

	it('走完了：被容忍的失败不拦这件事要说出来（否则「ok 却有 failed 事件」看着像 bug）', () => {
		const verdict = runVerdictOf({ outcome: { ok: true, events: [] }, cancelRequested: false });

		expect(verdict.face).toBe('走完了');
		expect(verdict.detail).toContain('被容忍的失败');
	});

	it('执行器没给原因时**不编一句**：如实说不知道停在哪', () => {
		const verdict = runVerdictOf({ outcome: { ok: false, events: [] }, cancelRequested: false });

		expect(verdict.detail).toContain('没给原因');
	});
});

// ---------------------------------------------------------------------------
// 下发 · 组件那一半（`runCompiledPlan` 打桩，一条 HTTP 都不发）
// ---------------------------------------------------------------------------

/** 摆好这一条用例的桩：跑一次就给这些事件，然后回这个结论。 */
const stubRun = (events: readonly PlanRunEvent[], outcome?: Partial<PlanRunResult>): void => {
	runnerImpl = async (_plan, options) => {
		for (const item of events) options.onStep?.(item);
		return { ok: true, events, ...outcome };
	};
};

/** 桩：跑起来就停在那儿，直到被 abort 才回结论（取消那条用例要的就是这个形状）。 */
const stubRunUntilAborted = (events: readonly PlanRunEvent[], reason: string): void => {
	runnerImpl = async (_plan, options) => {
		for (const item of events) options.onStep?.(item);
		await new Promise<void>((resolve) => {
			const signal = options.signal;
			if (signal === undefined || signal.aborted) {
				resolve();
				return;
			}
			signal.addEventListener('abort', () => resolve(), { once: true });
		});
		return { ok: false, events, reason };
	};
};

/** 某一行上的运行态那一块。没有它就说明「这一步没走到」（不是「有一个空状态」）。 */
const runBoxOf = (wrapper: VueWrapper, stepPath: string) =>
	wrapper.get(`li[data-step-path="${stepPath}"] [data-run-state]`);

/** 同上，但「在不在」也要问得出来（`get` 拿不到会抛，这里要的是布尔）。 */
const runBoxExists = (wrapper: VueWrapper, stepPath: string): boolean =>
	wrapper.find(`li[data-step-path="${stepPath}"] [data-run-state]`).exists();

const dispatchButton = (wrapper: VueWrapper) => wrapper.get('[data-testid="robot-calls-dispatch"]');

const hasDispatchButton = (wrapper: VueWrapper): boolean =>
	wrapper.find('[data-testid="robot-calls-dispatch"]').exists();

describe('发给机器人 · 按下去真的发（组件）', () => {
	beforeEach(() => {
		runnerImpl = null;
		window.localStorage.removeItem(BRIDGE_BASE_URL_STORAGE_KEY);
	});

	it('按不动就说清为什么：没有声明那一档', () => {
		setSelectedDevice('so101_sim');
		const wrapper = mount(RobotCallsPanel);
		const before = doc.declaration.value;
		doc.declaration.value = null;

		return wrapper.vm.$nextTick().then(async () => {
			expect(dispatchButton(wrapper).attributes('disabled')).toBeDefined();
			expect(wrapper.get('[data-testid="robot-calls-gate"]').text()).toContain('还没有声明');

			wrapper.unmount();
			if (before !== null) doc.applyDeclaration(before);
		});
	});

	it('按不动就说清为什么：一期声明（编译不出请求）那一档', async () => {
		// 灌一份**一期**那份示例（出生格式因此是 phase1_task）：面板有内容可画，但编不出请求
		setSelectedDevice('phase1_robot');
		expect(loadSampleTask()).toBe(true);
		expect(doc.declarationFormatRef.value).toBe('phase1_task');
		const wrapper = mount(RobotCallsPanel);

		expect(dispatchButton(wrapper).attributes('disabled')).toBeDefined();
		expect(wrapper.get('[data-testid="robot-calls-gate"]').text()).toContain('出生格式不是技能计划');
		wrapper.unmount();
	});

	it('下发：每一步的真实结果落在**它自己那一行**上，与那一步的请求并排', async () => {
		const wrapper = await mountedWithPlan();
		// 四类步都有的那份计划：0 技能 / 1 分支 / 1.then.0 技能 / 2 等待 / 3 原语 / 4 技能
		stubRun([
			event('0', 'running', `POST /v1/skills/execute skill=${SO101_SKILL}`),
			event('0', 'completed', '终态 state=completed success=true'),
			event('1', 'completed', '条件 last.success == false 不成立 → 走 else 臂'),
			event('1.then.0', 'running', `POST /v1/skills/execute skill=${SO101_SKILL}`),
			event('1.then.0', 'completed', '终态 state=completed success=true'),
			event('2', 'completed', '等了 2 秒（bridge 不参与，这一步不产生成败）'),
			event('4', 'running', `POST /v1/skills/execute skill=${SO101_SKILL}`),
			event('4', 'completed', '终态 state=completed success=true'),
		]);

		await dispatchButton(wrapper).trigger('click');
		await flushPromises();

		// 行还是在原来的位置上（下发是**在它旁边**加的一层，不是另开一个列表）
		expect(wrapper.findAll('[data-testid="robot-calls-rows"] > li').map((li) => li.attributes('data-step-path'))).toEqual([
			'0',
			'1',
			'1.then.0',
			'2',
			'3',
			'4',
		]);

		// 结果与请求**同一格**：技能行里既有请求行，也有它自己的运行态
		const skillRow = wrapper.get('li[data-step-path="0"]');
		expect(skillRow.find('[data-testid="robot-call-execute-line"]').exists()).toBe(true);
		expect(runBoxOf(wrapper, '0').attributes('data-run-state')).toBe('completed');
		expect(runBoxOf(wrapper, '0').text()).toContain(RUN_STATE_FACE.completed);
		expect(runBoxOf(wrapper, '0').text()).toContain('终态 state=completed success=true');

		// 臂里的那一步认得自己属于哪一层：它那条结果落在 `1.then.0` 那一行上
		expect(runBoxOf(wrapper, '1.then.0').attributes('data-run-state')).toBe('completed');
		expect(runBoxOf(wrapper, '1').attributes('data-run-state')).toBe('completed');
		expect(runBoxOf(wrapper, '2').text()).toContain('bridge 不参与');

		// 结论排在行列表上面，且与事件对得上：6 行里 5 行有结论（原语那一步没有事件）
		expect(wrapper.get('[data-testid="robot-calls-verdict-face"]').text()).toBe('走完了');
		expect(wrapper.get('[data-testid="robot-calls-verdict"]').text()).toContain('5 / 6 步有结论');
		wrapper.unmount();
	});

	it('下了发之后上面换了一份声明：上一趟的结论跟着那份计划一起走，不落在新行上', async () => {
		const wrapper = await mountedWithPlan();
		stubRun([
			event('0', 'running', 'POST /v1/skills/execute'),
			event('0', 'completed', '终态 state=completed success=true'),
			event('1.then.0', 'running', 'POST /v1/skills/execute'),
			event('1.then.0', 'completed', '终态 state=completed success=true'),
		]);
		await dispatchButton(wrapper).trigger('click');
		await flushPromises();

		const before = wrapper.findAll('[data-testid="robot-calls-rows"] > li').length;
		expect(wrapper.get('[data-testid="robot-calls-verdict"]').text()).toContain(`2 / ${String(before)} 步有结论`);
		expect(runBoxOf(wrapper, '0').attributes('data-run-state')).toBe('completed');

		// 换一份**更短**的声明：新计划第 0 步的路径还是 `0`——上一趟那条结果会正好落在它上面
		setSelectedDevice('so101_grasp_sim');
		expect(doc.loadTaskJson(GRASP_PLAN_TEXT)).toBe(true);
		await flushPromises();

		// 于是这一趟的账跟着上一份计划一起走了：结论没了，行上也没有「已完成」。
		// 留着它就会被当成**这一份**的结果读，而这一份从没发出去过。
		expect(wrapper.find('[data-testid="robot-calls-verdict"]').exists()).toBe(false);
		expect(runBoxExists(wrapper, '0')).toBe(false);
		expect(wrapper.findAll('[data-testid="robot-calls-rows"] > li').length).toBeGreaterThan(0);
		wrapper.unmount();
	});

	it('unreachable 与 failed 在屏幕上是两种东西：文案不同、观感不同、原文照抄', async () => {
		const unreachableDetail = 'POST /v1/skills/execute 回了 404：{"detail":"unknown skill: wave"}';
		const failedDetail = '终态 state=failed success=false error_code=skill_failed message=夹爪没夹住';

		const unreachable = await mountedWithPlan();
		stubRun([event('0', 'running'), event('0', 'unreachable', unreachableDetail)], {
			ok: false,
			reason: '第 0 步发不出去',
		});
		await dispatchButton(unreachable).trigger('click');
		await flushPromises();

		const unreachableBox = runBoxOf(unreachable, '0');
		expect(unreachableBox.attributes('data-run-state')).toBe('unreachable');
		expect(unreachableBox.classes()).toContain('is-unreachable');
		expect(unreachableBox.classes()).not.toContain('is-failed');
		expect(unreachableBox.text()).toContain(RUN_STATE_FACE.unreachable);
		expect(unreachableBox.text()).toContain(RUN_STATE_MEANING.unreachable);
		// 诊断原文照原样，一个字都不改写
		expect(unreachable.get('[data-testid="robot-call-run-detail"]').text()).toBe(unreachableDetail);
		unreachable.unmount();

		const failed = await mountedWithPlan();
		stubRun([event('0', 'running'), event('0', 'failed', failedDetail)], {
			ok: false,
			reason: '第 0 步失败',
		});
		await dispatchButton(failed).trigger('click');
		await flushPromises();

		const failedBox = runBoxOf(failed, '0');
		expect(failedBox.attributes('data-run-state')).toBe('failed');
		expect(failedBox.classes()).toContain('is-failed');
		expect(failedBox.classes()).not.toContain('is-unreachable');
		expect(failed.get('[data-testid="robot-call-run-detail"]').text()).toBe(failedDetail);

		// 三种不同：徽标那几个字、那句「它说的是什么事」、观感
		expect(unreachableBox.text()).not.toContain(RUN_STATE_FACE.failed);
		expect(failedBox.text()).not.toContain(RUN_STATE_FACE.unreachable);
		expect(unreachableBox.text()).not.toContain(RUN_STATE_MEANING.failed);
		expect(failedBox.text()).not.toContain(RUN_STATE_MEANING.unreachable);
		failed.unmount();
	});

	it('取消：按钮变成取消，按下去停在当下、如实说「已请求取消」', async () => {
		const wrapper = await mountedWithPlan();
		const reason =
			'运行被取消（AbortSignal）：第 0 步的请求已经发出去了，设备那边可能还在跑——我们不替它下结论';
		stubRunUntilAborted([event('0', 'running', `POST /v1/skills/execute skill=${SO101_SKILL}`)], reason);

		await dispatchButton(wrapper).trigger('click');
		await flushPromises();

		// 跑的时候按钮就是那一格「取消」——「下发」此时不在了（一次只跑一条）
		expect(hasDispatchButton(wrapper)).toBe(false);
		const cancel = wrapper.get('[data-testid="robot-calls-cancel"]');
		expect(cancel.text()).toBe('取消');
		// 走到哪儿了也看得出来：那一步是 running（成败还没读到，不许替它说）
		expect(runBoxOf(wrapper, '0').attributes('data-run-state')).toBe('running');
		expect(wrapper.find('[data-testid="robot-calls-verdict"]').exists()).toBe(false);

		await cancel.trigger('click');
		await flushPromises();

		expect(wrapper.get('[data-testid="robot-calls-verdict-face"]').text()).toBe('已请求取消');
		expect(wrapper.get('[data-testid="robot-calls-verdict"]').attributes('data-cancelled')).toBe('true');
		// 执行器那句原话照抄：设备那边可能还在跑，我们不替它下结论
		expect(wrapper.get('[data-testid="robot-calls-verdict-detail"]').text()).toBe(reason);
		// 取消之后按钮回到「下发」，还能再发一次
		expect(hasDispatchButton(wrapper)).toBe(true);
		expect(dispatchButton(wrapper).attributes('disabled')).toBeUndefined();
		wrapper.unmount();
	});

	it('primitive 那一行不参与下发：它没有事件，但看得出来「不是漏了」', async () => {
		const wrapper = await mountedWithPlan();
		stubRun([event('0', 'running'), event('0', 'completed', '终态 state=completed success=true')]);

		await dispatchButton(wrapper).trigger('click');
		await flushPromises();

		// 它那一行**没有请求行**（编译期就送不出去），也没有运行态那一块
		const blockedRow = wrapper.get('li[data-step-path="3"]');
		expect(blockedRow.find('[data-testid="robot-call-execute-line"]').exists()).toBe(false);
		expect(runBoxExists(wrapper, '3')).toBe(false);
		// 但它自己那一行说得出来：不参与下发
		expect(blockedRow.get('[data-testid="robot-call-blocked-no-dispatch"]').text()).toBe(BLOCKED_ROW_RUN_NOTE);
		expect(blockedRow.text()).toContain('不参与下发');
		// 别的行照旧有运行态——不是整块没画
		expect(runBoxExists(wrapper, '0')).toBe(true);
		wrapper.unmount();
	});

	it('基地址：面板上填的进 localStorage，重新挂载还在', async () => {
		const wrapper = await mountedWithPlan();
		const input = wrapper.get('[data-testid="robot-calls-base-url"]');
		expect((input.element as HTMLInputElement).value).toBe(DEFAULT_BRIDGE_BASE_URL);

		await input.setValue('http://127.0.0.1:9999');
		expect(window.localStorage.getItem(BRIDGE_BASE_URL_STORAGE_KEY)).toBe('http://127.0.0.1:9999');

		// 「刷新」＝重新挂一个全新的组件：它只认 localStorage
		const remounted = await mountedWithPlan();
		expect((remounted.get('[data-testid="robot-calls-base-url"]').element as HTMLInputElement).value).toBe(
			'http://127.0.0.1:9999',
		);

		wrapper.unmount();
		remounted.unmount();
	});

	it('两条路在面板上说清了：这里是真下发，上面那块 3D 是本机仿真', async () => {
		const wrapper = await mountedWithPlan();

		// 摆的是一行版（面板高度有限），全句挂在 `title` 上等人问——两版说的是同一件事
		const note = wrapper.get('[data-testid="robot-calls-path-note"]');
		expect(note.text()).toBe(DISPATCH_PATH_SHORT);
		expect(note.text()).toContain('真下发');
		expect(note.text()).toContain('HTTP');
		expect(note.text()).toContain('本机仿真');
		expect(note.attributes('title')).toBe(DISPATCH_PATH_NOTE);
		expect(DISPATCH_PATH_NOTE).toContain('一个网络请求都不发');
		wrapper.unmount();
	});

	it('下发之后声明被换掉：对不上的事件不咽掉，说得出来是哪几条', async () => {
		const wrapper = await mountedWithPlan();
		stubRun([event('0', 'completed'), event('9.then.7', 'completed')], { ok: false, reason: '换了' });

		await dispatchButton(wrapper).trigger('click');
		await flushPromises();

		const orphan = wrapper.get('[data-testid="robot-calls-orphan"]');
		expect(orphan.text()).toContain('9.then.7');
		expect(orphan.text()).toContain('确实发生过');
		wrapper.unmount();
	});
});
