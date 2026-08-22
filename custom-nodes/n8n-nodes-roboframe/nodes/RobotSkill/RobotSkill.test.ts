import type { IDataObject } from 'n8n-workflow';
import { describe, expect, it } from 'vitest';

import type { ActionClient } from '../shared/engine';
import { runSkill } from './RobotSkill.node';

function makeClient(
	verdict: { valid: boolean; message?: string } = { valid: true },
	actions: Array<{ kind: string; name: string }> = [],
	paramsSeen: IDataObject[] = [],
): ActionClient {
	return {
		catalog: async () => ({ config_digest: 'digest-1' }),
		execute: async (taskId, action, params) => {
			actions.push(action);
			paramsSeen.push(params);
			return { accepted: true, task_id: taskId, action, state: 'accepted' };
		},
		validate: async (action) => {
			actions.push(action);
			return { valid: verdict.valid, message: verdict.message ?? '' };
		},
		task: async (taskId) => ({
			body: {
				task_id: taskId,
				state: 'completed',
				success: true,
				executed_primitives: ['move_relative_ee'],
			},
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

describe('runSkill', () => {
	it('validates and executes with an explicit skill action', async () => {
		const actions: Array<{ kind: string; name: string }> = [];
		const result = await runSkill(
			makeClient({ valid: true }, actions),
			{
				skill: 'move_relative_ee',
				motionDirection: 'forward',
				motionDistance: 0.03,
				timeoutSec: 45,
			},
			{ validateFirst: true, waitForResult: true },
		);
		expect(result).toMatchObject({
			action: { kind: 'skill', name: 'move_relative_ee' },
			state: 'completed',
			success: true,
			executedPrimitives: ['move_relative_ee'],
		});
		expect(actions).toEqual([
			{ kind: 'skill', name: 'move_relative_ee' },
			{ kind: 'skill', name: 'move_relative_ee' },
		]);
	});

	it('throws when validation rejects the parameters', async () => {
		const client = makeClient({ valid: false, message: 'missing motion_direction' });
		await expect(
			runSkill(client, { skill: 'move_relative_ee' }, { validateFirst: true, waitForResult: true }),
		).rejects.toThrow('rejected by validation: missing motion_direction');
	});

	it('returns the accepted bridge state when result polling is disabled', async () => {
		const result = await runSkill(
			makeClient(),
			{ skill: 'inspect_scene' },
			{ validateFirst: false, waitForResult: false },
		);
		expect(result).toMatchObject({
			action: { kind: 'skill', name: 'inspect_scene' },
			state: 'accepted',
			success: null,
		});
		expect(typeof result.taskId).toBe('string');
	});

	it('preserves nested objects and lists from action parameter JSON', async () => {
		const paramsSeen: IDataObject[] = [];
		await runSkill(
			makeClient({ valid: true }, [], paramsSeen),
			{
				skill: 'inspect_scene',
				parametersJson: JSON.stringify({
					profile: { speed: 0.2 },
					waypoints: [{ name: 'observe' }, { name: 'home' }],
				}),
			},
			{ validateFirst: false, waitForResult: false },
		);
		expect(paramsSeen).toEqual([
			{
				profile: { speed: 0.2 },
				waypoints: [{ name: 'observe' }, { name: 'home' }],
			},
		]);
	});

	it('requires a skill name', async () => {
		await expect(
			runSkill(makeClient(), { skill: '' }, { validateFirst: false, waitForResult: true }),
		).rejects.toThrow('skill is required');
	});
});
