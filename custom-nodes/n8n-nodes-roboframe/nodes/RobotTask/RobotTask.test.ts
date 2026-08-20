import { describe, expect, it } from 'vitest';

import type { RobotTaskPlan } from '@n8n/blockly-robot-skills';
import { runPlan, verifyDigest } from './RobotTask.node';
import type { ActionClient } from '../shared/engine';

function planOf(...plan: RobotTaskPlan['plan']): RobotTaskPlan {
	return { schemaVersion: 1, robot: 'so101_single_arm', configDigest: 'digest-1', plan };
}

function makeClient(liveDigest = 'digest-1', states: Record<string, string> = {}): ActionClient {
	return {
		catalog: async () => ({ config_digest: liveDigest }),
		execute: async (taskId) => ({ accepted: true, task_id: taskId }),
		task: async (taskId) => {
			const state = states[taskId] ?? 'completed';
			return { body: { task_id: taskId, state, success: state === 'completed' }, terminal: true };
		},
	};
}

const noSleep = async () => {};

describe('runPlan', () => {
	it('summarizes a successful plan', async () => {
		const result = await runPlan(makeClient(), planOf({ step: 'skill', skill: 'inspect_scene' }, { step: 'wait', seconds: 0.01 }), {
			sleep: noSleep,
			pollIntervalMs: 0,
		});
		expect(result.success).toBe(true);
		expect(result.steps).toEqual([
			expect.objectContaining({ type: 'skill', skill: 'inspect_scene', status: 'completed' }),
			expect.objectContaining({ type: 'wait', status: 'completed', seconds: 0.01 }),
		]);
	});

	it('throws a user error naming the failed step on failure', async () => {
		let failNext = true;
		const client: ActionClient = {
			catalog: async () => ({}),
			execute: async (taskId) => ({ accepted: true, task_id: taskId }),
			task: async (taskId) => {
				const state = failNext ? 'failed' : 'completed';
				failNext = false;
				return { body: { task_id: taskId, state, success: state === 'completed', message: 'motion rejected' }, terminal: true };
			},
		};
		const plan = planOf(
			{ step: 'skill', skill: 'inspect_scene' },
			{ step: 'skill', skill: 'recover_safe_pose' },
		);
		await expect(runPlan(client, plan, { sleep: noSleep, pollIntervalMs: 0 })).rejects.toThrow(
			'plan failed at step 0 "inspect_scene" (failed); 0 step(s) completed',
		);
	});
});

describe('verifyDigest', () => {
	it('accepts a matching digest and rejects a stale one', async () => {
		expect(await verifyDigest(makeClient('digest-1'), planOf({ step: 'skill', skill: 'inspect_scene' }))).toBeNull();
		expect(await verifyDigest(makeClient('digest-2'), planOf({ step: 'skill', skill: 'inspect_scene' }))).toBe(
			'plan is stale: catalog digest changed (plan digest-1, live digest-2)',
		);
	});

	it('skips the check when the plan has no digest', async () => {
		const plan = planOf({ step: 'skill', skill: 'inspect_scene' });
		plan.configDigest = '';
		expect(await verifyDigest(makeClient('whatever'), plan)).toBeNull();
	});
});
