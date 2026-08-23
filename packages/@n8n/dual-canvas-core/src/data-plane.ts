import { z } from 'zod';

import type { DiagnosticV1 } from './diagnostics';
import {
	canvasPositionSchema,
	installedNodeTypeSchema,
	jsonObjectSchema,
	jsonValueSchema,
	packageNameSchema,
	stableReferenceSchema,
	timestampSchema,
} from './primitives';

const capabilityParameterV1Schema = z
	.object({
		parameterRef: stableReferenceSchema,
		displayName: z.string().trim().min(1).max(128),
		description: z.string().trim().min(1).max(1000).optional(),
		valueType: z.enum(['string', 'number', 'boolean', 'object', 'array', 'binary']),
		required: z.boolean(),
		defaultValue: jsonValueSchema.optional(),
		constraints: jsonObjectSchema.optional(),
	})
	.strict()
	.superRefine((parameter, context) => {
		if (
			parameter.defaultValue !== undefined &&
			!matchesCapabilityValueType(parameter.defaultValue, parameter.valueType)
		) {
			context.addIssue({
				code: 'custom',
				path: ['defaultValue'],
				message: `defaultValue must be ${parameter.valueType}`,
			});
		}
	});

const capabilityOutputV1Schema = z
	.object({
		outputRef: stableReferenceSchema,
		displayName: z.string().trim().min(1).max(128),
		description: z.string().trim().min(1).max(1000).optional(),
		valueType: z.enum(['string', 'number', 'boolean', 'object', 'array', 'binary']),
	})
	.strict();

const capabilityV1Schema = z
	.object({
		capabilityRef: stableReferenceSchema,
		displayName: z.string().trim().min(1).max(128),
		description: z.string().trim().min(1).max(1000).optional(),
		category: stableReferenceSchema.optional(),
		inputs: z.array(capabilityParameterV1Schema).max(128),
		outputs: z.array(capabilityOutputV1Schema).max(128),
		metadata: jsonObjectSchema.optional(),
	})
	.strict()
	.superRefine((capability, context) => {
		addDuplicateIssues(
			capability.inputs.map((input) => input.parameterRef),
			context,
			'inputs',
			'parameterRef',
		);
		addDuplicateIssues(
			capability.outputs.map((output) => output.outputRef),
			context,
			'outputs',
			'outputRef',
		);
	});

export const capabilityCatalogV1Schema = z
	.object({
		apiVersion: z.literal(1),
		catalogRef: stableReferenceSchema,
		revisionRef: stableReferenceSchema,
		generatedAt: timestampSchema.optional(),
		capabilities: z.array(capabilityV1Schema).min(1).max(1024),
		metadata: jsonObjectSchema.optional(),
	})
	.strict()
	.superRefine((catalog, context) => {
		addDuplicateIssues(
			catalog.capabilities.map((capability) => capability.capabilityRef),
			context,
			'capabilities',
			'capabilityRef',
		);
	});

const guardOutputPathSegmentSchema = z
	.string()
	.min(1)
	.max(128)
	.refine(
		(value) => !['__proto__', 'prototype', 'constructor'].includes(value),
		'guard output path contains a reserved segment',
	);

export const executionPlanGuardV1Schema = z
	.object({
		source: z
			.object({
				stepRef: stableReferenceSchema,
				outputPath: z.array(guardOutputPathSegmentSchema).min(1).max(32),
			})
			.strict(),
		operator: z.enum(['eq', 'neq', 'lt', 'lte', 'gt', 'gte']),
		value: jsonValueSchema,
		effect: z.enum(['run', 'skip']),
	})
	.strict()
	.superRefine((guard, context) => {
		if (
			['lt', 'lte', 'gt', 'gte'].includes(guard.operator) &&
			typeof guard.value !== 'number' &&
			typeof guard.value !== 'string'
		) {
			context.addIssue({
				code: 'custom',
				path: ['value'],
				message: 'ordered guard comparisons require a number or string value',
			});
		}
	});

const executionPlanStepV1Schema = z
	.object({
		stepRef: stableReferenceSchema,
		capabilityRef: stableReferenceSchema,
		label: z.string().trim().min(1).max(128).optional(),
		arguments: jsonObjectSchema,
		dependsOn: z.array(stableReferenceSchema).max(128),
		guard: executionPlanGuardV1Schema.optional(),
		timeoutMs: z.number().int().positive().max(86_400_000).optional(),
		metadata: jsonObjectSchema.optional(),
	})
	.strict();

export const executionPlanV1Schema = z
	.object({
		apiVersion: z.literal(1),
		planRef: stableReferenceSchema,
		catalogRef: stableReferenceSchema,
		catalogRevisionRef: stableReferenceSchema,
		steps: z.array(executionPlanStepV1Schema).min(1).max(1000),
		metadata: jsonObjectSchema.optional(),
	})
	.strict()
	.superRefine((plan, context) => {
		addDuplicateIssues(
			plan.steps.map((step) => step.stepRef),
			context,
			'steps',
			'stepRef',
		);
		const stepRefs = new Set(plan.steps.map((step) => step.stepRef));
		for (const [stepIndex, step] of plan.steps.entries()) {
			if (step.guard !== undefined) {
				if (!stepRefs.has(step.guard.source.stepRef)) {
					context.addIssue({
						code: 'custom',
						path: ['steps', stepIndex, 'guard', 'source', 'stepRef'],
						message: `unknown guard source step "${step.guard.source.stepRef}"`,
					});
				}
				if (step.guard.source.stepRef === step.stepRef) {
					context.addIssue({
						code: 'custom',
						path: ['steps', stepIndex, 'guard', 'source', 'stepRef'],
						message: 'a step guard must not reference the guarded step',
					});
				}
				if (
					step.guard.source.stepRef !== step.stepRef &&
					stepRefs.has(step.guard.source.stepRef) &&
					!step.dependsOn.includes(step.guard.source.stepRef)
				) {
					context.addIssue({
						code: 'custom',
						path: ['steps', stepIndex, 'guard', 'source', 'stepRef'],
						message: 'a guard source step must be an explicit dependency of the guarded step',
					});
				}
			}
			const dependencies = new Set<string>();
			for (const [dependencyIndex, dependency] of step.dependsOn.entries()) {
				if (!stepRefs.has(dependency)) {
					context.addIssue({
						code: 'custom',
						path: ['steps', stepIndex, 'dependsOn', dependencyIndex],
						message: `unknown dependency "${dependency}"`,
					});
				}
				if (dependency === step.stepRef) {
					context.addIssue({
						code: 'custom',
						path: ['steps', stepIndex, 'dependsOn', dependencyIndex],
						message: 'a step must not depend on itself',
					});
				}
				if (dependencies.has(dependency)) {
					context.addIssue({
						code: 'custom',
						path: ['steps', stepIndex, 'dependsOn', dependencyIndex],
						message: `duplicate dependency "${dependency}"`,
					});
				}
				dependencies.add(dependency);
			}
		}
		if (hasDependencyCycle(plan.steps)) {
			context.addIssue({
				code: 'custom',
				path: ['steps'],
				message: 'execution plan dependencies must be acyclic',
			});
		}
	});

export const nodeTypeBindingsV1Schema = z
	.object({
		apiVersion: z.literal(1),
		packageName: packageNameSchema,
		nodeTypes: z.record(stableReferenceSchema, installedNodeTypeSchema),
	})
	.strict()
	.superRefine((bindings, context) => {
		const entries = Object.entries(bindings.nodeTypes);
		if (entries.length === 0) {
			context.addIssue({
				code: 'custom',
				path: ['nodeTypes'],
				message: 'at least one node type binding is required',
			});
		}
		if (entries.length > 256) {
			context.addIssue({
				code: 'custom',
				path: ['nodeTypes'],
				message: 'node type bindings exceed 256 entries',
			});
		}
	});

const workflowCredentialReferenceV1Schema = z
	.object({
		id: z.string().trim().min(1).max(256),
		name: z.string().trim().min(1).max(256),
	})
	.strict();

const workflowFragmentNodeV1Schema = z
	.object({
		nodeRef: stableReferenceSchema,
		bindingRef: stableReferenceSchema,
		nodeType: installedNodeTypeSchema,
		typeVersion: z.number().positive().finite(),
		label: z.string().trim().min(1).max(128),
		position: canvasPositionSchema,
		parameters: jsonObjectSchema,
		credentials: z.record(installedNodeTypeSchema, workflowCredentialReferenceV1Schema).optional(),
		disabled: z.boolean().optional(),
	})
	.strict();

const workflowEndpointV1Schema = z
	.object({
		nodeRef: stableReferenceSchema,
		port: z.string().trim().min(1).max(128),
		index: z.number().int().nonnegative().max(1024),
	})
	.strict();

const workflowFragmentConnectionV1Schema = z
	.object({
		connectionRef: stableReferenceSchema,
		from: workflowEndpointV1Schema,
		to: workflowEndpointV1Schema,
	})
	.strict();

export const workflowFragmentV1Schema = z
	.object({
		apiVersion: z.literal(1),
		fragmentRef: stableReferenceSchema,
		nodes: z.array(workflowFragmentNodeV1Schema).min(1).max(1000),
		connections: z.array(workflowFragmentConnectionV1Schema).max(4000),
		entryNodeRefs: z.array(stableReferenceSchema).min(1).max(128),
		exitNodeRefs: z.array(stableReferenceSchema).min(1).max(128),
		metadata: jsonObjectSchema.optional(),
	})
	.strict()
	.superRefine((fragment, context) => {
		addDuplicateIssues(
			fragment.nodes.map((node) => node.nodeRef),
			context,
			'nodes',
			'nodeRef',
		);
		addDuplicateIssues(
			fragment.connections.map((connection) => connection.connectionRef),
			context,
			'connections',
			'connectionRef',
		);
		const nodeRefs = new Set(fragment.nodes.map((node) => node.nodeRef));
		for (const [index, connection] of fragment.connections.entries()) {
			if (!nodeRefs.has(connection.from.nodeRef)) {
				context.addIssue({
					code: 'custom',
					path: ['connections', index, 'from', 'nodeRef'],
					message: `unknown source node "${connection.from.nodeRef}"`,
				});
			}
			if (!nodeRefs.has(connection.to.nodeRef)) {
				context.addIssue({
					code: 'custom',
					path: ['connections', index, 'to', 'nodeRef'],
					message: `unknown target node "${connection.to.nodeRef}"`,
				});
			}
		}
		for (const [field, refs] of [
			['entryNodeRefs', fragment.entryNodeRefs],
			['exitNodeRefs', fragment.exitNodeRefs],
		] as const) {
			const seen = new Set<string>();
			for (const [index, nodeRef] of refs.entries()) {
				if (!nodeRefs.has(nodeRef)) {
					context.addIssue({
						code: 'custom',
						path: [field, index],
						message: `unknown node "${nodeRef}"`,
					});
				}
				if (seen.has(nodeRef)) {
					context.addIssue({
						code: 'custom',
						path: [field, index],
						message: `duplicate node "${nodeRef}"`,
					});
				}
				seen.add(nodeRef);
			}
		}
	});

export type CapabilityCatalogV1 = z.infer<typeof capabilityCatalogV1Schema>;
export type ExecutionPlanGuardV1 = z.infer<typeof executionPlanGuardV1Schema>;
export type ExecutionPlanV1 = z.infer<typeof executionPlanV1Schema>;
export type NodeTypeBindingsV1 = z.infer<typeof nodeTypeBindingsV1Schema>;
export type WorkflowFragmentV1 = z.infer<typeof workflowFragmentV1Schema>;

export function resolveNodeTypeBinding(
	bindingsInput: unknown,
	bindingRef: string,
): { ok: true; nodeType: string } | { ok: false; diagnostic: DiagnosticV1 } {
	const parsed = nodeTypeBindingsV1Schema.safeParse(bindingsInput);
	if (!parsed.success) {
		const issue = parsed.error.issues[0];
		return {
			ok: false,
			diagnostic: {
				apiVersion: 1,
				code: 'NODE_TYPE_BINDINGS_INVALID',
				severity: 'error',
				message: issue?.message ?? 'node type bindings are invalid',
				path: issue?.path.join('.') || 'bindings',
			},
		};
	}
	const nodeType = parsed.data.nodeTypes[bindingRef];
	if (nodeType === undefined) {
		return {
			ok: false,
			diagnostic: {
				apiVersion: 1,
				code: 'NODE_TYPE_BINDING_MISSING',
				severity: 'error',
				message: `node type binding "${bindingRef}" is missing`,
				ref: stableReferenceSchema.safeParse(bindingRef).success ? bindingRef : undefined,
				path: `nodeTypes.${bindingRef}`,
			},
		};
	}
	return { ok: true, nodeType };
}

export function validateWorkflowFragmentBindings(
	fragmentInput: unknown,
	bindingsInput: unknown,
): DiagnosticV1[] {
	const fragment = workflowFragmentV1Schema.safeParse(fragmentInput);
	if (!fragment.success) return zodDiagnostics('WORKFLOW_FRAGMENT_INVALID', fragment.error);
	const bindings = nodeTypeBindingsV1Schema.safeParse(bindingsInput);
	if (!bindings.success) return zodDiagnostics('NODE_TYPE_BINDINGS_INVALID', bindings.error);

	const diagnostics: DiagnosticV1[] = [];
	for (const [index, node] of fragment.data.nodes.entries()) {
		const boundType = bindings.data.nodeTypes[node.bindingRef];
		if (boundType === undefined) {
			diagnostics.push({
				apiVersion: 1,
				code: 'NODE_TYPE_BINDING_MISSING',
				severity: 'error',
				message: `node type binding "${node.bindingRef}" is missing`,
				ref: node.nodeRef,
				path: `nodes.${index}.bindingRef`,
			});
		} else if (boundType !== node.nodeType) {
			diagnostics.push({
				apiVersion: 1,
				code: 'NODE_TYPE_BINDING_MISMATCH',
				severity: 'error',
				message: `node type does not match binding "${node.bindingRef}"`,
				ref: node.nodeRef,
				path: `nodes.${index}.nodeType`,
			});
		}
	}
	return diagnostics;
}

export function validateExecutionPlanAgainstCatalog(
	planInput: unknown,
	catalogInput: unknown,
): DiagnosticV1[] {
	const plan = executionPlanV1Schema.safeParse(planInput);
	if (!plan.success) return zodDiagnostics('EXECUTION_PLAN_INVALID', plan.error);
	const catalog = capabilityCatalogV1Schema.safeParse(catalogInput);
	if (!catalog.success) return zodDiagnostics('CAPABILITY_CATALOG_INVALID', catalog.error);

	const diagnostics: DiagnosticV1[] = [];
	if (plan.data.catalogRef !== catalog.data.catalogRef) {
		diagnostics.push({
			apiVersion: 1,
			code: 'PLAN_CATALOG_MISMATCH',
			severity: 'error',
			message: 'execution plan references a different capability catalog',
			path: 'catalogRef',
		});
	}
	if (plan.data.catalogRevisionRef !== catalog.data.revisionRef) {
		diagnostics.push({
			apiVersion: 1,
			code: 'PLAN_CATALOG_REVISION_MISMATCH',
			severity: 'error',
			message: 'execution plan references a different catalog revision',
			path: 'catalogRevisionRef',
		});
	}

	const capabilities = new Map(
		catalog.data.capabilities.map((capability) => [capability.capabilityRef, capability]),
	);
	const steps = new Map(plan.data.steps.map((step) => [step.stepRef, step]));
	for (const [stepIndex, step] of plan.data.steps.entries()) {
		const capability = capabilities.get(step.capabilityRef);
		if (capability === undefined) {
			diagnostics.push({
				apiVersion: 1,
				code: 'PLAN_CAPABILITY_MISSING',
				severity: 'error',
				message: `capability "${step.capabilityRef}" is not present in the catalog`,
				ref: step.stepRef,
				path: `steps.${stepIndex}.capabilityRef`,
			});
			continue;
		}
		const declaredInputs = new Set(capability.inputs.map((input) => input.parameterRef));
		for (const argumentRef of Object.keys(step.arguments)) {
			if (!declaredInputs.has(argumentRef)) {
				diagnostics.push({
					apiVersion: 1,
					code: 'PLAN_ARGUMENT_UNKNOWN',
					severity: 'error',
					message: `argument "${argumentRef}" is not declared by capability "${capability.capabilityRef}"`,
					ref: step.stepRef,
					path: `steps.${stepIndex}.arguments.${argumentRef}`,
				});
			}
		}
		for (const input of capability.inputs) {
			const value = step.arguments[input.parameterRef];
			if (value === undefined) {
				if (input.required && input.defaultValue === undefined) {
					diagnostics.push({
						apiVersion: 1,
						code: 'PLAN_ARGUMENT_REQUIRED',
						severity: 'error',
						message: `argument "${input.parameterRef}" is required`,
						ref: step.stepRef,
						path: `steps.${stepIndex}.arguments.${input.parameterRef}`,
					});
				}
				continue;
			}
			if (!matchesCapabilityValueType(value, input.valueType)) {
				diagnostics.push({
					apiVersion: 1,
					code: 'PLAN_ARGUMENT_TYPE_INVALID',
					severity: 'error',
					message: `argument "${input.parameterRef}" must be ${input.valueType}`,
					ref: step.stepRef,
					path: `steps.${stepIndex}.arguments.${input.parameterRef}`,
				});
			}
		}

		if (step.guard !== undefined) {
			const sourceStep = steps.get(step.guard.source.stepRef);
			const sourceCapability =
				sourceStep === undefined ? undefined : capabilities.get(sourceStep.capabilityRef);
			const outputRef = step.guard.source.outputPath[0];
			const sourceOutput = sourceCapability?.outputs.find(
				(output) => output.outputRef === outputRef,
			);
			if (sourceCapability !== undefined && sourceOutput === undefined) {
				diagnostics.push({
					apiVersion: 1,
					code: 'PLAN_GUARD_OUTPUT_MISSING',
					severity: 'error',
					message: `guard output "${outputRef}" is not present on capability "${sourceCapability.capabilityRef}"`,
					ref: step.stepRef,
					path: `steps.${stepIndex}.guard.source.outputPath.0`,
				});
			}
			if (sourceOutput !== undefined) {
				const guardPath = `steps.${stepIndex}.guard`;
				if (
					step.guard.source.outputPath.length > 1 &&
					!['object', 'array'].includes(sourceOutput.valueType)
				) {
					diagnostics.push({
						apiVersion: 1,
						code: 'PLAN_GUARD_OUTPUT_PATH_INVALID',
						severity: 'error',
						message: `guard output "${outputRef}" is scalar and has no nested path`,
						ref: step.stepRef,
						path: `${guardPath}.source.outputPath`,
					});
				}
				if (
					['lt', 'lte', 'gt', 'gte'].includes(step.guard.operator) &&
					(step.guard.source.outputPath.length > 1 ||
						!['number', 'string'].includes(sourceOutput.valueType))
				) {
					diagnostics.push({
						apiVersion: 1,
						code: 'PLAN_GUARD_OPERATOR_INVALID',
						severity: 'error',
						message: 'ordered guard comparisons require a top-level number or string output',
						ref: step.stepRef,
						path: `${guardPath}.operator`,
					});
				}
				if (
					step.guard.source.outputPath.length === 1 &&
					!matchesCapabilityValueType(step.guard.value, sourceOutput.valueType)
				) {
					diagnostics.push({
						apiVersion: 1,
						code: 'PLAN_GUARD_VALUE_TYPE_INVALID',
						severity: 'error',
						message: `guard comparison value must be ${sourceOutput.valueType}`,
						ref: step.stepRef,
						path: `${guardPath}.value`,
					});
				}
			}
		}
	}
	return diagnostics;
}

function addDuplicateIssues(
	values: string[],
	context: z.RefinementCtx,
	collection: string,
	field: string,
): void {
	const seen = new Set<string>();
	for (const [index, value] of values.entries()) {
		if (seen.has(value)) {
			context.addIssue({
				code: 'custom',
				path: [collection, index, field],
				message: `duplicate ${field} "${value}"`,
			});
		}
		seen.add(value);
	}
}

function zodDiagnostics(code: string, error: z.ZodError): DiagnosticV1[] {
	return error.issues.map((issue) => ({
		apiVersion: 1,
		code,
		severity: 'error',
		message: issue.message,
		path: issue.path.join('.') || undefined,
	}));
}

function hasDependencyCycle(steps: Array<{ stepRef: string; dependsOn: string[] }>): boolean {
	const stepRefs = new Set(steps.map((step) => step.stepRef));
	const pendingDependencyCount = new Map(
		steps.map((step) => [
			step.stepRef,
			new Set(step.dependsOn.filter((dependency) => stepRefs.has(dependency))).size,
		]),
	);
	const dependents = new Map<string, string[]>();
	for (const step of steps) {
		for (const dependency of new Set(step.dependsOn)) {
			if (!stepRefs.has(dependency)) continue;
			const existing = dependents.get(dependency) ?? [];
			existing.push(step.stepRef);
			dependents.set(dependency, existing);
		}
	}
	const ready = [...pendingDependencyCount.entries()]
		.filter(([, count]) => count === 0)
		.map(([stepRef]) => stepRef);
	let visited = 0;
	while (ready.length > 0) {
		const stepRef = ready.shift();
		if (stepRef === undefined) break;
		visited += 1;
		for (const dependent of dependents.get(stepRef) ?? []) {
			const nextCount = (pendingDependencyCount.get(dependent) ?? 0) - 1;
			pendingDependencyCount.set(dependent, nextCount);
			if (nextCount === 0) ready.push(dependent);
		}
	}
	return visited !== steps.length;
}

function matchesCapabilityValueType(
	value: unknown,
	valueType: 'string' | 'number' | 'boolean' | 'object' | 'array' | 'binary',
): boolean {
	if (valueType === 'array') return Array.isArray(value);
	if (valueType === 'object')
		return typeof value === 'object' && value !== null && !Array.isArray(value);
	if (valueType === 'binary') return typeof value === 'string';
	return typeof value === valueType;
}
