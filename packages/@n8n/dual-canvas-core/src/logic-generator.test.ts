import { compileBlocklyWorkspace, parseBlocklyDataPayload } from '@n8n/blockly-data-transform';
import {
	createOperationBlockTypeV1,
	createOperationModuleCatalogV1,
	finalizeOperationModuleSpecV1,
} from '@n8n/dual-canvas-operation-runtime';
import { describe, expect, it } from 'vitest';

import { generateLogicCanvas } from './logic-generator';
import type { LogicNodeDraftV1 } from './logic-ir';

const emptyOperationCatalog = createOperationModuleCatalogV1({ apiVersion: 1, modules: [] });

const clampOperationCatalog = createOperationModuleCatalogV1({
	apiVersion: 1,
	modules: [
		finalizeOperationModuleSpecV1({
			apiVersion: 1,
			requestRef: 'module-request.clamp-score',
			operationRef: 'operation.clamp-score.v1',
			implementationRef: null,
			qualifiedName: 'clampScore',
			arity: 3,
			version: '1.0.0',
			behaviorSummary: 'Bounds a score between the supplied minimum and maximum.',
			execution: 'synchronous',
			determinism: 'deterministic',
			effects: 'none',
			dataFlow: 'json-to-json',
			parameters: [
				{ parameterRef: 'arg.value', name: 'value', type: 'number', nullPolicy: 'reject' },
				{ parameterRef: 'arg.minimum', name: 'minimum', type: 'number', nullPolicy: 'reject' },
				{ parameterRef: 'arg.maximum', name: 'maximum', type: 'number', nullPolicy: 'reject' },
			],
			output: { type: 'number', nullPolicy: 'reject' },
			expression: {
				kind: 'conditional',
				condition: {
					kind: 'binary',
					operator: 'lt',
					left: { kind: 'parameter', parameterRef: 'arg.value' },
					right: { kind: 'parameter', parameterRef: 'arg.minimum' },
				},
				whenTrue: { kind: 'parameter', parameterRef: 'arg.minimum' },
				whenFalse: {
					kind: 'conditional',
					condition: {
						kind: 'binary',
						operator: 'gt',
						left: { kind: 'parameter', parameterRef: 'arg.value' },
						right: { kind: 'parameter', parameterRef: 'arg.maximum' },
					},
					whenTrue: { kind: 'parameter', parameterRef: 'arg.maximum' },
					whenFalse: { kind: 'parameter', parameterRef: 'arg.value' },
				},
			},
			testVectors: [
				{ name: 'below', arguments: [-5, 0, 100], expected: 0 },
				{ name: 'inside', arguments: [68, 0, 100], expected: 68 },
				{ name: 'above', arguments: [125, 0, 100], expected: 100 },
			],
		}),
	],
});

const clampOperation = clampOperationCatalog.modules[0];
if (clampOperation === undefined) throw new Error('clamp operation fixture is missing');

const draft: LogicNodeDraftV1 = {
	nodeRef: 'prepare.input',
	label: 'Prepare input',
	outputMode: 'copyInput',
	statements: [
		{
			kind: 'set',
			stepRef: 'calculate.total',
			targetField: 'total',
			value: {
				kind: 'arithmetic',
				op: 'multiply',
				left: { kind: 'input', path: 'price' },
				right: { kind: 'number', value: 1.2 },
			},
			teaching: {
				what: 'Calculate the adjusted total',
				why: 'Prepare one stable value for later steps',
				editable: ['multiplier'],
				expectedEffect: 'The output receives a total field',
			},
			source: {
				sourceRef: 'source.main',
				start: { line: 1, column: 0, offset: 0 },
				end: { line: 1, column: 24, offset: 24 },
			},
		},
		{
			kind: 'if',
			stepRef: 'choose.label',
			condition: {
				kind: 'compare',
				op: 'gte',
				left: { kind: 'input', path: 'score' },
				right: { kind: 'number', value: 60 },
			},
			then: [
				{
					kind: 'set',
					stepRef: 'set.label',
					targetField: 'label',
					value: {
						kind: 'join',
						values: [
							{ kind: 'text', value: 'ready-' },
							{ kind: 'convert', to: 'text', value: { kind: 'input', path: 'id' } },
						],
					},
				},
			],
			else: [
				{
					kind: 'delete',
					stepRef: 'clear.label',
					targetField: 'label',
				},
			],
		},
	],
};

describe('generateLogicCanvas', () => {
	it('generates a canonical Blockly payload, preview, and generic source map', () => {
		const result = generateLogicCanvas(draft, 'lesson.alpha', emptyOperationCatalog);

		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(parseBlocklyDataPayload(result.generated.blocklyPayload)).toMatchObject({ ok: true });
		const compiled = compileBlocklyWorkspace(result.generated.workspace, emptyOperationCatalog);
		expect(compiled.ok).toBe(true);
		if (!compiled.ok) return;
		expect(compiled.javascript).toBe(result.generated.javascript);
		expect(compiled.blockCount).toBeGreaterThan(0);
		expect(result.generated.javascript).toContain(
			'output["total"] = (($json?.["price"] ?? null) * 1.2);',
		);
		expect(result.generated.javascript).toContain("['ready-'".replaceAll("'", '"'));
		expect(result.generated.sourceMap.map((entry) => entry.semanticRef)).toEqual([
			'calculate.total',
			'choose.label',
			'set.label',
			'clear.label',
		]);
		expect(result.generated.blockRefs.length).toBe(compiled.blockCount);
		expect(result.generated.blockRefs).toEqual(
			expect.arrayContaining([result.generated.sourceMap[0].artifact.ref]),
		);
		expect(result.generated.sourceMap[0]).toMatchObject({
			apiVersion: 1,
			artifact: { kind: 'canvasBlock' },
			source: { sourceRef: 'source.main' },
			context: {
				nodeRef: 'prepare.input',
				statementKind: 'set',
				targetField: 'total',
			},
		});
		expect(result.generated.blocklyPayload).toContain('calculate.total');
		expect(result.generated.blocklyPayload).toContain('source.main');
	});

	it('is byte-stable for the same normalized input and changes IDs across documents', () => {
		const first = generateLogicCanvas(draft, 'lesson.alpha', emptyOperationCatalog);
		const second = generateLogicCanvas(draft, 'lesson.alpha', emptyOperationCatalog);
		const other = generateLogicCanvas(draft, 'lesson.beta', emptyOperationCatalog);

		expect(first).toEqual(second);
		expect(first.ok).toBe(true);
		expect(other.ok).toBe(true);
		if (!first.ok || !other.ok) return;
		expect(first.generated.blocklyPayload).not.toBe(other.generated.blocklyPayload);
		expect(first.generated.sourceMap).not.toEqual(other.generated.sourceMap);
	});

	it('persists a registered operation as one dynamic value block with a call source mapping', () => {
		const operationSource = {
			sourceRef: 'source.main',
			start: { line: 3, column: 16, offset: 54 },
			end: { line: 3, column: 56, offset: 94 },
		};
		const result = generateLogicCanvas(
			{
				nodeRef: 'normalize.score',
				label: 'Normalize score',
				outputMode: 'empty',
				statements: [
					{
						kind: 'set',
						stepRef: 'set.normalized-score',
						targetField: 'score',
						value: {
							kind: 'operationCall',
							callRef: 'call.clamp-score.1',
							operationRef: 'operation.clamp-score.v1',
							implementationRef: clampOperation.implementationRef,
							qualifiedName: 'clampScore',
							version: '1.0.0',
							arguments: [
								{ kind: 'input', path: 'score' },
								{ kind: 'number', value: 0 },
								{ kind: 'number', value: 100 },
							],
							source: operationSource,
						},
					},
				],
			},
			'lesson.operation-call',
			clampOperationCatalog,
		);

		expect(result.ok).toBe(true);
		if (!result.ok) return;
		const workspaceJson = JSON.stringify(result.generated.workspace);
		expect(workspaceJson).toContain(
			createOperationBlockTypeV1(
				'operation.clamp-score.v1',
				clampOperation.implementationRef,
				'1.0.0',
			),
		);
		expect(workspaceJson).toContain('"OPERATION_REF":"operation.clamp-score.v1"');
		expect(workspaceJson).toContain(`"IMPLEMENTATION_REF":"${clampOperation.implementationRef}"`);
		expect(workspaceJson).toContain('"VERSION":"1.0.0"');
		expect(workspaceJson).toContain('"QUALIFIED_NAME":"clampScore"');
		expect(workspaceJson).toContain('"ARG0"');
		expect(workspaceJson).toContain('"ARG2"');
		expect(workspaceJson).toContain('call.clamp-score.1');
		expect(result.generated.javascript).toContain('output["score"]');
		const operationMapping = result.generated.sourceMap.find(
			(mapping) => mapping.semanticRef === 'call.clamp-score.1',
		);
		expect(operationMapping?.artifact.kind).toBe('canvasBlock');
		expect(operationMapping?.source).toEqual(operationSource);
		expect(operationMapping?.context).toMatchObject({
			expressionKind: 'operationCall',
			operationRef: 'operation.clamp-score.v1',
			implementationRef: clampOperation.implementationRef,
		});

		const missingImplementation = structuredClone(result.normalizedDraft);
		const statement = missingImplementation.statements[0];
		if (statement?.kind !== 'set' || statement.value.kind !== 'operationCall') {
			throw new Error('operation call fixture is malformed');
		}
		Reflect.deleteProperty(statement.value, 'implementationRef');
		expect(
			generateLogicCanvas(missingImplementation, 'lesson.operation-call', clampOperationCatalog),
		).toMatchObject({ ok: false, error: { code: 'LOGIC_DRAFT_INVALID' } });
	});

	it('covers structured values, assertions, collection operations, and conversions', () => {
		const result = generateLogicCanvas(
			{
				nodeRef: 'build.summary',
				label: 'Build summary',
				outputMode: 'empty',
				statements: [
					{
						kind: 'assert',
						stepRef: 'require.items',
						condition: {
							kind: 'compare',
							op: 'gt',
							left: { kind: 'arrayLength', array: { kind: 'input', path: 'items' } },
							right: { kind: 'number', value: 0 },
						},
						message: { kind: 'text', value: 'items are required' },
					},
					{
						kind: 'set',
						stepRef: 'create.summary',
						targetField: 'summary',
						value: {
							kind: 'object',
							properties: [
								{
									key: 'ids',
									value: {
										kind: 'arrayMapPath',
										array: {
											kind: 'arrayFilterPath',
											array: { kind: 'input', path: 'items' },
											path: 'score',
											op: 'gte',
											value: { kind: 'number', value: 60 },
										},
										path: 'id',
									},
								},
								{
									key: 'first',
									value: {
										kind: 'getPath',
										path: 'name',
										value: {
											kind: 'arrayAt',
											array: { kind: 'input', path: 'items' },
											index: { kind: 'number', value: 0 },
										},
									},
								},
							],
						},
					},
					{
						kind: 'set',
						stepRef: 'create.flags',
						targetField: 'flags',
						value: {
							kind: 'array',
							values: [
								{ kind: 'boolean', value: true },
								{
									kind: 'not',
									value: { kind: 'convert', to: 'boolean', value: { kind: 'input', path: 'off' } },
								},
							],
						},
					},
				],
			},
			'lesson.collections',
			emptyOperationCatalog,
		);

		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.generated.javascript).toContain('Array.isArray(items)');
		expect(result.generated.javascript).toContain('throw new Error');
		expect(result.generated.javascript).toContain('["ids"]');
	});

	it('returns diagnostics for invalid scopes and semantic drafts', () => {
		expect(generateLogicCanvas(draft, 'invalid scope', emptyOperationCatalog)).toMatchObject({
			ok: false,
			error: { code: 'LOGIC_SCOPE_INVALID', path: 'documentRef' },
		});
		expect(
			generateLogicCanvas(
				{
					...draft,
					statements: [draft.statements[0], draft.statements[0]],
				},
				'lesson.alpha',
				emptyOperationCatalog,
			),
		).toMatchObject({ ok: false, error: { code: 'LOGIC_DRAFT_INVALID' } });
	});
});
