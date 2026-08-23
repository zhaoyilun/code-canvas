import { describe, expect, it } from 'vitest';

import {
	CAPABILITY_PLAN_LIMITS,
	CAPABILITY_PLAN_ADAPTER_REF,
	CAPABILITY_PLAN_EDITOR_PROFILE,
	CAPABILITY_PLAN_MAX_STEPS,
	CAPABILITY_PLAN_MEDIA_TYPE,
	CAPABILITY_PLAN_ROOT_BLOCK_TYPE,
	CAPABILITY_PLAN_SCHEMA_VERSION,
	CAPABILITY_PLAN_STEP_BLOCK_TYPE,
	compileCapabilityPlanWorkspace,
	createEmptyCapabilityPlanWorkspace,
	generateCapabilityPlanWorkspace,
	parseCapabilityPlanPayload,
	serializeCapabilityPlanPayload,
} from './index';

const catalog = {
	apiVersion: 1,
	catalogRef: 'education.content',
	revisionRef: 'revision.1',
	capabilities: [
		{
			capabilityRef: 'content.prepare',
			displayName: 'Prepare content',
			inputs: [
				{
					parameterRef: 'title',
					displayName: 'Title',
					valueType: 'string',
					required: true,
				},
				{
					parameterRef: 'options',
					displayName: 'Options',
					valueType: 'object',
					required: false,
				},
			],
			outputs: [
				{ outputRef: 'draftId', displayName: 'Draft ID', valueType: 'string' },
				{ outputRef: 'quality', displayName: 'Quality', valueType: 'number' },
			],
		},
		{
			capabilityRef: 'content.publish',
			displayName: 'Publish content',
			inputs: [
				{
					parameterRef: 'draftId',
					displayName: 'Draft ID',
					valueType: 'string',
					required: true,
				},
				{
					parameterRef: 'notify',
					displayName: 'Notify',
					valueType: 'boolean',
					required: false,
				},
			],
			outputs: [{ outputRef: 'publicationId', displayName: 'Publication ID', valueType: 'string' }],
		},
	],
} as const;

const guardedPlan = {
	apiVersion: 1,
	planRef: 'lesson.publish',
	catalogRef: catalog.catalogRef,
	catalogRevisionRef: catalog.revisionRef,
	steps: [
		{
			stepRef: 'prepare',
			capabilityRef: 'content.prepare',
			label: 'Prepare lesson',
			arguments: { title: 'Field notes', options: { tone: 'clear' } },
			dependsOn: [],
			timeoutMs: 5000,
		},
		{
			stepRef: 'publish',
			capabilityRef: 'content.publish',
			arguments: { draftId: 'draft-1', notify: true },
			dependsOn: ['prepare'],
			guard: {
				source: { stepRef: 'prepare', outputPath: ['draftId'] },
				operator: 'neq',
				value: '',
				effect: 'run',
			},
		},
	],
	metadata: { lesson: 'publishing' },
} as const;

describe('capability-plan workspace', () => {
	it('exports the versioned format identifiers', () => {
		expect(CAPABILITY_PLAN_SCHEMA_VERSION).toBe(1);
		expect(CAPABILITY_PLAN_MEDIA_TYPE).toBe('application/vnd.n8n.capability-plan+json');
		expect(CAPABILITY_PLAN_ADAPTER_REF).toBe('capability-plan');
		expect(CAPABILITY_PLAN_EDITOR_PROFILE).toBe(CAPABILITY_PLAN_ADAPTER_REF);
	});

	it('creates a deterministic empty workspace with the two-block grammar root', () => {
		const first = createEmptyCapabilityPlanWorkspace('lesson.empty');
		const second = createEmptyCapabilityPlanWorkspace('lesson.empty');
		expect(first).toEqual(second);
		expect(rootBlock(first)).toMatchObject({ type: CAPABILITY_PLAN_ROOT_BLOCK_TYPE, x: 40, y: 40 });
		expect(JSON.stringify(first)).not.toContain(CAPABILITY_PLAN_STEP_BLOCK_TYPE);
	});

	it('generates the same workspace and source map for the same plan', () => {
		const first = generateCapabilityPlanWorkspace(guardedPlan, catalog);
		const second = generateCapabilityPlanWorkspace(guardedPlan, catalog);
		expect(first).toEqual(second);
		expect(first.ok).toBe(true);
		if (!first.ok) return;
		expect(first.value.sourceMap).toHaveLength(2);
		expect(first.value.sourceMap).toEqual([
			expect.objectContaining({ stepRef: 'prepare', stepIndex: 0 }),
			expect.objectContaining({ stepRef: 'publish', stepIndex: 1 }),
		]);
		expect(stepBlocks(first.value.workspace).map((block) => block.type)).toEqual([
			CAPABILITY_PLAN_STEP_BLOCK_TYPE,
			CAPABILITY_PLAN_STEP_BLOCK_TYPE,
		]);
	});

	it('round-trips a guard, labels, timeout, arguments, and plan metadata', () => {
		const generated = generateCapabilityPlanWorkspace(guardedPlan, catalog);
		expect(generated.ok).toBe(true);
		if (!generated.ok) return;
		const compiled = compileCapabilityPlanWorkspace(
			generated.value.workspace,
			catalog,
			guardedPlan.planRef,
			guardedPlan.metadata,
		);
		expect(compiled).toEqual({
			ok: true,
			value: {
				plan: guardedPlan,
				sourceMap: generated.value.sourceMap,
				blockCount: 3,
			},
		});
	});

	it('generates, serializes, parses, and compiles the public 127-step limit', () => {
		const plan = linearPlan(CAPABILITY_PLAN_MAX_STEPS);
		const generated = generateCapabilityPlanWorkspace(plan, catalog);
		expect(generated.ok).toBe(true);
		if (!generated.ok) return;

		const serialized = serializeCapabilityPlanPayload({
			schemaVersion: CAPABILITY_PLAN_SCHEMA_VERSION,
			catalog,
			planRef: plan.planRef,
			workspace: generated.value.workspace,
		});
		const parsed = parseCapabilityPlanPayload(serialized);
		expect(parsed.ok).toBe(true);
		if (!parsed.ok) return;

		const compiled = compileCapabilityPlanWorkspace(
			parsed.payload.workspace,
			parsed.payload.catalog,
			parsed.payload.planRef,
		);
		expect(compiled.ok).toBe(true);
		if (!compiled.ok) return;
		expect(compiled.value.plan.steps).toHaveLength(CAPABILITY_PLAN_MAX_STEPS);
		expect(compiled.value.blockCount).toBe(CAPABILITY_PLAN_MAX_STEPS + 1);
	});

	it('rejects plans and workspaces above the public step limit', () => {
		const overLimitPlan = linearPlan(CAPABILITY_PLAN_MAX_STEPS + 1);
		expect(generateCapabilityPlanWorkspace(overLimitPlan, catalog)).toMatchObject({
			ok: false,
			error: { code: 'WORKSPACE_LIMIT_EXCEEDED', path: 'plan.steps' },
		});

		const overLimitWorkspace = workspaceFor(
			Array.from({ length: CAPABILITY_PLAN_MAX_STEPS + 1 }, (_, index) =>
				fields(`step-${index}`, 'content.prepare', { title: `Draft ${index}` }),
			),
		);
		expect(
			compileCapabilityPlanWorkspace(overLimitWorkspace, catalog, 'lesson.over-limit'),
		).toMatchObject({ ok: false, error: { code: 'WORKSPACE_LIMIT_EXCEEDED' } });
	});

	it('derives linear dependsOn links exclusively from chain order', () => {
		const compiled = compileCapabilityPlanWorkspace(
			workspaceFor([
				fields('first', 'content.prepare', { title: 'First' }),
				fields('second', 'content.publish', { draftId: 'draft-1' }),
			]),
			catalog,
			'lesson.chain',
		);
		expect(compiled.ok).toBe(true);
		if (!compiled.ok) return;
		expect(compiled.value.plan.steps.map((step) => step.dependsOn)).toEqual([[], ['first']]);
	});

	it('rejects a capability absent from the catalog', () => {
		const result = compileCapabilityPlanWorkspace(
			workspaceFor([fields('missing', 'content.missing', {})]),
			catalog,
			'lesson.invalid',
		);
		expect(result).toMatchObject({ ok: false, error: { code: 'PLAN_CAPABILITY_MISSING' } });
	});

	it('rejects wrong argument types through the core catalog validator', () => {
		const result = compileCapabilityPlanWorkspace(
			workspaceFor([fields('prepare', 'content.prepare', { title: 42 })]),
			catalog,
			'lesson.invalid',
		);
		expect(result).toMatchObject({
			ok: false,
			error: { code: 'PLAN_ARGUMENT_TYPE_INVALID', stepRef: 'prepare', blockId: 'step-0' },
		});
	});

	it('rejects arguments not declared by the selected capability', () => {
		const result = compileCapabilityPlanWorkspace(
			workspaceFor([fields('prepare', 'content.prepare', { title: 'Draft', extra: true })]),
			catalog,
			'lesson.invalid',
		);
		expect(result).toMatchObject({ ok: false, error: { code: 'PLAN_ARGUMENT_UNKNOWN' } });
	});

	it('requires ARGUMENTS_JSON to contain an object', () => {
		const invalidFields = fields('prepare', 'content.prepare', { title: 'Draft' });
		invalidFields.ARGUMENTS_JSON = '[]';
		const result = compileCapabilityPlanWorkspace(
			workspaceFor([invalidFields]),
			catalog,
			'lesson.invalid',
		);
		expect(result).toMatchObject({ ok: false, error: { code: 'ARGUMENTS_INVALID' } });
	});

	it('rejects reserved keys anywhere in arguments or guard paths', () => {
		const argumentFields = fields('prepare', 'content.prepare', { title: 'Draft' });
		argumentFields.ARGUMENTS_JSON = '{"title":"Draft","constructor":{"value":1}}';
		expect(
			compileCapabilityPlanWorkspace(workspaceFor([argumentFields]), catalog, 'lesson.invalid'),
		).toMatchObject({ ok: false, error: { code: 'ARGUMENTS_INVALID' } });

		const guarded = fields('publish', 'content.publish', { draftId: 'draft-1' });
		guarded.GUARD_JSON = JSON.stringify({
			source: { stepRef: 'prepare', outputPath: ['constructor'] },
			operator: 'eq',
			value: true,
			effect: 'skip',
		});
		expect(
			compileCapabilityPlanWorkspace(
				workspaceFor([fields('prepare', 'content.prepare', { title: 'Draft' }), guarded]),
				catalog,
				'lesson.invalid',
			),
		).toMatchObject({ ok: false, error: { code: 'GUARD_INVALID' } });
	});

	it('requires a guard source to be the explicit preceding dependency', () => {
		const first = fields('first', 'content.prepare', { title: 'Draft' });
		first.GUARD_JSON = JSON.stringify({
			source: { stepRef: 'first', outputPath: ['draftId'] },
			operator: 'eq',
			value: 'draft-1',
			effect: 'run',
		});
		expect(
			compileCapabilityPlanWorkspace(workspaceFor([first]), catalog, 'lesson.invalid'),
		).toMatchObject({ ok: false, error: { code: 'EXECUTION_PLAN_INVALID' } });

		const third = fields('third', 'content.publish', { draftId: 'draft-1' });
		third.GUARD_JSON = JSON.stringify({
			source: { stepRef: 'first', outputPath: ['draftId'] },
			operator: 'eq',
			value: 'draft-1',
			effect: 'run',
		});
		expect(
			compileCapabilityPlanWorkspace(
				workspaceFor([
					fields('first', 'content.prepare', { title: 'Draft' }),
					fields('second', 'content.publish', { draftId: 'draft-1' }),
					third,
				]),
				catalog,
				'lesson.invalid',
			),
		).toMatchObject({ ok: false, error: { code: 'EXECUTION_PLAN_INVALID' } });
	});

	it('checks a guard output against the source capability catalog entry', () => {
		const publish = fields('publish', 'content.publish', { draftId: 'draft-1' });
		publish.GUARD_JSON = JSON.stringify({
			source: { stepRef: 'prepare', outputPath: ['missing'] },
			operator: 'neq',
			value: '',
			effect: 'run',
		});
		const result = compileCapabilityPlanWorkspace(
			workspaceFor([fields('prepare', 'content.prepare', { title: 'Draft' }), publish]),
			catalog,
			'lesson.invalid',
		);
		expect(result).toMatchObject({ ok: false, error: { code: 'PLAN_GUARD_OUTPUT_MISSING' } });
	});

	it('bounds JSON depth and block count', () => {
		let nested: Record<string, unknown> = { end: true };
		for (let index = 0; index <= CAPABILITY_PLAN_LIMITS.maxJsonDepth; index += 1) {
			nested = { value: nested };
		}
		expect(
			compileCapabilityPlanWorkspace(
				workspaceFor([fields('prepare', 'content.prepare', { title: 'Draft', options: nested })]),
				catalog,
				'lesson.invalid',
			),
		).toMatchObject({ ok: false, error: { code: 'ARGUMENTS_INVALID' } });

		const manySteps = Array.from({ length: CAPABILITY_PLAN_MAX_STEPS + 1 }, (_, index) =>
			fields(`step-${index}`, 'content.prepare', { title: `Draft ${index}` }),
		);
		expect(
			compileCapabilityPlanWorkspace(workspaceFor(manySteps), catalog, 'lesson.invalid'),
		).toMatchObject({ ok: false, error: { code: 'WORKSPACE_LIMIT_EXCEEDED' } });
	});

	it('rejects hidden workspace fields and duplicate block ids', () => {
		const hidden = workspaceFor([fields('prepare', 'content.prepare', { title: 'Draft' })]);
		rootBlock(hidden).data = 'hidden';
		expect(compileCapabilityPlanWorkspace(hidden, catalog, 'lesson.invalid')).toMatchObject({
			ok: false,
			error: { code: 'WORKSPACE_INVALID' },
		});

		const duplicate = workspaceFor([
			fields('prepare', 'content.prepare', { title: 'Draft' }),
			fields('publish', 'content.publish', { draftId: 'draft-1' }),
		]);
		const secondBlock = stepBlocks(duplicate)[1];
		expect(secondBlock).toBeDefined();
		if (secondBlock === undefined) return;
		secondBlock.id = 'step-0';
		expect(compileCapabilityPlanWorkspace(duplicate, catalog, 'lesson.invalid')).toMatchObject({
			ok: false,
			error: { code: 'WORKSPACE_INVALID' },
		});
	});

	it('rejects plans whose dependencies are not a single ordered chain', () => {
		const nonlinear = {
			...guardedPlan,
			steps: [guardedPlan.steps[0], { ...guardedPlan.steps[1], dependsOn: [] }],
		};
		expect(generateCapabilityPlanWorkspace(nonlinear, catalog)).toMatchObject({
			ok: false,
			error: { code: 'EXECUTION_PLAN_INVALID' },
		});
	});

	it('rejects step metadata rather than dropping it during generation', () => {
		const planWithStepMetadata = {
			...guardedPlan,
			steps: [{ ...guardedPlan.steps[0], metadata: { note: 'preserve' } }, guardedPlan.steps[1]],
		};
		expect(generateCapabilityPlanWorkspace(planWithStepMetadata, catalog)).toMatchObject({
			ok: false,
			error: { code: 'STEP_METADATA_UNSUPPORTED' },
		});
	});
});

function linearPlan(stepCount: number) {
	return {
		apiVersion: 1,
		planRef: 'lesson.max-steps',
		catalogRef: catalog.catalogRef,
		catalogRevisionRef: catalog.revisionRef,
		steps: Array.from({ length: stepCount }, (_, index) => ({
			stepRef: `step-${index}`,
			capabilityRef: 'content.prepare',
			arguments: { title: `Draft ${index}` },
			dependsOn: index === 0 ? [] : [`step-${index - 1}`],
		})),
	};
}

function fields(
	stepRef: string,
	capabilityRef: string,
	args: Record<string, unknown>,
): Record<string, unknown> {
	return {
		STEP_REF: stepRef,
		CAPABILITY_REF: capabilityRef,
		ARGUMENTS_JSON: JSON.stringify(args),
	};
}

function workspaceFor(stepFields: Array<Record<string, unknown>>): Record<string, unknown> {
	let next: Record<string, unknown> | undefined;
	for (let index = stepFields.length - 1; index >= 0; index -= 1) {
		const block: Record<string, unknown> = {
			type: CAPABILITY_PLAN_STEP_BLOCK_TYPE,
			id: `step-${index}`,
			fields: stepFields[index],
		};
		if (next !== undefined) block.next = { block: next };
		next = block;
	}
	const root: Record<string, unknown> = {
		type: CAPABILITY_PLAN_ROOT_BLOCK_TYPE,
		id: 'root-1',
		x: 40,
		y: 40,
	};
	if (next !== undefined) root.inputs = { STEPS: { block: next } };
	return { blocks: { languageVersion: 0, blocks: [root] } };
}

function rootBlock(workspace: Record<string, unknown>): Record<string, unknown> {
	return (
		(workspace.blocks as Record<string, unknown>).blocks as Array<Record<string, unknown>>
	)[0];
}

function stepBlocks(workspace: Record<string, unknown>): Array<Record<string, unknown>> {
	const root = rootBlock(workspace);
	const inputs = root.inputs as Record<string, unknown> | undefined;
	if (inputs === undefined) return [];
	let current = (inputs.STEPS as Record<string, unknown>).block as Record<string, unknown>;
	const blocks: Array<Record<string, unknown>> = [];
	while (current !== undefined) {
		blocks.push(current);
		const next = current.next as Record<string, unknown> | undefined;
		current = next?.block as Record<string, unknown>;
	}
	return blocks;
}
