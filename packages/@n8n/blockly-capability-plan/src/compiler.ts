import {
	capabilityCatalogV1Schema,
	executionPlanV1Schema,
	jsonObjectSchema,
	stableReferenceSchema,
	validateExecutionPlanAgainstCatalog,
	type JsonObject,
} from '@n8n/dual-canvas-core';

import { CAPABILITY_PLAN_LIMITS } from './constants';
import { inspectJsonValue } from './json';
import type { CapabilityPlanCompileResult, CapabilityPlanSourceMapEntryV1 } from './types';
import { failure, readCapabilityPlanWorkspace } from './workspace-reader';

export function compileCapabilityPlanWorkspace(
	workspaceInput: unknown,
	catalogInput: unknown,
	planRefInput: unknown,
	metadataInput?: unknown,
): CapabilityPlanCompileResult {
	const catalogInspection = inspectJsonValue(catalogInput, 32, 100_000);
	if (!catalogInspection.ok) {
		return failure(
			'CAPABILITY_CATALOG_INVALID',
			catalogInspection.message,
			`catalog${catalogInspection.path.slice(1)}`,
		);
	}
	const catalog = capabilityCatalogV1Schema.safeParse(catalogInput);
	if (!catalog.success) {
		const issue = catalog.error.issues[0];
		return failure(
			'CAPABILITY_CATALOG_INVALID',
			issue?.message ?? 'Capability catalog is invalid',
			issue?.path.length ? `catalog.${issue.path.join('.')}` : 'catalog',
		);
	}
	const planRef = stableReferenceSchema.safeParse(planRefInput);
	if (!planRef.success) {
		return failure('PLAN_REF_INVALID', 'planRef must be a stable reference', 'planRef');
	}
	const metadataResult = parseMetadata(metadataInput);
	if (!metadataResult.ok) return metadataResult;

	const workspace = readCapabilityPlanWorkspace(workspaceInput, catalog.data);
	if (!workspace.ok) return workspace;
	if (workspace.steps.length === 0) {
		return failure('WORKSPACE_EMPTY', 'Capability plan requires at least one step', 'workspace');
	}

	const planInput: Record<string, unknown> = {
		apiVersion: 1,
		planRef: planRef.data,
		catalogRef: catalog.data.catalogRef,
		catalogRevisionRef: catalog.data.revisionRef,
		steps: workspace.steps.map((entry) => entry.step),
	};
	if (metadataResult.value !== undefined) planInput.metadata = metadataResult.value;
	const plan = executionPlanV1Schema.safeParse(planInput);
	if (!plan.success) {
		const issue = plan.error.issues[0];
		return failure(
			'EXECUTION_PLAN_INVALID',
			issue?.message ?? 'Compiled execution plan is invalid',
			issue?.path.length ? `plan.${issue.path.join('.')}` : 'plan',
		);
	}

	const diagnostics = validateExecutionPlanAgainstCatalog(plan.data, catalog.data);
	const diagnostic = diagnostics[0];
	if (diagnostic !== undefined) {
		const result = failure(
			diagnostic.code,
			diagnostic.message,
			diagnostic.path === undefined ? undefined : `plan.${diagnostic.path}`,
			undefined,
			diagnostic.ref,
		);
		if (diagnostic.ref !== undefined) {
			const mapping = workspace.steps.find((entry) => entry.step.stepRef === diagnostic.ref);
			if (mapping !== undefined) result.error.blockId = mapping.blockId;
		}
		return result;
	}

	const sourceMap: CapabilityPlanSourceMapEntryV1[] = workspace.steps.map((entry, stepIndex) => ({
		apiVersion: 1,
		planRef: planRef.data,
		stepRef: entry.step.stepRef,
		blockId: entry.blockId,
		stepIndex,
	}));
	return {
		ok: true,
		value: { plan: plan.data, sourceMap, blockCount: workspace.blockCount },
	};
}

function parseMetadata(
	value: unknown,
): { ok: true; value: JsonObject | undefined } | ReturnType<typeof failure> {
	if (value === undefined) return { ok: true, value: undefined };
	const inspection = inspectJsonValue(
		value,
		CAPABILITY_PLAN_LIMITS.maxJsonDepth,
		CAPABILITY_PLAN_LIMITS.maxJsonEntries,
	);
	if (!inspection.ok) {
		return failure(
			'PLAN_METADATA_INVALID',
			inspection.message,
			`metadata${inspection.path.slice(1)}`,
		);
	}
	const parsed = jsonObjectSchema.safeParse(value);
	if (!parsed.success) {
		const issue = parsed.error.issues[0];
		return failure(
			'PLAN_METADATA_INVALID',
			issue?.message ?? 'Plan metadata is invalid',
			issue?.path.length ? `metadata.${issue.path.join('.')}` : 'metadata',
		);
	}
	return { ok: true, value: parsed.data };
}
