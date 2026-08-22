import { describe, expect, it } from 'vitest';

import { mapBridgeCatalog } from './catalog';

const bridgeCatalog = {
	robot_name: 'rk3588_training_arm',
	config_digest: 'sha256:catalog-v1',
	skills: [
		{
			kind: 'skill',
			name: 'inspect_scene',
			summary: 'Inspect the current workspace',
			domain: 'perception',
			moves_robot: false,
			required_control_mode: 'moveit_planning',
			parameters: {
				type: 'object',
				properties: { camera: { type: 'string', enum: ['front', 'wrist'] } },
				required: ['camera'],
				additionalProperties: false,
			},
			recovery_policy: 'never_retry',
			timeout_policy: { timeout_sec: 12 },
		},
	],
	primitives: [
		{
			kind: 'primitive',
			name: 'open_gripper',
			summary: 'Open the gripper',
			parameters: { type: 'object', properties: {}, additionalProperties: false },
			timeout_policy: { default_timeout_sec: 5 },
		},
	],
};

const bridgePoses = {
	robot_name: 'rk3588_training_arm',
	config_digest: 'sha256:catalog-v1',
	poses: ['home', 'observe_table'],
};

describe('mapBridgeCatalog', () => {
	it('maps live action and pose catalogs into the strict Blockly catalog', () => {
		const result = mapBridgeCatalog(bridgeCatalog, bridgePoses);
		expect(result).toEqual({
			ok: true,
			catalog: {
				robotName: 'rk3588_training_arm',
				configDigest: 'sha256:catalog-v1',
				skills: [
					{
						name: 'inspect_scene',
						summary: 'Inspect the current workspace',
						domain: 'perception',
						movesRobot: false,
						requiredControlMode: 'moveit_planning',
						parameters: {
							type: 'object',
							properties: { camera: { type: 'string', enum: ['front', 'wrist'] } },
							required: ['camera'],
							additionalProperties: false,
						},
						recoveryPolicy: 'never_retry',
						timeoutSec: 12,
					},
				],
				primitives: ['open_gripper'],
				primitiveDetails: [
					{
						name: 'open_gripper',
						summary: 'Open the gripper',
						parameters: {
							type: 'object',
							properties: {},
							additionalProperties: false,
						},
						timeoutSec: 5,
					},
				],
				namedPoses: ['home', 'observe_table'],
			},
		});
	});

	it('maps the enriched Bridge skill shape and gives top-level timeout_sec priority', () => {
		const result = mapBridgeCatalog(
			{
				robot_name: 'so101_single_arm',
				config_digest: 'sha256:real-bridge-catalog',
				skills: [
					{
						kind: 'skill',
						name: 'move_relative_ee',
						contract_schema_version: 2,
						summary: 'Move the end effector relative to its current pose',
						domain: 'manipulation',
						moves_robot: true,
						required_control_mode: 'moveit_planning',
						parameters: {
							type: 'object',
							properties: {
								motion_direction: { type: 'string' },
								motion_distance: { type: 'number' },
							},
							required: ['motion_direction', 'motion_distance'],
							additionalProperties: false,
						},
						recovery_policy: 'never_retry',
						timeout_policy: {
							default_skill_timeout_sec: 30,
							task_budget_sec: 180,
							rpc_timeout_sec: 5,
						},
						timeout_sec: 120,
						config_digest: 'sha256:real-bridge-catalog',
					},
				],
				primitives: [],
				poses: ['home', 'observe_table', 'zero'],
			},
			{
				robot_name: 'so101_single_arm',
				config_digest: 'sha256:real-bridge-catalog',
				poses: ['home', 'observe_table', 'zero'],
			},
		);

		expect(result).toMatchObject({
			ok: true,
			catalog: {
				skills: [{ name: 'move_relative_ee', timeoutSec: 120 }],
			},
		});
	});

	it('uses default_skill_timeout_sec when an action-specific timeout is absent', () => {
		const result = mapBridgeCatalog(
			{
				...bridgeCatalog,
				skills: [
					{
						...bridgeCatalog.skills[0],
						timeout_sec: null,
						timeout_policy: { default_skill_timeout_sec: 120 },
					},
				],
			},
			bridgePoses,
		);

		expect(result).toMatchObject({
			ok: true,
			catalog: { skills: [{ timeoutSec: 120 }] },
		});
	});

	it('rejects an invalid top-level timeout even when the policy has a valid default', () => {
		const result = mapBridgeCatalog(
			{
				...bridgeCatalog,
				skills: [
					{
						...bridgeCatalog.skills[0],
						timeout_sec: '120',
						timeout_policy: { default_skill_timeout_sec: 120 },
					},
				],
			},
			bridgePoses,
		);

		expect(result).toMatchObject({
			ok: false,
			error: { path: 'catalog.skills[0].timeout_sec' },
		});
	});

	it('rejects a pose catalog from another digest', () => {
		const result = mapBridgeCatalog(bridgeCatalog, {
			...bridgePoses,
			config_digest: 'sha256:stale',
		});
		expect(result).toMatchObject({
			ok: false,
			error: { code: 'BRIDGE_CATALOG_INVALID', path: 'poses.config_digest' },
		});
	});

	it('rejects action entries published under the wrong kind', () => {
		const result = mapBridgeCatalog(
			{
				...bridgeCatalog,
				skills: [{ ...bridgeCatalog.skills[0], kind: 'primitive' }],
			},
			bridgePoses,
		);
		expect(result).toMatchObject({
			ok: false,
			error: { path: 'catalog.skills[0].kind' },
		});
	});

	it('rejects lossy parameter-schema mappings', () => {
		const result = mapBridgeCatalog(
			{
				...bridgeCatalog,
				skills: [
					{
						...bridgeCatalog.skills[0],
						parameters: { type: 'object', oneOf: [] },
					},
				],
			},
			bridgePoses,
		);
		expect(result).toMatchObject({
			ok: false,
			error: { path: 'catalog.skills[0].parameters' },
		});
	});
});
