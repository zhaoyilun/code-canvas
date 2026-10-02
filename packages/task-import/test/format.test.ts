/**
 * 两种任务格式的**来回一趟**：声明 → 任务 JSON → 声明，内容必须一样。
 *
 * 这一条是 JSON 视图的底气：那个视图显示的是「声明还原成的原文」，
 * 如果来回一趟会丢东西或变形，它显示的就是另一份东西，而不是同一份真相的另一种写法。
 *
 * 两条路都用**真实目录**跑：一期用示意目录，技能计划用上游 RoboFrame 转出来的那份。
 */
import { describe, expect, it } from 'vitest';
import { PHASE1_ROBOT_CATALOG, ROBOFRAME_SO101_CATALOG } from '@codecanvas/capabilities';
import { createDeterministicIdFactory, type WorkflowDeclaration } from '@codecanvas/contracts';
import { declarationToSkillPlan, declarationToTask, findTaskFormat } from '../src/format';
import { importSkillPlan } from '../src/skill-plan';
import { importTaskJson } from '../src/convert';

const ids = createDeterministicIdFactory();

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
		const broken = { schemaVersion: 1, robot: 'so101_single_arm', plan: [{ step: 'wait', seconds: 2 }] };
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
});
