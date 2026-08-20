import { describe, expect, it } from 'vitest';

import { SO101_CATALOG_SNAPSHOT } from './catalog';
import { compileRobotWorkspace } from './compiler';
import {
	createDefaultRobotWorkspace,
	extractPlan,
	parseRobotPlanPayload,
	serializeRobotPlanPayload,
} from './payload';

describe('parseRobotPlanPayload', () => {
	it('round-trips a serialized payload', () => {
		const workspace = createDefaultRobotWorkspace();
		const compiled = compileRobotWorkspace(workspace, SO101_CATALOG_SNAPSHOT);
		expect(compiled.ok).toBe(true);
		if (!compiled.ok) return;
		const serialized = serializeRobotPlanPayload(workspace, compiled.plan);
		const parsed = parseRobotPlanPayload(serialized);
		expect(parsed.ok).toBe(true);
		if (!parsed.ok) return;
		expect(parsed.payload.workspace).toEqual(workspace);
	});

	it('accepts intermediate saves without a plan preview', () => {
		const serialized = serializeRobotPlanPayload(createDefaultRobotWorkspace(), undefined);
		expect(parseRobotPlanPayload(serialized).ok).toBe(true);
	});

	it('rejects empty, non-JSON, wrong-version, and oversized payloads', () => {
		expect(parseRobotPlanPayload('')).toEqual({ ok: false, error: 'payload is empty' });
		expect(parseRobotPlanPayload('nope')).toEqual({
			ok: false,
			error: 'payload is not valid JSON',
		});
		expect(parseRobotPlanPayload('{"schemaVersion":9,"workspace":{}}')).toEqual({
			ok: false,
			error: 'unsupported payload schemaVersion 9',
		});
		const oversized = JSON.stringify({
			schemaVersion: 1,
			workspace: { padding: 'x'.repeat(300 * 1024) },
		});
		expect(parseRobotPlanPayload(oversized)).toEqual({
			ok: false,
			error: 'payload exceeds 256 KiB',
		});
	});

	it('rejects a workspace that is not an object', () => {
		expect(parseRobotPlanPayload('{"schemaVersion":1,"workspace":5}')).toEqual({
			ok: false,
			error: 'payload workspace must be an object',
		});
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
