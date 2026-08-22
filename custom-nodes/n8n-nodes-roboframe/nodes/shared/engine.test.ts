import type { RobotTaskPlan } from '@n8n/blockly-robot-skills';
import { describe, expect, it } from 'vitest';

import type { RobotAction } from './bridge';
import type { ActionClient, StepOutcome } from './engine';
import { executePlan, generateTaskId, runAction } from './engine';

function planOf(...plan: RobotTaskPlan['plan']): RobotTaskPlan {
	return { schemaVersion: 1, robot: 'so101_single_arm', configDigest: 'digest-1', plan };
}

function baseClient(overrides: Partial<ActionClient> = {}): ActionClient {
	return {
		catalog: async () => ({ config_digest: 'digest-1' }),
		execute: async (taskId, action) => ({
			accepted: true,
			task_id: taskId,
			action,
			state: 'accepted',
		}),
		validate: async () => ({ valid: true }),
		task: async (taskId) => ({
			body: { task_id: taskId, state: 'completed', success: true },
			terminal: true,
		}),
		cancel: async (taskId) => ({
			task_id: taskId,
			requested: true,
			confirmed: true,
			state: 'canceled',
		}),
		...overrides,
	};
}

function fakeClock() {
	let current = 0;
	return {
		now: () => current,
		sleep: async (ms: number) => {
			current += Math.max(ms, 1);
		},
	};
}

const noSleep = async () => {};

describe('executePlan', () => {
	it('runs skill and primitive actions sequentially with explicit kinds', async () => {
		const actions: RobotAction[] = [];
		const contexts: unknown[] = [];
		const polls = new Map<string, number>();
		const client = baseClient({
			execute: async (taskId, action, _params, _timeoutSec, context) => {
				actions.push(action);
				contexts.push(context);
				return { accepted: true, task_id: taskId, action, state: 'accepted' };
			},
			task: async (taskId) => {
				const count = (polls.get(taskId) ?? 0) + 1;
				polls.set(taskId, count);
				if (count === 1) {
					return { body: { task_id: taskId, state: 'accepted' }, terminal: false };
				}
				if (count === 2) {
					return { body: { task_id: taskId, state: 'running' }, terminal: false };
				}
				return {
					body: {
						task_id: taskId,
						state: 'completed',
						success: true,
						executed_primitives: ['move_relative_ee'],
					},
					terminal: true,
				};
			},
		});
		const plan = planOf(
			{
				step: 'skill',
				skill: 'inspect_scene',
				blockId: 'block-skill',
				planStepId: 'step:block-skill',
			},
			{ step: 'wait', seconds: 0.01 },
			{
				step: 'primitive',
				primitive: 'open_gripper',
				blockId: 'block-primitive',
				planStepId: 'step:block-primitive',
			},
		);
		const result = await executePlan(client, plan, { sleep: noSleep, pollIntervalMs: 0 });
		expect(result.success).toBe(true);
		expect(result.outcomes.map((outcome) => outcome.status)).toEqual([
			'completed',
			'completed',
			'completed',
		]);
		expect(actions).toEqual([
			{ kind: 'skill', name: 'inspect_scene' },
			{ kind: 'primitive', name: 'open_gripper' },
		]);
		expect(contexts).toEqual([
			{ blockId: 'block-skill', planStepId: 'step:block-skill' },
			{ blockId: 'block-primitive', planStepId: 'step:block-primitive' },
		]);
	});

	it('stops at the first failed step', async () => {
		const actions: RobotAction[] = [];
		const client = baseClient({
			execute: async (taskId, action) => {
				actions.push(action);
				return { accepted: true, task_id: taskId };
			},
			task: async (taskId) => ({
				body: { task_id: taskId, state: 'failed', success: false, error_code: 'MOTION' },
				terminal: true,
			}),
		});
		const result = await executePlan(
			client,
			planOf(
				{ step: 'skill', skill: 'inspect_scene' },
				{ step: 'skill', skill: 'recover_safe_pose' },
			),
			{ sleep: noSleep, pollIntervalMs: 0 },
		);
		expect(result.success).toBe(false);
		expect(result.failedAt?.state).toBe('failed');
		expect(actions).toEqual([{ kind: 'skill', name: 'inspect_scene' }]);
	});

	it('keeps guard evaluation on the previous completed action', async () => {
		const actions: RobotAction[] = [];
		const client = baseClient({
			execute: async (taskId, action) => {
				actions.push(action);
				return { accepted: true, task_id: taskId };
			},
		});
		const result = await executePlan(
			client,
			planOf(
				{ step: 'skill', skill: 'inspect_scene' },
				{
					step: 'skill',
					skill: 'recover_safe_pose',
					skipIf: { field: 'last.success', op: '==', value: true },
				},
				{
					step: 'skill',
					skill: 'wave_hello',
					skipIf: { field: 'last.success', op: '==', value: false },
				},
			),
			{ sleep: noSleep, pollIntervalMs: 0 },
		);
		expect(result.outcomes.map((outcome) => outcome.status)).toEqual([
			'completed',
			'skipped',
			'completed',
		]);
		expect(actions).toHaveLength(2);
	});
});

describe('runAction polling and cancellation', () => {
	it('tolerates a short post-submit lookup gap before accepted and running', async () => {
		const lookups = [
			null,
			{ body: { state: 'accepted' }, terminal: false },
			{ body: { state: 'running' }, terminal: false },
			{ body: { state: 'completed', success: true }, terminal: true },
		];
		const outcome = await runAction(
			baseClient({ task: async () => lookups.shift() ?? null }),
			{ step: 'skill', skill: 'inspect_scene' },
			0,
			{ sleep: noSleep, pollIntervalMs: 0, registrationGraceMs: 10_000 },
		);
		expect(outcome).toMatchObject({ status: 'completed', state: 'completed', success: true });
	});

	it('cancels on a local timeout and records a confirmed canceled terminal state', async () => {
		const clock = fakeClock();
		const canceled: string[] = [];
		const client = baseClient({
			task: async (taskId) => ({ body: { task_id: taskId, state: 'running' }, terminal: false }),
			cancel: async (taskId) => {
				canceled.push(taskId);
				return { task_id: taskId, requested: true, confirmed: true, state: 'canceled' };
			},
		});
		const outcome = await runAction(
			client,
			{ step: 'skill', skill: 'inspect_scene', timeoutSec: 0.001 },
			0,
			{ ...clock, pollIntervalMs: 1, pollMarginSec: 0 },
		);
		expect(canceled).toEqual([outcome.taskId]);
		expect(outcome).toMatchObject({
			status: 'canceled',
			state: 'canceled',
			cancelRequested: true,
			cancelConfirmed: true,
			errorCode: 'LOCAL_TIMEOUT',
		});
	});

	it('keeps polling after cancel returns running and records the later terminal state', async () => {
		const clock = fakeClock();
		let cancelCalled = false;
		let confirmationPoll = 0;
		const client = baseClient({
			task: async (taskId) => {
				if (!cancelCalled) {
					return { body: { task_id: taskId, state: 'running' }, terminal: false };
				}
				confirmationPoll += 1;
				if (confirmationPoll === 1) {
					return { body: { task_id: taskId, state: 'running' }, terminal: false };
				}
				return {
					body: { task_id: taskId, state: 'canceled', success: false },
					terminal: true,
				};
			},
			cancel: async (taskId) => {
				cancelCalled = true;
				return { task_id: taskId, requested: true, confirmed: false, state: 'running' };
			},
		});
		const outcome = await runAction(
			client,
			{ step: 'primitive', primitive: 'open_gripper', timeoutSec: 0.001 },
			0,
			{ ...clock, pollIntervalMs: 1, pollMarginSec: 0, cancelConfirmSec: 0.01 },
		);
		expect(outcome).toMatchObject({
			status: 'canceled',
			state: 'canceled',
			cancelRequested: true,
			cancelConfirmed: true,
		});
	});

	it('reports unknown when cancellation has no terminal confirmation', async () => {
		const clock = fakeClock();
		const outcome: StepOutcome = await runAction(
			baseClient({
				task: async (taskId) => ({ body: { task_id: taskId, state: 'running' }, terminal: false }),
				cancel: async (taskId) => ({
					task_id: taskId,
					requested: true,
					confirmed: false,
					state: 'running',
				}),
			}),
			{ step: 'skill', skill: 'inspect_scene', timeoutSec: 0.001 },
			0,
			{ ...clock, pollIntervalMs: 1, pollMarginSec: 0, cancelConfirmSec: 0.002 },
		);
		expect(outcome).toMatchObject({
			status: 'unknown',
			state: 'unknown',
			success: null,
			cancelRequested: true,
			cancelConfirmed: false,
			errorCode: 'LOCAL_TIMEOUT',
		});
	});

	it('cancels when the task stays absent beyond the registration grace period', async () => {
		const clock = fakeClock();
		const outcome = await runAction(
			baseClient({ task: async () => null }),
			{ step: 'skill', skill: 'inspect_scene' },
			0,
			{ ...clock, pollIntervalMs: 1, registrationGraceMs: 2 },
		);
		expect(outcome).toMatchObject({
			status: 'canceled',
			cancelConfirmed: true,
			errorCode: 'TASK_NOT_REGISTERED',
		});
	});

	it('returns a structured submission failure', async () => {
		const outcome = await runAction(
			baseClient({ execute: async () => Promise.reject(new Error('duplicate task id')) }),
			{ step: 'skill', skill: 'inspect_scene' },
			0,
		);
		expect(outcome).toMatchObject({
			status: 'failed',
			state: 'failed',
			errorCode: 'ACTION_SUBMIT_FAILED',
			message: 'duplicate task id',
		});
	});
});

describe('generateTaskId', () => {
	it('produces unique prefixed ids', () => {
		const first = generateTaskId();
		const second = generateTaskId();
		expect(first.startsWith('n8n-')).toBe(true);
		expect(first).not.toBe(second);
	});
});
