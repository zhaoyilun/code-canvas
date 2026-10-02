/**
 * 技能计划 → 声明的转换。
 *
 * 钉住四件事：
 * 1. 每个 plan 步变一个节点，`action` 是技能名、技能参数平铺在它旁边——
 *    三个视图靠 `action` 找能力，这条路与一期任务**完全一样**；
 * 2. 节点按顺序串成一条链，坐标依次右移；
 * 3. 目录说了算：技能查不到、参数名不认、类型不对，都在这一步被拦下，且带路径；
 * 4. 超时不是技能参数，带着原名进节点参数，来回一趟不丢。
 */
import { describe, expect, it } from 'vitest';
import { capabilityCatalogSchema, createDeterministicIdFactory, type CapabilityCatalog } from '@codecanvas/contracts';
import { importSkillPlan, importSkillPlanJson } from '../src/skill-plan';

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
