/** Payload handling: the workspace is the source of truth; `plan` is a
 * read-only preview cache the runtime never trusts (mirrors v1 decisions). */

import { isJsonRecord } from './catalog';
import type { RobotTaskPlan } from './compiler';

export const ROBOT_SKILL_SCHEMA_VERSION = 1;

export const MAX_PAYLOAD_BYTES = 256 * 1024;

export type RobotPlanPayload = {
	schemaVersion: typeof ROBOT_SKILL_SCHEMA_VERSION;
	workspace: Record<string, unknown>;
	plan?: RobotTaskPlan;
};

export type ParseResult = { ok: true; payload: RobotPlanPayload } | { ok: false; error: string };

export function parseRobotPlanPayload(value: string): ParseResult {
	if (typeof value !== 'string' || value.trim() === '') {
		return { ok: false, error: 'payload is empty' };
	}
	if (value.length > MAX_PAYLOAD_BYTES) {
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
	if (!isJsonRecord(parsed.workspace))
		return { ok: false, error: 'payload workspace must be an object' };
	return {
		ok: true,
		payload: { schemaVersion: ROBOT_SKILL_SCHEMA_VERSION, workspace: parsed.workspace },
	};
}

export function serializeRobotPlanPayload(
	workspace: Record<string, unknown>,
	plan: RobotTaskPlan | undefined,
): string {
	return JSON.stringify({
		schemaVersion: ROBOT_SKILL_SCHEMA_VERSION,
		workspace,
		plan,
	});
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
	return value.schemaVersion === ROBOT_SKILL_SCHEMA_VERSION && Array.isArray(value.plan);
}
