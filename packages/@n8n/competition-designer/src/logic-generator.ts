import { compileBlocklyWorkspace, serializeBlocklyDataPayload } from '@n8n/blockly-data-transform';
import { z } from 'zod';

import { stableReference } from './contracts';
import { stableCompetitionId } from './stable-ids';

const safePath = z
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
		'path contains an empty or forbidden segment',
	);

const safeObjectKey = z
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

const teachingAnnotationSchema = z
	.object({
		what: z.string().trim().min(1).max(1000),
		why: z.string().trim().min(1).max(1000),
		editable: z.array(z.string().trim().min(1).max(1000)).max(32),
		expectedEffect: z.string().trim().min(1).max(1000),
	})
	.strict();

export type BlocklyLogicExpressionDraft =
	| { kind: 'input'; path: string }
	| { kind: 'getPath'; value: BlocklyLogicExpressionDraft; path: string }
	| {
			kind: 'convert';
			to: 'text' | 'number' | 'boolean';
			value: BlocklyLogicExpressionDraft;
	  }
	| { kind: 'array'; values: BlocklyLogicExpressionDraft[] }
	| { kind: 'arrayLength'; array: BlocklyLogicExpressionDraft }
	| {
			kind: 'arrayAt';
			array: BlocklyLogicExpressionDraft;
			index: BlocklyLogicExpressionDraft;
	  }
	| { kind: 'arrayMapPath'; array: BlocklyLogicExpressionDraft; path: string }
	| {
			kind: 'arrayFilterPath';
			array: BlocklyLogicExpressionDraft;
			path: string;
			op: 'eq' | 'neq' | 'lt' | 'lte' | 'gt' | 'gte';
			value: BlocklyLogicExpressionDraft;
	  }
	| {
			kind: 'object';
			properties: Array<{ key: string; value: BlocklyLogicExpressionDraft }>;
	  }
	| { kind: 'number'; value: number }
	| { kind: 'text'; value: string }
	| { kind: 'boolean'; value: boolean }
	| {
			kind: 'arithmetic';
			op: 'add' | 'subtract' | 'multiply' | 'divide' | 'power';
			left: BlocklyLogicExpressionDraft;
			right: BlocklyLogicExpressionDraft;
	  }
	| {
			kind: 'compare';
			op: 'eq' | 'neq' | 'lt' | 'lte' | 'gt' | 'gte';
			left: BlocklyLogicExpressionDraft;
			right: BlocklyLogicExpressionDraft;
	  }
	| {
			kind: 'booleanOperation';
			op: 'and' | 'or';
			left: BlocklyLogicExpressionDraft;
			right: BlocklyLogicExpressionDraft;
	  }
	| { kind: 'not'; value: BlocklyLogicExpressionDraft }
	| {
			kind: 'conditional';
			condition: BlocklyLogicExpressionDraft;
			whenTrue: BlocklyLogicExpressionDraft;
			whenFalse: BlocklyLogicExpressionDraft;
	  }
	| { kind: 'join'; values: BlocklyLogicExpressionDraft[] };

const blocklyLogicExpressionSchema: z.ZodType<BlocklyLogicExpressionDraft> = z.lazy(() =>
	z.discriminatedUnion('kind', [
		z.object({ kind: z.literal('input'), path: safePath }).strict(),
		z
			.object({ kind: z.literal('getPath'), value: blocklyLogicExpressionSchema, path: safePath })
			.strict(),
		z
			.object({
				kind: z.literal('convert'),
				to: z.enum(['text', 'number', 'boolean']),
				value: blocklyLogicExpressionSchema,
			})
			.strict(),
		z
			.object({
				kind: z.literal('array'),
				values: z.array(blocklyLogicExpressionSchema).max(32),
			})
			.strict(),
		z.object({ kind: z.literal('arrayLength'), array: blocklyLogicExpressionSchema }).strict(),
		z
			.object({
				kind: z.literal('arrayAt'),
				array: blocklyLogicExpressionSchema,
				index: blocklyLogicExpressionSchema,
			})
			.strict(),
		z
			.object({
				kind: z.literal('arrayMapPath'),
				array: blocklyLogicExpressionSchema,
				path: safePath,
			})
			.strict(),
		z
			.object({
				kind: z.literal('arrayFilterPath'),
				array: blocklyLogicExpressionSchema,
				path: safePath,
				op: z.enum(['eq', 'neq', 'lt', 'lte', 'gt', 'gte']),
				value: blocklyLogicExpressionSchema,
			})
			.strict(),
		z
			.object({
				kind: z.literal('object'),
				properties: z
					.array(z.object({ key: safeObjectKey, value: blocklyLogicExpressionSchema }).strict())
					.max(32),
			})
			.strict(),
		z.object({ kind: z.literal('number'), value: z.number().finite() }).strict(),
		z.object({ kind: z.literal('text'), value: z.string().max(1000) }).strict(),
		z.object({ kind: z.literal('boolean'), value: z.boolean() }).strict(),
		z
			.object({
				kind: z.literal('arithmetic'),
				op: z.enum(['add', 'subtract', 'multiply', 'divide', 'power']),
				left: blocklyLogicExpressionSchema,
				right: blocklyLogicExpressionSchema,
			})
			.strict(),
		z
			.object({
				kind: z.literal('compare'),
				op: z.enum(['eq', 'neq', 'lt', 'lte', 'gt', 'gte']),
				left: blocklyLogicExpressionSchema,
				right: blocklyLogicExpressionSchema,
			})
			.strict(),
		z
			.object({
				kind: z.literal('booleanOperation'),
				op: z.enum(['and', 'or']),
				left: blocklyLogicExpressionSchema,
				right: blocklyLogicExpressionSchema,
			})
			.strict(),
		z.object({ kind: z.literal('not'), value: blocklyLogicExpressionSchema }).strict(),
		z
			.object({
				kind: z.literal('conditional'),
				condition: blocklyLogicExpressionSchema,
				whenTrue: blocklyLogicExpressionSchema,
				whenFalse: blocklyLogicExpressionSchema,
			})
			.strict(),
		z
			.object({
				kind: z.literal('join'),
				values: z.array(blocklyLogicExpressionSchema).min(1).max(32),
			})
			.strict(),
	]),
);

type BlocklyLogicTeachingAnnotation = z.infer<typeof teachingAnnotationSchema>;

export type BlocklyLogicStatementDraft =
	| {
			kind: 'set';
			intentStepId: string;
			targetField: string;
			value: BlocklyLogicExpressionDraft;
			teaching?: BlocklyLogicTeachingAnnotation;
	  }
	| {
			kind: 'delete';
			intentStepId: string;
			targetField: string;
			teaching?: BlocklyLogicTeachingAnnotation;
	  }
	| {
			kind: 'if';
			intentStepId: string;
			condition: BlocklyLogicExpressionDraft;
			then: BlocklyLogicStatementDraft[];
			else: BlocklyLogicStatementDraft[];
			teaching?: BlocklyLogicTeachingAnnotation;
	  }
	| {
			kind: 'assert';
			intentStepId: string;
			condition: BlocklyLogicExpressionDraft;
			message: BlocklyLogicExpressionDraft;
			teaching?: BlocklyLogicTeachingAnnotation;
	  };

const blocklyLogicStatementSchema: z.ZodType<BlocklyLogicStatementDraft> = z.lazy(() =>
	z.discriminatedUnion('kind', [
		z
			.object({
				kind: z.literal('set'),
				intentStepId: stableReference,
				targetField: safePath,
				value: blocklyLogicExpressionSchema,
				teaching: teachingAnnotationSchema.optional(),
			})
			.strict(),
		z
			.object({
				kind: z.literal('delete'),
				intentStepId: stableReference,
				targetField: safePath,
				teaching: teachingAnnotationSchema.optional(),
			})
			.strict(),
		z
			.object({
				kind: z.literal('if'),
				intentStepId: stableReference,
				condition: blocklyLogicExpressionSchema,
				then: z.array(blocklyLogicStatementSchema).max(32),
				else: z.array(blocklyLogicStatementSchema).max(32),
				teaching: teachingAnnotationSchema.optional(),
			})
			.strict(),
		z
			.object({
				kind: z.literal('assert'),
				intentStepId: stableReference,
				condition: blocklyLogicExpressionSchema,
				message: blocklyLogicExpressionSchema,
				teaching: teachingAnnotationSchema.optional(),
			})
			.strict(),
	]),
);

export const blocklyLogicNodeDraftSchema = z
	.object({
		nodeRef: stableReference,
		label: z.string().trim().min(1).max(128),
		outputMode: z.enum(['copyInput', 'empty']),
		statements: z.array(blocklyLogicStatementSchema).min(1).max(64),
	})
	.strict()
	.superRefine((node, context) => {
		const intentIds = new Set<string>();
		for (const [index, statement] of flattenStatements(node.statements).entries()) {
			if (intentIds.has(statement.intentStepId)) {
				context.addIssue({
					code: 'custom',
					path: ['statements', index, 'intentStepId'],
					message: `duplicate intentStepId "${statement.intentStepId}"`,
				});
			}
			intentIds.add(statement.intentStepId);
			if (statement.kind === 'if' && statement.then.length === 0 && statement.else.length === 0) {
				context.addIssue({
					code: 'custom',
					path: ['statements', index],
					message: 'if statement requires a then or else branch',
				});
			}
			for (const expression of statementExpressions(statement)) {
				validateObjectKeys(expression, context, ['statements', index]);
			}
		}
	});

export type BlocklyLogicNodeDraft = z.infer<typeof blocklyLogicNodeDraftSchema>;

export type BlocklyLogicSourceMapEntry = {
	logicNodeRef: string;
	intentStepId: string;
	blockId: string;
	statementKind: BlocklyLogicStatementDraft['kind'];
	targetField?: string;
};

export type GeneratedBlocklyLogicNode = {
	nodeRef: string;
	label: string;
	workspace: Record<string, unknown>;
	blocklyPayload: string;
	javascript: string;
	sourceMap: BlocklyLogicSourceMapEntry[];
};

export type BlocklyLogicGenerationError = {
	code: 'LOGIC_DRAFT_INVALID' | 'LOGIC_WORKSPACE_COMPILE_FAILED';
	path: string;
	message: string;
};

export type BlocklyLogicGenerationResult =
	| { ok: true; generated: GeneratedBlocklyLogicNode; normalizedDraft: BlocklyLogicNodeDraft }
	| { ok: false; error: BlocklyLogicGenerationError };

type BlocklyBlock = Record<string, unknown> & { type: string; id: string };

export function generateBlocklyLogicNode(
	draftInput: unknown,
	designId: string,
): BlocklyLogicGenerationResult {
	const parsed = blocklyLogicNodeDraftSchema.safeParse(draftInput);
	if (!parsed.success) {
		const issue = parsed.error.issues[0];
		return {
			ok: false,
			error: {
				code: 'LOGIC_DRAFT_INVALID',
				path: issue?.path.join('.') ?? 'logicNode',
				message: issue?.message ?? 'Blockly Logic draft is invalid',
			},
		};
	}

	const workspace = createWorkspace(parsed.data, designId);
	const compiled = compileBlocklyWorkspace(workspace);
	if (!compiled.ok) {
		return {
			ok: false,
			error: {
				code: 'LOGIC_WORKSPACE_COMPILE_FAILED',
				path: `logicNodes.${parsed.data.nodeRef}`,
				message: compiled.error,
			},
		};
	}
	return {
		ok: true,
		generated: {
			nodeRef: parsed.data.nodeRef,
			label: parsed.data.label,
			workspace,
			blocklyPayload: serializeBlocklyDataPayload(workspace),
			javascript: compiled.javascript,
			sourceMap: flattenStatements(parsed.data.statements).map((statement) => {
				const entry: BlocklyLogicSourceMapEntry = {
					logicNodeRef: parsed.data.nodeRef,
					intentStepId: statement.intentStepId,
					blockId: statementBlockId(designId, parsed.data.nodeRef, statement.intentStepId),
					statementKind: statement.kind,
				};
				if (statement.kind === 'set' || statement.kind === 'delete') {
					entry.targetField = statement.targetField;
				}
				return entry;
			}),
		},
		normalizedDraft: parsed.data,
	};
}

function createWorkspace(draft: BlocklyLogicNodeDraft, designId: string): Record<string, unknown> {
	const head = statementChain(draft.statements, designId, draft.nodeRef);
	if (head === undefined) throw new Error('validated Blockly Logic node has no statements');

	const root: BlocklyBlock = {
		type: 'n8n_transform_item',
		id: logicBlockId(designId, draft.nodeRef, 'root'),
		x: 24,
		y: 24,
		fields: { MODE: draft.outputMode === 'copyInput' ? 'COPY' : 'EMPTY' },
		inputs: { STATEMENTS: { block: head } },
	};
	return { blocks: { languageVersion: 0, blocks: [root] } };
}

function statementChain(
	statements: BlocklyLogicStatementDraft[],
	designId: string,
	nodeRef: string,
): BlocklyBlock | undefined {
	let head: BlocklyBlock | undefined;
	for (const statement of [...statements].reverse()) {
		const block = statementBlock(statement, designId, nodeRef);
		if (head !== undefined) block.next = { block: head };
		head = block;
	}
	return head;
}

function statementBlock(
	statement: BlocklyLogicStatementDraft,
	designId: string,
	nodeRef: string,
): BlocklyBlock {
	const id = statementBlockId(designId, nodeRef, statement.intentStepId);
	const data = serializeStatementData(statement);
	const expression = (value: BlocklyLogicExpressionDraft, localPath: string) => ({
		block: expressionBlock(value, designId, nodeRef, statement.intentStepId, localPath),
	});
	switch (statement.kind) {
		case 'set':
			return {
				type: 'n8n_set_field',
				id,
				data,
				fields: { KEY: statement.targetField },
				inputs: { VALUE: expression(statement.value, 'value') },
			};
		case 'delete':
			return { type: 'n8n_delete_field', id, data, fields: { KEY: statement.targetField } };
		case 'if': {
			const thenBranch = statementChain(statement.then, designId, nodeRef);
			const elseBranch = statementChain(statement.else, designId, nodeRef);
			return {
				type: 'n8n_if',
				id,
				data,
				inputs: {
					CONDITION: expression(statement.condition, 'condition'),
					...(thenBranch === undefined ? {} : { THEN: { block: thenBranch } }),
					...(elseBranch === undefined ? {} : { ELSE: { block: elseBranch } }),
				},
			};
		}
		case 'assert':
			return {
				type: 'n8n_assert',
				id,
				data,
				inputs: {
					CONDITION: expression(statement.condition, 'condition'),
					MESSAGE: expression(statement.message, 'message'),
				},
			};
	}
}

function serializeStatementData(statement: BlocklyLogicStatementDraft): string {
	return JSON.stringify({
		intentStepId: statement.intentStepId,
		...(statement.teaching === undefined ? {} : { teaching: statement.teaching }),
	});
}

function expressionBlock(
	expression: BlocklyLogicExpressionDraft,
	designId: string,
	nodeRef: string,
	intentStepId: string,
	path: string,
): BlocklyBlock {
	const id = logicBlockId(designId, nodeRef, `${intentStepId}:${path}`);
	const child = (value: BlocklyLogicExpressionDraft, localPath: string) => ({
		block: expressionBlock(value, designId, nodeRef, intentStepId, `${path}:${localPath}`),
	});
	switch (expression.kind) {
		case 'input':
			return { type: 'n8n_get_field', id, fields: { PATH: expression.path } };
		case 'getPath':
			return {
				type: 'n8n_get_path',
				id,
				fields: { PATH: expression.path },
				inputs: { VALUE: child(expression.value, 'value') },
			};
		case 'convert':
			return {
				type: 'n8n_convert',
				id,
				fields: { TYPE: blocklyConversionType(expression.to) },
				inputs: { VALUE: child(expression.value, 'value') },
			};
		case 'array':
			return {
				type: 'lists_create_with',
				id,
				extraState: { itemCount: expression.values.length },
				inputs: Object.fromEntries(
					expression.values.map((value, index) => [`ADD${index}`, child(value, `values:${index}`)]),
				),
			};
		case 'arrayLength':
			return {
				type: 'lists_length',
				id,
				inputs: { VALUE: child(expression.array, 'array') },
			};
		case 'arrayAt':
			return {
				type: 'n8n_array_at',
				id,
				inputs: {
					ARRAY: child(expression.array, 'array'),
					INDEX: child(expression.index, 'index'),
				},
			};
		case 'arrayMapPath':
			return {
				type: 'n8n_array_map_path',
				id,
				fields: { PATH: expression.path },
				inputs: { ARRAY: child(expression.array, 'array') },
			};
		case 'arrayFilterPath':
			return {
				type: 'n8n_array_filter_path',
				id,
				fields: { PATH: expression.path, OP: comparisonOperator[expression.op] },
				inputs: {
					ARRAY: child(expression.array, 'array'),
					VALUE: child(expression.value, 'value'),
				},
			};
		case 'object':
			return {
				type: 'n8n_object_create',
				id,
				inputs:
					expression.properties.length === 0
						? {}
						: {
								PROPERTIES: {
									block: objectPropertyChain(
										expression.properties,
										designId,
										nodeRef,
										intentStepId,
										path,
									),
								},
							},
			};
		case 'number':
			return { type: 'math_number', id, fields: { NUM: expression.value } };
		case 'text':
			return { type: 'text', id, fields: { TEXT: expression.value } };
		case 'boolean':
			return {
				type: 'logic_boolean',
				id,
				fields: { BOOL: expression.value ? 'TRUE' : 'FALSE' },
			};
		case 'arithmetic':
			return {
				type: 'math_arithmetic',
				id,
				fields: { OP: arithmeticOperator[expression.op] },
				inputs: { A: child(expression.left, 'left'), B: child(expression.right, 'right') },
			};
		case 'compare':
			return {
				type: 'logic_compare',
				id,
				fields: { OP: comparisonOperator[expression.op] },
				inputs: { A: child(expression.left, 'left'), B: child(expression.right, 'right') },
			};
		case 'booleanOperation':
			return {
				type: 'logic_operation',
				id,
				fields: { OP: expression.op === 'and' ? 'AND' : 'OR' },
				inputs: { A: child(expression.left, 'left'), B: child(expression.right, 'right') },
			};
		case 'not':
			return { type: 'logic_negate', id, inputs: { BOOL: child(expression.value, 'value') } };
		case 'conditional':
			return {
				type: 'logic_ternary',
				id,
				inputs: {
					IF: child(expression.condition, 'condition'),
					THEN: child(expression.whenTrue, 'whenTrue'),
					ELSE: child(expression.whenFalse, 'whenFalse'),
				},
			};
		case 'join':
			return {
				type: 'text_join',
				id,
				extraState: { itemCount: expression.values.length },
				inputs: Object.fromEntries(
					expression.values.map((value, index) => [`ADD${index}`, child(value, `values:${index}`)]),
				),
			};
	}
}

function objectPropertyChain(
	properties: Array<{ key: string; value: BlocklyLogicExpressionDraft }>,
	designId: string,
	nodeRef: string,
	intentStepId: string,
	path: string,
): BlocklyBlock {
	let head: BlocklyBlock | undefined;
	for (const property of [...properties].reverse()) {
		const propertyPath = `${path}:properties:${property.key}`;
		const block: BlocklyBlock = {
			type: 'n8n_object_property',
			id: logicBlockId(designId, nodeRef, `${intentStepId}:${propertyPath}`),
			fields: { KEY: property.key },
			inputs: {
				VALUE: {
					block: expressionBlock(
						property.value,
						designId,
						nodeRef,
						intentStepId,
						`${path}:properties:${property.key}:value`,
					),
				},
			},
		};
		if (head !== undefined) block.next = { block: head };
		head = block;
	}
	if (head === undefined) throw new Error('object property chain is empty');
	return head;
}

const arithmeticOperator = {
	add: 'ADD',
	subtract: 'SUBTRACT',
	multiply: 'MULTIPLY',
	divide: 'DIVIDE',
	power: 'POWER',
} as const;

const comparisonOperator = {
	eq: 'EQ',
	neq: 'NEQ',
	lt: 'LT',
	lte: 'LTE',
	gt: 'GT',
	gte: 'GTE',
} as const;

function blocklyConversionType(value: 'text' | 'number' | 'boolean'): string {
	if (value === 'text') return 'TEXT';
	if (value === 'number') return 'NUMBER';
	return 'BOOLEAN';
}

function flattenStatements(statements: BlocklyLogicStatementDraft[]): BlocklyLogicStatementDraft[] {
	return statements.flatMap((statement) =>
		statement.kind === 'if'
			? [statement, ...flattenStatements(statement.then), ...flattenStatements(statement.else)]
			: [statement],
	);
}

function statementExpressions(
	statement: BlocklyLogicStatementDraft,
): BlocklyLogicExpressionDraft[] {
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
	expression: BlocklyLogicExpressionDraft,
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
			validateObjectKeys(property.value, context, [...path, 'properties', index, 'value']);
		}
		return;
	}
	for (const [index, child] of expressionChildren(expression).entries()) {
		validateObjectKeys(child, context, [...path, index]);
	}
}

function expressionChildren(
	expression: BlocklyLogicExpressionDraft,
): BlocklyLogicExpressionDraft[] {
	switch (expression.kind) {
		case 'input':
		case 'number':
		case 'text':
		case 'boolean':
			return [];
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

function statementBlockId(designId: string, nodeRef: string, intentStepId: string): string {
	return logicBlockId(designId, nodeRef, `statement:${intentStepId}`);
}

function logicBlockId(designId: string, nodeRef: string, localRef: string): string {
	return `logic-${stableCompetitionId(designId, `${nodeRef}:${localRef}`)}`;
}
