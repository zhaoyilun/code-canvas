/**
 * 技能计划 → 声明的转换。
 *
 * 钉住五件事：
 * 1. 每个 plan 步变一个节点，`action` 是技能名、技能参数平铺在它旁边——
 *    三个视图靠 `action` 找能力，这条路与一期任务**完全一样**；
 * 2. 节点按顺序串成一条链，坐标依次右移；
 * 3. 目录说了算：技能查不到、参数名不认、类型不对，都在这一步被拦下，且带路径；
 * 4. 超时不是技能参数，带着原名进节点参数，来回一趟不丢；
 * 5. `if` 步变一个 `task.branch` 节点，条件原样进参数，**三格出边**（then / else / 这一层后面的步骤）
 *    位置就是语义——空的那一格也要占着位置，臂的链尾不接回主干。
 */
import { describe, expect, it } from 'vitest';
import {
	capabilityCatalogSchema,
	createDeterministicIdFactory,
	type CapabilityCatalog,
	type JsonObject,
	type WorkflowDeclaration,
} from '@codecanvas/contracts';
import { declarationToSkillPlan } from '../src/format';
import { TASK_BRANCH_NODE_TYPE, importSkillPlan, importSkillPlanJson } from '../src/skill-plan';

const catalog: CapabilityCatalog = capabilityCatalogSchema.parse({
	catalogRef: 'roboframe_so101_single_arm',
	displayName: 'SO-101 单臂（RoboFrame 技能库）',
	robotName: 'so101_single_arm',
	revisionRef: 'roboframe-so101-v1',
	primitives: [
		{
			primitiveRef: 'move_to_named_pose',
			label: '移动到命名位姿',
			parameters: [{ name: 'pose_name', label: '命名位姿', type: 'pose' }],
		},
	],
	capabilities: [
		{
			capabilityRef: 'inspect_scene',
			label: '观察桌面',
			kind: 'skill',
			parameters: [],
			implementation: [
				{ kind: 'call', primitiveRef: 'move_to_named_pose', arguments: { pose_name: { kind: 'literal', value: 'observe_table' } } },
			],
		},
		{
			capabilityRef: 'move_relative_ee',
			label: '相对移动',
			kind: 'skill',
			parameters: [
				{ name: 'motion_direction', label: '移动方向', type: 'string' },
				{ name: 'motion_distance', label: '移动距离（米）', type: 'number' },
			],
			implementation: [
				{ kind: 'call', primitiveRef: 'move_to_named_pose', arguments: { pose_name: { kind: 'literal', value: 'home' } } },
			],
		},
	],
});

const ids = createDeterministicIdFactory();

const PLAN = {
	schemaVersion: 1,
	robot: 'so101_single_arm',
	description: '先看一眼再挪一点',
	plan: [
		{ step: 'skill', skill: 'inspect_scene' },
		{ step: 'skill', skill: 'move_relative_ee', params: { motion_direction: 'forward', motion_distance: 0.03 }, timeoutSec: 15 },
	],
};

describe('技能计划 → 声明', () => {
	it('每个 plan 步一个节点：action 是技能名，参数平铺在它旁边', () => {
		const result = importSkillPlan(PLAN, { catalog, idFactory: ids });
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.declaration.nodes.map((node) => node.parameters)).toEqual([
			{ action: 'inspect_scene' },
			{ action: 'move_relative_ee', motion_direction: 'forward', motion_distance: 0.03, timeoutSec: 15 },
		]);
		expect(result.declaration.name).toBe('先看一眼再挪一点');
		expect(result.declaration.meta).toEqual({ schemaVersion: 1, robot: 'so101_single_arm', description: '先看一眼再挪一点' });
	});

	it('显示名用目录里的中文标签，不用技能名', () => {
		const result = importSkillPlan(PLAN, { catalog, idFactory: ids });
		if (!result.ok) throw new Error('应当通过');
		expect(result.declaration.nodes.map((node) => node.name)).toEqual(['1. 观察桌面', '2. 相对移动']);
	});

	it('按顺序串成一条链，坐标依次右移', () => {
		const result = importSkillPlan(PLAN, { catalog, idFactory: ids });
		if (!result.ok) throw new Error('应当通过');
		const [first, second] = result.declaration.nodes;
		if (first === undefined || second === undefined) throw new Error('应当有两个节点');
		expect(result.declaration.connections[first.id]).toEqual({ main: [[{ node: second.id, input: 0 }]] });
		expect(result.declaration.connections[second.id]).toBeUndefined();
		expect(second.position.x).toBeGreaterThan(first.position.x);
	});

	it('没写任务名时用机器人名兜底（界面总得有个名字可显示）', () => {
		const result = importSkillPlan({ ...PLAN, description: undefined }, { catalog, idFactory: ids });
		if (!result.ok) throw new Error('应当通过');
		expect(result.declaration.name).toBe('so101_single_arm');
	});

	it('目录说不行就是不行：技能查不到、参数不认、类型不对，都带路径回来', () => {
		const result = importSkillPlan(
			{
				schemaVersion: 1,
				robot: 'so101_single_arm',
				plan: [
					{ step: 'skill', skill: 'fly' },
					{ step: 'skill', skill: 'move_relative_ee', params: { motion_distance: 'far' } },
				],
			},
			{ catalog, idFactory: ids },
		);
		expect(result.ok).toBe(false);
		expect(result.diagnostics.map((diagnostic) => `${diagnostic.code}@${diagnostic.path ?? ''}`)).toEqual([
			'plan.step.skill.unknown@plan[0].skill',
			'plan.step.param.type@plan[1].params.motion_distance',
			// 另一个参数压根没给：提醒，不拦（目录里没有必填这一栏）。
			'plan.step.param.missing@plan[1].params',
		]);
	});

	it('文本入口：JSON 解析不了给的是自己的码，不是抛异常', () => {
		const result = importSkillPlanJson('{ not json', { catalog, idFactory: ids });
		expect(result.ok).toBe(false);
		expect(result.diagnostics[0]?.code).toBe('skill_plan_import.json_parse_error');
	});

	it('文本入口：合法 JSON 走同一条路', () => {
		const result = importSkillPlanJson(JSON.stringify(PLAN), { catalog, idFactory: ids });
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.declaration.nodes).toHaveLength(2);
	});
});

// ---------------------------------------------------------------------------
// 分支（`if` 步 → `task.branch` 节点）
// ---------------------------------------------------------------------------

/** 某一步的节点参数：拿它做**内容断言**（技能名、参数、条件都在这儿）。 */
const parametersAt = (declaration: WorkflowDeclaration, nodeId: string | undefined): JsonObject | undefined =>
	nodeId === undefined ? undefined : declaration.nodes.find((node) => node.id === nodeId)?.parameters;

const typeAt = (declaration: WorkflowDeclaration, nodeId: string | undefined): string | undefined =>
	nodeId === undefined ? undefined : declaration.nodes.find((node) => node.id === nodeId)?.type;

/** 某一步第 `port` 格出边指向谁（位置就是语义：0=then，1=else，2=这一层后面那一步）。 */
const portHead = (declaration: WorkflowDeclaration, nodeId: string, port: number): string | undefined =>
	declaration.connections[nodeId]?.main?.[port]?.[0]?.node;

/** 谁指向了这一步。用来断言「后续那一步只挂在分支节点上」，而不是从两条臂汇回来的。 */
const parentsOf = (declaration: WorkflowDeclaration, nodeId: string): string[] =>
	Object.entries(declaration.connections).flatMap(([sourceId, ports]) =>
		Object.values(ports).flatMap((groups) =>
			groups.flatMap((group) => group.filter((target) => target.node === nodeId).map(() => sourceId)),
		),
	);

const branchIdOf = (declaration: WorkflowDeclaration): string | undefined =>
	declaration.nodes.find((node) => node.type === TASK_BRANCH_NODE_TYPE)?.id;

const branchIdAt = (declaration: WorkflowDeclaration, parentId: string | undefined, port: number): string | undefined =>
	parentId === undefined ? undefined : portHead(declaration, parentId, port);

/**
 * 身份字段（id / digest）不参与比较——同一份计划导入两次本来就是两个文档；
 * 出边按**节点显示名**比对，于是内容一样就相等。
 */
const stripVolatile = (declaration: WorkflowDeclaration) => {
	const nameOf = new Map(declaration.nodes.map((node) => [node.id, node.name]));
	return {
		name: declaration.name,
		meta: declaration.meta,
		nodes: declaration.nodes.map((node) => ({ name: node.name, type: node.type, parameters: node.parameters })),
		connections: Object.fromEntries(
			declaration.nodes.map((node) => [
				node.name,
				(declaration.connections[node.id]?.main ?? []).map((group) =>
					group.map((target) => ({ node: nameOf.get(target.node), input: target.input })),
				),
			]),
		),
	};
};

/** 「看一眼 → 没成就再看一眼，否则往前挪一点 → 再往前挪一点」：分支在中间，后面还有同层步骤。 */
const BRANCH_PLAN = {
	schemaVersion: 1,
	robot: 'so101_single_arm',
	description: '看一眼，没成就重看，否则挪一点，最后再挪一点',
	plan: [
		{ step: 'skill', skill: 'inspect_scene' },
		{
			step: 'if',
			condition: { field: 'last.success', op: '==', value: false },
			then: [{ step: 'skill', skill: 'inspect_scene' }],
			else: [
				{ step: 'skill', skill: 'move_relative_ee', params: { motion_direction: 'forward', motion_distance: 0.03 } },
			],
		},
		{ step: 'skill', skill: 'move_relative_ee', params: { motion_direction: 'forward', motion_distance: 0.01 } },
	],
};

describe('技能计划的分支 → 声明', () => {
	it('`if` 步一个 `task.branch` 节点，条件**原样**进参数（键名照 SkillPlan 里写）', () => {
		const result = importSkillPlan(BRANCH_PLAN, { catalog, idFactory: ids });
		if (!result.ok) throw new Error('应当通过');
		const branchId = branchIdOf(result.declaration);
		expect(branchId).toBeDefined();
		expect(typeAt(result.declaration, branchId)).toBe(TASK_BRANCH_NODE_TYPE);
		expect(parametersAt(result.declaration, branchId)).toEqual({
			condition: { field: 'last.success', op: '==', value: false },
		});
		// 分支节点不是技能：它没有 `action`，三个视图不会拿它去目录里找能力。
		expect(parametersAt(result.declaration, branchId)).not.toHaveProperty('action');
	});

	it('三格出边：main[0]=then 的头、main[1]=else 的头、main[2]=这一层后面的步骤（内容断言）', () => {
		const result = importSkillPlan(BRANCH_PLAN, { catalog, idFactory: ids });
		if (!result.ok) throw new Error('应当通过');
		const declaration = result.declaration;
		const branchId = branchIdOf(declaration);
		if (branchId === undefined) throw new Error('应当有一个分支节点');

		const groups = declaration.connections[branchId]?.main;
		expect(groups).toHaveLength(3);

		// then 那一臂：就是条件成立时要重看的那一眼。
		expect(parametersAt(declaration, portHead(declaration, branchId, 0))).toEqual({ action: 'inspect_scene' });
		// else 那一臂：挪一点（距离 0.03）。
		expect(parametersAt(declaration, portHead(declaration, branchId, 1))).toEqual({
			action: 'move_relative_ee',
			motion_direction: 'forward',
			motion_distance: 0.03,
		});
		// 第三格：if 之后接着走的步骤（距离 0.01），与走了哪一臂无关。
		expect(parametersAt(declaration, portHead(declaration, branchId, 2))).toEqual({
			action: 'move_relative_ee',
			motion_direction: 'forward',
			motion_distance: 0.01,
		});

		// 节点声明顺序：分支节点之后紧跟着它的两条臂，然后才是后续步骤。
		expect(declaration.nodes.map((node) => node.type)).toEqual([
			'task.action',
			TASK_BRANCH_NODE_TYPE,
			'task.action',
			'task.action',
			'task.action',
		]);
	});

	it('不回汇：两条臂的链尾没有出边，后续步骤只挂在分支节点上', () => {
		const result = importSkillPlan(BRANCH_PLAN, { catalog, idFactory: ids });
		if (!result.ok) throw new Error('应当通过');
		const declaration = result.declaration;
		const branchId = branchIdOf(declaration);
		if (branchId === undefined) throw new Error('应当有一个分支节点');

		const thenHead = portHead(declaration, branchId, 0);
		const elseHead = portHead(declaration, branchId, 1);
		const continuation = portHead(declaration, branchId, 2);
		if (thenHead === undefined || elseHead === undefined || continuation === undefined) throw new Error('三格都该有东西');

		// 两条臂各自收尾：链尾没有出边。
		expect(declaration.connections[thenHead]).toBeUndefined();
		expect(declaration.connections[elseHead]).toBeUndefined();
		// 后续那一步只有分支节点一个父亲——不是从两条臂收进来的。
		expect(parentsOf(declaration, continuation)).toEqual([branchId]);
		// 分支节点自己的父亲是前一步。
		expect(parentsOf(declaration, branchId)).toEqual([declaration.nodes[0]?.id]);
	});

	it('没有 else、后面也没有步骤：两格都留空数组，位置不省略', () => {
		const result = importSkillPlan(
			{
				schemaVersion: 1,
				robot: 'so101_single_arm',
				plan: [{ step: 'if', condition: { field: 'last.success', op: '!=', value: true }, then: [{ step: 'skill', skill: 'inspect_scene' }] }],
			},
			{ catalog, idFactory: ids },
		);
		if (!result.ok) throw new Error('应当通过');
		const branchId = branchIdOf(result.declaration);
		if (branchId === undefined) throw new Error('应当有一个分支节点');
		const thenHead = portHead(result.declaration, branchId, 0);
		expect(result.declaration.connections[branchId]).toEqual({
			main: [[{ node: thenHead, input: 0 }], [], []],
		});
	});

	it('臂里再放 `if`：嵌套的也各是三格，外层的 then 指向内层分支节点', () => {
		const result = importSkillPlan(
			{
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
								then: [{ step: 'skill', skill: 'inspect_scene' }],
								else: [{ step: 'skill', skill: 'move_relative_ee', params: { motion_direction: 'back', motion_distance: 0.02 } }],
							},
							{ step: 'skill', skill: 'inspect_scene' },
						],
					},
				],
			},
			{ catalog, idFactory: ids },
		);
		if (!result.ok) throw new Error('应当通过');
		const declaration = result.declaration;
		const outer = branchIdOf(declaration);
		if (outer === undefined) throw new Error('应当有外层分支节点');
		const inner = branchIdAt(declaration, outer, 0);
		expect(typeAt(declaration, inner)).toBe(TASK_BRANCH_NODE_TYPE);
		if (inner === undefined) throw new Error('应当有内层分支节点');

		expect(parametersAt(declaration, portHead(declaration, inner, 0))).toEqual({ action: 'inspect_scene' });
		expect(parametersAt(declaration, portHead(declaration, inner, 1))).toEqual({
			action: 'move_relative_ee',
			motion_direction: 'back',
			motion_distance: 0.02,
		});
		// 内层的第三格是「内层 if 之后」那一步——它在 then 臂里，链尾不再接回外层。
		expect(parametersAt(declaration, portHead(declaration, inner, 2))).toEqual({ action: 'inspect_scene' });
		expect(declaration.connections[outer]?.main?.[1]).toEqual([]);
	});

	it('来回一趟字节等价：带分支的计划 → 声明 → 计划', () => {
		const first = importSkillPlan(BRANCH_PLAN, { catalog, idFactory: ids });
		if (!first.ok) throw new Error('计划应当能导入');

		const restored = declarationToSkillPlan(first.declaration);
		expect(restored).toEqual(BRANCH_PLAN);
		// 深等价之外再钉一次字节：键序也照冻结的形状（schemaVersion / robot / description / plan，
		// 以及 step / condition / then / else）。
		expect(JSON.stringify(restored)).toBe(JSON.stringify(BRANCH_PLAN));

		// 还原出来的计划再导一遍，声明的内容照旧（身份字段 id / digest 每次导入本来就不一样）。
		const second = importSkillPlan(restored, { catalog, idFactory: ids });
		if (!second.ok) throw new Error('还原出来的计划应当能再导入');
		expect(stripVolatile(second.declaration)).toEqual(stripVolatile(first.declaration));
	});
});
