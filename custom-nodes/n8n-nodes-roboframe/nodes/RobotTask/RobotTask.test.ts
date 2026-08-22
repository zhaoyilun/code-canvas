import type { RobotTaskPlan } from '@n8n/blockly-robot-skills';
import { describe, expect, it } from 'vitest';

import { checkCatalogDigest } from '../shared/catalogDigest';
import type { ActionClient } from '../shared/engine';
import { computePlanDigest } from '../shared/planDigest';
import { requirePlanValidation, runPlan } from './RobotTask.node';

function planOf(...plan: RobotTaskPlan['plan']): RobotTaskPlan {
	return { schemaVersion: 1, robot: 'so101_single_arm', configDigest: 'digest-1', plan };
}

function makeClient(liveDigest = 'digest-1'): ActionClient {
	return {
		catalog: async () => ({ config_digest: liveDigest }),
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
	};
}

const noSleep = async () => {};

function planVerdict(plan: RobotTaskPlan) {
	return {
		mode: 'plan',
		valid: true,
		catalogDigest: { valid: true },
		planDigest: computePlanDigest(plan),
	};
}

describe('RobotTask validation handoff', () => {
	it('accepts only a successful plan verdict with a successful digest verdict', () => {
		const plan = planOf({ step: 'skill', skill: 'inspect_scene' });
		expect(() => requirePlanValidation(planVerdict(plan), plan, 0)).not.toThrow();
	});

	it('blocks incomplete and rejected validation verdicts', () => {
		const plan = planOf({ step: 'skill', skill: 'inspect_scene' });
		const digest = computePlanDigest(plan);
		const cases: Array<[unknown, string]> = [
			[undefined, 'plan verdict is required'],
			[
				{ mode: 'action', valid: true, catalogDigest: { valid: true }, planDigest: digest },
				'plan verdict is required',
			],
			[
				{ mode: 'plan', valid: false, catalogDigest: { valid: true }, planDigest: digest },
				'rejected the plan',
			],
			[{ mode: 'plan', valid: true, planDigest: digest }, 'catalog digest verdict is required'],
			[
				{ mode: 'plan', valid: true, catalogDigest: { valid: false }, planDigest: digest },
				'catalog digest verdict is required',
			],
			[
				{ mode: 'plan', valid: true, catalogDigest: { valid: true } },
				'plan digest verdict is required',
			],
		];
		for (const [validation, message] of cases) {
			expect(() => requirePlanValidation(validation, plan, 2)).toThrow(
				`item 2: Robot Validate ${message}`,
			);
		}
	});

	it('rejects a plan changed after validation', () => {
		const reviewed = planOf({ step: 'wait', seconds: 1 });
		const edited = planOf({ step: 'wait', seconds: 2 });
		expect(() => requirePlanValidation(planVerdict(reviewed), edited, 0)).toThrow(
			'item 0: plan changed after Robot Validate',
		);
	});
});

describe('runPlan', () => {
	it('preserves task ids and structured steps for a successful plan', async () => {
		const result = await runPlan(
			makeClient(),
			planOf(
				{
					step: 'skill',
					skill: 'inspect_scene',
					blockId: 'block-1',
					planStepId: 'step:block-1',
				},
				{ step: 'wait', seconds: 0.01 },
			),
			{ sleep: noSleep, pollIntervalMs: 0 },
		);
		expect(result).toMatchObject({ success: true, finalStatus: 'completed' });
		expect(result.taskIds).toEqual([expect.any(String)]);
		expect(result.steps).toEqual([
			expect.objectContaining({
				action: { kind: 'skill', name: 'inspect_scene' },
				status: 'completed',
				taskId: expect.any(String),
				blockId: 'block-1',
				planStepId: 'step:block-1',
			}),
			expect.objectContaining({ type: 'wait', status: 'completed', seconds: 0.01 }),
		]);
	});

	it('returns the first failure with task id, final status, steps, and error details', async () => {
		const client: ActionClient = {
			...makeClient(),
			task: async (taskId) => ({
				body: {
					task_id: taskId,
					state: 'failed',
					success: false,
					error_code: 'MOTION_REJECTED',
					message: 'motion rejected',
				},
				terminal: true,
			}),
		};
		const result = await runPlan(
			client,
			planOf(
				{ step: 'skill', skill: 'inspect_scene' },
				{ step: 'skill', skill: 'recover_safe_pose' },
			),
			{ sleep: noSleep, pollIntervalMs: 0 },
		);
		expect(result).toMatchObject({
			success: false,
			finalStatus: 'failed',
			taskIds: [expect.any(String)],
			error: {
				step: 'inspect_scene',
				index: 0,
				taskId: expect.any(String),
				state: 'failed',
				errorCode: 'MOTION_REJECTED',
				message: 'motion rejected',
				completedSteps: 0,
			},
		});
		expect(result.steps).toEqual([
			expect.objectContaining({
				action: { kind: 'skill', name: 'inspect_scene' },
				status: 'failed',
				taskId: expect.any(String),
				errorCode: 'MOTION_REJECTED',
			}),
		]);
	});

	it('preserves an unknown final state after an unconfirmed cancellation', async () => {
		let now = 0;
		const client: ActionClient = {
			...makeClient(),
			task: async (taskId) => ({ body: { task_id: taskId, state: 'running' }, terminal: false }),
			cancel: async (taskId) => ({
				task_id: taskId,
				requested: true,
				confirmed: false,
				state: 'unknown',
			}),
		};
		const result = await runPlan(
			client,
			planOf({ step: 'primitive', primitive: 'open_gripper', timeoutSec: 0.001 }),
			{
				now: () => now,
				sleep: async (ms) => {
					now += Math.max(ms, 1);
				},
				pollIntervalMs: 1,
				pollMarginSec: 0,
			},
		);
		expect(result).toMatchObject({
			success: false,
			finalStatus: 'unknown',
			taskIds: [expect.any(String)],
			steps: [
				expect.objectContaining({
					action: { kind: 'primitive', name: 'open_gripper' },
					status: 'unknown',
					cancelConfirmed: false,
				}),
			],
		});
	});
});

describe('catalog digest checks', () => {
	it('accepts the exact live digest and rejects a stale plan', async () => {
		expect(await checkCatalogDigest(makeClient('digest-1'), planOf({ step: 'skill', skill: 'inspect_scene' }))).toEqual({
			valid: true,
			plan: 'digest-1',
			live: 'digest-1',
			message: '',
		});
		expect(await checkCatalogDigest(makeClient('digest-2'), planOf({ step: 'skill', skill: 'inspect_scene' }))).toEqual({
			valid: false,
			plan: 'digest-1',
			live: 'digest-2',
			message: 'plan is stale: catalog digest changed (plan digest-1, live digest-2)',
		});
	});

	it('requires a digest on both the plan and live catalog', async () => {
		const noPlanDigest = planOf({ step: 'skill', skill: 'inspect_scene' });
		noPlanDigest.configDigest = '';
		expect(await checkCatalogDigest(makeClient('digest-1'), noPlanDigest)).toMatchObject({
			valid: false,
			message: 'plan configDigest is required',
		});
		expect(await checkCatalogDigest(makeClient(''), planOf({ step: 'skill', skill: 'inspect_scene' }))).toMatchObject({
			valid: false,
			message: 'live catalog config_digest is required',
		});
	});
});
