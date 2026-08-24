import {
	operationImplementationReferenceV1Schema,
	operationModuleVersionV1Schema,
	operationQualifiedNameSchema,
} from '@n8n/dual-canvas-operation-runtime';
import { z } from 'zod';

import { sourceSpanV1Schema } from './mapping';
import { stableReferenceSchema } from './primitives';

const safePathSchema = z
	.string()
	.min(1)
	.max(128)
	.refine(
		(value) =>
			value
				.split('.')
				.every(
					(segment) =>
						segment.length > 0 &&
						segment !== '__proto__' &&
						segment !== 'prototype' &&
						segment !== 'constructor',
				),
		'path contains an empty or reserved segment',
	);

const safeObjectKeySchema = z
	.string()
	.min(1)
	.max(128)
	.refine(
		(value) =>
			!value.includes('.') &&
			value !== '__proto__' &&
			value !== 'prototype' &&
			value !== 'constructor',
		'object key must be one safe path segment',
	);

export const teachingAnnotationV1Schema = z
	.object({
		what: z.string().trim().min(1).max(1000),
		why: z.string().trim().min(1).max(1000),
		editable: z.array(z.string().trim().min(1).max(1000)).max(32),
		expectedEffect: z.string().trim().min(1).max(1000),
	})
	.strict();

export type LogicExpressionV1 =
	| { kind: 'input'; path: string }
	| { kind: 'getPath'; value: LogicExpressionV1; path: string }
	| { kind: 'convert'; to: 'text' | 'number' | 'boolean'; value: LogicExpressionV1 }
	| { kind: 'array'; values: LogicExpressionV1[] }
	| { kind: 'arrayLength'; array: LogicExpressionV1 }
	| { kind: 'arrayAt'; array: LogicExpressionV1; index: LogicExpressionV1 }
	| { kind: 'arrayMapPath'; array: LogicExpressionV1; path: string }
	| {
			kind: 'arrayFilterPath';
			array: LogicExpressionV1;
			path: string;
			op: 'eq' | 'neq' | 'lt' | 'lte' | 'gt' | 'gte';
			value: LogicExpressionV1;
	  }
	| { kind: 'object'; properties: Array<{ key: string; value: LogicExpressionV1 }> }
	| { kind: 'number'; value: number }
	| { kind: 'text'; value: string }
	| { kind: 'boolean'; value: boolean }
	| {
			kind: 'operationCall';
			callRef: string;
			operationRef: string;
			implementationRef: string;
			qualifiedName: string;
			version: '1.0.0';
			arguments: LogicExpressionV1[];
			source: z.infer<typeof sourceSpanV1Schema>;
	  }
	| {
			kind: 'arithmetic';
			op: 'add' | 'subtract' | 'multiply' | 'divide' | 'power';
			left: LogicExpressionV1;
			right: LogicExpressionV1;
	  }
	| {
			kind: 'compare';
			op: 'eq' | 'neq' | 'lt' | 'lte' | 'gt' | 'gte';
			left: LogicExpressionV1;
			right: LogicExpressionV1;
	  }
	| {
			kind: 'booleanOperation';
			op: 'and' | 'or';
			left: LogicExpressionV1;
			right: LogicExpressionV1;
	  }
	| { kind: 'not'; value: LogicExpressionV1 }
	| {
			kind: 'conditional';
			condition: LogicExpressionV1;
			whenTrue: LogicExpressionV1;
			whenFalse: LogicExpressionV1;
	  }
	| { kind: 'join'; values: LogicExpressionV1[] };

export const logicExpressionV1Schema: z.ZodType<LogicExpressionV1> = z.lazy(() =>
	z.discriminatedUnion('kind', [
		z.object({ kind: z.literal('input'), path: safePathSchema }).strict(),
		z
			.object({ kind: z.literal('getPath'), value: logicExpressionV1Schema, path: safePathSchema })
			.strict(),
		z
			.object({
				kind: z.literal('convert'),
				to: z.enum(['text', 'number', 'boolean']),
				value: logicExpressionV1Schema,
			})
			.strict(),
		z
			.object({ kind: z.literal('array'), values: z.array(logicExpressionV1Schema).max(32) })
			.strict(),
		z.object({ kind: z.literal('arrayLength'), array: logicExpressionV1Schema }).strict(),
		z
			.object({
				kind: z.literal('arrayAt'),
				array: logicExpressionV1Schema,
				index: logicExpressionV1Schema,
			})
			.strict(),
		z
			.object({
				kind: z.literal('arrayMapPath'),
				array: logicExpressionV1Schema,
				path: safePathSchema,
			})
			.strict(),
		z
			.object({
				kind: z.literal('arrayFilterPath'),
				array: logicExpressionV1Schema,
				path: safePathSchema,
				op: z.enum(['eq', 'neq', 'lt', 'lte', 'gt', 'gte']),
				value: logicExpressionV1Schema,
			})
			.strict(),
		z
			.object({
				kind: z.literal('object'),
				properties: z
					.array(z.object({ key: safeObjectKeySchema, value: logicExpressionV1Schema }).strict())
					.max(32),
			})
			.strict(),
		z.object({ kind: z.literal('number'), value: z.number().finite() }).strict(),
		z.object({ kind: z.literal('text'), value: z.string().max(1000) }).strict(),
		z.object({ kind: z.literal('boolean'), value: z.boolean() }).strict(),
		z
			.object({
				kind: z.literal('operationCall'),
				callRef: stableReferenceSchema,
				operationRef: stableReferenceSchema,
				implementationRef: operationImplementationReferenceV1Schema,
				qualifiedName: operationQualifiedNameSchema,
				version: operationModuleVersionV1Schema,
				arguments: z.array(logicExpressionV1Schema).max(16),
				source: sourceSpanV1Schema,
			})
			.strict(),
		z
			.object({
				kind: z.literal('arithmetic'),
				op: z.enum(['add', 'subtract', 'multiply', 'divide', 'power']),
				left: logicExpressionV1Schema,
				right: logicExpressionV1Schema,
			})
			.strict(),
		z
			.object({
				kind: z.literal('compare'),
				op: z.enum(['eq', 'neq', 'lt', 'lte', 'gt', 'gte']),
				left: logicExpressionV1Schema,
				right: logicExpressionV1Schema,
			})
			.strict(),
		z
			.object({
				kind: z.literal('booleanOperation'),
				op: z.enum(['and', 'or']),
				left: logicExpressionV1Schema,
				right: logicExpressionV1Schema,
			})
			.strict(),
		z.object({ kind: z.literal('not'), value: logicExpressionV1Schema }).strict(),
		z
			.object({
				kind: z.literal('conditional'),
				condition: logicExpressionV1Schema,
				whenTrue: logicExpressionV1Schema,
				whenFalse: logicExpressionV1Schema,
			})
			.strict(),
		z
			.object({
				kind: z.literal('join'),
				values: z.array(logicExpressionV1Schema).min(1).max(32),
			})
			.strict(),
	]),
);

export type TeachingAnnotationV1 = z.infer<typeof teachingAnnotationV1Schema>;

type LogicStatementBaseV1 = {
	stepRef: string;
	teaching?: TeachingAnnotationV1;
	source?: z.infer<typeof sourceSpanV1Schema>;
};

export type LogicStatementV1 = LogicStatementBaseV1 &
	(
		| { kind: 'set'; targetField: string; value: LogicExpressionV1 }
		| { kind: 'delete'; targetField: string }
		| {
				kind: 'if';
				condition: LogicExpressionV1;
				then: LogicStatementV1[];
				else: LogicStatementV1[];
		  }
		| { kind: 'assert'; condition: LogicExpressionV1; message: LogicExpressionV1 }
	);

const logicStatementBaseShape = {
	stepRef: stableReferenceSchema,
	teaching: teachingAnnotationV1Schema.optional(),
	source: sourceSpanV1Schema.optional(),
};

export const logicStatementV1Schema: z.ZodType<LogicStatementV1> = z.lazy(() =>
	z.discriminatedUnion('kind', [
		z
			.object({
				kind: z.literal('set'),
				...logicStatementBaseShape,
				targetField: safePathSchema,
				value: logicExpressionV1Schema,
			})
			.strict(),
		z
			.object({
				kind: z.literal('delete'),
				...logicStatementBaseShape,
				targetField: safePathSchema,
			})
			.strict(),
		z
			.object({
				kind: z.literal('if'),
				...logicStatementBaseShape,
				condition: logicExpressionV1Schema,
				then: z.array(logicStatementV1Schema).max(32),
				else: z.array(logicStatementV1Schema).max(32),
			})
			.strict(),
		z
			.object({
				kind: z.literal('assert'),
				...logicStatementBaseShape,
				condition: logicExpressionV1Schema,
				message: logicExpressionV1Schema,
			})
			.strict(),
	]),
);

export const logicNodeDraftV1Schema = z
	.object({
		nodeRef: stableReferenceSchema,
		label: z.string().trim().min(1).max(128),
		outputMode: z.enum(['copyInput', 'empty']),
		statements: z.array(logicStatementV1Schema).min(1).max(64),
	})
	.strict()
	.superRefine((node, context) => {
		const stepRefs = new Set<string>();
		for (const [index, statement] of flattenLogicStatements(node.statements).entries()) {
			if (stepRefs.has(statement.stepRef)) {
				context.addIssue({
					code: 'custom',
					path: ['statements', index, 'stepRef'],
					message: `duplicate stepRef "${statement.stepRef}"`,
				});
			}
			stepRefs.add(statement.stepRef);
			if (statement.kind === 'if' && statement.then.length === 0 && statement.else.length === 0) {
				context.addIssue({
					code: 'custom',
					path: ['statements', index],
					message: 'if statement requires a then or else branch',
				});
			}
			for (const expression of logicStatementExpressions(statement)) {
				validateObjectKeys(expression, context, ['statements', index]);
			}
		}
		const operationCallRefs = new Set<string>();
		for (const [index, { expression }] of flattenLogicOperationCalls(node.statements).entries()) {
			if (operationCallRefs.has(expression.callRef) || stepRefs.has(expression.callRef)) {
				context.addIssue({
					code: 'custom',
					path: ['statements', index, 'callRef'],
					message: `duplicate logic semantic reference "${expression.callRef}"`,
				});
			}
			operationCallRefs.add(expression.callRef);
		}
	});

export type LogicNodeDraftV1 = z.infer<typeof logicNodeDraftV1Schema>;

export function flattenLogicStatements(statements: LogicStatementV1[]): LogicStatementV1[] {
	return statements.flatMap((statement) =>
		statement.kind === 'if'
			? [
					statement,
					...flattenLogicStatements(statement.then),
					...flattenLogicStatements(statement.else),
				]
			: [statement],
	);
}

export type LogicOperationCallV1 = Extract<LogicExpressionV1, { kind: 'operationCall' }>;

export type LogicOperationCallLocationV1 = {
	expression: LogicOperationCallV1;
	stepRef: string;
	path: string;
};

export function flattenLogicOperationCalls(
	statements: LogicStatementV1[],
): LogicOperationCallLocationV1[] {
	return flattenLogicStatements(statements).flatMap((statement) => {
		switch (statement.kind) {
			case 'set':
				return operationCallLocations(statement.value, statement.stepRef, 'value');
			case 'delete':
				return [];
			case 'if':
				return operationCallLocations(statement.condition, statement.stepRef, 'condition');
			case 'assert':
				return [
					...operationCallLocations(statement.condition, statement.stepRef, 'condition'),
					...operationCallLocations(statement.message, statement.stepRef, 'message'),
				];
		}
	});
}

function operationCallLocations(
	expression: LogicExpressionV1,
	stepRef: string,
	path: string,
): LogicOperationCallLocationV1[] {
	const current: LogicOperationCallLocationV1[] =
		expression.kind === 'operationCall' ? [{ expression, stepRef, path }] : [];
	return [
		...current,
		...expressionChildrenWithPaths(expression).flatMap(({ expression: child, path: childPath }) =>
			operationCallLocations(child, stepRef, `${path}:${childPath}`),
		),
	];
}

function expressionChildrenWithPaths(
	expression: LogicExpressionV1,
): Array<{ expression: LogicExpressionV1; path: string }> {
	switch (expression.kind) {
		case 'input':
		case 'number':
		case 'text':
		case 'boolean':
			return [];
		case 'getPath':
		case 'convert':
		case 'not':
			return [{ expression: expression.value, path: 'value' }];
		case 'array':
		case 'join':
			return expression.values.map((value, index) => ({
				expression: value,
				path: `values:${index}`,
			}));
		case 'arrayLength':
		case 'arrayMapPath':
			return [{ expression: expression.array, path: 'array' }];
		case 'arrayAt':
			return [
				{ expression: expression.array, path: 'array' },
				{ expression: expression.index, path: 'index' },
			];
		case 'arrayFilterPath':
			return [
				{ expression: expression.array, path: 'array' },
				{ expression: expression.value, path: 'value' },
			];
		case 'object':
			return expression.properties.map((property) => ({
				expression: property.value,
				path: `properties:${property.key}:value`,
			}));
		case 'operationCall':
			return expression.arguments.map((argument, index) => ({
				expression: argument,
				path: `arguments:${index}`,
			}));
		case 'arithmetic':
		case 'compare':
		case 'booleanOperation':
			return [
				{ expression: expression.left, path: 'left' },
				{ expression: expression.right, path: 'right' },
			];
		case 'conditional':
			return [
				{ expression: expression.condition, path: 'condition' },
				{ expression: expression.whenTrue, path: 'whenTrue' },
				{ expression: expression.whenFalse, path: 'whenFalse' },
			];
	}
}

function logicStatementExpressions(statement: LogicStatementV1): LogicExpressionV1[] {
	switch (statement.kind) {
		case 'set':
			return [statement.value];
		case 'delete':
			return [];
		case 'if':
			return [statement.condition];
		case 'assert':
			return [statement.condition, statement.message];
	}
}

function validateObjectKeys(
	expression: LogicExpressionV1,
	context: z.RefinementCtx,
	path: Array<string | number>,
): void {
	if (expression.kind === 'object') {
		const keys = new Set<string>();
		for (const [index, property] of expression.properties.entries()) {
			if (keys.has(property.key)) {
				context.addIssue({
					code: 'custom',
					path: [...path, 'properties', index, 'key'],
					message: `duplicate object key "${property.key}"`,
				});
			}
			keys.add(property.key);
		}
	}
	for (const child of childExpressions(expression)) {
		validateObjectKeys(child, context, path);
	}
}

function childExpressions(expression: LogicExpressionV1): LogicExpressionV1[] {
	switch (expression.kind) {
		case 'input':
		case 'number':
		case 'text':
		case 'boolean':
			return [];
		case 'operationCall':
			return expression.arguments;
		case 'getPath':
		case 'convert':
		case 'not':
			return [expression.value];
		case 'array':
		case 'join':
			return expression.values;
		case 'arrayLength':
		case 'arrayMapPath':
			return [expression.array];
		case 'arrayAt':
			return [expression.array, expression.index];
		case 'arrayFilterPath':
			return [expression.array, expression.value];
		case 'object':
			return expression.properties.map((property) => property.value);
		case 'arithmetic':
		case 'compare':
		case 'booleanOperation':
			return [expression.left, expression.right];
		case 'conditional':
			return [expression.condition, expression.whenTrue, expression.whenFalse];
	}
}
