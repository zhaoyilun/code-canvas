import type { IExecuteFunctions, INodeExecutionData } from 'n8n-workflow';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { clientFromCredentialsMock } = vi.hoisted(() => ({
	clientFromCredentialsMock: vi.fn(),
}));

vi.mock('../shared/context', () => ({ clientFromCredentials: clientFromCredentialsMock }));

import { RobotStatus, robotStatusJson } from './RobotStatus.node';

function makeContext(items: INodeExecutionData[]): IExecuteFunctions {
	return {
		getInputData: () => items,
		getCredentials: vi.fn(async () => ({ baseUrl: 'http://bridge', token: 'test' })),
	} as unknown as IExecuteFunctions;
}

describe('robotStatusJson', () => {
	beforeEach(() => {
		clientFromCredentialsMock.mockReset();
		clientFromCredentialsMock.mockResolvedValue({
			status: vi.fn(async () => ({
				schema_version: 1,
				robot_name: 'rk3588_training_arm',
				motion_authorized: true,
				busy: false,
				config_digest: 'sha256:live-catalog',
			})),
		});
	});

	it('preserves the real RoboFrame status identity, digests and readiness fields', () => {
		const result = robotStatusJson({
			schema_version: 1,
			robot_name: 'so101_single_arm',
			motion_authorized: true,
			active_control_mode: 'moveit_planning',
			busy: false,
			active_task_id: '',
			default_skill_timeout_sec: 120,
			task_budget_sec: 180,
			rpc_timeout_sec: 5,
			config_digest: 'sha256:catalog',
			capability_digest: 'sha256:capabilities',
			registry_epoch: 'epoch-1',
			registry_generation: 7,
			registry_digest: 'sha256:registry',
			primitive_contract_digest: 'sha256:primitives',
			source_release_digest: 'sha256:release',
			provenance_digest: 'sha256:provenance',
			control_plane_ready: true,
			control_plane_state: 'ready',
			control_plane_error_code: '',
			request_state: 'idle',
			request_error_code: '',
			capabilities: [
				{
					name: 'move_relative_ee',
					semantic_level: 'skill',
					planner_visible: true,
					ready: true,
					reason: '',
					required_control_mode: 'moveit_planning',
				},
			],
		});

		expect(result).toMatchObject({
			schemaVersion: 1,
			robotName: 'so101_single_arm',
			motionAuthorized: true,
			busy: false,
			defaultSkillTimeoutSec: 120,
			configDigest: 'sha256:catalog',
			registryGeneration: 7,
			controlPlaneReady: true,
			requestState: 'idle',
		});
		expect(result.capabilities).toEqual([
			expect.objectContaining({ name: 'move_relative_ee', ready: true }),
		]);
		expect(result).not.toHaveProperty('requiredControlMode');
		expect(result).not.toHaveProperty('readiness');
	});

	it('keeps Blockly Logic output while live robot status fields take precedence', async () => {
		const result = await new RobotStatus().execute.call(
			makeContext([
				{
					json: {
						lessonId: 'lesson-1',
						normalizedScore: 72,
						activeStudentNames: ['Lin', 'Tao'],
						robotName: 'stale-name',
						busy: true,
					},
					pairedItem: { item: 0 },
				},
			]),
		);

		expect(result[0][0]).toEqual({
			json: expect.objectContaining({
				lessonId: 'lesson-1',
				normalizedScore: 72,
				activeStudentNames: ['Lin', 'Tao'],
				robotName: 'rk3588_training_arm',
				busy: false,
				motionAuthorized: true,
				configDigest: 'sha256:live-catalog',
			}),
			pairedItem: { item: 0 },
		});
	});
});
