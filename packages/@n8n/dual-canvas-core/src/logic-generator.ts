import { compileBlocklyWorkspace, serializeBlocklyDataPayload } from '@n8n/blockly-data-transform';

import { createLogicStatementBlockRef } from './logic-block-refs';
import {
	flattenLogicStatements,
	logicNodeDraftV1Schema,
	type LogicExpressionV1,
	type LogicNodeDraftV1,
	type LogicStatementV1,
} from './logic-ir';
import type { SourceMapEntryV1 } from './mapping';
import { stableReferenceSchema } from './primitives';
import { createStableId } from './stable-ids';

export type GeneratedLogicCanvasV1 = {
	nodeRef: string;
	label: string;
	workspace: Record<string, unknown>;
	blocklyPayload: string;
	javascript: string;
	blockRefs: string[];
	sourceMap: SourceMapEntryV1[];
};

export type LogicCanvasGenerationErrorV1 = {
	code: 'LOGIC_SCOPE_INVALID' | 'LOGIC_DRAFT_INVALID' | 'LOGIC_WORKSPACE_COMPILE_FAILED';
	path: string;
	message: string;
};

export type LogicCanvasGenerationResultV1 =
	| { ok: true; generated: GeneratedLogicCanvasV1; normalizedDraft: LogicNodeDraftV1 }
	| { ok: false; error: LogicCanvasGenerationErrorV1 };

type BlocklyBlock = Record<string, unknown> & { type: string; id: string };

export function generateLogicCanvas(
	draftInput: unknown,
	documentRef: string,
): LogicCanvasGenerationResultV1 {
	const parsedDocumentRef = stableReferenceSchema.safeParse(documentRef);
	if (!parsedDocumentRef.success) {
		return {
			ok: false,
			error: {
				code: 'LOGIC_SCOPE_INVALID',
				path: 'documentRef',
				message: parsedDocumentRef.error.issues[0]?.message ?? 'documentRef is invalid',
			},
		};
	}
	const parsed = logicNodeDraftV1Schema.safeParse(draftInput);
	if (!parsed.success) {
		const issue = parsed.error.issues[0];
		return {
			ok: false,
			error: {
				code: 'LOGIC_DRAFT_INVALID',
				path: issue?.path.join('.') ?? 'logicNode',
				message: issue?.message ?? 'logic draft is invalid',
			},
		};
	}

	const workspace = createWorkspace(parsed.data, documentRef);
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
			blockRefs: collectBlockRefs(workspace),
			sourceMap: flattenLogicStatements(parsed.data.statements).map((statement) => {
				const blockRef = createLogicStatementBlockRef(
					documentRef,
					parsed.data.nodeRef,
					statement.stepRef,
				);
				const context = {
					nodeRef: parsed.data.nodeRef,
					statementKind: statement.kind,
					...(statement.kind === 'set' || statement.kind === 'delete'
						? { targetField: statement.targetField }
						: {}),
				};
				const entry: SourceMapEntryV1 = {
					apiVersion: 1,
					mappingRef: `mapping-${createStableId(
						documentRef,
						`mapping:${parsed.data.nodeRef}:${statement.stepRef}`,
					)}`,
					semanticRef: statement.stepRef,
					artifact: { kind: 'canvasBlock', ref: blockRef },
					...(statement.source === undefined ? {} : { source: statement.source }),
					context,
				};
				return entry;
			}),
		},
		normalizedDraft: parsed.data,
	};
}

function collectBlockRefs(value: unknown): string[] {
	const refs: string[] = [];
	const seen = new Set<string>();
	const visit = (candidate: unknown): void => {
		if (Array.isArray(candidate)) {
			for (const item of candidate) visit(item);
			return;
		}
		if (candidate === null || typeof candidate !== 'object') return;
		const record = candidate as Record<string, unknown>;
		if (typeof record.type === 'string' && typeof record.id === 'string' && !seen.has(record.id)) {
			seen.add(record.id);
			refs.push(record.id);
		}
		for (const child of Object.values(record)) visit(child);
	};
	visit(value);
	return refs;
}

function createWorkspace(draft: LogicNodeDraftV1, documentRef: string): Record<string, unknown> {
	const head = statementChain(draft.statements, documentRef, draft.nodeRef);
	if (head === undefined) throw new Error('validated Blockly Logic node has no statements');

	const root: BlocklyBlock = {
		type: 'n8n_transform_item',
		id: logicBlockId(documentRef, draft.nodeRef, 'root'),
		x: 24,
		y: 24,
		fields: { MODE: draft.outputMode === 'copyInput' ? 'COPY' : 'EMPTY' },
		inputs: { STATEMENTS: { block: head } },
	};
	return { blocks: { languageVersion: 0, blocks: [root] } };
}

function statementChain(
	statements: LogicStatementV1[],
	documentRef: string,
	nodeRef: string,
): BlocklyBlock | undefined {
	let head: BlocklyBlock | undefined;
	for (const statement of [...statements].reverse()) {
		const block = statementBlock(statement, documentRef, nodeRef);
		if (head !== undefined) block.next = { block: head };
		head = block;
	}
	return head;
}

function statementBlock(
	statement: LogicStatementV1,
	documentRef: string,
	nodeRef: string,
): BlocklyBlock {
	const id = createLogicStatementBlockRef(documentRef, nodeRef, statement.stepRef);
	const data = serializeStatementData(statement);
	const expression = (value: LogicExpressionV1, localPath: string) => ({
		block: expressionBlock(value, documentRef, nodeRef, statement.stepRef, localPath),
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
			const thenBranch = statementChain(statement.then, documentRef, nodeRef);
			const elseBranch = statementChain(statement.else, documentRef, nodeRef);
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

function serializeStatementData(statement: LogicStatementV1): string {
	return JSON.stringify({
		stepRef: statement.stepRef,
		...(statement.teaching === undefined ? {} : { teaching: statement.teaching }),
		...(statement.source === undefined ? {} : { source: statement.source }),
	});
}

function expressionBlock(
	expression: LogicExpressionV1,
	documentRef: string,
	nodeRef: string,
	stepRef: string,
	path: string,
): BlocklyBlock {
	const id = logicBlockId(documentRef, nodeRef, `${stepRef}:${path}`);
	const child = (value: LogicExpressionV1, localPath: string) => ({
		block: expressionBlock(value, documentRef, nodeRef, stepRef, `${path}:${localPath}`),
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
										documentRef,
										nodeRef,
										stepRef,
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
	properties: Array<{ key: string; value: LogicExpressionV1 }>,
	documentRef: string,
	nodeRef: string,
	stepRef: string,
	path: string,
): BlocklyBlock {
	let head: BlocklyBlock | undefined;
	for (const property of [...properties].reverse()) {
		const propertyPath = `${path}:properties:${property.key}`;
		const block: BlocklyBlock = {
			type: 'n8n_object_property',
			id: logicBlockId(documentRef, nodeRef, `${stepRef}:${propertyPath}`),
			fields: { KEY: property.key },
			inputs: {
				VALUE: {
					block: expressionBlock(
						property.value,
						documentRef,
						nodeRef,
						stepRef,
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

function logicBlockId(documentRef: string, nodeRef: string, localRef: string): string {
	return `logic-${createStableId(documentRef, `${nodeRef}:${localRef}`)}`;
}
