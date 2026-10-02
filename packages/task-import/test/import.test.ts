import {
	canonicalWorkflowBytes,
	computeWorkflowDigest,
	createDeterministicIdFactory,
	isStableReference,
	validateWorkflowDeclaration,
	type WorkflowDeclaration,
} from '@codecanvas/contracts';
import { describe, expect, it } from 'vitest';
import {
	importTask,
	importTaskJson,
	NODE_HORIZONTAL_SPACING,
	TASK_ACTION_NODE_TYPE,
	TASK_ACTION_NODE_TYPE_VERSION,
} from '../src/convert';

const DEFAULT_LIMITS = {
	max_linear: 0.3,
	max_angular: 1.2,
	max_duration: 30.0,
	require_confirmation: true,
};

const FULL_TASK = {
	schema_version: '1.0',
	task_id: 'task-canvas-001',
	description: '前进1米，避障后停止',
	steps: [
		{ id: 'step-move', action: 'move', linear: 0.2, angular: 0.0, duration: 5.0 },
		{ id: 'step-scan', action: 'stop_if_obstacle', sensors: ['/scan0', '/scan1'], distance: 1.5 },
		{ id: 'step-turn', action: 'turn', angular: -0.8, duration: 1.5 },
		{ id: 'step-stop', action: 'stop' },
		{ id: 'step-status', action: 'get_status' },
		{ id: 'step-arm', action: 'arm_joint', joint_id: 3, joint: 90 },
		{ id: 'step-arm6', action: 'arm6_joints', joint1: 0, joint2: 45, joint3: 90, joint4: 135, joint5: 180, joint6: 90, time: 2000 },
	],
	limits: DEFAULT_LIMITS,
};

const deterministic = () => createDeterministicIdFactory({ seed: 'task-import-fixture' });

const importWithFactory = (task: unknown) => {
	const result = importTask(task, { idFactory: deterministic() });
	if (!result.ok) throw new Error(`导入失败：${result.diagnostics.map((diagnostic) => diagnostic.message).join('; ')}`);
	return result.declaration;
};

const deepFreeze = <T>(value: T): T => {
	if (value !== null && typeof value === 'object') {
		for (const child of Object.values(value)) deepFreeze(child);
		Object.freeze(value);
	}
	return value;
};

describe('任务 → 声明', () => {
	it('每个 step 一个节点，按顺序串成一条链', () => {
		const declaration = importWithFactory(FULL_TASK);
		expect(declaration.nodes).toHaveLength(FULL_TASK.steps.length);

		for (let index = 0; index < declaration.nodes.length; index += 1) {
			const node = declaration.nodes[index];
			expect(node?.position).toEqual({ x: index * NODE_HORIZONTAL_SPACING, y: 0 });
			expect(node?.type).toBe(TASK_ACTION_NODE_TYPE);
			expect(node?.typeVersion).toBe(TASK_ACTION_NODE_TYPE_VERSION);
			expect(node?.disabled).toBe(false);
			expect(node?.parameters['step_id']).toBe(FULL_TASK.steps[index]?.id);
			expect(node?.parameters['action']).toBe(FULL_TASK.steps[index]?.action);
		}

		const sourceIds = Object.keys(declaration.connections);
		expect(sourceIds).toEqual(declaration.nodes.slice(0, -1).map((node) => node.id));
		declaration.nodes.slice(0, -1).forEach((node, index) => {
			expect(declaration.connections[node.id]).toEqual({
				main: [[{ node: declaration.nodes[index + 1]?.id, input: 0 }]],
			});
		});
		expect(declaration.connections[declaration.nodes[declaration.nodes.length - 1]?.id ?? '']).toBeUndefined();
	});

	it('limits / task_id / description 进 meta，description 兼作流程名', () => {
		const declaration = importWithFactory(FULL_TASK);
		expect(declaration.meta).toEqual({
			schema_version: '1.0',
			task_id: 'task-canvas-001',
			description: '前进1米，避障后停止',
			limits: DEFAULT_LIMITS,
		});
		expect(declaration.name).toBe('前进1米，避障后停止');
	});

	it('没有 description 时退回 task_id 作名字，且 meta 不塞空字段', () => {
		const declaration = importWithFactory({
			schema_version: '1.0',
			task_id: 'task-no-desc',
			steps: [{ id: 's1', action: 'stop' }],
			limits: DEFAULT_LIMITS,
		});
		expect(declaration.name).toBe('task-no-desc');
		expect('description' in declaration.meta).toBe(false);
	});

	it('生成物自身通过声明校验（含 digest）', () => {
		const declaration = importWithFactory(FULL_TASK);
		const validation = validateWorkflowDeclaration(declaration);
		expect(validation.ok, validation.diagnostics.map((d) => `${d.path}: ${d.message}`).join('\n')).toBe(true);
		expect(declaration.digest).toBe(computeWorkflowDigest(declaration));
	});

	it('time 缺省被解析成 1500 写进参数', () => {
		const declaration = importWithFactory({
			schema_version: '1.0',
			task_id: 'task-arm',
			steps: [{ id: 's1', action: 'arm_joint', joint_id: 1, joint: 30 }],
			limits: DEFAULT_LIMITS,
		});
		expect(declaration.nodes[0]?.parameters).toMatchObject({ action: 'arm_joint', joint_id: 1, joint: 30, time: 1500 });
	});

	it('节点名工作流内唯一，id 满足稳定引用词法', () => {
		const declaration = importWithFactory({
			schema_version: '1.0',
			task_id: 'task-dup-action',
			steps: [
				{ id: 's1', action: 'move', linear: 0.1, angular: 0, duration: 1 },
				{ id: 's2', action: 'move', linear: 0.1, angular: 0, duration: 1 },
			],
			limits: DEFAULT_LIMITS,
		});
		const names = declaration.nodes.map((node) => node.name);
		expect(new Set(names).size).toBe(names.length);
		const ids = [declaration.id, ...declaration.nodes.map((node) => node.id)];
		expect(new Set(ids).size).toBe(ids.length);
		for (const id of ids) expect(isStableReference(id), id).toBe(true);
	});

	it('不修改输入任务（冻结对象也能导入）', () => {
		const frozen = deepFreeze(structuredClone(FULL_TASK));
		expect(() => importWithFactory(frozen)).not.toThrow();
		expect(JSON.stringify(frozen)).toBe(JSON.stringify(FULL_TASK));
	});
});

describe('确定性', () => {
	it('同一输入连续两次，规范化产物字节级相同', () => {
		const first = importTask(FULL_TASK, { idFactory: deterministic() });
		const second = importTask(FULL_TASK, { idFactory: deterministic() });
		expect(first.ok && second.ok).toBe(true);
		if (!first.ok || !second.ok) return;
		expect(canonicalWorkflowBytes(first.declaration)).toBe(canonicalWorkflowBytes(second.declaration));
		expect(first.declaration.digest).toBe(second.declaration.digest);
	});

	it('默认工厂下 id 各不相同（导入即新文档）', () => {
		const first = importTask(FULL_TASK);
		const second = importTask(FULL_TASK);
		expect(first.ok && second.ok).toBe(true);
		if (!first.ok || !second.ok) return;
		expect(first.declaration.id).not.toBe(second.declaration.id);
		expect(first.declaration.nodes[0]?.id).not.toBe(second.declaration.nodes[0]?.id);
		// 内容摘要跟着 id 变：digest 回答的是「这份产物是不是从那份声明来的」。
		expect(first.declaration.digest).not.toBe(second.declaration.digest);
	});
});

describe('非法任务只回诊断', () => {
	it('放宽限值被拒，且不产出声明', () => {
		const result = importTask({ ...FULL_TASK, limits: { ...DEFAULT_LIMITS, max_linear: 0.9, max_duration: 60 } });
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.diagnostics.map((diagnostic) => diagnostic.code)).toEqual(
			expect.arrayContaining(['limits.max_linear.exceeds', 'limits.max_duration.exceeds']),
		);
		expect('declaration' in result).toBe(false);
	});

	it('未知 action / 重复 step id 都带定位', () => {
		const result = importTask({
			schema_version: '1.0',
			task_id: 'task-bad',
			steps: [
				{ id: 's1', action: 'fly' },
				{ id: 's1', action: 'stop' },
			],
			limits: DEFAULT_LIMITS,
		});
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.diagnostics.map((diagnostic) => diagnostic.code)).toEqual(
			expect.arrayContaining(['step.action.unknown', 'step.id.duplicate']),
		);
		expect(result.diagnostics.find((diagnostic) => diagnostic.code === 'step.action.unknown')?.path).toBe('steps[0].action');
	});

	it('JSON 解析失败也是诊断，不抛裸异常', () => {
		const result = importTaskJson('{ not json');
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.diagnostics[0]?.code).toBe('task_import.json_parse_error');
	});

	it('JSON 文本导入与对象导入等价', () => {
		const fromJson = importTaskJson(JSON.stringify(FULL_TASK), { idFactory: deterministic() });
		const fromObject = importTask(FULL_TASK, { idFactory: deterministic() });
		expect(fromJson.ok && fromObject.ok).toBe(true);
		if (!fromJson.ok || !fromObject.ok) return;
		expect(canonicalWorkflowBytes(fromJson.declaration)).toBe(canonicalWorkflowBytes(fromObject.declaration));
	});
});

describe('参数载荷', () => {
	it('七种 action 的参数形状与校验器字段一致', () => {
		const declaration: WorkflowDeclaration = importWithFactory(FULL_TASK);
		const parameters = declaration.nodes.map((node) => node.parameters);
		expect(parameters[0]).toEqual({ step_id: 'step-move', action: 'move', linear: 0.2, angular: 0, duration: 5 });
		expect(parameters[1]).toEqual({
			step_id: 'step-scan',
			action: 'stop_if_obstacle',
			sensors: ['/scan0', '/scan1'],
			distance: 1.5,
		});
		expect(parameters[2]).toEqual({ step_id: 'step-turn', action: 'turn', angular: -0.8, duration: 1.5 });
		expect(parameters[3]).toEqual({ step_id: 'step-stop', action: 'stop' });
		expect(parameters[4]).toEqual({ step_id: 'step-status', action: 'get_status' });
		expect(parameters[5]).toEqual({ step_id: 'step-arm', action: 'arm_joint', joint_id: 3, joint: 90, time: 1500 });
		expect(parameters[6]).toEqual({
			step_id: 'step-arm6',
			action: 'arm6_joints',
			joint1: 0,
			joint2: 45,
			joint3: 90,
			joint4: 135,
			joint5: 180,
			joint6: 90,
			time: 2000,
		});
	});

	it('step_id 是语义身份：重排步骤不改变「哪一块对应哪一步」', () => {
		const reordered: unknown = {
			schema_version: '1.0',
			task_id: 'task-reorder',
			steps: [
				{ id: 'step-stop', action: 'stop' },
				{ id: 'step-move', action: 'move', linear: 0.1, angular: 0, duration: 1 },
			],
			limits: DEFAULT_LIMITS,
		};
		const declaration = importWithFactory(reordered);
		expect(declaration.nodes.map((node) => node.parameters['step_id'])).toEqual(['step-stop', 'step-move']);
		expect(declaration.nodes.map((node) => node.name)).toEqual(['1. stop', '2. move']);
	});
});
