import { describe, expect, it } from 'vitest';

import { BridgeClient, type Transport } from './bridge';

describe('BridgeClient action contract', () => {
	it('retrieves the full pose catalog for digest-safe catalog mapping', async () => {
		const client = new BridgeClient({
			baseUrl: 'http://bridge',
			transport: async (method, path) => {
				expect(method).toBe('GET');
				expect(path).toBe('http://bridge/v1/catalog/poses');
				return {
					status: 200,
					body: { robot_name: 'rk3588_training_arm', config_digest: 'digest-1', poses: ['home'] },
				};
			},
		});
		expect(await client.poseCatalog()).toEqual({
			robot_name: 'rk3588_training_arm',
			config_digest: 'digest-1',
			poses: ['home'],
		});
	});

	it('sends kind and name to the action validate and execute endpoints', async () => {
		const calls: Array<{ method: string; path: string; body?: unknown }> = [];
		const transport: Transport = async (method, path, body) => {
			calls.push({ method, path, body });
			return { status: method === 'POST' && path.endsWith('/execute') ? 202 : 200, body: {} };
		};
		const client = new BridgeClient({ baseUrl: 'http://bridge/', transport });
		await client.validate({ kind: 'primitive', name: 'open_gripper' }, { force: 1 });
		await client.execute(
			'task-1',
			{ kind: 'skill', name: 'inspect_scene' },
			{ target_name: 'table' },
			12,
			{ blockId: 'block-1', planStepId: 'step:block-1' },
		);
		expect(calls).toEqual([
			{
				method: 'POST',
				path: 'http://bridge/v1/actions/validate',
				body: {
					action: { kind: 'primitive', name: 'open_gripper' },
					params: { force: 1 },
				},
			},
			{
				method: 'POST',
				path: 'http://bridge/v1/actions/execute',
				body: {
					task_id: 'task-1',
					action: { kind: 'skill', name: 'inspect_scene' },
					params: { target_name: 'table' },
					timeout_sec: 12,
					context: { blockId: 'block-1', planStepId: 'step:block-1' },
				},
			},
		]);
	});

	it('maps an absent task lookup to null for bounded registration polling', async () => {
		const client = new BridgeClient({
			baseUrl: 'http://bridge',
			transport: async () => ({ status: 404, body: { detail: 'unknown task' } }),
		});
		expect(await client.task('task-1')).toBeNull();
	});

	it('recognizes terminal state from the response body', async () => {
		const client = new BridgeClient({
			baseUrl: 'http://bridge',
			transport: async () => ({
				status: 200,
				body: { task_id: 'task-1', state: 'completed', success: true },
			}),
		});
		expect(await client.task('task-1')).toEqual({
			body: { task_id: 'task-1', state: 'completed', success: true },
			terminal: true,
		});
	});
});
