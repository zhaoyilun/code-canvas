import { describe, expect, it } from 'vitest';

import { robotStatusJson } from './RobotStatus.node';

describe('robotStatusJson', () => {
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
});
