import { describe, expect, it } from 'vitest';

import {
	CAPABILITY_PLAN_LIMITS,
	CAPABILITY_PLAN_SCHEMA_VERSION,
	compileCapabilityPlanWorkspace,
	createDefaultCapabilityPlanPayload,
	generateCapabilityPlanWorkspace,
	parseCapabilityPlanPayload,
	serializeCapabilityPlanPayload,
} from './index';

const catalog = {
	apiVersion: 1,
	catalogRef: 'education.delivery',
	revisionRef: 'revision.1',
	capabilities: [
		{
			capabilityRef: 'message.deliver',
			displayName: 'Deliver message',
			inputs: [
				{
					parameterRef: 'text',
					displayName: 'Text',
					valueType: 'string',
					required: true,
				},
			],
			outputs: [{ outputRef: 'messageId', displayName: 'Message ID', valueType: 'string' }],
		},
	],
} as const;

describe('capability-plan payload', () => {
	it('creates an empty source payload without a derived plan', () => {
		const payload = createDefaultCapabilityPlanPayload(catalog, 'lesson.delivery', {
			title: 'Delivery lesson',
		});
		expect(payload).toMatchObject({
			schemaVersion: CAPABILITY_PLAN_SCHEMA_VERSION,
			catalog,
			planRef: 'lesson.delivery',
			metadata: { title: 'Delivery lesson' },
		});
		expect(Object.keys(payload).sort()).toEqual([
			'catalog',
			'metadata',
			'planRef',
			'schemaVersion',
			'workspace',
		]);
	});

	it('serializes canonically and parses a populated workspace', () => {
		const plan = {
			apiVersion: 1,
			planRef: 'lesson.delivery',
			catalogRef: catalog.catalogRef,
			catalogRevisionRef: catalog.revisionRef,
			steps: [
				{
					stepRef: 'deliver',
					capabilityRef: 'message.deliver',
					arguments: { text: 'Hello' },
					dependsOn: [],
				},
			],
			metadata: { order: 1, title: 'Delivery lesson' },
		} as const;
		const generated = generateCapabilityPlanWorkspace(plan, catalog);
		expect(generated.ok).toBe(true);
		if (!generated.ok) return;
		const payload = {
			schemaVersion: CAPABILITY_PLAN_SCHEMA_VERSION,
			catalog,
			planRef: plan.planRef,
			workspace: generated.value.workspace,
			metadata: plan.metadata,
		};
		const serialized = serializeCapabilityPlanPayload(payload);
		expect(serialized).toBe(serializeCapabilityPlanPayload(payload));
		expect(serialized.indexOf('"catalog"')).toBeLessThan(serialized.indexOf('"metadata"'));
		expect(parseCapabilityPlanPayload(serialized)).toEqual({ ok: true, payload });
	});

	it.each(['plan', 'javascript', 'preview'])(
		'rejects a derived or hidden payload field: %s',
		(key) => {
			const payload = createDefaultCapabilityPlanPayload(catalog, 'lesson.delivery');
			expect(parseCapabilityPlanPayload(JSON.stringify({ ...payload, [key]: {} }))).toMatchObject({
				ok: false,
				error: { code: 'PAYLOAD_INVALID' },
			});
		},
	);

	it('rejects unsupported schema versions', () => {
		const payload = createDefaultCapabilityPlanPayload(catalog, 'lesson.delivery');
		expect(
			parseCapabilityPlanPayload(JSON.stringify({ ...payload, schemaVersion: 2 })),
		).toMatchObject({ ok: false, error: { code: 'PAYLOAD_SCHEMA_UNSUPPORTED' } });
	});

	it('rejects catalog fields outside CapabilityCatalogV1', () => {
		const payload = createDefaultCapabilityPlanPayload(catalog, 'lesson.delivery');
		expect(
			parseCapabilityPlanPayload(
				JSON.stringify({ ...payload, catalog: { ...payload.catalog, hidden: true } }),
			),
		).toMatchObject({ ok: false, error: { code: 'CAPABILITY_CATALOG_INVALID' } });
	});

	it('preserves an intermediate workspace while compilation reports its semantic error', () => {
		const payload = createDefaultCapabilityPlanPayload(catalog, 'lesson.delivery');
		payload.workspace = workspaceFor({
			STEP_REF: 'missing',
			CAPABILITY_REF: 'message.missing',
			ARGUMENTS_JSON: '{}',
		});
		const serialized = serializeCapabilityPlanPayload(payload);
		expect(parseCapabilityPlanPayload(serialized)).toEqual({ ok: true, payload });
		expect(
			compileCapabilityPlanWorkspace(
				payload.workspace,
				payload.catalog,
				payload.planRef,
				payload.metadata,
			),
		).toMatchObject({
			ok: false,
			error: { code: 'PLAN_CAPABILITY_MISSING' },
		});
	});

	it('rejects reserved metadata keys before compilation', () => {
		const payload = createDefaultCapabilityPlanPayload(catalog, 'lesson.delivery');
		const serialized = `{"schemaVersion":1,"catalog":${JSON.stringify(catalog)},"planRef":"lesson.delivery","workspace":${JSON.stringify(payload.workspace)},"metadata":{"constructor":true}}`;
		expect(parseCapabilityPlanPayload(serialized)).toMatchObject({
			ok: false,
			error: { code: 'PAYLOAD_INVALID' },
		});
	});

	it('enforces the UTF-8 payload bound', () => {
		expect(
			parseCapabilityPlanPayload(' '.repeat(CAPABILITY_PLAN_LIMITS.maxPayloadBytes + 1)),
		).toMatchObject({
			ok: false,
			error: { code: 'PAYLOAD_LIMIT_EXCEEDED' },
		});
	});

	it('throws when asked to serialize a tampered payload object', () => {
		const payload = createDefaultCapabilityPlanPayload(catalog, 'lesson.delivery');
		expect(() => serializeCapabilityPlanPayload({ ...payload, derived: {} })).toThrow(
			'PAYLOAD_INVALID',
		);
	});
});

function workspaceFor(fields: Record<string, unknown>): Record<string, unknown> {
	return {
		blocks: {
			languageVersion: 0,
			blocks: [
				{
					type: 'n8n_capability_plan',
					id: 'root-1',
					x: 40,
					y: 40,
					inputs: {
						STEPS: {
							block: { type: 'n8n_capability_step', id: 'step-1', fields },
						},
					},
				},
			],
		},
	};
}
