/**
 * 写回通道的两道闸。
 *
 * 这一组测试的存在理由：声明层的 schema **故意不解释 `parameters`**，
 * 所以「越界参数」在结构校验那一层是拦不住的。如果哪天有人把 `applyDeclaration`
 * 里的任务层校验删掉，这里必须红。
 *
 * 后面那一组守的是**第二道闸拿哪把尺子**：声明出生时那台设备的格式，而不是现在选中的设备。
 * 「生成之后换台设备看看，再回来改一个数字」是常事，那时声明没坏——坏的是尺子。
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { PHASE1_ROBOT_CATALOG } from '@codecanvas/capabilities';
import type { JsonValue, WorkflowDeclaration } from '@codecanvas/contracts';
import { findTaskFormat } from '@codecanvas/task-import';
import { setSelectedDevice, DEVICES } from '../shell/devices';
import { loadSampleTask, useStudioDocument } from './document';
import { SAMPLE_SKILL_PLAN_JSON } from './sample-skill-plan';
import { SAMPLE_TASK_JSON } from './sample-task';

const doc = useStudioDocument();

const nodes = () => doc.nodes.value;

/** 一期设备的步：节点参数里带 `step_id`。 */
const indexOfStep = (stepId: string): number => {
	const index = nodes().findIndex((node) => node.parameters['step_id'] === stepId);
	if (index < 0) throw new Error(`no node for step ${stepId}`);
	return index;
};

/** 技能计划那台的步：`action` 就是技能名（见 `@codecanvas/task-import` 的 skill-plan）。 */
const indexOfSkill = (skill: string): number => {
	const index = nodes().findIndex((node) => node.parameters['action'] === skill);
	if (index < 0) throw new Error(`no node for skill ${skill}`);
	return index;
};

const paramsAt = (index: number): Record<string, unknown> =>
	(nodes()[index]?.parameters ?? {}) as Record<string, unknown>;

const paramsOf = (stepId: string): Record<string, unknown> => paramsAt(indexOfStep(stepId));

const currentDeclaration = (): WorkflowDeclaration => {
	const current = doc.declaration.value;
	if (current === null) throw new Error('no declaration loaded');
	return current;
};

/** 改某个节点的参数，交出一份新声明——摘要由写回通道负责重算。 */
const withNodeParameter = (index: number, patch: Record<string, JsonValue>): WorkflowDeclaration => {
	const current = currentDeclaration();
	const updated = current.nodes.map((node, i) =>
		i === index ? { ...node, parameters: { ...node.parameters, ...patch } } : node,
	);
	return { ...current, nodes: updated };
};

const withParameter = (stepId: string, patch: Record<string, JsonValue>): WorkflowDeclaration =>
	withNodeParameter(indexOfStep(stepId), patch);

const taskWithSteps = (steps: unknown): string =>
	JSON.stringify({
		schema_version: '1.0',
		task_id: 'task-test',
		description: '测试用任务',
		steps,
		limits: { max_linear: 0.3, max_angular: 1.2, max_duration: 30.0, require_confirmation: true },
	});

describe('applyDeclaration', () => {
	beforeEach(() => {
		// 这一组量的是**一期那把尺子**，所以设备也得是一期那台：
		// 格式是设备属性，设备换了，格式就换了。
		setSelectedDevice('phase1_robot');
		expect(doc.loadTaskJson(SAMPLE_TASK_JSON)).toBe(true);
	});

	it('合法改动写进真相', () => {
		expect(doc.applyDeclaration(withParameter('s1', { duration: 7.5 }))).toBe(true);
		expect(paramsOf('s1')['duration']).toBe(7.5);
	});

	it('distance = 0 被任务层拦住，真相不动', () => {
		const before = doc.declaration.value;
		expect(doc.applyDeclaration(withParameter('s2', { distance: 0 }))).toBe(false);
		expect(doc.declaration.value).toBe(before);
		expect(paramsOf('s2')['distance']).toBe(0.5);
		expect(doc.diagnostics.value.length).toBeGreaterThan(0);
	});

	it('distance 超过 2 米被拦住', () => {
		expect(doc.applyDeclaration(withParameter('s2', { distance: 5 }))).toBe(false);
		expect(paramsOf('s2')['distance']).toBe(0.5);
	});

	it('linear 超过任务限值 max_linear 被拦住', () => {
		expect(doc.applyDeclaration(withParameter('s1', { linear: 0.9 }))).toBe(false);
		expect(paramsOf('s1')['linear']).toBe(0.2);
	});

	it('未知 action 被拦住', () => {
		expect(doc.applyDeclaration(withParameter('s4', { action: 'fly' }))).toBe(false);
		expect(paramsOf('s4')['action']).toBe('stop');
	});

	it('id 含空格这类结构错误被第一道闸拦住', () => {
		const current = currentDeclaration();
		const updated = current.nodes.map((node, i) => (i === 0 ? { ...node, id: 'bad id' } : node));
		expect(doc.applyDeclaration({ ...current, nodes: updated })).toBe(false);
	});

	it('arm_joint 的 joint_id 越界被拦住', () => {
		expect(
			doc.loadTaskJson(
				taskWithSteps([{ id: 'a1', action: 'arm_joint', joint_id: 1, joint: 90, time: 1500 }]),
			),
		).toBe(true);
		expect(doc.applyDeclaration(withParameter('a1', { joint_id: 9 }))).toBe(false);
		expect(paramsOf('a1')['joint_id']).toBe(1);
	});
});

describe('第二道闸的尺子来自声明出生时那台设备', () => {
	it('启动样例跟着设备走：默认那台（技能计划）下也灌得进去，界面起手不是空的', () => {
		const first = DEVICES[0];
		if (first === undefined) throw new Error('设备表不该是空的');
		setSelectedDevice(first.deviceRef);

		expect(loadSampleTask()).toBe(true);
		expect(doc.declarationFormatRef.value).toBe(first.formatRef);
		expect(doc.nodes.value.length).toBeGreaterThan(0);
	});

	it('技能计划格式下能进：真相换了，出生格式记成 skill_plan', () => {
		setSelectedDevice('so101_robot');
		expect(doc.loadTaskJson(SAMPLE_SKILL_PLAN_JSON)).toBe(true);
		expect(doc.declarationFormatRef.value).toBe('skill_plan');
		expect(doc.declaration.value?.nodes).toHaveLength(3);
	});

	it('技能计划格式下，一期那份样例进不来（所以启动样例得跟着设备走）', () => {
		setSelectedDevice('so101_robot');
		const before = doc.declaration.value;
		expect(doc.loadTaskJson(SAMPLE_TASK_JSON)).toBe(false);
		expect(doc.declaration.value).toBe(before);
		expect(doc.diagnostics.value.length).toBeGreaterThan(0);
	});

	it('导入之后换成一期设备，写回仍按出生时那套技能计划判：改一个技能参数照样成功', () => {
		setSelectedDevice('so101_robot');
		expect(doc.loadTaskJson(SAMPLE_SKILL_PLAN_JSON)).toBe(true);
		const index = indexOfSkill('move_relative_ee');
		expect(paramsAt(index)['motion_distance']).toBe(0.03);

		// 用户换设备：声明还是技能计划产出的，出生格式不该跟着变。
		setSelectedDevice('phase1_robot');
		expect(doc.declarationFormatRef.value).toBe('skill_plan');

		expect(doc.applyDeclaration(withNodeParameter(index, { motion_distance: 0.05 }))).toBe(true);
		expect(paramsAt(index)['motion_distance']).toBe(0.05);
		expect(doc.declarationFormatRef.value).toBe('skill_plan');
	});

	it('技能计划下**不换设备**直接改一个技能参数也写得回（就是积木字段那一步）', () => {
		setSelectedDevice('so101_robot');
		expect(doc.loadTaskJson(SAMPLE_SKILL_PLAN_JSON)).toBe(true);
		const index = indexOfSkill('move_relative_ee');

		const next = withNodeParameter(index, { motion_distance: 0.07 });
		expect(doc.applyDeclaration(next)).toBe(true);
		expect(paramsAt(index)['motion_distance']).toBe(0.07);
		// 尤其不许再出现「meta 里没有 task_id / schema_version / limits」那三条：
		// 那是拿一期的尺子量技能计划的声明才会报的，两份格式的 meta 本来就不一样。
		expect(doc.diagnostics.value).toEqual([]);
	});

	it('反证：同一份声明拿一期那把尺子量是过不去的——所以尺子只能取出生时那把', () => {
		setSelectedDevice('so101_robot');
		expect(doc.loadTaskJson(SAMPLE_SKILL_PLAN_JSON)).toBe(true);

		const phase1 = findTaskFormat('phase1_task');
		const measured = phase1.validateDeclaration(currentDeclaration(), { catalog: PHASE1_ROBOT_CATALOG });

		expect(measured.ok).toBe(false);
		expect(measured.diagnostics.some((diagnostic) => diagnostic.code.includes('action'))).toBe(true);
	});
});
