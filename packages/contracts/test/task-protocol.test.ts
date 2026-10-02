import { describe, expect, it } from 'vitest';
import { DEFAULT_LIMITS, explainTask, validateTask, type TaskValidationResult } from '../src/task-protocol';
import { TASK_CASES, type TaskCase } from './fixtures/task-cases';

const runCase = (testCase: TaskCase): TaskValidationResult =>
	validateTask(testCase.task, testCase.seenTaskIds === undefined ? {} : { seenTaskIds: testCase.seenTaskIds });

const codesOf = (result: TaskValidationResult): string[] => result.diagnostics.map((diagnostic) => diagnostic.code);

describe('任务协议对照语料（内建期望值）', () => {
	for (const testCase of TASK_CASES) {
		it(`${testCase.expectation === 'valid' ? '接受' : '拒绝'}：${testCase.name}`, () => {
			const result = runCase(testCase);
			expect(result.ok, explainTask(testCase.task)).toBe(testCase.expectation === 'valid');
			for (const expected of testCase.expectedCodes ?? []) {
				expect(codesOf(result), `缺诊断码 ${expected}`).toContain(expected);
			}
		});
	}
});

describe('诊断带定位', () => {
	it('除「任务不是对象」外，每条 error 都带 path', () => {
		for (const testCase of TASK_CASES) {
			for (const diagnostic of runCase(testCase).diagnostics) {
				if (diagnostic.severity !== 'error' || diagnostic.code === 'task.not_object') continue;
				expect(diagnostic.path, `${testCase.name} / ${diagnostic.code}`).toBeTruthy();
			}
		}
	});

	it('step 级诊断带上 step id 作为 ref', () => {
		const result = validateTask({
			schema_version: '1.0',
			task_id: 't1',
			steps: [{ id: 'step-a', action: 'move', linear: 9, angular: 0, duration: 1 }],
			limits: DEFAULT_LIMITS,
		});
		expect(result.ok).toBe(false);
		if (result.ok) return;
		const [first] = result.diagnostics;
		expect(first?.code).toBe('step.move.linear.range');
		expect(first?.path).toBe('steps[0].linear');
		expect(first?.ref).toBe('step-a');
	});

	it('重复 step id 指向第二处', () => {
		const result = validateTask({
			schema_version: '1.0',
			task_id: 't1',
			steps: [
				{ id: 'dup', action: 'stop' },
				{ id: 'dup', action: 'stop' },
			],
			limits: DEFAULT_LIMITS,
		});
		const duplicate = result.diagnostics.find((diagnostic) => diagnostic.code === 'step.id.duplicate');
		expect(duplicate?.path).toBe('steps[1].id');
		expect(duplicate?.ref).toBe('dup');
	});
});

describe('收集式校验', () => {
	it('一次跑完给出多处诊断（含跨 step）', () => {
		const result = validateTask({
			schema_version: '1.0',
			task_id: 't1',
			steps: [
				{ id: 's1', action: 'move', linear: 0.9, angular: 0, duration: 1 },
				{ id: 's2', action: 'arm_joint', joint_id: 9, joint: 90 },
				{ id: 's3', action: 'stop_if_obstacle', sensors: ['/scan9'], distance: 5 },
			],
			limits: DEFAULT_LIMITS,
		});
		expect(result.ok).toBe(false);
		expect(codesOf(result)).toEqual(
			expect.arrayContaining([
				'step.move.linear.range',
				'step.arm_joint.joint_id.range',
				'step.stop_if_obstacle.sensors.invalid',
				'step.stop_if_obstacle.distance.range',
			]),
		);
	});
});

describe('规范化输出', () => {
	it('time 缺省被解析成 1500', () => {
		const result = validateTask({
			schema_version: '1.0',
			task_id: 't1',
			steps: [{ id: 's1', action: 'arm_joint', joint_id: 1, joint: 30 }],
			limits: DEFAULT_LIMITS,
		});
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		const [step] = result.task.steps;
		expect(step?.action).toBe('arm_joint');
		expect(step !== undefined && 'time' in step ? step.time : undefined).toBe(1500);
	});

	it('limits 与默认值合并后回传', () => {
		const result = validateTask({
			schema_version: '1.0',
			task_id: 't1',
			steps: [{ id: 's1', action: 'stop' }],
			limits: { max_linear: 0.1 },
		});
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.task.limits).toEqual({ ...DEFAULT_LIMITS, max_linear: 0.1 });
	});

	it('步序与符号原样保留（限值只影响判定）', () => {
		const result = validateTask({
			schema_version: '1.0',
			task_id: 't1',
			steps: [
				{ id: 's1', action: 'move', linear: -0.2, angular: 0, duration: 1 },
				{ id: 's2', action: 'stop' },
			],
			limits: DEFAULT_LIMITS,
		});
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.task.steps.map((step) => step.index)).toEqual([0, 1]);
		const [first] = result.task.steps;
		expect(first !== undefined && 'linear' in first ? first.linear : undefined).toBe(-0.2);
	});

	it('description 不是字符串只给警告，不改判定（参考实现不检查它）', () => {
		const result = validateTask({
			schema_version: '1.0',
			task_id: 't1',
			description: 42,
			steps: [{ id: 's1', action: 'stop' }],
			limits: DEFAULT_LIMITS,
		});
		expect(result.ok).toBe(true);
		expect(result.diagnostics.map((diagnostic) => diagnostic.code)).toContain('task.description.type');
		expect(result.diagnostics.every((diagnostic) => diagnostic.severity === 'warning')).toBe(true);
	});
});

describe('限值只能收紧', () => {
	it('放宽的三条都被拒（0.9 / 2.0 / 60）', () => {
		const result = validateTask({
			schema_version: '1.0',
			task_id: 't1',
			steps: [{ id: 's1', action: 'stop' }],
			limits: { max_linear: 0.9, max_angular: 2.0, max_duration: 60 },
		});
		expect(result.ok).toBe(false);
		expect(codesOf(result)).toEqual(
			expect.arrayContaining(['limits.max_linear.exceeds', 'limits.max_angular.exceeds', 'limits.max_duration.exceeds']),
		);
	});

	it('安全上限本身合法（0.3 / 1.2 / 30）', () => {
		const result = validateTask({
			schema_version: '1.0',
			task_id: 't1',
			steps: [{ id: 's1', action: 'stop' }],
			limits: { max_linear: 0.3, max_angular: 1.2, max_duration: 30.0 },
		});
		expect(result.ok).toBe(true);
	});
});

describe('协议描述表', () => {
	it('被 taskStepParameterSchemas 覆盖的动作与 ALLOWED_ACTIONS 对齐', async () => {
		const protocol = await import('../src/task-protocol');
		expect(Object.keys(protocol.taskStepParameterSchemas).sort()).toEqual([...protocol.ALLOWED_ACTIONS].sort());
	});

	it('由描述表生成的 zod schema 能独立卡住静态约束', async () => {
		const { taskStepParameterSchemas } = await import('../src/task-protocol');
		expect(taskStepParameterSchemas['arm_joint']?.safeParse({ joint_id: 1, joint: 90 }).success).toBe(true);
		expect(taskStepParameterSchemas['arm_joint']?.safeParse({ joint_id: 9, joint: 90 }).success).toBe(false);
		expect(taskStepParameterSchemas['arm_joint']?.safeParse({ joint_id: 1, joint: 90, time: 50 }).success).toBe(false);
		expect(taskStepParameterSchemas['stop_if_obstacle']?.safeParse({ sensors: ['/scan0'], distance: 1 }).success).toBe(true);
		expect(taskStepParameterSchemas['stop_if_obstacle']?.safeParse({ sensors: ['/scan9'], distance: 1 }).success).toBe(false);
		expect(taskStepParameterSchemas['stop_if_obstacle']?.safeParse({ sensors: [], distance: 1 }).success).toBe(false);
		expect(taskStepParameterSchemas['arm6_joints']?.safeParse({ joint1: 0, joint2: 0 }).success).toBe(false);
		expect(
			taskStepParameterSchemas['arm6_joints']?.safeParse({ joint1: 0, joint2: 0, joint3: 0, joint4: 0, joint5: 0, joint6: 0 })
				.success,
		).toBe(true);
		// 与任务限值相关的上界不在静态 schema 里（要靠 validateTask），这正是两层的分工。
		expect(taskStepParameterSchemas['move']?.safeParse({ linear: 0.5, angular: 0, duration: 1 }).success).toBe(true);
	});

	it('arm_joint 的字段描述带出上下界与默认值（下游视图靠它推导）', async () => {
		const { describeActionFields } = await import('../src/task-protocol');
		const fields = describeActionFields('arm_joint');
		expect(fields.map((field) => field.name)).toEqual(['joint_id', 'joint', 'time']);
		expect(fields[0]).toMatchObject({ min: 1, max: 6, required: true });
		expect(fields[2]).toMatchObject({ required: false, defaultValue: 1500, min: 100, max: 10000 });
	});
});
