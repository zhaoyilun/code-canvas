/** Payload handling: workspace and its digest-pinned catalog travel together. */

import type { RobotCatalog } from './catalog';
import { SO101_CATALOG_SNAPSHOT, isJsonRecord, parseRobotCatalog } from './catalog';
import type { RobotTaskPlan } from './compiler';

export const ROBOT_SKILL_SCHEMA_VERSION = 2;

export const MAX_PAYLOAD_BYTES = 256 * 1024;

export type RobotPlanPayload = {
	schemaVersion: typeof ROBOT_SKILL_SCHEMA_VERSION;
	catalog: RobotCatalog;
	workspace: Record<string, unknown>;
};

export type SerializeRobotPlanPayloadInput = Omit<RobotPlanPayload, 'schemaVersion'>;

export type ParseResult = { ok: true; payload: RobotPlanPayload } | { ok: false; error: string };

const PAYLOAD_KEYS = new Set(['schemaVersion', 'catalog', 'workspace']);

export function parseRobotPlanPayload(value: string): ParseResult {
	if (typeof value !== 'string' || value.trim() === '') {
		return { ok: false, error: 'payload is empty' };
	}
	if (utf8ByteLength(value) > MAX_PAYLOAD_BYTES) {
		return { ok: false, error: 'payload exceeds 256 KiB' };
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(value);
	} catch {
		return { ok: false, error: 'payload is not valid JSON' };
	}
	if (!isJsonRecord(parsed)) return { ok: false, error: 'payload must be an object' };
	if (parsed.schemaVersion !== ROBOT_SKILL_SCHEMA_VERSION) {
		return {
			ok: false,
			error: `unsupported payload schemaVersion ${String(parsed.schemaVersion)}`,
		};
	}
	const unknownKey = Object.keys(parsed).find((key) => !PAYLOAD_KEYS.has(key));
	if (unknownKey !== undefined) {
		return { ok: false, error: `payload contains unknown field "${unknownKey}"` };
	}
	const catalogResult = parseRobotCatalog(parsed.catalog);
	if (!catalogResult.ok) return { ok: false, error: catalogResult.error };
	if (!isJsonRecord(parsed.workspace)) {
		return { ok: false, error: 'payload workspace must be an object' };
	}
	return {
		ok: true,
		payload: {
			schemaVersion: ROBOT_SKILL_SCHEMA_VERSION,
			catalog: catalogResult.catalog,
			workspace: parsed.workspace,
		},
	};
}

export function serializeRobotPlanPayload(input: SerializeRobotPlanPayloadInput): string {
	if (!isJsonRecord(input.workspace)) throw new TypeError('payload workspace must be an object');
	const catalogResult = parseRobotCatalog(input.catalog);
	if (!catalogResult.ok) throw new TypeError(catalogResult.error);
	const serialized = JSON.stringify({
		schemaVersion: ROBOT_SKILL_SCHEMA_VERSION,
		catalog: catalogResult.catalog,
		workspace: input.workspace,
	});
	if (utf8ByteLength(serialized) > MAX_PAYLOAD_BYTES) {
		throw new RangeError('payload exceeds 256 KiB');
	}
	return serialized;
}

/** Default plan: observe the scene, then return to the safe pose. */
export function createDefaultRobotWorkspace(): Record<string, unknown> {
	return {
		blocks: {
			blocks: [
				{
					type: 'robot_task_plan',
					inputs: {
						DO: {
							block: {
								type: 'robot_execute_skill',
								fields: { SKILL: 'inspect_scene' },
								next: {
									block: {
										type: 'robot_execute_skill',
										fields: { SKILL: 'recover_safe_pose' },
									},
								},
							},
						},
					},
				},
			],
		},
	};
}

export function createDefaultRobotPlanPayload(): string {
	return serializeRobotPlanPayload({
		catalog: SO101_CATALOG_SNAPSHOT,
		workspace: createDefaultRobotWorkspace(),
	});
}

/** Runtime-side plan extraction from an item: accepts either a full
 * RobotTaskPlan or a bare `{ plan: [...] }` wrapper. */
export function extractPlan(value: unknown): RobotTaskPlan | string {
	if (!isJsonRecord(value)) return 'plan input must be an object';
	const candidate = isPlanShape(value) ? value : isJsonRecord(value.plan) ? value.plan : null;
	if (candidate === null || !isPlanShape(candidate)) {
		return 'plan input must contain a schemaVersion 1 RobotTaskPlan';
	}
	if (!Array.isArray(candidate.plan) || candidate.plan.length === 0) {
		return 'plan must contain at least one step';
	}
	for (const step of candidate.plan as unknown[]) {
		if (!isJsonRecord(step) || typeof step.step !== 'string') return 'plan step is malformed';
	}
	return {
		schemaVersion: 1,
		robot: typeof candidate.robot === 'string' ? candidate.robot : '',
		configDigest: typeof candidate.configDigest === 'string' ? candidate.configDigest : '',
		plan: candidate.plan,
	};
}

function isPlanShape(value: Record<string, unknown>): value is RobotTaskPlan {
	return value.schemaVersion === 1 && Array.isArray(value.plan);
}

function utf8ByteLength(value: string): number {
	let bytes = 0;
	for (const character of value) {
		const codePoint = character.codePointAt(0);
		if (codePoint === undefined) continue;
		if (codePoint <= 0x7f) bytes += 1;
		else if (codePoint <= 0x7ff) bytes += 2;
		else if (codePoint <= 0xffff) bytes += 3;
		else bytes += 4;
	}
	return bytes;
}
