import {
	capabilityCatalogV1Schema,
	createStableArtifactRef,
	executionPlanV1Schema,
	stableReferenceSchema,
	validateExecutionPlanAgainstCatalog,
} from '@n8n/dual-canvas-core';

import {
	CAPABILITY_PLAN_MAX_STEPS,
	CAPABILITY_PLAN_ROOT_BLOCK_TYPE,
	CAPABILITY_PLAN_STEP_BLOCK_TYPE,
} from './constants';
import { canonicalJson, inspectJsonValue } from './json';
import type {
	CapabilityPlanGenerateResult,
	CapabilityPlanSourceMapEntryV1,
	CapabilityPlanWorkspaceV1,
} from './types';
import { failure } from './workspace-reader';

type BlocklyBlock = {
	type: string;
	id: string;
	fields?: Record<string, unknown>;
	inputs?: Record<string, unknown>;
	next?: { block: BlocklyBlock };
	x?: number;
	y?: number;
};

export function generateCapabilityPlanWorkspace(
	planInput: unknown,
	catalogInput: unknown,
): CapabilityPlanGenerateResult {
	const planInspection = inspectJsonValue(planInput, 32, 100_000);
	if (!planInspection.ok) {
		return failure(
			'EXECUTION_PLAN_INVALID',
			planInspection.message,
			`plan${planInspection.path.slice(1)}`,
		);
	}
	const catalogInspection = inspectJsonValue(catalogInput, 32, 100_000);
	if (!catalogInspection.ok) {
		return failure(
			'CAPABILITY_CATALOG_INVALID',
			catalogInspection.message,
			`catalog${catalogInspection.path.slice(1)}`,
		);
	}
	const plan = executionPlanV1Schema.safeParse(planInput);
	if (!plan.success) {
		const issue = plan.error.issues[0];
		return failure(
			'EXECUTION_PLAN_INVALID',
			issue?.message ?? 'Execution plan is invalid',
			issue?.path.length ? `plan.${issue.path.join('.')}` : 'plan',
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
	const diagnostic = validateExecutionPlanAgainstCatalog(plan.data, catalog.data)[0];
	if (diagnostic !== undefined) {
		return failure(
			diagnostic.code,
			diagnostic.message,
			diagnostic.path === undefined ? undefined : `plan.${diagnostic.path}`,
			undefined,
			diagnostic.ref,
		);
	}
	if (plan.data.steps.length > CAPABILITY_PLAN_MAX_STEPS) {
		return failure(
			'WORKSPACE_LIMIT_EXCEEDED',
			`Plan exceeds ${CAPABILITY_PLAN_MAX_STEPS} steps`,
			'plan.steps',
		);
	}

	for (const [stepIndex, step] of plan.data.steps.entries()) {
		const expectedDependencies = stepIndex === 0 ? [] : [plan.data.steps[stepIndex - 1]?.stepRef];
		if (
			step.dependsOn.length !== expectedDependencies.length ||
			step.dependsOn.some((dependency, index) => dependency !== expectedDependencies[index])
		) {
			return failure(
				'PLAN_NOT_LINEAR',
				'Capability-plan workspaces represent a single ordered dependency chain',
				`plan.steps.${stepIndex}.dependsOn`,
				undefined,
				step.stepRef,
			);
		}
		if (step.metadata !== undefined) {
			return failure(
				'STEP_METADATA_UNSUPPORTED',
				'Step metadata is outside the capability-plan workspace grammar',
				`plan.steps.${stepIndex}.metadata`,
				undefined,
				step.stepRef,
			);
		}
	}

	const blocks = plan.data.steps.map((step, stepIndex) => {
		const blockId = createStepBlockId(plan.data.planRef, step.stepRef);
		const fields: Record<string, unknown> = {
			STEP_REF: step.stepRef,
			CAPABILITY_REF: step.capabilityRef,
			ARGUMENTS_JSON: canonicalJson(step.arguments),
		};
		if (step.label !== undefined) fields.LABEL = step.label;
		if (step.timeoutMs !== undefined) fields.TIMEOUT_MS = step.timeoutMs;
		if (step.guard !== undefined) fields.GUARD_JSON = canonicalJson(step.guard);
		const block: BlocklyBlock = { type: CAPABILITY_PLAN_STEP_BLOCK_TYPE, id: blockId, fields };
		const mapping: CapabilityPlanSourceMapEntryV1 = {
			apiVersion: 1,
			planRef: plan.data.planRef,
			stepRef: step.stepRef,
			blockId,
			stepIndex,
		};
		return { block, mapping };
	});
	for (let index = 0; index < blocks.length - 1; index += 1) {
		const current = blocks[index];
		const next = blocks[index + 1];
		if (current !== undefined && next !== undefined) current.block.next = { block: next.block };
	}

	const root: BlocklyBlock = {
		type: CAPABILITY_PLAN_ROOT_BLOCK_TYPE,
		id: createRootBlockId(plan.data.planRef),
		x: 40,
		y: 40,
	};
	const first = blocks[0];
	if (first !== undefined) root.inputs = { STEPS: { block: first.block } };
	const workspace: CapabilityPlanWorkspaceV1 = {
		blocks: { languageVersion: 0, blocks: [root] },
	};
	return {
		ok: true,
		value: { workspace, sourceMap: blocks.map((entry) => entry.mapping) },
	};
}

export function createEmptyCapabilityPlanWorkspace(
	planRefInput: unknown,
): CapabilityPlanWorkspaceV1 {
	const planRef = stableReferenceSchema.parse(planRefInput);
	return {
		blocks: {
			languageVersion: 0,
			blocks: [
				{
					type: CAPABILITY_PLAN_ROOT_BLOCK_TYPE,
					id: createRootBlockId(planRef),
					x: 40,
					y: 40,
				},
			],
		},
	};
}

function createRootBlockId(planRef: string): string {
	return createStableArtifactRef('block', planRef, 'capability-plan-root');
}

function createStepBlockId(planRef: string, stepRef: string): string {
	return createStableArtifactRef('block', planRef, `capability-plan-step:${stepRef}`);
}
