/**
 * 两种任务格式的**来回一趟**：声明 → 任务 JSON → 声明，内容必须一样。
 *
 * 这一条是 JSON 视图的底气：那个视图显示的是「声明还原成的原文」，
 * 如果来回一趟会丢东西或变形，它显示的就是另一份东西，而不是同一份真相的另一种写法。
 *
 * 两条路都用**真实目录**跑：一期用示意目录，技能计划用上游 RoboFrame 转出来的那份。
 * 技能计划这一侧还有分支：`if` 步 ↔ `task.branch` 节点，三条出边的**位置就是语义**，
 * 所以「来回一趟等价」要连出边一起量（不是只量长度）。
 */
import { describe, expect, it } from 'vitest';
import { PHASE1_ROBOT_CATALOG, ROBOFRAME_SO101_CATALOG } from '@codecanvas/capabilities';
import { createDeterministicIdFactory, type JsonObject, type WorkflowDeclaration } from '@codecanvas/contracts';
import { declarationToSkillPlan, declarationToTask, findTaskFormat } from '../src/format';
import { TASK_BRANCH_NODE_TYPE, TASK_WAIT_NODE_TYPE, importSkillPlan } from '../src/skill-plan';
import { importTaskJson } from '../src/convert';

const ids = createDeterministicIdFactory();

/** 某一步第 `port` 格出边指向谁（0=then，1=else，2=这一层后面那一步）。 */
const portHead = (declaration: WorkflowDeclaration, nodeId: string, port: number): string | undefined =>
	declaration.connections[nodeId]?.main?.[port]?.[0]?.node;

const parametersAt = (declaration: WorkflowDeclaration, nodeId: string | undefined): JsonObject | undefined =>
	nodeId === undefined ? undefined : declaration.nodes.find((node) => node.id === nodeId)?.parameters;

/** 一份最小的合法一期任务：够跑通「导入 → 还原 → 再导入」就行。 */
const SAMPLE_TASK = {
	schema_version: '1.0',
	task_id: 'task-roundtrip-001',
	description: '前进1米，避障后停止',
	steps: [
		{ id: 'step-move', action: 'move', linear: 0.2, angular: 0.0, duration: 5.0 },
		{ id: 'step-stop', action: 'stop' },
	],
	limits: { max_linear: 0.3, max_angular: 1.2, max_duration: 30.0, require_confirmation: true },
};

const stripVolatile = (declaration: WorkflowDeclaration) => ({
	name: declaration.name,
	meta: declaration.meta,
	nodes: declaration.nodes.map((node) => ({ name: node.name, parameters: node.parameters })),
});

describe('一期协议：声明 ↔ 任务 JSON', () => {
	const format = findTaskFormat('phase1_task');
	const context = { catalog: PHASE1_ROBOT_CATALOG, idFactory: ids };

	it('来回一趟内容不变', () => {
		const first = importTaskJson(JSON.stringify(SAMPLE_TASK), { idFactory: ids });
		if (!first.ok) throw new Error('示例任务应当能导入');

		const text = JSON.stringify(format.fromDeclaration(first.declaration));
		const second = format.parse(text, context);
		if (!second.ok) throw new Error('还原出来的任务应当能再导入');

		expect(stripVolatile(second.declaration)).toEqual(stripVolatile(first.declaration));
	});

	it('还原出来的就是二期协议原文的键名（不是节点参数的键名）', () => {
		const imported = importTaskJson(JSON.stringify(SAMPLE_TASK), { idFactory: ids });
		if (!imported.ok) throw new Error('示例任务应当能导入');
		const task = declarationToTask(imported.declaration);
		const steps = task['steps'] as Record<string, unknown>[];
		// 节点侧叫 `step_id`，协议里叫 `id`；节点侧叫 `action`，协议里也叫 `action`。
		expect(Object.keys(steps[0] ?? {})).toContain('id');
		expect(Object.keys(steps[0] ?? {})).not.toContain('step_id');
	});

	it('第二道闸认得出被改坏的值（拿的是任务层那把尺子）', () => {
		const imported = importTaskJson(JSON.stringify(SAMPLE_TASK), { idFactory: ids });
		if (!imported.ok) throw new Error('示例任务应当能导入');
		const broken: WorkflowDeclaration = {
			...imported.declaration,
			nodes: imported.declaration.nodes.map((node, index) =>
				index === 0 ? { ...node, parameters: { ...node.parameters, action: 'fly' } } : node,
			),
		};
		const result = format.validateDeclaration(broken, context);
		expect(result.ok).toBe(false);
		expect(result.diagnostics.map((diagnostic) => diagnostic.code)).toContain('step.action.unknown');
	});
});

describe('技能计划：声明 ↔ 技能计划 JSON', () => {
	const context = { catalog: ROBOFRAME_SO101_CATALOG, idFactory: ids };
	const PLAN = {
		schemaVersion: 1,
		robot: 'so101_single_arm',
		description: '打个招呼再挪一点',
		plan: [
			{ step: 'skill', skill: 'wave_hello' },
			{ step: 'skill', skill: 'move_relative_ee', params: { motion_direction: 'forward', motion_distance: 0.03 }, timeoutSec: 15 },
		],
	};

	it('来回一趟内容不变（技能参数与超时都不丢）', () => {
		const first = importSkillPlan(PLAN, context);
		if (!first.ok) throw new Error('计划应当能导入');

		const restored = declarationToSkillPlan(first.declaration);
		expect(restored).toEqual(PLAN);

		const second = importSkillPlan(restored, context);
		if (!second.ok) throw new Error('还原出来的计划应当能再导入');
		expect(stripVolatile(second.declaration)).toEqual(stripVolatile(first.declaration));
	});

	it('写死这一版不做的步种类：还原不出来就直说，不编一个技能', () => {
		const broken = { schemaVersion: 1, robot: 'so101_single_arm', plan: [{ step: 'primitive', name: 'grab' }] };
		const result = importSkillPlan(broken, context);
		expect(result.ok).toBe(false);
		expect(result.diagnostics[0]?.code).toBe('plan.step.kind_unsupported');
	});

	it('第二道闸认得出目录里没有的技能', () => {
		const imported = importSkillPlan(PLAN, context);
		if (!imported.ok) throw new Error('计划应当能导入');
		const broken: WorkflowDeclaration = {
			...imported.declaration,
			nodes: imported.declaration.nodes.map((node, index) =>
				index === 0 ? { ...node, parameters: { ...node.parameters, action: 'fly' } } : node,
			),
		};
		const result = findTaskFormat('skill_plan').validateDeclaration(broken, context);
		expect(result.ok).toBe(false);
		expect(result.diagnostics.map((diagnostic) => diagnostic.code)).toContain('plan.step.skill.unknown');
	});

	it('没有分支的声明按声明顺序还原——哪怕它一条 connections 都没有', () => {
		// 手拼出来的声明就是这种形状（studio 的夹具与「把声明贴进来」这种用法都有）。
		// 平铺的一串只有按声明顺序读才对得上，所以这一条不能被分支那条路吃掉。
		const flat: WorkflowDeclaration = {
			formatVersion: 1,
			id: 'wf_flat',
			name: '两句技能',
			nodes: [
				{ id: 'nd_1', name: '1. 打招呼', type: 'task.action', typeVersion: 1, parameters: { action: 'wave_hello' }, position: { x: 0, y: 0 }, disabled: false },
				{
					id: 'nd_2',
					name: '2. 相对移动',
					type: 'task.action',
					typeVersion: 1,
					parameters: { action: 'move_relative_ee', motion_direction: 'forward', motion_distance: 0.03 },
					position: { x: 220, y: 0 },
					disabled: false,
				},
			],
			connections: {},
			digest: 'sha256-0000000000000000000000000000000000000000000000000000000000000000',
			meta: { schemaVersion: 1, robot: 'so101_single_arm' },
		};
		expect(declarationToSkillPlan(flat)).toEqual({
			schemaVersion: 1,
			robot: 'so101_single_arm',
			plan: [
				{ step: 'skill', skill: 'wave_hello' },
				{ step: 'skill', skill: 'move_relative_ee', params: { motion_direction: 'forward', motion_distance: 0.03 } },
			],
		});
	});

	// ------------------------------------------------------------------
	// 分支：计划 → 声明 → 计划
	// ------------------------------------------------------------------

	/** 计划 → 声明 → 计划：深等价，再钉一次字节（键序照冻结的形状）。 */
	const expectRoundTrip = (plan: Record<string, unknown>): WorkflowDeclaration => {
		const imported = importSkillPlan(plan, context);
		if (!imported.ok) throw new Error('计划应当能导入');
		const restored = declarationToSkillPlan(imported.declaration);
		expect(restored).toEqual(plan);
		expect(JSON.stringify(restored)).toBe(JSON.stringify(plan));
		// 第二道闸走的就是这条逆映射：同一份声明量出来必须是绿的。
		expect(findTaskFormat('skill_plan').validateDeclaration(imported.declaration, context).ok).toBe(true);
		return imported.declaration;
	};

	/** 「看一眼 → 没成就重看，否则挪一点 → 再挪一点」：then / else / if 之后的步骤三格全占。 */
	const BRANCH_PLAN = {
		schemaVersion: 1,
		robot: 'so101_single_arm',
		description: '看一眼，没成就重看，否则挪一点，最后再挪一点',
		plan: [
			{ step: 'skill', skill: 'inspect_scene' },
			{
				step: 'if',
				condition: { field: 'last.success', op: '==', value: false },
				then: [{ step: 'skill', skill: 'wave_hello' }],
				else: [
					{ step: 'skill', skill: 'move_relative_ee', params: { motion_direction: 'forward', motion_distance: 0.03 } },
				],
			},
			{ step: 'skill', skill: 'inspect_scene' },
		],
	};

	it('带分支的计划来回一趟等价，且三格出边的位置真的是 then / else / if 之后（内容断言）', () => {
		const declaration = expectRoundTrip(BRANCH_PLAN);
		const branchId = declaration.nodes.find((node) => node.type === TASK_BRANCH_NODE_TYPE)?.id;
		if (branchId === undefined) throw new Error('应当有一个分支节点');

		const groups = declaration.connections[branchId]?.main;
		expect(groups).toHaveLength(3);
		// main[0] 是 then：条件成立时走的那一步。
		expect(parametersAt(declaration, portHead(declaration, branchId, 0))).toEqual({ action: 'wave_hello' });
		// main[1] 是 else：条件不成立时挪一点（距离 0.03，不是 main[2] 那一步的距离）。
		expect(parametersAt(declaration, portHead(declaration, branchId, 1))).toEqual({
			action: 'move_relative_ee',
			motion_direction: 'forward',
			motion_distance: 0.03,
		});
		// main[2] 是 if 执行完接着走的那一步，与走了哪一臂无关。
		expect(parametersAt(declaration, portHead(declaration, branchId, 2))).toEqual({ action: 'inspect_scene' });
	});

	it('只有 then 的计划来回一趟等价：没有 else 就给空格子（位置不省略）', () => {
		const declaration = expectRoundTrip({
			schemaVersion: 1,
			robot: 'so101_single_arm',
			plan: [
				{
					step: 'if',
					condition: { field: 'last.success', op: '!=', value: false },
					then: [{ step: 'skill', skill: 'wave_hello', timeoutSec: 5 }],
				},
			],
		});
		const branchId = declaration.nodes.find((node) => node.type === TASK_BRANCH_NODE_TYPE)?.id;
		if (branchId === undefined) throw new Error('应当有一个分支节点');
		expect(declaration.connections[branchId]?.main).toEqual([
			[{ node: portHead(declaration, branchId, 0), input: 0 }],
			[],
			[],
		]);
	});

	it('嵌套的计划来回一趟等价：臂里再放一个 if', () => {
		expectRoundTrip({
			schemaVersion: 1,
			robot: 'so101_single_arm',
			plan: [
				{
					step: 'if',
					condition: { field: 'last.success', op: '==', value: false },
					then: [
						{
							step: 'if',
							condition: { field: 'last.success', op: '!=', value: false },
							then: [{ step: 'skill', skill: 'wave_hello' }],
						},
						{ step: 'skill', skill: 'inspect_scene' },
					],
					else: [
						{
							step: 'skill',
							skill: 'move_relative_ee',
							params: { motion_direction: 'back', motion_distance: 0.02 },
							timeoutSec: 10,
						},
					],
				},
			],
		});
	});

	it('第二道闸认得出被改坏的分支臂，且 path 指到臂里那一层', () => {
		const imported = importSkillPlan(BRANCH_PLAN, context);
		if (!imported.ok) throw new Error('计划应当能导入');
		const declaration = imported.declaration;
		const branchId = declaration.nodes.find((node) => node.type === TASK_BRANCH_NODE_TYPE)?.id;
		if (branchId === undefined) throw new Error('应当有一个分支节点');
		const thenHead = portHead(declaration, branchId, 0);

		const broken: WorkflowDeclaration = {
			...declaration,
			nodes: declaration.nodes.map((node) =>
				node.id === thenHead ? { ...node, parameters: { ...node.parameters, action: 'fly' } } : node,
			),
		};
		const result = findTaskFormat('skill_plan').validateDeclaration(broken, context);
		expect(result.ok).toBe(false);
		expect(result.diagnostics.map((diagnostic) => `${diagnostic.code}@${diagnostic.path ?? ''}`)).toContain(
			'plan.step.skill.unknown@plan[1].then[0].skill',
		);
	});

	// ------------------------------------------------------------------
	// 等待：计划 → 声明 → 计划
	// ------------------------------------------------------------------

	it('等待步来回一趟等价：节点是 task.wait、参数只有 seconds，出边就一格', () => {
		const declaration = expectRoundTrip({
			schemaVersion: 1,
			robot: 'so101_single_arm',
			description: '夹住，等它稳定两秒，再移动',
			plan: [
				{ step: 'skill', skill: 'open_gripper_skill' },
				{ step: 'wait', seconds: 2 },
				{ step: 'skill', skill: 'move_relative_ee', params: { motion_direction: 'forward', motion_distance: 0.05 } },
			],
		});

		const waitIndex = declaration.nodes.findIndex((node) => node.type === TASK_WAIT_NODE_TYPE);
		const waitNode = declaration.nodes[waitIndex];
		if (waitNode === undefined) throw new Error('应当有一个等待节点');
		// 秒数原样进参数：不翻译成别的键，也不塞进技能那套 `action` 里
		expect(waitNode.parameters).toEqual({ seconds: 2 });
		expect(waitNode.name).toBe('2. 等待 2 秒');
		// **一格出边**：下一步。三格是分支专用的，等待段没有臂，给它三格等于让下游猜哪一格算数
		const groups = declaration.connections[waitNode.id]?.main;
		expect(groups).toHaveLength(1);
		expect(parametersAt(declaration, groups?.[0]?.[0]?.node)).toEqual({
			action: 'move_relative_ee',
			motion_direction: 'forward',
			motion_distance: 0.05,
		});
		// 它的父亲是前面那个技能步（不是别的东西），链是一条
		expect(parametersAt(declaration, declaration.nodes[waitIndex - 1]?.id)).toEqual({ action: 'open_gripper_skill' });
	});

	it('等待与分支混排也等价：臂里有等待、臂外也有等待', () => {
		expectRoundTrip({
			schemaVersion: 1,
			robot: 'so101_single_arm',
			description: '等一拍，看一眼；没成就重看并再等，最后再等半秒',
			plan: [
				{ step: 'wait', seconds: 1 },
				{
					step: 'if',
					condition: { field: 'last.success', op: '==', value: false },
					then: [
						{ step: 'skill', skill: 'inspect_scene' },
						{ step: 'wait', seconds: 0.5 },
					],
					else: [{ step: 'wait', seconds: 2 }],
				},
				{ step: 'wait', seconds: 0.25 },
			],
		});
	});

	// ------------------------------------------------------------------
	// 失败处置（`onFailure`）：计划 → 声明 → 计划
	// ------------------------------------------------------------------

	it('失败处置来回一趟等价：显式 continue、显式 stop 与缺省三种都在，且与分支、等待混排', () => {
		const declaration = expectRoundTrip({
			schemaVersion: 1,
			robot: 'so101_single_arm',
			description: '可能不成的一步，没成就走补救那一臂',
			plan: [
				{
					step: 'skill',
					skill: 'move_relative_ee',
					params: { motion_direction: 'forward', motion_distance: 0.1 },
					timeoutSec: 10,
					onFailure: 'continue',
				},
				{ step: 'wait', seconds: 0.5 },
				{
					step: 'if',
					condition: { field: 'last.success', op: '==', value: false },
					// 臂里也带：显式 stop 与缺省各一步——两个都该原样回来（缺省不补键）
					then: [{ step: 'skill', skill: 'inspect_scene', onFailure: 'stop' }],
					else: [{ step: 'skill', skill: 'wave_hello' }],
				},
			],
		});

		// 节点参数里那一栏是**原名**（不是技能参数），值原样带过去
		const first = declaration.nodes[0];
		expect(first?.parameters).toEqual({
			action: 'move_relative_ee',
			motion_direction: 'forward',
			motion_distance: 0.1,
			timeoutSec: 10,
			onFailure: 'continue',
		});
		const branchId = declaration.nodes.find((node) => node.type === TASK_BRANCH_NODE_TYPE)?.id;
		if (branchId === undefined) throw new Error('应当有一个分支节点');
		expect(parametersAt(declaration, portHead(declaration, branchId, 0))).toEqual({ action: 'inspect_scene', onFailure: 'stop' });
		// 缺省那一步：参数里没有这一栏（缺省是停，不许在执行侧看不见的地方写一个 stop 进去）
		expect(parametersAt(declaration, portHead(declaration, branchId, 1))).toEqual({ action: 'wave_hello' });
	});

	it('第二道闸认得出被改坏的那一栏：节点里写了一个不认的取值，还原出来照旧交给校验器判', () => {
		const imported = importSkillPlan(
			{ schemaVersion: 1, robot: 'so101_single_arm', plan: [{ step: 'skill', skill: 'wave_hello', onFailure: 'continue' }] },
			context,
		);
		if (!imported.ok) throw new Error('计划应当能导入');
		const declaration = imported.declaration;
		const head = declaration.nodes[0];
		if (head === undefined) throw new Error('应当有一步');

		const broken: WorkflowDeclaration = {
			...declaration,
			nodes: [{ ...head, parameters: { ...head.parameters, onFailure: 'keep_going' } }],
		};
		// 逆映射**不替校验器丢掉**这个取值：丢了就等于把它悄悄还原成「缺省＝停」，第二道闸再也看不见问题
		expect(declarationToSkillPlan(broken).plan).toEqual([{ step: 'skill', skill: 'wave_hello', onFailure: 'keep_going' }]);
		const result = findTaskFormat('skill_plan').validateDeclaration(broken, context);
		expect(result.ok).toBe(false);
		expect(result.diagnostics.map((item) => `${item.code}@${item.path ?? ''}`)).toEqual([
			'plan.step.onfailure_invalid@plan[0].onFailure',
		]);
	});
});
