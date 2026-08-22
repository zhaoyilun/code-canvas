import {
	isJsonRecord,
	parseRobotCatalog,
	type CatalogPrimitiveEntry,
	type CatalogSkillEntry,
	type JsonRecord,
	type RobotCatalog,
	type SkillParamSchema,
} from '@n8n/blockly-robot-skills';

export type BridgeCatalogMappingError = {
	code: 'BRIDGE_CATALOG_INVALID';
	path: string;
	message: string;
};

export type BridgeCatalogMappingResult =
	| { ok: true; catalog: RobotCatalog }
	| { ok: false; error: BridgeCatalogMappingError };

class MappingError extends Error {
	constructor(
		readonly path: string,
		message: string,
	) {
		super(message);
	}
}

/** Convert the bridge's snake_case transport model into the strict Blockly catalog model. */
export function mapBridgeCatalog(
	catalogInput: unknown,
	poseCatalogInput: unknown,
): BridgeCatalogMappingResult {
	try {
		const live = requireRecord(catalogInput, 'catalog');
		const poseCatalog = requireRecord(poseCatalogInput, 'poses');
		const robotName = requireText(live.robot_name, 'catalog.robot_name');
		const configDigest = requireText(live.config_digest, 'catalog.config_digest');
		const poseRobotName = requireText(poseCatalog.robot_name, 'poses.robot_name');
		const poseConfigDigest = requireText(poseCatalog.config_digest, 'poses.config_digest');

		if (poseRobotName !== robotName) {
			throw new MappingError(
				'poses.robot_name',
				`pose catalog robot ${poseRobotName} does not match action catalog robot ${robotName}`,
			);
		}
		if (poseConfigDigest !== configDigest) {
			throw new MappingError(
				'poses.config_digest',
				`pose catalog digest ${poseConfigDigest} does not match action catalog digest ${configDigest}`,
			);
		}

		const skillInputs = requireArray(live.skills, 'catalog.skills');
		const primitiveInputs = requireArray(live.primitives, 'catalog.primitives');
		const poseInputs = requireArray(poseCatalog.poses, 'poses.poses');
		const skills = skillInputs.map((entry, index) => mapSkill(entry, index));
		const primitiveDetails = primitiveInputs.map((entry, index) => mapPrimitive(entry, index));
		const namedPoses = poseInputs.map((entry, index) =>
			requireText(entry, `poses.poses[${index}]`),
		);

		const candidate: RobotCatalog = {
			robotName,
			configDigest,
			skills,
			primitives: primitiveDetails.map((entry) => entry.name),
			primitiveDetails,
			namedPoses,
		};
		const parsed = parseRobotCatalog(candidate);
		if (!parsed.ok) throw new MappingError('catalog', parsed.error);
		return { ok: true, catalog: parsed.catalog };
	} catch (error) {
		if (error instanceof MappingError) {
			return {
				ok: false,
				error: { code: 'BRIDGE_CATALOG_INVALID', path: error.path, message: error.message },
			};
		}
		return {
			ok: false,
			error: {
				code: 'BRIDGE_CATALOG_INVALID',
				path: 'catalog',
				message: error instanceof Error ? error.message : 'unexpected catalog mapping error',
			},
		};
	}
}

function mapSkill(value: unknown, index: number): CatalogSkillEntry {
	const path = `catalog.skills[${index}]`;
	const entry = requireRecord(value, path);
	requireKind(entry.kind, 'skill', `${path}.kind`);
	const skill: CatalogSkillEntry = {
		name: requireText(entry.name, `${path}.name`),
		summary: requireText(entry.summary, `${path}.summary`),
	};
	copyOptionalText(entry.domain, `${path}.domain`, (text) => {
		skill.domain = text;
	});
	copyOptionalText(entry.required_control_mode, `${path}.required_control_mode`, (text) => {
		skill.requiredControlMode = text;
	});
	if (entry.moves_robot !== undefined) {
		if (typeof entry.moves_robot !== 'boolean') {
			throw new MappingError(`${path}.moves_robot`, 'moves_robot must be a boolean');
		}
		skill.movesRobot = entry.moves_robot;
	}
	const parameters = mapParameters(entry.parameters, `${path}.parameters`);
	if (parameters !== undefined) skill.parameters = parameters;
	copyOptionalText(entry.recovery_policy, `${path}.recovery_policy`, (text) => {
		skill.recoveryPolicy = text;
	});
	const timeoutSec = mapCapabilityTimeout(entry, path);
	if (timeoutSec !== undefined) skill.timeoutSec = timeoutSec;
	return skill;
}

function mapPrimitive(value: unknown, index: number): CatalogPrimitiveEntry {
	const path = `catalog.primitives[${index}]`;
	const entry = requireRecord(value, path);
	requireKind(entry.kind, 'primitive', `${path}.kind`);
	const primitive: CatalogPrimitiveEntry = {
		name: requireText(entry.name, `${path}.name`),
	};
	copyOptionalText(entry.summary, `${path}.summary`, (text) => {
		primitive.summary = text;
	});
	const parameters = mapParameters(entry.parameters, `${path}.parameters`);
	if (parameters !== undefined) primitive.parameters = parameters;
	const timeoutSec = mapCapabilityTimeout(entry, path);
	if (timeoutSec !== undefined) primitive.timeoutSec = timeoutSec;
	return primitive;
}

function mapParameters(value: unknown, path: string): SkillParamSchema | undefined {
	if (value === undefined) return undefined;
	const input = requireRecord(value, path);
	const allowed = new Set(['type', 'properties', 'required', 'additionalProperties']);
	const unknownKey = Object.keys(input).find((key) => !allowed.has(key));
	if (unknownKey !== undefined) {
		throw new MappingError(path, `parameter schema contains unknown field ${unknownKey}`);
	}

	const schema: SkillParamSchema = {};
	if (input.type !== undefined) {
		if (typeof input.type !== 'string' || input.type.trim() === '') {
			throw new MappingError(`${path}.type`, 'schema type must be a non-empty string');
		}
		schema.type = input.type;
	}
	if (input.properties !== undefined) {
		const sourceProperties = requireRecord(input.properties, `${path}.properties`);
		const properties: Record<string, JsonRecord> = {};
		for (const [name, property] of Object.entries(sourceProperties)) {
			properties[name] = requireRecord(property, `${path}.properties.${name}`);
		}
		schema.properties = properties;
	}
	if (input.required !== undefined) {
		const required = requireArray(input.required, `${path}.required`).map((entry, index) =>
			requireText(entry, `${path}.required[${index}]`),
		);
		schema.required = required;
	}
	if (input.additionalProperties !== undefined) {
		if (typeof input.additionalProperties !== 'boolean') {
			throw new MappingError(
				`${path}.additionalProperties`,
				'additionalProperties must be a boolean',
			);
		}
		schema.additionalProperties = input.additionalProperties;
	}
	return schema;
}

function mapCapabilityTimeout(entry: JsonRecord, path: string): number | undefined {
	const direct = mapTimeoutValue(entry.timeout_sec, `${path}.timeout_sec`);
	const policy = mapTimeoutPolicy(entry.timeout_policy, `${path}.timeout_policy`);
	// Priority: action timeout_sec, then policy timeout_sec, default_skill_timeout_sec, default_timeout_sec.
	return direct ?? policy;
}

function mapTimeoutPolicy(value: unknown, path: string): number | undefined {
	if (value === undefined) return undefined;
	const policy = requireRecord(value, path);
	const direct = mapTimeoutValue(policy.timeout_sec, `${path}.timeout_sec`);
	const skillDefault = mapTimeoutValue(
		policy.default_skill_timeout_sec,
		`${path}.default_skill_timeout_sec`,
	);
	const genericDefault = mapTimeoutValue(
		policy.default_timeout_sec,
		`${path}.default_timeout_sec`,
	);
	return direct ?? skillDefault ?? genericDefault;
}

function mapTimeoutValue(value: unknown, path: string): number | undefined {
	if (value === undefined || value === null) return undefined;
	if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0 || value > 600) {
		throw new MappingError(path, 'timeout value must be a positive number at most 600');
	}
	return value;
}

function requireRecord(value: unknown, path: string): JsonRecord {
	if (!isJsonRecord(value)) throw new MappingError(path, `${path} must be an object`);
	return value;
}

function requireArray(value: unknown, path: string): unknown[] {
	if (!Array.isArray(value)) throw new MappingError(path, `${path} must be an array`);
	return value;
}

function requireText(value: unknown, path: string): string {
	if (typeof value !== 'string' || value.trim() === '') {
		throw new MappingError(path, `${path} must be a non-empty string`);
	}
	return value;
}

function requireKind(value: unknown, expected: 'skill' | 'primitive', path: string): void {
	if (value !== expected) throw new MappingError(path, `${path} must be ${expected}`);
}

function copyOptionalText(
	value: unknown,
	path: string,
	assign: (value: string) => void,
): void {
	if (value === undefined || value === '') return;
	if (typeof value !== 'string' || value.trim() === '') {
		throw new MappingError(path, `${path} must be a string`);
	}
	assign(value);
}
