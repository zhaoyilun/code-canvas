import { describe, expect, it } from 'vitest';

import type { RobotCatalog } from './catalog';
import { SO101_CATALOG_SNAPSHOT } from './catalog';
import { compileRobotWorkspace } from './compiler';
import {
	createDefaultRobotPlanPayload,
	createDefaultRobotWorkspace,
	extractPlan,
	parseRobotPlanPayload,
	serializeRobotPlanPayload,
} from './payload';

describe('RobotPlanPayload v2', () => {
	it('round-trips workspace and the exact catalog used to compile it', () => {
		const workspace = createDefaultRobotWorkspace();
		const serialized = serializeRobotPlanPayload({
			catalog: SO101_CATALOG_SNAPSHOT,
			workspace,
		});
		const parsed = parseRobotPlanPayload(serialized);
		expect(parsed.ok).toBe(true);
		if (!parsed.ok) return;
		expect(parsed.payload).toEqual({
			schemaVersion: 2,
			catalog: SO101_CATALOG_SNAPSHOT,
			workspace,
		});

		const compiled = compileRobotWorkspace(parsed.payload.workspace, parsed.payload.catalog);
		expect(compiled.ok).toBe(true);
	});

	it('keeps a live catalog capability available after payload import', () => {
		const catalog: RobotCatalog = {
			robotName: 'classroom_robot',
			configDigest: 'live-digest-42',
			skills: [
				{
					name: 'lesson_wave',
					summary: 'Wave for the current lesson.',
					parameters: {
						type: 'object',
						properties: { repetitions: { type: 'number' } },
						required: ['repetitions'],
						additionalProperties: false,
					},
					timeoutSec: 20,
				},
			],
			primitives: ['move_to_named_pose'],
			primitiveDetails: [
				{
					name: 'move_to_named_pose',
					parameters: {
						type: 'object',
						properties: { target_name: { type: 'string' } },
						required: ['target_name'],
						additionalProperties: false,
					},
				},
			],
			namedPoses: ['lesson_home'],
		};
		const workspace = {
			blocks: {
				blocks: [
					{
						type: 'robot_task_plan',
						inputs: {
							DO: {
								block: {
									type: 'robot_execute_skill',
									fields: { SKILL: 'lesson_wave', PARAMS_JSON: '{"repetitions":2}' },
								},
							},
						},
					},
				],
			},
		};
		const parsed = parseRobotPlanPayload(serializeRobotPlanPayload({ catalog, workspace }));
		expect(parsed.ok).toBe(true);
		if (!parsed.ok) return;
		expect(parsed.payload.catalog.configDigest).toBe('live-digest-42');
		expect(parsed.payload.catalog.skills[0]?.name).toBe('lesson_wave');
		expect(compileRobotWorkspace(parsed.payload.workspace, parsed.payload.catalog)).toMatchObject({
			ok: true,
			plan: {
				robot: 'classroom_robot',
				configDigest: 'live-digest-42',
				plan: [
					{
						step: 'skill',
						skill: 'lesson_wave',
						params: { repetitions: 2 },
						timeoutSec: 20,
					},
				],
			},
		});
	});

	it('creates a complete default payload', () => {
		const parsed = parseRobotPlanPayload(createDefaultRobotPlanPayload());
		expect(parsed.ok).toBe(true);
		if (!parsed.ok) return;
		expect(parsed.payload.catalog.configDigest).toBe(SO101_CATALOG_SNAPSHOT.configDigest);
		expect(compileRobotWorkspace(parsed.payload.workspace, parsed.payload.catalog).ok).toBe(true);
	});

	it('rejects empty, non-JSON, old-version, unknown-field, and oversized payloads', () => {
		expect(parseRobotPlanPayload('')).toEqual({ ok: false, error: 'payload is empty' });
		expect(parseRobotPlanPayload('nope')).toEqual({
			ok: false,
			error: 'payload is not valid JSON',
		});
		expect(parseRobotPlanPayload('{"schemaVersion":1,"workspace":{}}')).toEqual({
			ok: false,
			error: 'unsupported payload schemaVersion 1',
		});
		const withPreview = JSON.stringify({
			schemaVersion: 2,
			catalog: SO101_CATALOG_SNAPSHOT,
			workspace: {},
			plan: {},
		});
		expect(parseRobotPlanPayload(withPreview)).toEqual({
			ok: false,
			error: 'payload contains unknown field "plan"',
		});
		const oversized = JSON.stringify({
			schemaVersion: 2,
			catalog: SO101_CATALOG_SNAPSHOT,
			workspace: { padding: '课'.repeat(100 * 1024) },
		});
		expect(parseRobotPlanPayload(oversized)).toEqual({
			ok: false,
			error: 'payload exceeds 256 KiB',
		});
	});

	it('rejects missing or malformed catalog data and invalid serializer input', () => {
		expect(parseRobotPlanPayload('{"schemaVersion":2,"workspace":{}}')).toEqual({
			ok: false,
			error: 'catalog must be an object',
		});
		const malformedCatalog = JSON.stringify({
			schemaVersion: 2,
			catalog: { ...SO101_CATALOG_SNAPSHOT, configDigest: '' },
			workspace: {},
		});
		expect(parseRobotPlanPayload(malformedCatalog)).toEqual({
			ok: false,
			error: 'catalog configDigest must be a non-empty string',
		});
		expect(() =>
			serializeRobotPlanPayload({
				catalog: { ...SO101_CATALOG_SNAPSHOT, configDigest: '' },
				workspace: {},
			}),
		).toThrow('catalog configDigest must be a non-empty string');
	});
});

describe('extractPlan', () => {
	it('accepts a full plan and a bare wrapper', () => {
		const plan = {
			schemaVersion: 1,
			robot: 'r',
			configDigest: 'd',
			plan: [{ step: 'wait', seconds: 1 }],
		};
		expect(extractPlan(plan)).toEqual(plan);
		expect(extractPlan({ plan })).toEqual(plan);
	});

	it('rejects malformed inputs', () => {
		expect(extractPlan(null)).toEqual('plan input must be an object');
		expect(extractPlan({ schemaVersion: 1, plan: [] })).toEqual(
			'plan must contain at least one step',
		);
		expect(extractPlan({ schemaVersion: 2, plan: [{ step: 'wait', seconds: 1 }] })).toEqual(
			'plan input must contain a schemaVersion 1 RobotTaskPlan',
		);
		expect(extractPlan({ schemaVersion: 1, plan: [{ nope: true }] })).toEqual(
			'plan step is malformed',
		);
	});
});
