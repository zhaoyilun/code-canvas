/** Robot catalog types, the offline SO-101 snapshot, and param-schema validation. */

export type JsonRecord = Record<string, unknown>;

export type SkillParamSchema = {
	type?: string;
	properties?: Record<string, JsonRecord>;
	required?: string[];
	additionalProperties?: boolean;
};

export type CatalogSkillEntry = {
	name: string;
	summary: string;
	domain?: string;
	requiredControlMode?: string;
	movesRobot?: boolean;
	parameters?: SkillParamSchema;
	recoveryPolicy?: string;
	timeoutSec?: number;
};

export type RobotCatalog = {
	robotName: string;
	configDigest: string;
	skills: CatalogSkillEntry[];
	primitives: string[];
	namedPoses: string[];
};

export const MOTION_DIRECTIONS = ['forward', 'backward', 'left', 'right', 'up', 'down'] as const;

export const DEFAULT_SKILL_TIMEOUT_SEC = 30;
export const TASK_BUDGET_SEC = 180;

/** The offline whitelist embedded with the node package (design §7.1).
 *
 * Snapshot of `so101_single_arm` enabled skills (planning_policy.allowed_skills),
 * the ten supported primitives, and the public named poses. Freshness is
 * enforced at execution time via configDigest comparison against the live
 * bridge catalog.
 */
export const SO101_CATALOG_SNAPSHOT: RobotCatalog = {
	robotName: 'so101_single_arm',
	configDigest: 'so101-single-arm-snapshot-v1',
	skills: [
		{
			name: 'inspect_scene',
			summary: 'Inspect the workspace from the observation view.',
			domain: 'manipulation',
			requiredControlMode: 'moveit_planning',
			parameters: { type: 'object', properties: {}, required: [], additionalProperties: false },
			recoveryPolicy: 'never_retry',
			timeoutSec: 30,
		},
		{
			name: 'recover_safe_pose',
			summary: "Return the arm to the 'home' safe rest pose.",
			domain: 'manipulation',
			requiredControlMode: 'moveit_planning',
			parameters: { type: 'object', properties: {}, required: [], additionalProperties: false },
			recoveryPolicy: 'never_retry',
			timeoutSec: 30,
		},
		{
			name: 'recover_zero_pose',
			summary: "Return the arm to the 'zero' pose.",
			domain: 'manipulation',
			requiredControlMode: 'moveit_planning',
			parameters: { type: 'object', properties: {}, required: [], additionalProperties: false },
			recoveryPolicy: 'never_retry',
			timeoutSec: 30,
		},
		{
			name: 'move_relative_ee',
			summary: 'Move the end effector relative to its current pose.',
			domain: 'manipulation',
			requiredControlMode: 'moveit_planning',
			parameters: {
				type: 'object',
				properties: {
					motion_direction: { type: 'string', enum: [...MOTION_DIRECTIONS] },
					motion_distance: { type: 'number' },
				},
				required: ['motion_direction', 'motion_distance'],
				additionalProperties: false,
			},
			recoveryPolicy: 'never_retry',
			timeoutSec: 30,
		},
		{
			name: 'open_gripper_skill',
			summary: 'Open the gripper.',
			domain: 'manipulation',
			requiredControlMode: 'moveit_planning',
			parameters: { type: 'object', properties: {}, required: [], additionalProperties: false },
			recoveryPolicy: 'never_retry',
			timeoutSec: 15,
		},
		{
			name: 'close_gripper_skill',
			summary: 'Close the gripper.',
			domain: 'manipulation',
			requiredControlMode: 'moveit_planning',
			parameters: { type: 'object', properties: {}, required: [], additionalProperties: false },
			recoveryPolicy: 'never_retry',
			timeoutSec: 15,
		},
		{
			name: 'rotate_gripper_cw',
			summary: 'Rotate the gripper clockwise around the end-effector Z axis.',
			domain: 'manipulation',
			requiredControlMode: 'moveit_planning',
			parameters: {
				type: 'object',
				properties: { motion_distance: { type: 'number' } },
				required: ['motion_distance'],
				additionalProperties: false,
			},
			recoveryPolicy: 'never_retry',
			timeoutSec: 30,
		},
		{
			name: 'rotate_gripper_ccw',
			summary: 'Rotate the gripper counter-clockwise around the end-effector Z axis.',
			domain: 'manipulation',
			requiredControlMode: 'moveit_planning',
			parameters: {
				type: 'object',
				properties: { motion_distance: { type: 'number' } },
				required: ['motion_distance'],
				additionalProperties: false,
			},
			recoveryPolicy: 'never_retry',
			timeoutSec: 30,
		},
		{
			name: 'dance_basic',
			summary: 'Perform a rhythmic dance gesture.',
			domain: 'entertainment',
			requiredControlMode: 'moveit_planning',
			parameters: { type: 'object', properties: {}, required: [], additionalProperties: false },
			recoveryPolicy: 'never_retry',
			timeoutSec: 60,
		},
		{
			name: 'wave_hello',
			summary: 'Wave hello.',
			domain: 'social',
			requiredControlMode: 'moveit_planning',
			parameters: { type: 'object', properties: {}, required: [], additionalProperties: false },
			recoveryPolicy: 'never_retry',
			timeoutSec: 30,
		},
		{
			name: 'nod_yes',
			summary: 'Nod yes.',
			domain: 'social',
			requiredControlMode: 'moveit_planning',
			parameters: { type: 'object', properties: {}, required: [], additionalProperties: false },
			recoveryPolicy: 'never_retry',
			timeoutSec: 30,
		},
		{
			name: 'shake_no',
			summary: 'Shake no.',
			domain: 'social',
			requiredControlMode: 'moveit_planning',
			parameters: { type: 'object', properties: {}, required: [], additionalProperties: false },
			recoveryPolicy: 'never_retry',
			timeoutSec: 30,
		},
		{
			name: 'celebrate',
			summary: 'Celebrate a success.',
			domain: 'social',
			requiredControlMode: 'moveit_planning',
			parameters: { type: 'object', properties: {}, required: [], additionalProperties: false },
			recoveryPolicy: 'never_retry',
			timeoutSec: 30,
		},
		{
			name: 'greet_observe_raise',
			summary: 'Raise into the observe pose as a greeting.',
			domain: 'social',
			requiredControlMode: 'moveit_planning',
			parameters: { type: 'object', properties: {}, required: [], additionalProperties: false },
			recoveryPolicy: 'never_retry',
			timeoutSec: 30,
		},
		{
			name: 'act_cute',
			summary: 'Act cute to seek attention.',
			domain: 'social',
			requiredControlMode: 'moveit_planning',
			parameters: { type: 'object', properties: {}, required: [], additionalProperties: false },
			recoveryPolicy: 'never_retry',
			timeoutSec: 30,
		},
		{
			name: 'happy_spin_upright',
			summary: 'Spin cheerfully while upright.',
			domain: 'social',
			requiredControlMode: 'moveit_planning',
			parameters: { type: 'object', properties: {}, required: [], additionalProperties: false },
			recoveryPolicy: 'never_retry',
			timeoutSec: 30,
		},
	],
	primitives: [
		'move_to_named_pose',
		'move_to_pose',
		'move_to_configuration',
		'move_relative_ee',
		'move_to_joint_positions',
		'move_through_joint_positions',
		'open_gripper',
		'close_gripper',
		'rotate_gripper_cw',
		'rotate_gripper_ccw',
	],
	namedPoses: ['home', 'observe_table', 'zero'],
};

const DANGEROUS_SEGMENTS = ['__proto__', 'prototype', 'constructor'];

export function containsDangerousKey(value: unknown, depth = 0): boolean {
	if (depth > 8) return true;
	if (Array.isArray(value)) {
		return value.some((entry) => containsDangerousKey(entry, depth + 1));
	}
	if (typeof value === 'object' && value !== null) {
		return Object.entries(value).some(
			([key, entry]) => isDangerousSegment(key) || containsDangerousKey(entry, depth + 1),
		);
	}
	return false;
}

export function isDangerousSegment(key: string): boolean {
	const lowered = key.toLowerCase();
	return DANGEROUS_SEGMENTS.some((segment) => lowered.includes(segment));
}

function schemaTypeOf(value: unknown): string | null {
	if (typeof value === 'string') return 'string';
	if (typeof value === 'number') return Number.isFinite(value) ? 'number' : null;
	if (typeof value === 'boolean') return 'boolean';
	return null;
}

/** Minimal JSON-Schema subset validator for `capability.parameters` schemas.
 *
 * Supports the constructs the SSOT YAML uses: object roots with `properties`,
 * `required`, `additionalProperties: false`, `type`, `enum`, `const`.
 */
export function validateParamsAgainstSchema(
	schema: SkillParamSchema | undefined,
	params: JsonRecord,
): string | null {
	if (!schema || schema.type !== 'object') return null;

	const properties = schema.properties ?? {};
	const required = schema.required ?? [];

	for (const key of Object.keys(params)) {
		if (isDangerousSegment(key)) return `parameter key "${key}" is not allowed`;
		if (!(key in properties)) {
			if (schema.additionalProperties === false) {
				return `parameter "${key}" is not defined for this skill`;
			}
			continue;
		}
		const property = properties[key];
		if (!isJsonRecord(property)) continue;
		const value = params[key];
		const expected = typeof property.type === 'string' ? property.type : null;
		if (expected) {
			const actual = schemaTypeOf(value);
			if (actual !== expected) {
				return `parameter "${key}" must be of type ${expected}`;
			}
		}
		if (Array.isArray(property.enum) && !property.enum.includes(value)) {
			return `parameter "${key}" must be one of: ${property.enum.join(', ')}`;
		}
		if ('const' in property && property.const !== value) {
			return `parameter "${key}" must equal ${String(property.const)}`;
		}
	}

	for (const key of required) {
		if (!(key in params)) return `missing required parameter "${key}"`;
	}
	return null;
}

export function isJsonRecord(value: unknown): value is JsonRecord {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}
