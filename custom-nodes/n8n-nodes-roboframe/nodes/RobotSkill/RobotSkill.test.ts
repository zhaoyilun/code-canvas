import { describe, expect, it } from 'vitest';

import { runSkill } from './RobotSkill.node';
import type { ActionClient } from '../shared/engine';

function makeClient(verdict: { valid: boolean; message?: string } = { valid: true }): ActionClient {
	return {
		catalog: async () => ({}),
		execute: async (taskId) => ({ accepted: true, task_id: taskId }),
		validate: async () => ({
			valid: verdict.valid,
			message: verdict.message ?? '',
		}),
		task: async (taskId) => ({
			body: { task_id: taskId, state: 'completed', success: true, executed_primitives: ['move_relative_ee'] },
			terminal: true,
		}),
	} as unknown as ActionClient;
}

describe('runSkill', () => {
	it('validates, executes, and returns the terminal outcome', async () => {
		const client = makeClient();
		const result = await runSkill(
			client,
			{
				skill: 'move_relative_ee',
				motionDirection: 'forward',
				motionDistance: 0.03,
				timeoutSec: 45,
			},
			{ validateFirst: true, waitForResult: true },
		);
		expect(result).toMatchObject({
			skill: 'move_relative_ee',
			state: 'completed',
			success: true,
			executedPrimitives: ['move_relative_ee'],
		});
	});

	it('throws when validation rejects the parameters', async () => {
		const client = makeClient({ valid: false, message: 'missing motion_direction' });
		await expect(
			runSkill(client, { skill: 'move_relative_ee' }, { validateFirst: true, waitForResult: true }),
		).rejects.toThrow('rejected by validation: missing motion_direction');
	});

	it('returns a submitted state without waiting when asked', async () => {
		const client = makeClient();
		const result = await runSkill(
			client,
			{ skill: 'inspect_scene' },
			{ validateFirst: false, waitForResult: false },
		);
		expect(result).toMatchObject({ skill: 'inspect_scene', state: 'submitted', success: null });
		expect(typeof result.taskId).toBe('string');
	});

	it('requires a skill name', async () => {
		await expect(
			runSkill(makeClient(), { skill: '' }, { validateFirst: false, waitForResult: true }),
		).rejects.toThrow('skill is required');
	});
});
