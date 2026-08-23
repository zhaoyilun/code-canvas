import { describe, expect, it } from 'vitest';

import {
	capabilityCatalogV1Schema,
	executionPlanV1Schema,
	nodeTypeBindingsV1Schema,
	resolveNodeTypeBinding,
	validateExecutionPlanAgainstCatalog,
	validateWorkflowFragmentBindings,
	workflowFragmentV1Schema,
} from './data-plane';

const catalog = {
	apiVersion: 1,
	catalogRef: 'sample.catalog',
	revisionRef: 'revision.1',
	capabilities: [
		{
			capabilityRef: 'document.publish',
			displayName: 'Publish document',
			inputs: [
				{
					parameterRef: 'title',
					displayName: 'Title',
					valueType: 'string',
					required: true,
				},
			],
			outputs: [
				{
					outputRef: 'documentId',
					displayName: 'Document ID',
					valueType: 'string',
				},
			],
		},
	],
} as const;

const bindings = {
	apiVersion: 1,
	packageName: 'n8n-nodes-sample',
	nodeTypes: { publish: 'n8n-nodes-sample.publish' },
} as const;

const fragment = {
	apiVersion: 1,
	fragmentRef: 'fragment.publish',
	nodes: [
		{
			nodeRef: 'publish.1',
			bindingRef: 'publish',
			nodeType: 'n8n-nodes-sample.publish',
			typeVersion: 1,
			label: 'Publish',
			position: { x: 100, y: 200 },
			parameters: { title: 'Weekly notes' },
		},
	],
	connections: [],
	entryNodeRefs: ['publish.1'],
	exitNodeRefs: ['publish.1'],
} as const;

describe('versioned data-plane contracts', () => {
	it('accepts a generic capability catalog and rejects duplicate capability references', () => {
		expect(capabilityCatalogV1Schema.safeParse(catalog).success).toBe(true);
		expect(
			capabilityCatalogV1Schema.safeParse({
				...catalog,
				capabilities: [...catalog.capabilities, catalog.capabilities[0]],
			}).success,
		).toBe(false);
		expect(
			capabilityCatalogV1Schema.safeParse({
				...catalog,
				capabilities: [
					{
						...catalog.capabilities[0],
						inputs: [
							{
								...catalog.capabilities[0].inputs[0],
								valueType: 'number',
								defaultValue: 'not-a-number',
							},
						],
					},
				],
			}).success,
		).toBe(false);
	});

	it('checks execution-plan dependency references', () => {
		const valid = {
			apiVersion: 1,
			planRef: 'plan.publish',
			catalogRef: catalog.catalogRef,
			catalogRevisionRef: catalog.revisionRef,
			steps: [
				{
					stepRef: 'prepare',
					capabilityRef: 'document.publish',
					arguments: { title: 'Weekly notes' },
					dependsOn: [],
				},
			],
		};
		expect(executionPlanV1Schema.safeParse(valid).success).toBe(true);
		expect(
			executionPlanV1Schema.safeParse({
				...valid,
				steps: [{ ...valid.steps[0], dependsOn: ['missing'] }],
			}).success,
		).toBe(false);
		expect(
			executionPlanV1Schema.safeParse({
				...valid,
				steps: [
					{ ...valid.steps[0], stepRef: 'first', dependsOn: ['second'] },
					{ ...valid.steps[0], stepRef: 'second', dependsOn: ['first'] },
				],
			}).success,
		).toBe(false);
	});

	it('validates domain-independent guards and their step references', () => {
		const guardedPlan = {
			apiVersion: 1,
			planRef: 'plan.guarded-publish',
			catalogRef: catalog.catalogRef,
			catalogRevisionRef: catalog.revisionRef,
			steps: [
				{
					stepRef: 'first',
					capabilityRef: 'document.publish',
					arguments: { title: 'Draft' },
					dependsOn: [],
				},
				{
					stepRef: 'second',
					capabilityRef: 'document.publish',
					arguments: { title: 'Final' },
					dependsOn: ['first'],
					guard: {
						source: { stepRef: 'first', outputPath: ['documentId'] },
						operator: 'neq',
						value: '',
						effect: 'run',
					},
				},
			],
		} as const;

		expect(executionPlanV1Schema.safeParse(guardedPlan).success).toBe(true);
		expect(validateExecutionPlanAgainstCatalog(guardedPlan, catalog)).toEqual([]);
		expect(
			executionPlanV1Schema.safeParse({
				...guardedPlan,
				steps: [
					guardedPlan.steps[0],
					{
						...guardedPlan.steps[1],
						guard: {
							...guardedPlan.steps[1].guard,
							source: { stepRef: 'second', outputPath: ['documentId'] },
						},
					},
				],
			}).success,
		).toBe(false);
		expect(
			executionPlanV1Schema.safeParse({
				...guardedPlan,
				steps: [
					guardedPlan.steps[0],
					{
						...guardedPlan.steps[1],
						guard: {
							...guardedPlan.steps[1].guard,
							source: { stepRef: 'missing', outputPath: ['documentId'] },
						},
					},
				],
			}).success,
		).toBe(false);
		expect(
			validateExecutionPlanAgainstCatalog(
				{
					...guardedPlan,
					steps: [
						guardedPlan.steps[0],
						{
							...guardedPlan.steps[1],
							guard: {
								...guardedPlan.steps[1].guard,
								source: { stepRef: 'first', outputPath: ['missingOutput'] },
							},
						},
					],
				},
				catalog,
			),
		).toEqual([
			expect.objectContaining({
				code: 'PLAN_GUARD_OUTPUT_MISSING',
				ref: 'second',
			}),
		]);

		const booleanCatalog = {
			...catalog,
			capabilities: [
				{
					...catalog.capabilities[0],
					outputs: [{ outputRef: 'ready', displayName: 'Ready', valueType: 'boolean' }],
				},
			],
		} as const;
		const booleanGuardedPlan = {
			...guardedPlan,
			steps: [
				guardedPlan.steps[0],
				{
					...guardedPlan.steps[1],
					guard: {
						source: { stepRef: 'first', outputPath: ['ready', 'nested'] },
						operator: 'gt',
						value: 'true',
						effect: 'run',
					},
				},
			],
		} as const;
		expect(validateExecutionPlanAgainstCatalog(booleanGuardedPlan, booleanCatalog)).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ code: 'PLAN_GUARD_OUTPUT_PATH_INVALID' }),
				expect.objectContaining({ code: 'PLAN_GUARD_OPERATOR_INVALID' }),
			]),
		);
		const wrongBooleanValuePlan = {
			...booleanGuardedPlan,
			steps: [
				booleanGuardedPlan.steps[0],
				{
					...booleanGuardedPlan.steps[1],
					guard: {
						source: { stepRef: 'first', outputPath: ['ready'] },
						operator: 'eq',
						value: 'true',
						effect: 'run',
					},
				},
			],
		} as const;
		expect(validateExecutionPlanAgainstCatalog(wrongBooleanValuePlan, booleanCatalog)).toEqual([
			expect.objectContaining({ code: 'PLAN_GUARD_VALUE_TYPE_INVALID' }),
		]);
	});

	it('validates plan capabilities, required arguments, and argument types against a catalog', () => {
		const plan = {
			apiVersion: 1,
			planRef: 'plan.publish',
			catalogRef: catalog.catalogRef,
			catalogRevisionRef: catalog.revisionRef,
			steps: [
				{
					stepRef: 'publish',
					capabilityRef: 'document.publish',
					arguments: { title: 'Weekly notes' },
					dependsOn: [],
				},
			],
		};
		expect(validateExecutionPlanAgainstCatalog(plan, catalog)).toEqual([]);
		expect(
			validateExecutionPlanAgainstCatalog(
				{
					...plan,
					steps: [{ ...plan.steps[0], arguments: { title: 42 } }],
				},
				catalog,
			),
		).toEqual([
			expect.objectContaining({
				code: 'PLAN_ARGUMENT_TYPE_INVALID',
				ref: 'publish',
			}),
		]);
		expect(
			validateExecutionPlanAgainstCatalog(
				{
					...plan,
					steps: [{ ...plan.steps[0], arguments: {} }],
				},
				catalog,
			),
		).toEqual([
			expect.objectContaining({
				code: 'PLAN_ARGUMENT_REQUIRED',
				ref: 'publish',
			}),
		]);
		expect(
			validateExecutionPlanAgainstCatalog(
				{
					...plan,
					steps: [{ ...plan.steps[0], arguments: { title: 'Weekly notes', undeclared: true } }],
				},
				catalog,
			),
		).toEqual([
			expect.objectContaining({
				code: 'PLAN_ARGUMENT_UNKNOWN',
				ref: 'publish',
			}),
		]);
	});

	it('resolves installed node types exclusively through bindings', () => {
		expect(nodeTypeBindingsV1Schema.safeParse(bindings).success).toBe(true);
		expect(resolveNodeTypeBinding(bindings, 'publish')).toEqual({
			ok: true,
			nodeType: 'n8n-nodes-sample.publish',
		});
		expect(resolveNodeTypeBinding(bindings, 'missing')).toMatchObject({
			ok: false,
			diagnostic: { code: 'NODE_TYPE_BINDING_MISSING' },
		});
	});

	it('validates a fragment graph and its resolved node types', () => {
		expect(workflowFragmentV1Schema.safeParse(fragment).success).toBe(true);
		expect(validateWorkflowFragmentBindings(fragment, bindings)).toEqual([]);
		expect(
			validateWorkflowFragmentBindings(
				{
					...fragment,
					nodes: [{ ...fragment.nodes[0], nodeType: 'n8n-nodes-sample.other' }],
				},
				bindings,
			),
		).toEqual([
			expect.objectContaining({
				code: 'NODE_TYPE_BINDING_MISMATCH',
				ref: 'publish.1',
			}),
		]);
	});
});
