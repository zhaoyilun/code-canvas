/**
 * 写回通道的两道闸。
 *
 * 这一组测试的存在理由：声明层的 schema **故意不解释 `parameters`**，
 * 所以「越界参数」在结构校验那一层是拦不住的。如果哪天有人把 `applyDeclaration`
 * 里的任务层校验删掉，这里必须红。
 */
import { beforeEach, describe, expect, it } from 'vitest';
import type { JsonValue, WorkflowDeclaration } from '@codecanvas/contracts';
import { useStudioDocument } from './document';
import { SAMPLE_TASK_JSON } from './sample-task';

const doc = useStudioDocument();

const indexOfStep = (stepId: string): number => {
	const index = doc.nodes.value.findIndex((node) => node.parameters.step_id === stepId);
	if (index < 0) throw new Error(`no node for step ${stepId}`);
	return index;
};

const paramsOf = (stepId: string): Record<string, unknown> =>
	(doc.nodes.value[indexOfStep(stepId)]?.parameters ?? {}) as Record<string, unknown>;

/** 改某个节点的参数，交出一份新声明——摘要由写回通道负责重算。 */
const withParameter = (stepId: string, patch: Record<string, JsonValue>): WorkflowDeclaration => {
	const current = doc.declaration.value;
	if (current === null) throw new Error('no declaration loaded');
	const index = indexOfStep(stepId);
	const nodes = current.nodes.map((node, i) =>
		i === index ? { ...node, parameters: { ...node.parameters, ...patch } } : node,
	);
	return { ...current, nodes };
};

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
		expect(doc.loadTaskJson(SAMPLE_TASK_JSON)).toBe(true);
	});

	it('合法改动写进真相', () => {
		expect(doc.applyDeclaration(withParameter('s1', { duration: 7.5 }))).toBe(true);
		expect(paramsOf('s1').duration).toBe(7.5);
	});

	it('distance = 0 被任务层拦住，真相不动', () => {
		const before = doc.declaration.value;
		expect(doc.applyDeclaration(withParameter('s2', { distance: 0 }))).toBe(false);
		expect(doc.declaration.value).toBe(before);
		expect(paramsOf('s2').distance).toBe(0.5);
		expect(doc.diagnostics.value.length).toBeGreaterThan(0);
	});

	it('distance 超过 2 米被拦住', () => {
		expect(doc.applyDeclaration(withParameter('s2', { distance: 5 }))).toBe(false);
		expect(paramsOf('s2').distance).toBe(0.5);
	});

	it('linear 超过任务限值 max_linear 被拦住', () => {
		expect(doc.applyDeclaration(withParameter('s1', { linear: 0.9 }))).toBe(false);
		expect(paramsOf('s1').linear).toBe(0.2);
	});

	it('未知 action 被拦住', () => {
		expect(doc.applyDeclaration(withParameter('s4', { action: 'fly' }))).toBe(false);
		expect(paramsOf('s4').action).toBe('stop');
	});

	it('id 含空格这类结构错误被第一道闸拦住', () => {
		const current = doc.declaration.value;
		if (current === null) throw new Error('no declaration loaded');
		const nodes = current.nodes.map((node, i) => (i === 0 ? { ...node, id: 'bad id' } : node));
		expect(doc.applyDeclaration({ ...current, nodes })).toBe(false);
	});

	it('arm_joint 的 joint_id 越界被拦住', () => {
		expect(
			doc.loadTaskJson(
				taskWithSteps([{ id: 'a1', action: 'arm_joint', joint_id: 1, joint: 90, time: 1500 }]),
			),
		).toBe(true);
		expect(doc.applyDeclaration(withParameter('a1', { joint_id: 9 }))).toBe(false);
		expect(paramsOf('a1').joint_id).toBe(1);
	});
});
