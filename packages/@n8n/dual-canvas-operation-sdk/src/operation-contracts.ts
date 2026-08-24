import {
	createStableId,
	jsonValueSchema,
	sourceSpanV1Schema,
	stableReferenceSchema,
	type JsonValue,
} from '@n8n/dual-canvas-core';
import { z } from 'zod';

export const OPERATION_EXPRESSION_MAX_DEPTH = 16;
export const OPERATION_EXPRESSION_MAX_NODES = 128;

const qualifiedNameSchema = z
	.string()
	.min(1)
	.max(256)
	.regex(/^[A-Za-z_$][A-Za-z0-9_$]*(?:\.[A-Za-z_$][A-Za-z0-9_$]*)*$/)
	.refine(
		(value) =>
			value
				.split('.')
				.every((segment) => !['__proto__', 'prototype', 'constructor'].includes(segment)),
		'qualified name contains a reserved segment',
	);

const aritySchema = z.number().int().min(0).max(16);
const valueTypeSchema = z.enum(['json', 'number', 'string', 'boolean', 'array', 'object']);
const nullPolicySchema = z.enum(['allow', 'reject', 'propagate']);

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
		requestRef: stableReferenceSchema,
		scope: z
			.object({
				documentRef: stableReferenceSchema,
				revisionRef: stableReferenceSchema,
				sourceRef: stableReferenceSchema,
			})
			.strict(),
		qualifiedName: qualifiedNameSchema,
		arity: aritySchema,
		calls: z.array(operationCallObservationV1Schema).min(1).max(128),
		requiredDecisions: z.array(operationModuleRequiredDecisionV1Schema).length(7),
	})
	.strict()
	.superRefine((request, context) => {
		if (new Set(request.requiredDecisions).size !== REQUIRED_DECISIONS.length) {
			context.addIssue({
				code: 'custom',
				path: ['requiredDecisions'],
				message: 'requiredDecisions must contain each admission decision exactly once',
			});
		}
		for (const decision of REQUIRED_DECISIONS) {
			if (!request.requiredDecisions.includes(decision)) {
				context.addIssue({
					code: 'custom',
					path: ['requiredDecisions'],
					message: `required decision is missing: ${decision}`,
				});
			}
		}
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
		parameterRef: stableReferenceSchema,
		name: z
			.string()
			.min(1)
			.max(64)
			.regex(/^[A-Za-z_][A-Za-z0-9_]*$/),
		type: valueTypeSchema.nullable(),
		nullPolicy: nullPolicySchema.nullable(),
	})
	.strict();

export const operationModuleTemplateV1Schema = z
	.object({
		apiVersion: z.literal(1),
		templateRef: stableReferenceSchema,
		requestRef: stableReferenceSchema,
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
				operationRef: stableReferenceSchema,
				qualifiedName: qualifiedNameSchema,
				arity: aritySchema,
				version: z.literal('1.0.0'),
			})
			.strict(),
		parameters: z.array(operationParameterTemplateV1Schema).max(16),
		output: z
			.object({ type: valueTypeSchema.nullable(), nullPolicy: nullPolicySchema.nullable() })
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

export type OperationExpressionV1 =
	| { kind: 'literal'; value: JsonValue }
	| { kind: 'parameter'; parameterRef: string }
	| { kind: 'unary'; operator: 'not' | 'negate'; value: OperationExpressionV1 }
	| {
			kind: 'binary';
			operator:
				| 'add'
				| 'subtract'
				| 'multiply'
				| 'divide'
				| 'power'
				| 'eq'
				| 'neq'
				| 'lt'
				| 'lte'
				| 'gt'
				| 'gte'
				| 'and'
				| 'or';
			left: OperationExpressionV1;
			right: OperationExpressionV1;
	  }
	| {
			kind: 'conditional';
			condition: OperationExpressionV1;
			whenTrue: OperationExpressionV1;
			whenFalse: OperationExpressionV1;
	  }
	| { kind: 'array'; values: OperationExpressionV1[] }
	| { kind: 'object'; properties: Array<{ key: string; value: OperationExpressionV1 }> };

const operationObjectKeySchema = z
	.string()
	.min(1)
	.max(128)
	.refine((key) => !['__proto__', 'prototype', 'constructor'].includes(key), 'reserved key');

const operationExpressionV1BodySchema: z.ZodType<OperationExpressionV1> = z.lazy(() =>
	z.discriminatedUnion('kind', [
		z.object({ kind: z.literal('literal'), value: jsonValueSchema }).strict(),
		z.object({ kind: z.literal('parameter'), parameterRef: stableReferenceSchema }).strict(),
		z
			.object({
				kind: z.literal('unary'),
				operator: z.enum(['not', 'negate']),
				value: operationExpressionV1BodySchema,
			})
			.strict(),
		z
			.object({
				kind: z.literal('binary'),
				operator: z.enum([
					'add',
					'subtract',
					'multiply',
					'divide',
					'power',
					'eq',
					'neq',
					'lt',
					'lte',
					'gt',
					'gte',
					'and',
					'or',
				]),
				left: operationExpressionV1BodySchema,
				right: operationExpressionV1BodySchema,
			})
			.strict(),
		z
			.object({
				kind: z.literal('conditional'),
				condition: operationExpressionV1BodySchema,
				whenTrue: operationExpressionV1BodySchema,
				whenFalse: operationExpressionV1BodySchema,
			})
			.strict(),
		z
			.object({
				kind: z.literal('array'),
				values: z.array(operationExpressionV1BodySchema).max(64),
			})
			.strict(),
		z
			.object({
				kind: z.literal('object'),
				properties: z
					.array(
						z
							.object({ key: operationObjectKeySchema, value: operationExpressionV1BodySchema })
							.strict(),
					)
					.max(64),
			})
			.strict(),
	]),
);

export const operationExpressionV1Schema = z.preprocess(
	(input) => (isSchemaTraversalBounded(input) && isExpressionValueBounded(input) ? input : {}),
	operationExpressionV1BodySchema,
);

const operationParameterV1Schema = z
	.object({
		parameterRef: stableReferenceSchema,
		name: z
			.string()
			.min(1)
			.max(64)
			.regex(/^[A-Za-z_][A-Za-z0-9_]*$/),
		type: valueTypeSchema,
		nullPolicy: nullPolicySchema,
	})
	.strict();

const operationTestVectorV1Schema = z
	.object({
		name: z.string().trim().min(1).max(128),
		arguments: z.array(jsonValueSchema).max(16),
		expected: jsonValueSchema,
	})
	.strict();

const operationModuleSpecV1BodySchema = z
	.object({
		apiVersion: z.literal(1),
		requestRef: stableReferenceSchema,
		operationRef: stableReferenceSchema,
		qualifiedName: qualifiedNameSchema,
		arity: aritySchema,
		version: z.literal('1.0.0'),
		behaviorSummary: z.string().trim().min(1).max(1000),
		execution: z.literal('synchronous'),
		determinism: z.literal('deterministic'),
		effects: z.literal('none'),
		dataFlow: z.literal('json-to-json'),
		parameters: z.array(operationParameterV1Schema).max(16),
		output: z.object({ type: valueTypeSchema, nullPolicy: nullPolicySchema }).strict(),
		expression: operationExpressionV1Schema,
		testVectors: z.array(operationTestVectorV1Schema).min(3).max(32),
	})
	.strict()
	.superRefine((spec, context) => {
		if (spec.parameters.length !== spec.arity) {
			context.addIssue({
				code: 'custom',
				path: ['parameters'],
				message: 'parameter count must equal operation arity',
			});
		}
		const refs = new Set<string>();
		const names = new Set<string>();
		for (const [index, parameter] of spec.parameters.entries()) {
			if (refs.has(parameter.parameterRef)) {
				context.addIssue({
					code: 'custom',
					path: ['parameters', index, 'parameterRef'],
					message: 'parameterRef must be unique',
				});
			}
			refs.add(parameter.parameterRef);
			if (names.has(parameter.name)) {
				context.addIssue({
					code: 'custom',
					path: ['parameters', index, 'name'],
					message: 'parameter name must be unique',
				});
			}
			names.add(parameter.name);
		}

		const complexity = inspectExpression(spec.expression, refs, context);
		if (complexity.depth > OPERATION_EXPRESSION_MAX_DEPTH) {
			context.addIssue({
				code: 'custom',
				path: ['expression'],
				message: `expression depth exceeds ${OPERATION_EXPRESSION_MAX_DEPTH}`,
			});
		}
		if (complexity.nodes > OPERATION_EXPRESSION_MAX_NODES) {
			context.addIssue({
				code: 'custom',
				path: ['expression'],
				message: `expression node count exceeds ${OPERATION_EXPRESSION_MAX_NODES}`,
			});
		}
		for (const [index, vector] of spec.testVectors.entries()) {
			if (vector.arguments.length !== spec.parameters.length) {
				context.addIssue({
					code: 'custom',
					path: ['testVectors', index, 'arguments'],
					message: 'test vector argument count must equal parameter count',
				});
			}
		}
	});

export const operationModuleSpecV1Schema = z.preprocess(
	(input) => (isSchemaTraversalBounded(input) && isExpressionInputBounded(input) ? input : {}),
	operationModuleSpecV1BodySchema,
);

export type OperationModuleSpecV1 = z.infer<typeof operationModuleSpecV1Schema>;

const operationModuleAdmissionV1BodySchema = z
	.object({
		request: moduleScaffoldRequestV1Schema,
		spec: operationModuleSpecV1Schema,
	})
	.strict()
	.superRefine((admission, context) => {
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

function isExpressionInputBounded(input: unknown): boolean {
	if (typeof input !== 'object' || input === null || !('expression' in input)) return true;
	return isExpressionValueBounded((input as { expression?: unknown }).expression);
}

function isExpressionValueBounded(value: unknown): boolean {
	const stack: Array<{ value: unknown; depth: number }> = [{ value, depth: 1 }];
	const seen = new WeakSet<object>();
	let nodes = 0;
	while (stack.length > 0) {
		const current = stack.pop();
		if (current === undefined) break;
		if (typeof current.value !== 'object' || current.value === null) continue;
		if (
			seen.has(current.value) ||
			current.depth > OPERATION_EXPRESSION_MAX_DEPTH ||
			nodes >= OPERATION_EXPRESSION_MAX_NODES
		) {
			return false;
		}
		seen.add(current.value);
		nodes += 1;
		const expression = current.value as Record<string, unknown>;
		const children: unknown[] = [];
		if (expression.kind === 'unary') {
			children.push(expression.value);
		} else if (expression.kind === 'binary') {
			children.push(expression.left, expression.right);
		} else if (expression.kind === 'conditional') {
			children.push(expression.condition, expression.whenTrue, expression.whenFalse);
		} else if (expression.kind === 'array' && Array.isArray(expression.values)) {
			for (const value of expression.values) children.push(value as unknown);
		} else if (expression.kind === 'object' && Array.isArray(expression.properties)) {
			for (const property of expression.properties) {
				if (typeof property === 'object' && property !== null && 'value' in property) {
					children.push((property as { value?: unknown }).value);
				}
			}
		}
		for (const child of children) stack.push({ value: child, depth: current.depth + 1 });
	}
	return true;
}

function inspectExpression(
	expression: OperationExpressionV1,
	parameterRefs: ReadonlySet<string>,
	context: z.RefinementCtx,
	path: Array<string | number> = ['expression'],
): { depth: number; nodes: number } {
	if (expression.kind === 'parameter') {
		if (!parameterRefs.has(expression.parameterRef)) {
			context.addIssue({
				code: 'custom',
				path: [...path, 'parameterRef'],
				message: `expression references undeclared parameter: ${expression.parameterRef}`,
			});
		}
		return { depth: 1, nodes: 1 };
	}
	if (expression.kind === 'literal') return { depth: 1, nodes: 1 };
	const children: Array<{ expression: OperationExpressionV1; path: Array<string | number> }> = [];
	if (expression.kind === 'unary') {
		children.push({ expression: expression.value, path: [...path, 'value'] });
	} else if (expression.kind === 'binary') {
		children.push(
			{ expression: expression.left, path: [...path, 'left'] },
			{ expression: expression.right, path: [...path, 'right'] },
		);
	} else if (expression.kind === 'conditional') {
		children.push(
			{ expression: expression.condition, path: [...path, 'condition'] },
			{ expression: expression.whenTrue, path: [...path, 'whenTrue'] },
			{ expression: expression.whenFalse, path: [...path, 'whenFalse'] },
		);
	} else if (expression.kind === 'array') {
		for (const [index, value] of expression.values.entries()) {
			children.push({ expression: value, path: [...path, 'values', index] });
		}
	} else {
		const keys = new Set<string>();
		for (const [index, property] of expression.properties.entries()) {
			if (keys.has(property.key)) {
				context.addIssue({
					code: 'custom',
					path: [...path, 'properties', index, 'key'],
					message: `object expression key must be unique: ${property.key}`,
				});
			}
			keys.add(property.key);
			children.push({ expression: property.value, path: [...path, 'properties', index, 'value'] });
		}
	}

	let depth = 1;
	let nodes = 1;
	for (const child of children) {
		const childComplexity = inspectExpression(child.expression, parameterRefs, context, child.path);
		depth = Math.max(depth, childComplexity.depth + 1);
		nodes += childComplexity.nodes;
	}
	return { depth, nodes };
}
