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

export type CatalogPrimitiveEntry = {
	name: string;
	summary?: string;
	parameters?: SkillParamSchema;
	timeoutSec?: number;
};

export type RobotCatalog = {
	robotName: string;
	configDigest: string;
	skills: CatalogSkillEntry[];
	primitives: string[];
	primitiveDetails?: CatalogPrimitiveEntry[];
	namedPoses: string[];
};

export type RobotCatalogParseResult =
	| { ok: true; catalog: RobotCatalog }
	| { ok: false; error: string };

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

const CATALOG_KEYS = new Set([
	'robotName',
	'configDigest',
	'skills',
	'primitives',
	'primitiveDetails',
	'namedPoses',
]);
const SKILL_KEYS = new Set([
	'name',
	'summary',
	'domain',
	'requiredControlMode',
	'movesRobot',
	'parameters',
	'recoveryPolicy',
	'timeoutSec',
]);
const PRIMITIVE_KEYS = new Set(['name', 'summary', 'parameters', 'timeoutSec']);
const PARAM_SCHEMA_KEYS = new Set(['type', 'properties', 'required', 'additionalProperties']);
const MAX_CATALOG_TEXT_LENGTH = 1000;
const MAX_CATALOG_TIMEOUT_SEC = 600;

/** Parse and normalize the catalog format persisted beside a Blockly workspace. */
export function parseRobotCatalog(value: unknown): RobotCatalogParseResult {
	if (!isJsonRecord(value)) return { ok: false, error: 'catalog must be an object' };
	const unknownKey = firstUnknownKey(value, CATALOG_KEYS);
	if (unknownKey !== null) {
		return { ok: false, error: `catalog contains unknown field "${unknownKey}"` };
	}
	if (!isCatalogText(value.robotName)) {
		return { ok: false, error: 'catalog robotName must be a non-empty string' };
	}
	if (!isCatalogText(value.configDigest)) {
		return { ok: false, error: 'catalog configDigest must be a non-empty string' };
	}
	if (!Array.isArray(value.skills)) return { ok: false, error: 'catalog skills must be an array' };
	if (!Array.isArray(value.primitives)) {
		return { ok: false, error: 'catalog primitives must be an array' };
	}
	if (!Array.isArray(value.namedPoses)) {
		return { ok: false, error: 'catalog namedPoses must be an array' };
	}

	const skills: CatalogSkillEntry[] = [];
	for (const [index, entry] of value.skills.entries()) {
		const parsed = parseCatalogSkill(entry, `catalog.skills[${index}]`);
		if (typeof parsed === 'string') return { ok: false, error: parsed };
		skills.push(parsed);
	}
	const skillNames = skills.map((entry) => entry.name);
	if (new Set(skillNames).size !== skillNames.length) {
		return { ok: false, error: 'catalog skill names must be unique' };
	}

	const primitives = parseCatalogNames(value.primitives, 'catalog.primitives');
	if (typeof primitives === 'string') return { ok: false, error: primitives };
	const namedPoses = parseCatalogNames(value.namedPoses, 'catalog.namedPoses');
	if (typeof namedPoses === 'string') return { ok: false, error: namedPoses };

	let primitiveDetails: CatalogPrimitiveEntry[] | undefined;
	if (value.primitiveDetails !== undefined) {
		if (!Array.isArray(value.primitiveDetails)) {
			return { ok: false, error: 'catalog primitiveDetails must be an array' };
		}
		primitiveDetails = [];
		for (const [index, entry] of value.primitiveDetails.entries()) {
			const parsed = parseCatalogPrimitive(entry, `catalog.primitiveDetails[${index}]`);
			if (typeof parsed === 'string') return { ok: false, error: parsed };
			if (!primitives.includes(parsed.name)) {
				return {
					ok: false,
					error: `catalog.primitiveDetails[${index}].name is absent from catalog.primitives`,
				};
			}
			primitiveDetails.push(parsed);
		}
		const detailNames = primitiveDetails.map((entry) => entry.name);
		if (new Set(detailNames).size !== detailNames.length) {
			return { ok: false, error: 'catalog primitive detail names must be unique' };
		}
	}

	const catalog: RobotCatalog = {
		robotName: value.robotName,
		configDigest: value.configDigest,
		skills,
		primitives,
		namedPoses,
	};
	if (primitiveDetails !== undefined) catalog.primitiveDetails = primitiveDetails;
	return { ok: true, catalog };
}

function parseCatalogSkill(value: unknown, path: string): CatalogSkillEntry | string {
	if (!isJsonRecord(value)) return `${path} must be an object`;
	const unknownKey = firstUnknownKey(value, SKILL_KEYS);
	if (unknownKey !== null) return `${path} contains unknown field "${unknownKey}"`;
	if (!isCatalogName(value.name)) return `${path}.name must be a safe non-empty string`;
	if (!isCatalogText(value.summary)) return `${path}.summary must be a non-empty string`;

	const parsed: CatalogSkillEntry = { name: value.name, summary: value.summary };
	const optionalTextError = copyOptionalCatalogText(
		value,
		parsed,
		['domain', 'requiredControlMode', 'recoveryPolicy'],
		path,
	);
	if (optionalTextError !== null) return optionalTextError;
	if (value.movesRobot !== undefined) {
		if (typeof value.movesRobot !== 'boolean') return `${path}.movesRobot must be a boolean`;
		parsed.movesRobot = value.movesRobot;
	}
	const timeout = parseCatalogTimeout(value.timeoutSec, `${path}.timeoutSec`);
	if (typeof timeout === 'string') return timeout;
	if (timeout !== undefined) parsed.timeoutSec = timeout;
	const schema = parseCatalogParamSchema(value.parameters, `${path}.parameters`);
	if (typeof schema === 'string') return schema;
	if (schema !== undefined) parsed.parameters = schema;
	return parsed;
}

function parseCatalogPrimitive(value: unknown, path: string): CatalogPrimitiveEntry | string {
	if (!isJsonRecord(value)) return `${path} must be an object`;
	const unknownKey = firstUnknownKey(value, PRIMITIVE_KEYS);
	if (unknownKey !== null) return `${path} contains unknown field "${unknownKey}"`;
	if (!isCatalogName(value.name)) return `${path}.name must be a safe non-empty string`;
	const parsed: CatalogPrimitiveEntry = { name: value.name };
	if (value.summary !== undefined) {
		if (!isCatalogText(value.summary)) return `${path}.summary must be a non-empty string`;
		parsed.summary = value.summary;
	}
	const timeout = parseCatalogTimeout(value.timeoutSec, `${path}.timeoutSec`);
	if (typeof timeout === 'string') return timeout;
	if (timeout !== undefined) parsed.timeoutSec = timeout;
	const schema = parseCatalogParamSchema(value.parameters, `${path}.parameters`);
	if (typeof schema === 'string') return schema;
	if (schema !== undefined) parsed.parameters = schema;
	return parsed;
}

function parseCatalogParamSchema(
	value: unknown,
	path: string,
): SkillParamSchema | string | undefined {
	if (value === undefined) return undefined;
	if (!isJsonRecord(value)) return `${path} must be an object`;
	const unknownKey = firstUnknownKey(value, PARAM_SCHEMA_KEYS);
	if (unknownKey !== null) return `${path} contains unknown field "${unknownKey}"`;
	if (containsDangerousKey(value)) return `${path} contains a forbidden key`;

	const schema: SkillParamSchema = {};
	if (value.type !== undefined) {
		if (typeof value.type !== 'string') return `${path}.type must be a string`;
		schema.type = value.type;
	}
	if (value.properties !== undefined) {
		if (!isJsonRecord(value.properties)) return `${path}.properties must be an object`;
		const properties: Record<string, JsonRecord> = {};
		for (const [name, property] of Object.entries(value.properties)) {
			if (isDangerousSegment(name)) return `${path}.properties contains forbidden key "${name}"`;
			if (!isJsonRecord(property)) return `${path}.properties.${name} must be an object`;
			properties[name] = property;
		}
		schema.properties = properties;
	}
	if (value.required !== undefined) {
		if (!Array.isArray(value.required) || !value.required.every(isCatalogName)) {
			return `${path}.required must contain safe parameter names`;
		}
		if (new Set(value.required).size !== value.required.length) {
			return `${path}.required must contain unique parameter names`;
		}
		if (
			schema.properties !== undefined &&
			value.required.some((name) => !(name in (schema.properties ?? {})))
		) {
			return `${path}.required references an undefined property`;
		}
		schema.required = [...value.required];
	}
	if (value.additionalProperties !== undefined) {
		if (typeof value.additionalProperties !== 'boolean') {
			return `${path}.additionalProperties must be a boolean`;
		}
		schema.additionalProperties = value.additionalProperties;
	}
	return schema;
}

function parseCatalogNames(value: unknown[], path: string): string[] | string {
	if (!value.every(isCatalogName)) return `${path} must contain safe non-empty strings`;
	if (new Set(value).size !== value.length) return `${path} must contain unique names`;
	return [...value];
}

function parseCatalogTimeout(value: unknown, path: string): number | string | undefined {
	if (value === undefined) return undefined;
	if (
		typeof value !== 'number' ||
		!Number.isFinite(value) ||
		value <= 0 ||
		value > MAX_CATALOG_TIMEOUT_SEC
	) {
		return `${path} must be a positive number at most ${MAX_CATALOG_TIMEOUT_SEC}`;
	}
	return value;
}

function copyOptionalCatalogText(
	source: JsonRecord,
	target: CatalogSkillEntry,
	keys: Array<'domain' | 'requiredControlMode' | 'recoveryPolicy'>,
	path: string,
): string | null {
	for (const key of keys) {
		const value = source[key];
		if (value === undefined) continue;
		if (!isCatalogText(value)) return `${path}.${key} must be a non-empty string`;
		target[key] = value;
	}
	return null;
}

function firstUnknownKey(value: JsonRecord, allowed: ReadonlySet<string>): string | null {
	return Object.keys(value).find((key) => !allowed.has(key)) ?? null;
}

function isCatalogText(value: unknown): value is string {
	return (
		typeof value === 'string' && value.trim() !== '' && value.length <= MAX_CATALOG_TEXT_LENGTH
	);
}

function isCatalogName(value: unknown): value is string {
	return isCatalogText(value) && !isDangerousSegment(value);
}
