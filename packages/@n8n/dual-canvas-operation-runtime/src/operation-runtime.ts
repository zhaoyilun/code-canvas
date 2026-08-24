import { v5 as uuidV5 } from 'uuid';
import { z } from 'zod';

export const OPERATION_EXPRESSION_MAX_DEPTH = 16;
export const OPERATION_EXPRESSION_MAX_NODES = 128;
export const OPERATION_CATALOG_MAX_MODULES = 256;
export const OPERATION_JSON_MAX_DEPTH = 32;
export const OPERATION_JSON_MAX_NODES = 4096;
export const OPERATION_JSON_MAX_STRING_LENGTH = 4096;
export const OPERATION_JSON_MAX_KEY_LENGTH = 128;
export const OPERATION_MODULE_MAX_BYTES = 32 * 1024;
export const OPERATION_CATALOG_MAX_BYTES = 96 * 1024;

const OPERATION_BLOCK_NAMESPACE = '254a9dcf-66ac-59bb-b17d-03ea915a6231';
const OPERATION_IMPLEMENTATION_NAMESPACE = '14fcdb61-3b6c-5f06-b086-6ead507d19e1';
const OPERATION_BLOCK_COLOUR = 290;
const FORBIDDEN_OBJECT_KEYS = new Set(['__proto__', 'prototype', 'constructor']);

export type OperationJsonPrimitive = boolean | number | string | null;
export type OperationJsonValue =
	| OperationJsonPrimitive
	| OperationJsonValue[]
	| OperationJsonObject;
export type OperationJsonObject = { [key: string]: OperationJsonValue };

const operationJsonValueBodySchema: z.ZodType<OperationJsonValue, z.ZodTypeDef, unknown> = z.lazy(
	() =>
		z.union([
			z.string().max(OPERATION_JSON_MAX_STRING_LENGTH),
			z.number().finite(),
			z.boolean(),
			z.null(),
			z.array(operationJsonValueBodySchema),
			operationJsonObjectBodySchema,
		]),
);

const operationJsonObjectBodySchema: z.ZodType<OperationJsonObject, z.ZodTypeDef, unknown> =
	z.preprocess(
		(input) => (hasReservedOwnObjectKey(input) ? undefined : input),
		z
			.record(z.string().max(OPERATION_JSON_MAX_KEY_LENGTH), operationJsonValueBodySchema)
			.superRefine((value, context) => {
				for (const key of Object.keys(value)) {
					if (FORBIDDEN_OBJECT_KEYS.has(key)) {
						context.addIssue({
							code: 'custom',
							path: [key],
							message: `object key "${key}" is reserved`,
						});
					}
				}
			}),
	);

export const operationJsonValueSchema: z.ZodType<OperationJsonValue, z.ZodTypeDef, unknown> =
	z.preprocess(
		(input) => (isOperationJsonValueBounded(input) ? input : undefined),
		operationJsonValueBodySchema,
	);

export const operationJsonObjectSchema: z.ZodType<OperationJsonObject, z.ZodTypeDef, unknown> =
	z.preprocess(
		(input) => (isOperationJsonValueBounded(input) ? input : undefined),
		operationJsonObjectBodySchema,
	);

export const operationStableReferenceSchema = z
	.string()
	.min(1)
	.max(128)
	.regex(/^[a-zA-Z0-9][a-zA-Z0-9._:-]*$/);

export const operationImplementationReferenceV1Schema = z
	.string()
	.regex(/^implementation-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);

export const operationQualifiedNameSchema = z
	.string()
	.min(1)
	.max(256)
	.regex(/^[A-Za-z_$][A-Za-z0-9_$]*(?:\.[A-Za-z_$][A-Za-z0-9_$]*)*$/)
	.refine(
		(value) => value.split('.').every((segment) => !FORBIDDEN_OBJECT_KEYS.has(segment)),
		'qualified name contains a reserved segment',
	);

export const operationAritySchema = z.number().int().min(0).max(16);
export const operationValueTypeSchema = z.enum([
	'json',
	'number',
	'string',
	'boolean',
	'array',
	'object',
]);
export const operationNullPolicySchema = z.enum(['allow', 'reject', 'propagate']);
export const operationModuleVersionV1Schema = z.literal('1.0.0');

export type OperationValueType = z.infer<typeof operationValueTypeSchema>;
export type OperationNullPolicy = z.infer<typeof operationNullPolicySchema>;
export type OperationModuleVersionV1 = z.infer<typeof operationModuleVersionV1Schema>;

export type OperationExpressionV1 =
	| { kind: 'literal'; value: OperationJsonValue }
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
	.refine((key) => !FORBIDDEN_OBJECT_KEYS.has(key), 'reserved key');

const operationExpressionV1BodySchema: z.ZodType<OperationExpressionV1, z.ZodTypeDef, unknown> =
	z.lazy(() =>
		z.discriminatedUnion('kind', [
			z.object({ kind: z.literal('literal'), value: operationJsonValueSchema }).strict(),
			z
				.object({ kind: z.literal('parameter'), parameterRef: operationStableReferenceSchema })
				.strict(),
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

export const operationParameterV1Schema = z
	.object({
		parameterRef: operationStableReferenceSchema,
		name: z
			.string()
			.min(1)
			.max(64)
			.regex(/^[A-Za-z_][A-Za-z0-9_]*$/),
		type: operationValueTypeSchema,
		nullPolicy: operationNullPolicySchema,
	})
	.strict();

export const operationOutputV1Schema = z
	.object({ type: operationValueTypeSchema, nullPolicy: z.enum(['allow', 'reject']) })
	.strict();

export const operationTestVectorV1Schema = z
	.object({
		name: z.string().trim().min(1).max(128),
		arguments: z.array(operationJsonValueSchema).max(16),
		expected: operationJsonValueSchema,
	})
	.strict();

const operationImplementationProjectionV1Shape = {
	operationRef: operationStableReferenceSchema,
	qualifiedName: operationQualifiedNameSchema,
	arity: operationAritySchema,
	version: operationModuleVersionV1Schema,
	execution: z.literal('synchronous'),
	determinism: z.literal('deterministic'),
	effects: z.literal('none'),
	dataFlow: z.literal('json-to-json'),
	parameters: z.array(operationParameterV1Schema).max(16),
	output: operationOutputV1Schema,
	expression: operationExpressionV1Schema,
} as const;

export const operationImplementationProjectionV1Schema = z
	.object(operationImplementationProjectionV1Shape)
	.strict();

export type OperationImplementationProjectionV1 = z.infer<
	typeof operationImplementationProjectionV1Schema
>;

const operationModuleCommonV1BodySchema = z
	.object({
		apiVersion: z.literal(1),
		requestRef: operationStableReferenceSchema,
		...operationImplementationProjectionV1Shape,
		behaviorSummary: z.string().trim().min(1).max(1000),
		testVectors: z.array(operationTestVectorV1Schema).min(3).max(32),
	})
	.strict();

type OperationModuleCommonV1 = z.infer<typeof operationModuleCommonV1BodySchema>;

const operationModuleDraftSpecV1BodySchema = operationModuleCommonV1BodySchema
	.extend({ implementationRef: z.null() })
	.strict()
	.superRefine(refineOperationModuleCommonV1);

export const operationModuleDraftSpecV1Schema = z.preprocess(
	(input) => (isSchemaTraversalBounded(input) && isExpressionInputBounded(input) ? input : {}),
	operationModuleDraftSpecV1BodySchema,
);

export type OperationModuleDraftSpecV1 = z.infer<typeof operationModuleDraftSpecV1Schema>;

const operationModuleFinalizationInputV1BodySchema = operationModuleCommonV1BodySchema
	.extend({ implementationRef: operationImplementationReferenceV1Schema.nullable() })
	.strict()
	.superRefine((spec, context) => {
		refineOperationModuleCommonV1(spec, context);
		if (spec.implementationRef !== null) {
			refineOperationImplementationIdentityV1(
				{ ...spec, implementationRef: spec.implementationRef },
				context,
			);
		}
	});

export const operationModuleFinalizationInputV1Schema = z.preprocess(
	(input) => (isSchemaTraversalBounded(input) && isExpressionInputBounded(input) ? input : {}),
	operationModuleFinalizationInputV1BodySchema,
);

export type OperationModuleFinalizationInputV1 = z.infer<
	typeof operationModuleFinalizationInputV1Schema
>;

const operationModuleSpecV1BodySchema = operationModuleCommonV1BodySchema
	.extend({ implementationRef: operationImplementationReferenceV1Schema })
	.strict()
	.superRefine((spec, context) => {
		refineOperationModuleCommonV1(spec, context);
		refineOperationImplementationIdentityV1(spec, context);
	});

export const operationModuleSpecV1Schema = z.preprocess(
	(input) => (isSchemaTraversalBounded(input) && isExpressionInputBounded(input) ? input : {}),
	operationModuleSpecV1BodySchema,
);

export type OperationParameterV1 = z.infer<typeof operationParameterV1Schema>;
export type OperationOutputV1 = z.infer<typeof operationOutputV1Schema>;
export type OperationTestVectorV1 = z.infer<typeof operationTestVectorV1Schema>;
export type OperationModuleSpecV1 = z.infer<typeof operationModuleSpecV1Schema>;

const operationModuleCatalogV1BodySchema = z
	.object({
		apiVersion: z.literal(1),
		modules: z.array(operationModuleSpecV1Schema).max(OPERATION_CATALOG_MAX_MODULES),
	})
	.strict()
	.superRefine((catalog, context) => {
		if (serializedJsonByteLength(catalog) > OPERATION_CATALOG_MAX_BYTES) {
			context.addIssue({
				code: 'custom',
				message: `operation catalog exceeds ${OPERATION_CATALOG_MAX_BYTES} bytes`,
			});
		}
	});

export const operationModuleCatalogV1Schema = z.preprocess(
	(input) => (isSchemaTraversalBounded(input) ? input : {}),
	operationModuleCatalogV1BodySchema,
);

export type OperationModuleCatalogV1 = z.infer<typeof operationModuleCatalogV1Schema>;

const blocklyCheckSchema = z.enum(['Number', 'String', 'Boolean', 'Array', 'Object']).nullable();

export const operationBlockDescriptorV1Schema = z
	.object({
		apiVersion: z.literal(1),
		blockType: z
			.string()
			.min(1)
			.max(128)
			.regex(/^[A-Za-z_][A-Za-z0-9_]*$/),
		operationRef: operationStableReferenceSchema,
		implementationRef: operationImplementationReferenceV1Schema,
		version: operationModuleVersionV1Schema,
		qualifiedName: operationQualifiedNameSchema,
		label: z.string().min(1).max(256),
		tooltip: z.string().min(1).max(1000),
		inputs: z
			.array(
				z
					.object({
						inputName: z.string().regex(/^ARG(?:0|[1-9][0-9]?)$/),
						parameterRef: operationStableReferenceSchema,
						name: z.string().min(1).max(64),
						type: operationValueTypeSchema,
						nullPolicy: operationNullPolicySchema,
						check: blocklyCheckSchema,
					})
					.strict(),
			)
			.max(16),
		output: z
			.object({
				type: operationValueTypeSchema,
				nullPolicy: z.enum(['allow', 'reject']),
				check: blocklyCheckSchema,
			})
			.strict(),
		colour: z.literal(OPERATION_BLOCK_COLOUR),
	})
	.strict()
	.superRefine((descriptor, context) => {
		for (const [index, input] of descriptor.inputs.entries()) {
			if (input.inputName !== `ARG${index}`) {
				context.addIssue({
					code: 'custom',
					path: ['inputs', index, 'inputName'],
					message: 'input names must be contiguous and source ordered',
				});
			}
		}
	});

export type OperationBlockDescriptorV1 = z.infer<typeof operationBlockDescriptorV1Schema>;

export type OperationModuleRuntimeErrorCode =
	| 'OPERATION_ARGUMENT_COUNT_INVALID'
	| 'OPERATION_ARGUMENT_TYPE_INVALID'
	| 'OPERATION_OUTPUT_TYPE_INVALID'
	| 'OPERATION_EXPRESSION_RESULT_INVALID'
	| 'OPERATION_TEST_VECTOR_INVALID'
	| 'OPERATION_IMPLEMENTATION_IDENTITY_MISMATCH'
	| 'OPERATION_CATALOG_DUPLICATE';

export class OperationModuleRuntimeError extends Error {
	readonly code: OperationModuleRuntimeErrorCode;

	constructor(code: OperationModuleRuntimeErrorCode, message: string) {
		super(message);
		this.name = 'OperationModuleRuntimeError';
		this.code = code;
	}
}

export type OperationModuleTestVectorVerificationV1 = {
	apiVersion: 1;
	operationRef: string;
	implementationRef: string;
	version: OperationModuleVersionV1;
	verifiedVectorCount: number;
};

export function createOperationImplementationProjectionV1(
	moduleInput: unknown,
): OperationImplementationProjectionV1 {
	const source = z
		.object(operationImplementationProjectionV1Shape)
		.passthrough()
		.parse(moduleInput);
	return deepFreeze(
		operationImplementationProjectionV1Schema.parse({
			operationRef: source.operationRef,
			qualifiedName: source.qualifiedName,
			arity: source.arity,
			version: source.version,
			execution: source.execution,
			determinism: source.determinism,
			effects: source.effects,
			dataFlow: source.dataFlow,
			parameters: source.parameters,
			output: source.output,
			expression: source.expression,
		}),
	);
}

export function canonicalizeOperationImplementationProjectionV1(moduleInput: unknown): string {
	return canonicalJson(createOperationImplementationProjectionV1(moduleInput));
}

export function createOperationImplementationRefV1(moduleInput: unknown): string {
	const canonicalProjection = canonicalizeOperationImplementationProjectionV1(moduleInput);
	return `implementation-${uuidV5(canonicalProjection, OPERATION_IMPLEMENTATION_NAMESPACE)}`;
}

export function finalizeOperationModuleSpecV1(moduleInput: unknown): OperationModuleSpecV1 {
	const draft = operationModuleFinalizationInputV1Schema.parse(moduleInput);
	const implementationRef = createOperationImplementationRefV1(draft);
	return operationModuleSpecV1Schema.parse({ ...draft, implementationRef });
}

export function createOperationBlockTypeV1(
	operationRefInput: string,
	implementationRefInput: string,
	versionInput: OperationModuleVersionV1,
): string {
	const operationRef = operationStableReferenceSchema.parse(operationRefInput);
	const implementationRef = operationImplementationReferenceV1Schema.parse(implementationRefInput);
	const version = operationModuleVersionV1Schema.parse(versionInput);
	const id = uuidV5(
		`${operationRef}@${implementationRef}@${version}`,
		OPERATION_BLOCK_NAMESPACE,
	).replaceAll('-', '_');
	return `n8n_operation_${id}`;
}

export function evaluateOperationExpressionV1(
	expressionInput: unknown,
	parametersInput: Readonly<Record<string, unknown>>,
): OperationJsonValue {
	const expression = operationExpressionV1Schema.parse(expressionInput);
	const parameters = new Map<string, OperationJsonValue>();
	for (const [parameterRef, value] of Object.entries(parametersInput)) {
		operationStableReferenceSchema.parse(parameterRef);
		parameters.set(parameterRef, operationJsonValueSchema.parse(value));
	}
	return evaluateExpression(expression, parameters);
}

export function evaluateOperationModuleV1(
	moduleInput: unknown,
	argumentsInput: unknown,
): OperationJsonValue {
	const module = operationModuleSpecV1Schema.parse(moduleInput);
	const argumentsResult = z.array(operationJsonValueSchema).max(16).safeParse(argumentsInput);
	if (!argumentsResult.success || argumentsResult.data.length !== module.parameters.length) {
		throw new OperationModuleRuntimeError(
			'OPERATION_ARGUMENT_COUNT_INVALID',
			`${module.qualifiedName}/${module.arity} requires exactly ${module.parameters.length} arguments`,
		);
	}

	const parameters = new Map<string, OperationJsonValue>();
	let propagatesNull = false;
	for (const [index, parameter] of module.parameters.entries()) {
		const value = argumentsResult.data[index];
		if (value === undefined) {
			throw new OperationModuleRuntimeError(
				'OPERATION_ARGUMENT_COUNT_INVALID',
				`${module.qualifiedName}/${module.arity} is missing argument ${index}`,
			);
		}
		assertValueMatchesContract(
			value,
			parameter,
			`argument ${index} (${parameter.name})`,
			'argument',
		);
		parameters.set(parameter.parameterRef, value);
		if (value === null && parameter.nullPolicy === 'propagate') propagatesNull = true;
	}

	const result = propagatesNull ? null : evaluateExpression(module.expression, parameters);
	const boundedResult = operationJsonValueSchema.safeParse(result);
	if (!boundedResult.success) {
		throw new OperationModuleRuntimeError(
			'OPERATION_EXPRESSION_RESULT_INVALID',
			'operation expression produced a JSON value outside the depth, node, or string limits',
		);
	}
	assertValueMatchesContract(boundedResult.data, module.output, 'operation output', 'output');
	return boundedResult.data;
}

export function verifyOperationModuleTestVectorsV1(
	moduleInput: unknown,
): OperationModuleTestVectorVerificationV1 {
	const module = operationModuleSpecV1Schema.parse(moduleInput);
	for (const [index, vector] of module.testVectors.entries()) {
		try {
			assertValueMatchesContract(vector.expected, module.output, 'expected output', 'output');
			const actual = evaluateOperationModuleV1(module, vector.arguments);
			if (!jsonValuesEqual(actual, vector.expected)) {
				throw new OperationModuleRuntimeError(
					'OPERATION_TEST_VECTOR_INVALID',
					`test vector ${JSON.stringify(vector.name)} expected ${canonicalJson(vector.expected)} but produced ${canonicalJson(actual)}`,
				);
			}
		} catch (error) {
			if (
				error instanceof OperationModuleRuntimeError &&
				error.code === 'OPERATION_TEST_VECTOR_INVALID'
			) {
				throw error;
			}
			const message = error instanceof Error ? error.message : String(error);
			throw new OperationModuleRuntimeError(
				'OPERATION_TEST_VECTOR_INVALID',
				`test vector ${index} (${JSON.stringify(vector.name)}) is invalid: ${message}`,
			);
		}
	}

	return Object.freeze({
		apiVersion: 1 as const,
		operationRef: module.operationRef,
		implementationRef: module.implementationRef,
		version: module.version,
		verifiedVectorCount: module.testVectors.length,
	});
}

export function createOperationModuleCatalogV1(input: unknown): OperationModuleCatalogV1 {
	const parsed = operationModuleCatalogV1Schema.parse(input);
	const refs = new Map<string, string>();
	const names = new Map<string, string>();
	const blockTypes = new Map<string, string>();

	for (const module of parsed.modules) {
		assertOperationImplementationIdentityV1(module);
		verifyOperationModuleTestVectorsV1(module);
		const identity = `${module.qualifiedName}/${module.arity}@${module.version}`;
		assertUniqueCatalogKey(
			refs,
			`${module.operationRef}@${module.implementationRef}@${module.version}`,
			identity,
			'operationRef, implementationRef, and version',
		);
		assertUniqueCatalogKey(
			names,
			identity,
			`${module.operationRef}@${module.implementationRef}`,
			'qualified name, arity, and version',
		);
		assertUniqueCatalogKey(
			blockTypes,
			createOperationBlockTypeV1(module.operationRef, module.implementationRef, module.version),
			identity,
			'Blockly block type',
		);
	}

	const modules = [...parsed.modules].sort(compareModules);
	return deepFreeze({ apiVersion: 1 as const, modules });
}

export function resolveOperationModuleV1(
	catalogInput: unknown,
	qualifiedNameInput: string,
	arityInput: number,
): OperationModuleSpecV1 | undefined {
	const catalog = createOperationModuleCatalogV1(catalogInput);
	const qualifiedName = operationQualifiedNameSchema.parse(qualifiedNameInput);
	const arity = operationAritySchema.parse(arityInput);
	return catalog.modules.find(
		(module) => module.qualifiedName === qualifiedName && module.arity === arity,
	);
}

export function createOperationBlockDescriptorV1(moduleInput: unknown): OperationBlockDescriptorV1 {
	const module = operationModuleSpecV1Schema.parse(moduleInput);
	verifyOperationModuleTestVectorsV1(module);
	return deepFreeze(
		operationBlockDescriptorV1Schema.parse({
			apiVersion: 1,
			blockType: createOperationBlockTypeV1(
				module.operationRef,
				module.implementationRef,
				module.version,
			),
			operationRef: module.operationRef,
			implementationRef: module.implementationRef,
			version: module.version,
			qualifiedName: module.qualifiedName,
			label: module.qualifiedName,
			tooltip: module.behaviorSummary,
			inputs: module.parameters.map((parameter, index) => ({
				inputName: `ARG${index}`,
				parameterRef: parameter.parameterRef,
				name: parameter.name,
				type: parameter.type,
				nullPolicy: parameter.nullPolicy,
				check: toBlocklyCheck(parameter.type),
			})),
			output: {
				type: module.output.type,
				nullPolicy: module.output.nullPolicy,
				check: toBlocklyCheck(module.output.type),
			},
			colour: OPERATION_BLOCK_COLOUR,
		}),
	);
}

function evaluateExpression(
	expression: OperationExpressionV1,
	parameters: ReadonlyMap<string, OperationJsonValue>,
): OperationJsonValue {
	switch (expression.kind) {
		case 'literal':
			return expression.value;
		case 'parameter': {
			const value = parameters.get(expression.parameterRef);
			if (value === undefined) {
				throw new OperationModuleRuntimeError(
					'OPERATION_EXPRESSION_RESULT_INVALID',
					`parameter value is missing: ${expression.parameterRef}`,
				);
			}
			return value;
		}
		case 'unary': {
			const value = evaluateExpression(expression.value, parameters);
			if (expression.operator === 'not') return !isJsTruthy(value);
			return finiteNumber(-toJsNumber(value), 'unary negate');
		}
		case 'binary':
			return evaluateBinaryExpression(expression, parameters);
		case 'conditional':
			return isJsTruthy(evaluateExpression(expression.condition, parameters))
				? evaluateExpression(expression.whenTrue, parameters)
				: evaluateExpression(expression.whenFalse, parameters);
		case 'array':
			return expression.values.map((value) => evaluateExpression(value, parameters));
		case 'object': {
			const result: OperationJsonObject = {};
			for (const property of expression.properties) {
				result[property.key] = evaluateExpression(property.value, parameters);
			}
			return result;
		}
	}
}

function evaluateBinaryExpression(
	expression: Extract<OperationExpressionV1, { kind: 'binary' }>,
	parameters: ReadonlyMap<string, OperationJsonValue>,
): OperationJsonValue {
	const left = evaluateExpression(expression.left, parameters);
	if (expression.operator === 'and') {
		return isJsTruthy(left) ? evaluateExpression(expression.right, parameters) : left;
	}
	if (expression.operator === 'or') {
		return isJsTruthy(left) ? left : evaluateExpression(expression.right, parameters);
	}
	const right = evaluateExpression(expression.right, parameters);

	switch (expression.operator) {
		case 'add':
			return jsAdd(left, right);
		case 'subtract':
			return finiteNumber(toJsNumber(left) - toJsNumber(right), 'subtraction');
		case 'multiply':
			return finiteNumber(toJsNumber(left) * toJsNumber(right), 'multiplication');
		case 'divide':
			return finiteNumber(toJsNumber(left) / toJsNumber(right), 'division');
		case 'power':
			return finiteNumber(toJsNumber(left) ** toJsNumber(right), 'power');
		case 'eq':
			return left === right;
		case 'neq':
			return left !== right;
		case 'lt':
			return jsRelational(left, right, 'lt');
		case 'lte':
			return jsRelational(left, right, 'lte');
		case 'gt':
			return jsRelational(left, right, 'gt');
		case 'gte':
			return jsRelational(left, right, 'gte');
	}
}

function jsAdd(left: OperationJsonValue, right: OperationJsonValue): OperationJsonValue {
	const leftPrimitive = toJsPrimitive(left);
	const rightPrimitive = toJsPrimitive(right);
	if (typeof leftPrimitive === 'string' || typeof rightPrimitive === 'string') {
		return String(leftPrimitive) + String(rightPrimitive);
	}
	return finiteNumber(Number(leftPrimitive) + Number(rightPrimitive), 'addition');
}

function jsRelational(
	left: OperationJsonValue,
	right: OperationJsonValue,
	operator: 'lt' | 'lte' | 'gt' | 'gte',
): boolean {
	const leftPrimitive = toJsPrimitive(left);
	const rightPrimitive = toJsPrimitive(right);
	if (typeof leftPrimitive === 'string' && typeof rightPrimitive === 'string') {
		if (operator === 'lt') return leftPrimitive < rightPrimitive;
		if (operator === 'lte') return leftPrimitive <= rightPrimitive;
		if (operator === 'gt') return leftPrimitive > rightPrimitive;
		return leftPrimitive >= rightPrimitive;
	}
	const leftNumber = Number(leftPrimitive);
	const rightNumber = Number(rightPrimitive);
	if (operator === 'lt') return leftNumber < rightNumber;
	if (operator === 'lte') return leftNumber <= rightNumber;
	if (operator === 'gt') return leftNumber > rightNumber;
	return leftNumber >= rightNumber;
}

function toJsPrimitive(value: OperationJsonValue): OperationJsonPrimitive {
	if (Array.isArray(value)) return value.map(toJsArrayElementString).join(',');
	if (typeof value === 'object' && value !== null) return '[object Object]';
	return value;
}

function toJsArrayElementString(value: OperationJsonValue): string {
	if (value === null) return '';
	if (Array.isArray(value)) return value.map(toJsArrayElementString).join(',');
	if (typeof value === 'object') return '[object Object]';
	return String(value);
}

function toJsNumber(value: OperationJsonValue): number {
	return Number(toJsPrimitive(value));
}

function finiteNumber(value: number, operation: string): number {
	if (!Number.isFinite(value)) {
		throw new OperationModuleRuntimeError(
			'OPERATION_EXPRESSION_RESULT_INVALID',
			`${operation} produced a non-finite number`,
		);
	}
	return value;
}

function hasReservedOwnObjectKey(value: unknown): boolean {
	return (
		typeof value === 'object' &&
		value !== null &&
		!Array.isArray(value) &&
		Object.keys(value).some((key) => FORBIDDEN_OBJECT_KEYS.has(key))
	);
}

function isJsTruthy(value: OperationJsonValue): boolean {
	return value !== null && value !== false && value !== 0 && value !== '';
}

function assertValueMatchesContract(
	value: OperationJsonValue,
	contract: { type: OperationValueType; nullPolicy: OperationNullPolicy },
	location: string,
	kind: 'argument' | 'output',
): void {
	const errorCode =
		kind === 'argument' ? 'OPERATION_ARGUMENT_TYPE_INVALID' : 'OPERATION_OUTPUT_TYPE_INVALID';
	if (value === null) {
		if (contract.nullPolicy === 'reject') {
			throw new OperationModuleRuntimeError(errorCode, `${location} rejects null`);
		}
		return;
	}

	const matches =
		contract.type === 'json' ||
		(contract.type === 'number' && typeof value === 'number' && Number.isFinite(value)) ||
		(contract.type === 'string' && typeof value === 'string') ||
		(contract.type === 'boolean' && typeof value === 'boolean') ||
		(contract.type === 'array' && Array.isArray(value)) ||
		(contract.type === 'object' && typeof value === 'object' && !Array.isArray(value));
	if (!matches) {
		throw new OperationModuleRuntimeError(errorCode, `${location} must have type ${contract.type}`);
	}
}

function jsonValuesEqual(left: OperationJsonValue, right: OperationJsonValue): boolean {
	if (left === right) return true;
	if (Array.isArray(left) || Array.isArray(right)) {
		return (
			Array.isArray(left) &&
			Array.isArray(right) &&
			left.length === right.length &&
			left.every((value, index) => {
				const rightValue = right[index];
				return rightValue !== undefined && jsonValuesEqual(value, rightValue);
			})
		);
	}
	if (typeof left === 'object' && left !== null && typeof right === 'object' && right !== null) {
		const leftKeys = Object.keys(left).sort(compareStrings);
		const rightKeys = Object.keys(right).sort(compareStrings);
		return (
			leftKeys.length === rightKeys.length &&
			leftKeys.every((key, index) => {
				const rightKey = rightKeys[index];
				return rightKey === key && jsonValuesEqual(left[key], right[key]);
			})
		);
	}
	return false;
}

function canonicalJson(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
	if (typeof value === 'object' && value !== null) {
		const record = value as Record<string, unknown>;
		return `{${Object.keys(value)
			.sort(compareStrings)
			.map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
			.join(',')}}`;
	}
	const serialized = JSON.stringify(value);
	if (serialized === undefined) throw new TypeError('canonical JSON value is invalid');
	return serialized;
}

function assertUniqueCatalogKey(
	seen: Map<string, string>,
	key: string,
	identity: string,
	label: string,
): void {
	const first = seen.get(key);
	if (first !== undefined) {
		throw new OperationModuleRuntimeError(
			'OPERATION_CATALOG_DUPLICATE',
			`catalog ${label} collision for ${JSON.stringify(key)} between ${first} and ${identity}`,
		);
	}
	seen.set(key, identity);
}

function compareModules(left: OperationModuleSpecV1, right: OperationModuleSpecV1): number {
	return (
		compareStrings(left.qualifiedName, right.qualifiedName) ||
		left.arity - right.arity ||
		compareStrings(left.version, right.version) ||
		compareStrings(left.operationRef, right.operationRef) ||
		compareStrings(left.implementationRef, right.implementationRef)
	);
}

function compareStrings(left: string, right: string): number {
	return left < right ? -1 : left > right ? 1 : 0;
}

function toBlocklyCheck(type: OperationValueType): z.infer<typeof blocklyCheckSchema> {
	if (type === 'number') return 'Number';
	if (type === 'string') return 'String';
	if (type === 'boolean') return 'Boolean';
	if (type === 'array') return 'Array';
	if (type === 'object') return 'Object';
	return null;
}

function deepFreeze<T>(value: T): T {
	if (typeof value !== 'object' || value === null || Object.isFrozen(value)) return value;
	for (const child of Object.values(value)) deepFreeze(child);
	return Object.freeze(value);
}

function isOperationJsonValueBounded(input: unknown): boolean {
	const stack: Array<{ value: unknown; depth: number; exit?: boolean }> = [
		{ value: input, depth: 1 },
	];
	const ancestors = new WeakSet<object>();
	let nodes = 0;
	while (stack.length > 0) {
		const current = stack.pop();
		if (current === undefined) break;
		if (current.exit) {
			if (typeof current.value === 'object' && current.value !== null) {
				ancestors.delete(current.value);
			}
			continue;
		}
		nodes += 1;
		if (current.depth > OPERATION_JSON_MAX_DEPTH || nodes > OPERATION_JSON_MAX_NODES) return false;
		if (typeof current.value !== 'object' || current.value === null) continue;
		if (ancestors.has(current.value)) return false;
		ancestors.add(current.value);
		stack.push({ ...current, exit: true });
		const children = Array.isArray(current.value)
			? current.value
			: Object.values(current.value as Record<string, unknown>);
		for (const child of children) stack.push({ value: child, depth: current.depth + 1 });
	}
	return true;
}

function serializedJsonByteLength(value: unknown): number {
	return new TextEncoder().encode(JSON.stringify(value)).byteLength;
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
			for (const child of expression.values) children.push(child);
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

function refineOperationModuleCommonV1(
	spec: OperationModuleCommonV1,
	context: z.RefinementCtx,
): void {
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
	if (
		spec.parameters.some((parameter) => parameter.nullPolicy === 'propagate') &&
		spec.output.nullPolicy !== 'allow'
	) {
		context.addIssue({
			code: 'custom',
			path: ['output', 'nullPolicy'],
			message: 'output must allow null when any parameter propagates null',
		});
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

	const vectorNames = new Set<string>();
	for (const [index, vector] of spec.testVectors.entries()) {
		if (vector.arguments.length !== spec.parameters.length) {
			context.addIssue({
				code: 'custom',
				path: ['testVectors', index, 'arguments'],
				message: 'test vector argument count must equal parameter count',
			});
		}
		if (vectorNames.has(vector.name)) {
			context.addIssue({
				code: 'custom',
				path: ['testVectors', index, 'name'],
				message: 'test vector name must be unique',
			});
		}
		vectorNames.add(vector.name);
	}
	if (serializedJsonByteLength(spec) > OPERATION_MODULE_MAX_BYTES) {
		context.addIssue({
			code: 'custom',
			message: `operation module exceeds ${OPERATION_MODULE_MAX_BYTES} bytes`,
		});
	}
}

function refineOperationImplementationIdentityV1(
	spec: OperationModuleCommonV1 & { implementationRef: string },
	context: z.RefinementCtx,
): void {
	let expected: string;
	try {
		expected = createOperationImplementationRefV1(spec);
	} catch {
		return;
	}
	if (spec.implementationRef !== expected) {
		context.addIssue({
			code: 'custom',
			path: ['implementationRef'],
			message: `OPERATION_IMPLEMENTATION_IDENTITY_MISMATCH: expected ${expected}`,
		});
	}
}

function assertOperationImplementationIdentityV1(module: OperationModuleSpecV1): void {
	const expected = createOperationImplementationRefV1(module);
	if (module.implementationRef !== expected) {
		throw new OperationModuleRuntimeError(
			'OPERATION_IMPLEMENTATION_IDENTITY_MISMATCH',
			`operation implementationRef must equal ${expected}`,
		);
	}
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
		for (const [index, child] of expression.values.entries()) {
			children.push({ expression: child, path: [...path, 'values', index] });
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
		const complexity = inspectExpression(child.expression, parameterRefs, context, child.path);
		depth = Math.max(depth, complexity.depth + 1);
		nodes += complexity.nodes;
	}
	return { depth, nodes };
}

// Pascal-case aliases are the same schema instances, not parallel contracts.
export const OperationExpressionV1Schema = operationExpressionV1Schema;
export const OperationModuleSpecV1Schema = operationModuleSpecV1Schema;
export const OperationModuleCatalogV1Schema = operationModuleCatalogV1Schema;
export const OperationBlockDescriptorV1Schema = operationBlockDescriptorV1Schema;
