import {
	capabilityCatalogV1Schema,
	jsonObjectSchema,
	stableReferenceSchema,
	type CapabilityCatalogV1,
	type JsonObject,
} from '@n8n/dual-canvas-core';

import { CAPABILITY_PLAN_LIMITS, CAPABILITY_PLAN_SCHEMA_VERSION } from './constants';
import { createEmptyCapabilityPlanWorkspace } from './generator';
import { canonicalJson, firstUnknownKey, inspectJsonValue, isRecord, utf8ByteLength } from './json';
import type { CapabilityPlanPayloadParseResult, CapabilityPlanPayloadV1 } from './types';
import { failure } from './workspace-reader';

const payloadKeys = new Set(['schemaVersion', 'catalog', 'planRef', 'workspace', 'metadata']);

export function parseCapabilityPlanPayload(serialized: string): CapabilityPlanPayloadParseResult {
	if (utf8ByteLength(serialized) > CAPABILITY_PLAN_LIMITS.maxPayloadBytes) {
		return failure(
			'PAYLOAD_LIMIT_EXCEEDED',
			`Payload exceeds ${CAPABILITY_PLAN_LIMITS.maxPayloadBytes} UTF-8 bytes`,
			'payload',
		);
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(serialized);
	} catch {
		return failure('PAYLOAD_INVALID', 'Payload is not valid JSON', 'payload');
	}
	return normalizePayload(parsed);
}

export function serializeCapabilityPlanPayload(payloadInput: unknown): string {
	const normalized = normalizePayload(payloadInput);
	if (!normalized.ok) {
		throw new Error(`${normalized.error.code}: ${normalized.error.message}`);
	}
	const serialized = canonicalJson(normalized.payload);
	if (utf8ByteLength(serialized) > CAPABILITY_PLAN_LIMITS.maxPayloadBytes) {
		throw new Error(
			`PAYLOAD_LIMIT_EXCEEDED: Payload exceeds ${CAPABILITY_PLAN_LIMITS.maxPayloadBytes} UTF-8 bytes`,
		);
	}
	return serialized;
}

export function createDefaultCapabilityPlanPayload(
	catalogInput: unknown,
	planRefInput: unknown,
	metadataInput?: unknown,
): CapabilityPlanPayloadV1 {
	const catalog = capabilityCatalogV1Schema.parse(catalogInput);
	const planRef = stableReferenceSchema.parse(planRefInput);
	let metadata: JsonObject | undefined;
	if (metadataInput !== undefined) metadata = jsonObjectSchema.parse(metadataInput);
	const payload: CapabilityPlanPayloadV1 = {
		schemaVersion: CAPABILITY_PLAN_SCHEMA_VERSION,
		catalog,
		planRef,
		workspace: createEmptyCapabilityPlanWorkspace(planRef),
	};
	if (metadata !== undefined) payload.metadata = metadata;
	return payload;
}

function normalizePayload(payloadInput: unknown): CapabilityPlanPayloadParseResult {
	const inspection = inspectJsonValue(
		payloadInput,
		CAPABILITY_PLAN_LIMITS.maxPayloadJsonDepth,
		100_000,
	);
	if (!inspection.ok) {
		return failure('PAYLOAD_INVALID', inspection.message, `payload${inspection.path.slice(1)}`);
	}
	if (!isRecord(payloadInput)) {
		return failure('PAYLOAD_INVALID', 'Payload must be an object', 'payload');
	}
	const unknownKey = firstUnknownKey(payloadInput, payloadKeys);
	if (unknownKey !== undefined) {
		return failure(
			'PAYLOAD_INVALID',
			`Payload contains unknown field "${unknownKey}"`,
			`payload.${unknownKey}`,
		);
	}
	if (payloadInput.schemaVersion !== CAPABILITY_PLAN_SCHEMA_VERSION) {
		return failure(
			'PAYLOAD_SCHEMA_UNSUPPORTED',
			`schemaVersion must be ${CAPABILITY_PLAN_SCHEMA_VERSION}`,
			'payload.schemaVersion',
		);
	}
	const catalogResult = parseCatalog(payloadInput.catalog);
	if (!catalogResult.ok) return catalogResult;
	const planRef = stableReferenceSchema.safeParse(payloadInput.planRef);
	if (!planRef.success) {
		return failure('PLAN_REF_INVALID', 'planRef must be a stable reference', 'payload.planRef');
	}
	if (!isRecord(payloadInput.workspace)) {
		return failure('WORKSPACE_INVALID', 'workspace must be an object', 'payload.workspace');
	}
	const workspaceInspection = inspectJsonValue(
		payloadInput.workspace,
		CAPABILITY_PLAN_LIMITS.maxWorkspaceJsonDepth,
		100_000,
	);
	if (!workspaceInspection.ok) {
		return failure(
			'WORKSPACE_INVALID',
			workspaceInspection.message,
			`payload.workspace${workspaceInspection.path.slice(1)}`,
		);
	}
	if (
		utf8ByteLength(canonicalJson(payloadInput.workspace)) > CAPABILITY_PLAN_LIMITS.maxWorkspaceBytes
	) {
		return failure(
			'WORKSPACE_LIMIT_EXCEEDED',
			`Workspace exceeds ${CAPABILITY_PLAN_LIMITS.maxWorkspaceBytes} UTF-8 bytes`,
			'payload.workspace',
		);
	}

	let metadata: JsonObject | undefined;
	if (payloadInput.metadata !== undefined) {
		const metadataInspection = inspectJsonValue(
			payloadInput.metadata,
			CAPABILITY_PLAN_LIMITS.maxJsonDepth,
			CAPABILITY_PLAN_LIMITS.maxJsonEntries,
		);
		if (!metadataInspection.ok) {
			return failure(
				'PLAN_METADATA_INVALID',
				metadataInspection.message,
				`payload.metadata${metadataInspection.path.slice(1)}`,
			);
		}
		const metadataResult = jsonObjectSchema.safeParse(payloadInput.metadata);
		if (!metadataResult.success) {
			const issue = metadataResult.error.issues[0];
			return failure(
				'PLAN_METADATA_INVALID',
				issue?.message ?? 'Plan metadata is invalid',
				issue?.path.length ? `payload.metadata.${issue.path.join('.')}` : 'payload.metadata',
			);
		}
		metadata = metadataResult.data;
	}

	const payload: CapabilityPlanPayloadV1 = {
		schemaVersion: CAPABILITY_PLAN_SCHEMA_VERSION,
		catalog: catalogResult.catalog,
		planRef: planRef.data,
		workspace: payloadInput.workspace,
	};
	if (metadata !== undefined) payload.metadata = metadata;
	return { ok: true, payload };
}

function parseCatalog(
	value: unknown,
):
	| { ok: true; catalog: CapabilityCatalogV1 }
	| { ok: false; error: { code: string; message: string; path?: string } } {
	const inspection = inspectJsonValue(value, 32, 100_000);
	if (!inspection.ok) {
		return failure(
			'CAPABILITY_CATALOG_INVALID',
			inspection.message,
			`payload.catalog${inspection.path.slice(1)}`,
		);
	}
	const parsed = capabilityCatalogV1Schema.safeParse(value);
	if (!parsed.success) {
		const issue = parsed.error.issues[0];
		return failure(
			'CAPABILITY_CATALOG_INVALID',
			issue?.message ?? 'Capability catalog is invalid',
			issue?.path.length ? `payload.catalog.${issue.path.join('.')}` : 'payload.catalog',
		);
	}
	return { ok: true, catalog: parsed.data };
}
