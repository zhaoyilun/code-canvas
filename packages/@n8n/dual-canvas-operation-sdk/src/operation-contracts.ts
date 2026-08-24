import {
	createStableId,
	jsonValueSchema,
	sourceSpanV1Schema,
	stableReferenceSchema,
} from '@n8n/dual-canvas-core';
import {
	operationAritySchema,
	operationModuleSpecV1Schema,
	operationNullPolicySchema,
	operationQualifiedNameSchema,
	operationStableReferenceSchema,
	operationValueTypeSchema,
	verifyOperationModuleTestVectorsV1,
} from '@n8n/dual-canvas-operation-runtime';
import { z } from 'zod';

export * from '@n8n/dual-canvas-operation-runtime';

const operationArgumentObservationV1BodySchema = z
	.object({
		index: z.number().int().nonnegative().max(15),
		text: z.string().min(1).max(2048),
		source: sourceSpanV1Schema,
		typeHint: z.enum(['number', 'string', 'boolean', 'null', 'array', 'object', 'unknown']),
		literalValue: jsonValueSchema.optional(),
	})
	.strict();

export const operationArgumentObservationV1Schema = z.preprocess(
	(input) => (isSchemaTraversalBounded(input) ? input : {}),
	operationArgumentObservationV1BodySchema,
);

export const operationCallObservationV1Schema = z
	.object({
		callRef: stableReferenceSchema,
		callText: z.string().min(1).max(4096),
		source: sourceSpanV1Schema,
		arguments: z.array(operationArgumentObservationV1Schema).max(16),
	})
	.strict()
	.superRefine((call, context) => {
		for (const [index, argument] of call.arguments.entries()) {
			if (argument.index !== index) {
				context.addIssue({
					code: 'custom',
					path: ['arguments', index, 'index'],
					message: 'argument indexes must be contiguous and source ordered',
				});
			}
			if (argument.source.sourceRef !== call.source.sourceRef) {
				context.addIssue({
					code: 'custom',
					path: ['arguments', index, 'source', 'sourceRef'],
					message: 'argument and call spans must share a sourceRef',
				});
			}
			if (
				argument.source.start.offset < call.source.start.offset ||
				argument.source.end.offset > call.source.end.offset
			) {
				context.addIssue({
					code: 'custom',
					path: ['arguments', index, 'source'],
					message: 'argument span must be contained by the call span',
				});
			}
		}
	});

export type OperationCallObservationV1 = z.infer<typeof operationCallObservationV1Schema>;

export const operationModuleRequiredDecisionV1Schema = z.enum([
	'behavior',
	'effect',
	'parameter-names',
	'input-types',
	'null-handling',
	'output-type',
	'test-vectors',
]);

const REQUIRED_DECISIONS = [
	'behavior',
	'effect',
	'parameter-names',
	'input-types',
	'null-handling',
	'output-type',
	'test-vectors',
] as const;

const moduleScaffoldRequestV1BodySchema = z
	.object({
		apiVersion: z.literal(1),
		requestRef: operationStableReferenceSchema,
		scope: z
			.object({
				documentRef: operationStableReferenceSchema,
				revisionRef: operationStableReferenceSchema,
				sourceRef: operationStableReferenceSchema,
			})
			.strict(),
		qualifiedName: operationQualifiedNameSchema,
		arity: operationAritySchema,
		calls: z.array(operationCallObservationV1Schema).min(1).max(128),
		requiredDecisions: z.array(operationModuleRequiredDecisionV1Schema).length(7),
	})
	.strict()
	.superRefine((request, context) => {
		validateRequiredDecisions(request.requiredDecisions, context);
		const callRefs = new Set<string>();
		for (const [index, call] of request.calls.entries()) {
			if (call.source.sourceRef !== request.scope.sourceRef) {
				context.addIssue({
					code: 'custom',
					path: ['calls', index, 'source', 'sourceRef'],
					message: 'call sourceRef must equal request scope sourceRef',
				});
			}
			if (call.arguments.length !== request.arity) {
				context.addIssue({
					code: 'custom',
					path: ['calls', index, 'arguments'],
					message: 'call argument count must equal request arity',
				});
			}
			if (callRefs.has(call.callRef)) {
				context.addIssue({
					code: 'custom',
					path: ['calls', index, 'callRef'],
					message: 'callRef must be unique within a request',
				});
			}
			callRefs.add(call.callRef);
		}
	});

export const moduleScaffoldRequestV1Schema = z.preprocess(
	(input) => (isSchemaTraversalBounded(input) ? input : {}),
	moduleScaffoldRequestV1BodySchema,
);

export type ModuleScaffoldRequestV1 = z.infer<typeof moduleScaffoldRequestV1Schema>;

const operationParameterTemplateV1Schema = z
	.object({
		parameterRef: operationStableReferenceSchema,
		name: z
			.string()
			.min(1)
			.max(64)
			.regex(/^[A-Za-z_][A-Za-z0-9_]*$/),
		type: operationValueTypeSchema.nullable(),
		nullPolicy: operationNullPolicySchema.nullable(),
	})
	.strict();

export const operationModuleTemplateV1Schema = z
	.object({
		apiVersion: z.literal(1),
		templateRef: operationStableReferenceSchema,
		requestRef: operationStableReferenceSchema,
		targetConstraints: z
			.object({
				execution: z.literal('synchronous'),
				determinism: z.literal('deterministic'),
				effects: z.literal('none'),
				dataFlow: z.literal('json-to-json'),
			})
			.strict(),
		identity: z
			.object({
				operationRef: operationStableReferenceSchema,
				implementationRef: z.null(),
				qualifiedName: operationQualifiedNameSchema,
				arity: operationAritySchema,
				version: z.literal('1.0.0'),
			})
			.strict(),
		parameters: z.array(operationParameterTemplateV1Schema).max(16),
		output: z
			.object({
				type: operationValueTypeSchema.nullable(),
				nullPolicy: z.enum(['allow', 'reject']).nullable(),
			})
			.strict(),
		behaviorSummary: z.string().trim().min(1).max(1000).nullable(),
		expression: z.null(),
		testVectors: z.array(z.never()).length(0),
		requiredDecisions: z.array(operationModuleRequiredDecisionV1Schema).length(7),
		routeIfIneligible: z.literal('capability-plugin'),
	})
	.strict()
	.superRefine((template, context) => {
		validateRequiredDecisions(template.requiredDecisions, context);
		if (template.parameters.length !== template.identity.arity) {
			context.addIssue({
				code: 'custom',
				path: ['parameters'],
				message: 'template parameter count must equal identity arity',
			});
		}
	});

export type OperationModuleTemplateV1 = z.infer<typeof operationModuleTemplateV1Schema>;

const operationModuleAdmissionV1BodySchema = z
	.object({
		request: moduleScaffoldRequestV1Schema,
		spec: operationModuleSpecV1Schema,
	})
	.strict()
	.superRefine((admission, context) => {
		const template = createOperationModuleTemplateV1(admission.request);
		for (const [field, requestValue, specValue] of [
			['requestRef', admission.request.requestRef, admission.spec.requestRef],
			['qualifiedName', admission.request.qualifiedName, admission.spec.qualifiedName],
			['arity', admission.request.arity, admission.spec.arity],
		] as const) {
			if (requestValue !== specValue) {
				context.addIssue({
					code: 'custom',
					path: ['spec', field],
					message: `spec ${field} must match its scaffold request`,
				});
			}
		}
		for (const [field, templateValue, specValue] of [
			['operationRef', template.identity.operationRef, admission.spec.operationRef],
			['version', template.identity.version, admission.spec.version],
		] as const) {
			if (templateValue !== specValue) {
				context.addIssue({
					code: 'custom',
					path: ['spec', field],
					message: `spec ${field} must match its deterministic template`,
				});
			}
		}
		for (const [index, parameter] of admission.spec.parameters.entries()) {
			if (parameter.parameterRef !== template.parameters[index]?.parameterRef) {
				context.addIssue({
					code: 'custom',
					path: ['spec', 'parameters', index, 'parameterRef'],
					message: 'spec parameterRef must match its deterministic template slot',
				});
			}
		}

		try {
			verifyOperationModuleTestVectorsV1(admission.spec);
		} catch (error) {
			context.addIssue({
				code: 'custom',
				path: ['spec', 'testVectors'],
				message: error instanceof Error ? error.message : String(error),
			});
		}
	});

export const operationModuleAdmissionV1Schema = z.preprocess(
	(input) => (isSchemaTraversalBounded(input) ? input : {}),
	operationModuleAdmissionV1BodySchema,
);

export type OperationModuleAdmissionV1 = z.infer<typeof operationModuleAdmissionV1Schema>;

export function createOperationModuleTemplateV1(
	requestInput: ModuleScaffoldRequestV1,
): OperationModuleTemplateV1 {
	const request = moduleScaffoldRequestV1Schema.parse(requestInput);
	const operationId = createStableId(
		request.requestRef,
		`operation:${request.qualifiedName}/${request.arity}`,
	);
	return operationModuleTemplateV1Schema.parse({
		apiVersion: 1,
		templateRef: `operation-template-${createStableId(request.requestRef, 'template:v1')}`,
		requestRef: request.requestRef,
		targetConstraints: {
			execution: 'synchronous',
			determinism: 'deterministic',
			effects: 'none',
			dataFlow: 'json-to-json',
		},
		identity: {
			operationRef: `operation-${operationId}`,
			implementationRef: null,
			qualifiedName: request.qualifiedName,
			arity: request.arity,
			version: '1.0.0',
		},
		parameters: Array.from({ length: request.arity }, (_, index) => ({
			parameterRef: `arg.${index}`,
			name: `arg${index}`,
			type: null,
			nullPolicy: null,
		})),
		output: { type: null, nullPolicy: null },
		behaviorSummary: null,
		expression: null,
		testVectors: [],
		requiredDecisions: [...REQUIRED_DECISIONS],
		routeIfIneligible: 'capability-plugin',
	});
}

function validateRequiredDecisions(
	decisions: ReadonlyArray<z.infer<typeof operationModuleRequiredDecisionV1Schema>>,
	context: z.RefinementCtx,
): void {
	if (
		new Set(decisions).size !== REQUIRED_DECISIONS.length ||
		REQUIRED_DECISIONS.some((decision) => !decisions.includes(decision))
	) {
		context.addIssue({
			code: 'custom',
			path: ['requiredDecisions'],
			message: 'requiredDecisions must contain each admission decision exactly once',
		});
	}
}

function isSchemaTraversalBounded(input: unknown): boolean {
	const stack: Array<{ value: unknown; depth: number }> = [{ value: input, depth: 1 }];
	const seen = new WeakSet<object>();
	let nodes = 0;
	while (stack.length > 0) {
		const current = stack.pop();
		if (current === undefined) break;
		if (typeof current.value !== 'object' || current.value === null) continue;
		if (seen.has(current.value) || current.depth > 64 || nodes >= 10_000) return false;
		seen.add(current.value);
		nodes += 1;
		const children = Array.isArray(current.value)
			? current.value
			: Object.values(current.value as Record<string, unknown>);
		for (const child of children) stack.push({ value: child, depth: current.depth + 1 });
	}
	return true;
}
