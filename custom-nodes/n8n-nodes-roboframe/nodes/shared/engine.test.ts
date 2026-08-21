import { describe, expect, it } from 'vitest';

import type { ActionClient, StepOutcome } from './engine';
import { executePlan, generateTaskId, runAction } from './engine';
import type { RobotTaskPlan } from '@n8n/blockly-robot-skills';

function planOf(...plan: RobotTaskPlan['plan']): RobotTaskPlan {
	return { schemaVersion: 1, robot: 'so101_single_arm', configDigest: 'digest-1', plan };
}

function makeClient(options: {
	results?: Record<string, 'completed' | 'failed' | 'canceled'>;
	executedCalls?: string[];
} = {}): ActionClient {
	const results = options.results ?? {};
	const executedCalls = options.executedCalls ?? [];
	let call = 0;
	return {
		catalog: async () => ({ config_digest: 'digest-1' }),
		execute: async (taskId) => {
			executedCalls.push(taskId);
			return { accepted: true, task_id: taskId };
		},
		task: async (taskId) => {
			call += 1;
			const state = results[taskId] ?? 'completed';
			// First poll returns non-terminal, second returns terminal.
			if (call % 2 === 1) {
				return { body: { task_id: taskId, state: 'executing' }, terminal: false };
			}
			return {
				body: {
					task_id: taskId,
					state,
					success: state === 'completed',
					executed_primitives: ['move_relative_ee'],
				},
				terminal: true,
			};
		},
	};
}

const noSleep = async () => {};

describe('executePlan', () => {
	it('runs steps sequentially and reports success', async () => {
		const executed: string[] = [];
		const client = makeClient({ executedCalls: executed });
		const plan = planOf(
			{ step: 'skill', skill: 'inspect_scene' },
			{ step: 'wait', seconds: 0.01 },
			{ step: 'primitive', primitive: 'open_gripper' },
		);
		const result = await executePlan(client, plan, { sleep: noSleep, pollIntervalMs: 0 });
		expect(result.success).toBe(true);
		expect(result.outcomes.map((outcome) => outcome.status)).toEqual([
			'completed',
			'completed',
			'completed',
		]);
		expect(executed.length).toBe(2);
	});

	it('stops at the first failed step without retrying', async () => {
		const executed: string[] = [];
		const client: ActionClient = {
			catalog: async () => ({}),
			execute: async (taskId) => {
				executed.push(taskId);
				return {};
			},
			task: async (taskId) => ({
				body: { task_id: taskId, state: 'failed', success: false, error_code: 'MOTION' },
				terminal: true,
			}),
		};
		const plan = planOf(
			{ step: 'skill', skill: 'inspect_scene' },
			{ step: 'skill', skill: 'recover_safe_pose' },
		);
		const result = await executePlan(client, plan, { sleep: noSleep, pollIntervalMs: 0 });
		expect(result.success).toBe(false);
		expect(result.failedAt?.state).toBe('failed');
		expect(executed.length).toBe(1); // no auto-retry, chain stopped
	});

	it('skips guarded steps when the guard does not hold', async () => {
		const executed: string[] = [];
		const client: ActionClient = {
			catalog: async () => ({}),
			execute: async (taskId) => {
				executed.push(taskId);
				return {};
			},
			task: async (taskId) => ({
				body: { task_id: taskId, state: 'completed', success: true },
				terminal: true,
			}),
		};
		const plan = planOf(
			{ step: 'skill', skill: 'inspect_scene' },
			{ step: 'skill', skill: 'recover_safe_pose', skipIf: { field: 'last.success', op: '==', value: true } },
			{ step: 'skill', skill: 'wave_hello', skipIf: { field: 'last.success', op: '==', value: false } },
		);
		const result = await executePlan(client, plan, { sleep: noSleep, pollIntervalMs: 0 });
		expect(result.outcomes.map((outcome) => outcome.status)).toEqual(['completed', 'skipped', 'completed']);
		expect(executed.length).toBe(2);
	});

	it('times out steps that never reach a terminal state', async () => {
		const client: ActionClient = {
			catalog: async () => ({}),
			execute: async () => ({}),
			task: async (taskId) => ({ body: { task_id: taskId, state: 'executing' }, terminal: false }),
		};
		const outcome: StepOutcome = await runAction(
			client,
			{ step: 'skill', skill: 'inspect_scene', timeoutSec: 0.05 },
			0,
			{ sleep: noSleep, pollIntervalMs: 0, pollMarginSec: 0 },
		);
		expect(outcome.status).toBe('failed');
		expect(outcome.state).toBe('timeout');
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
