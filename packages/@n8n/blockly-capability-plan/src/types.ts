import type { CapabilityCatalogV1, ExecutionPlanV1, JsonObject } from '@n8n/dual-canvas-core';

export type CapabilityPlanWorkspaceV1 = Record<string, unknown>;

export type CapabilityPlanPayloadV1 = {
	schemaVersion: 1;
	catalog: CapabilityCatalogV1;
	planRef: string;
	workspace: CapabilityPlanWorkspaceV1;
	metadata?: JsonObject;
};

export type CapabilityPlanSourceMapEntryV1 = {
	apiVersion: 1;
	planRef: string;
	stepRef: string;
	blockId: string;
	stepIndex: number;
};

export type CapabilityPlanError = {
	code: string;
	message: string;
	path?: string;
	blockId?: string;
	stepRef?: string;
};

export type CapabilityPlanCompilation = {
	plan: ExecutionPlanV1;
	sourceMap: CapabilityPlanSourceMapEntryV1[];
	blockCount: number;
};

export type CapabilityPlanCompileResult =
	| { ok: true; value: CapabilityPlanCompilation }
	| { ok: false; error: CapabilityPlanError };

export type CapabilityPlanGeneration = {
	workspace: CapabilityPlanWorkspaceV1;
	sourceMap: CapabilityPlanSourceMapEntryV1[];
};

export type CapabilityPlanGenerateResult =
	| { ok: true; value: CapabilityPlanGeneration }
	| { ok: false; error: CapabilityPlanError };

export type CapabilityPlanPayloadParseResult =
	| { ok: true; payload: CapabilityPlanPayloadV1 }
	| { ok: false; error: CapabilityPlanError };
