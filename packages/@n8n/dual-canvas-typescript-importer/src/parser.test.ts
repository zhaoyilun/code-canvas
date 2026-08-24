import { flattenLogicStatements } from '@n8n/dual-canvas-core';
import {
	createOperationModuleCatalogV1,
	finalizeOperationModuleSpecV1,
} from '@n8n/dual-canvas-operation-runtime';
import {
	createOperationModuleTemplateV1,
	moduleScaffoldRequestV1Schema,
} from '@n8n/dual-canvas-operation-sdk';
import { describe, expect, it } from 'vitest';

import { parseTeachingProgram } from './parser';
import { createTestRequest, scoreOperationCatalog } from './test-support';

const clampScoreOperation = scoreOperationCatalog.modules.find(
	(module) => module.qualifiedName === 'clampScore',
);
const doubleScoreOperation = scoreOperationCatalog.modules.find(
	(module) => module.qualifiedName === 'doubleScore',
);
if (clampScoreOperation === undefined || doubleScoreOperation === undefined) {
	throw new Error('score operation fixtures are incomplete');
}

const fullSource = `function transform(input) {
	const output = { ...input };
	if (!((input?.score ?? null) >= 0 && (input?.score ?? null) <= 100)) {
		throw new Error('score range');
	}
	output.scaled = (((input?.score ?? null) + 2) - 1) * 3 / 2 ** 2;
	output.name = input?.name ?? null;
	output.enabled = Boolean(input?.enabled ?? null);
	output.flag = true;
	output.details = { label: 'sample', values: [1, false] };
	output.choice = (input?.score ?? null) === 10 ? 'ten' : 'other';
	if ((input?.score ?? null) !== 0 || !Boolean(input?.enabled ?? null)) {
		output.result = (input?.score ?? null) < 5;
	} else if ((input?.score ?? null) > 10 && (input?.score ?? null) >= 20) {
		output.result = (input?.score ?? null) <= 100;
	} else {
		delete output.result;
	}
	return output;
}`;

describe('teaching-subset parser', () => {
	it('discovers and aggregates repeated static unknown calls as one stable scaffold request', () => {
		const source = `function transform(input) {
	const output = {};
	output.low = clamp(-2, 0, 10);
	output.high = clamp(12, 0, 10);
	return output;
}`;
		const first = parseTeachingProgram(createTestRequest(source), 'node.logic');
		const second = parseTeachingProgram(createTestRequest(source), 'node.logic');

		expect(first).toMatchObject({
			ok: false,
			diagnostics: [{ code: 'OPERATION_MODULE_MISSING' }],
		});
		if (first.ok || second.ok) return;
		expect(first.diagnostics).toHaveLength(1);
		expect(second.diagnostics).toEqual(first.diagnostics);
		const parsedRequest = moduleScaffoldRequestV1Schema.safeParse(first.diagnostics[0]?.details);
		expect(parsedRequest.success).toBe(true);
		if (!parsedRequest.success) return;
		expect(parsedRequest.data).toMatchObject({
			qualifiedName: 'clamp',
			arity: 3,
			calls: [
				{
					callText: 'clamp(-2, 0, 10)',
					source: { start: { offset: source.indexOf('clamp(-2') } },
					arguments: [
						{ index: 0, text: '-2', typeHint: 'number', literalValue: -2 },
						{ index: 1, text: '0', typeHint: 'number', literalValue: 0 },
						{ index: 2, text: '10', typeHint: 'number', literalValue: 10 },
					],
				},
				{ callText: 'clamp(12, 0, 10)' },
			],
			requiredDecisions: [
				'behavior',
				'effect',
				'parameter-names',
				'input-types',
				'null-handling',
				'output-type',
				'test-vectors',
			],
		});
		expect(new Set(parsedRequest.data.calls.map((call) => call.callRef)).size).toBe(2);
		const firstArgument = parsedRequest.data.calls[0]?.arguments[0];
		expect(firstArgument?.source).toMatchObject({
			start: { offset: source.indexOf('-2') },
			end: { offset: source.indexOf('-2') + 2 },
		});

		const template = createOperationModuleTemplateV1(parsedRequest.data);
		expect(template).toMatchObject({
			requestRef: parsedRequest.data.requestRef,
			identity: { qualifiedName: 'clamp' },
			parameters: [{ type: null }, { type: null }, { type: null }],
		});
	});

	it('discovers static property calls without guessing argument semantics', () => {
		const source = `function transform(input) {
	const output = {};
	output.value = tools.math.clamp(input?.value ?? null, { min: 0 }, [10]);
	return output;
}`;
		const result = parseTeachingProgram(createTestRequest(source), 'node.logic');

		expect(result.ok).toBe(false);
		if (result.ok) return;
		const request = moduleScaffoldRequestV1Schema.parse(result.diagnostics[0]?.details);
		expect(request).toMatchObject({
			qualifiedName: 'tools.math.clamp',
			arity: 3,
			calls: [
				{
					arguments: [
						{ text: 'input?.value ?? null', typeHint: 'unknown' },
						{ text: '{ min: 0 }', typeHint: 'object', literalValue: { min: 0 } },
						{ text: '[10]', typeHint: 'array', literalValue: [10] },
					],
				},
			],
		});
	});

	it('keeps non-finite numeric syntax as a number hint without emitting invalid JSON', () => {
		const source = `function transform(input) {
	const output = {};
	output.high = mystery(1e309);
	output.low = mystery(-1e309);
	return output;
}`;
		let result: ReturnType<typeof parseTeachingProgram> | undefined;
		expect(() => {
			result = parseTeachingProgram(createTestRequest(source), 'node.logic');
		}).not.toThrow();
		expect(result).toMatchObject({
			ok: false,
			diagnostics: [{ code: 'OPERATION_MODULE_MISSING' }],
		});
		if (result === undefined || result.ok) return;
		const request = moduleScaffoldRequestV1Schema.parse(result.diagnostics[0]?.details);
		expect(request.calls).toHaveLength(2);
		for (const call of request.calls) {
			const argument = call.arguments[0];
			expect(argument).toMatchObject({ typeHint: 'number' });
			expect(argument === undefined ? true : 'literalValue' in argument).toBe(false);
		}
	});

	it('recursively discovers and aggregates nested static unknown calls without duplicates', () => {
		const source = `function transform(input) {
	const output = {};
	output.first = outer(inner(1), sibling(2));
	output.second = outer(inner(3), sibling(4));
	return output;
}`;
		const first = parseTeachingProgram(createTestRequest(source), 'node.logic');
		const second = parseTeachingProgram(createTestRequest(source), 'node.logic');

		expect(first.ok).toBe(false);
		if (first.ok || second.ok) return;
		expect(first.diagnostics).toHaveLength(3);
		expect(second.diagnostics).toEqual(first.diagnostics);
		expect(
			first.diagnostics.every((diagnostic) => diagnostic.code === 'OPERATION_MODULE_MISSING'),
		).toBe(true);
		const requests = first.diagnostics.map((diagnostic) =>
			moduleScaffoldRequestV1Schema.parse(diagnostic.details),
		);
		expect(requests.map((request) => `${request.qualifiedName}/${request.arity}`)).toEqual([
			'outer/2',
			'inner/1',
			'sibling/1',
		]);
		for (const request of requests) {
			expect(request.calls).toHaveLength(2);
			expect(new Set(request.calls.map((call) => call.callRef)).size).toBe(2);
		}
	});

	it('resolves an exact qualified-name and arity match into a persistent operation call', () => {
		const source = `function transform(input) {
	const output = {};
	output.score = clampScore(input?.score ?? null, 0, 100);
	return output;
}`;
		const result = parseTeachingProgram(
			{ ...createTestRequest(source), operationCatalog: scoreOperationCatalog },
			'node.logic',
		);

		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.parsed.logic.statements[0]).toMatchObject({
			kind: 'set',
			value: {
				kind: 'operationCall',
				operationRef: 'operation.clamp-score.v1',
				implementationRef: clampScoreOperation.implementationRef,
				qualifiedName: 'clampScore',
				version: '1.0.0',
				arguments: [
					{ kind: 'input', path: 'score' },
					{ kind: 'number', value: 0 },
					{ kind: 'number', value: 100 },
				],
				source: { start: { offset: source.indexOf('clampScore(') } },
			},
		});
		const statement = result.parsed.logic.statements[0];
		if (statement?.kind !== 'set' || statement.value.kind !== 'operationCall') return;
		expect(statement.value.callRef).toMatch(/^operation-call-/);
	});

	it('indexes the admitted catalog once and resolves the exact canonical identity', () => {
		const versionOneModule = finalizeOperationModuleSpecV1({
			apiVersion: 1 as const,
			requestRef: 'module-request.versioned-v1',
			operationRef: 'operation.versioned.v1',
			implementationRef: null,
			qualifiedName: 'versioned',
			arity: 0,
			version: '1.0.0',
			behaviorSummary: 'Returns the canonical version marker.',
			execution: 'synchronous' as const,
			determinism: 'deterministic' as const,
			effects: 'none' as const,
			dataFlow: 'json-to-json' as const,
			parameters: [],
			output: { type: 'number' as const, nullPolicy: 'reject' as const },
			expression: { kind: 'literal' as const, value: 1 },
			testVectors: [
				{ name: 'first', arguments: [], expected: 1 },
				{ name: 'second', arguments: [], expected: 1 },
				{ name: 'third', arguments: [], expected: 1 },
			],
		});
		const catalog = createOperationModuleCatalogV1({
			apiVersion: 1,
			modules: [versionOneModule],
		});
		let moduleReads = 0;
		const observedCatalog = {
			apiVersion: catalog.apiVersion,
			get modules() {
				moduleReads += 1;
				return catalog.modules;
			},
		};
		const source = `function transform(input) {
	const output = {};
	output.first = versioned();
	output.second = versioned();
	return output;
}`;
		const result = parseTeachingProgram(
			{ ...createTestRequest(source), operationCatalog: observedCatalog },
			'node.logic',
		);

		expect(result.ok).toBe(true);
		expect(moduleReads).toBe(1);
		if (!result.ok) return;
		for (const statement of result.parsed.logic.statements) {
			if (statement.kind !== 'set' || statement.value.kind !== 'operationCall') {
				throw new Error('expected an operation call');
			}
			expect(statement.value).toMatchObject({
				operationRef: 'operation.versioned.v1',
				implementationRef: versionOneModule.implementationRef,
				qualifiedName: 'versioned',
				version: '1.0.0',
			});
		}
	});

	it('keeps exact operation identity through nested registered calls', () => {
		const source = `function transform(input) {
	const output = {};
	output.score = clampScore(doubleScore(input?.score ?? null), 0, 100);
	return output;
}`;
		const result = parseTeachingProgram(
			{ ...createTestRequest(source), operationCatalog: scoreOperationCatalog },
			'node.logic',
		);

		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.parsed.logic.statements[0]).toMatchObject({
			value: {
				kind: 'operationCall',
				qualifiedName: 'clampScore',
				arguments: [
					{
						kind: 'operationCall',
						operationRef: 'operation.double-score.v1',
						implementationRef: doubleScoreOperation.implementationRef,
						qualifiedName: 'doubleScore',
						arguments: [{ kind: 'input', path: 'score' }],
					},
					{ kind: 'number', value: 0 },
					{ kind: 'number', value: 100 },
				],
			},
		});
	});

	it('routes a wrong arity and a missing nested call through scaffold discovery', () => {
		const wrongAritySource = `function transform(input) {
	const output = {};
	output.score = clampScore(10, 0);
	return output;
}`;
		const wrongArity = parseTeachingProgram(
			{ ...createTestRequest(wrongAritySource), operationCatalog: scoreOperationCatalog },
			'node.logic',
		);
		expect(wrongArity).toMatchObject({
			ok: false,
			diagnostics: [
				{
					code: 'OPERATION_MODULE_MISSING',
					details: { qualifiedName: 'clampScore', arity: 2 },
				},
			],
		});

		const nestedMissingSource = `function transform(input) {
	const output = {};
	output.score = clampScore(missingScore(10), 0, 100);
	return output;
}`;
		const nestedMissing = parseTeachingProgram(
			{ ...createTestRequest(nestedMissingSource), operationCatalog: scoreOperationCatalog },
			'node.logic',
		);
		expect(nestedMissing).toMatchObject({
			ok: false,
			diagnostics: [
				{
					code: 'OPERATION_MODULE_MISSING',
					details: { qualifiedName: 'missingScore', arity: 1 },
				},
			],
		});
	});

	it('scopes stable request and call references to document revisions', () => {
		const source = `function transform(input) {
	const output = {};
	output.value = mystery(1);
	return output;
}`;
		const revisionOneRequest = createTestRequest(source);
		const sameRevision = parseTeachingProgram(revisionOneRequest, 'node.logic');
		const repeated = parseTeachingProgram(revisionOneRequest, 'node.logic');
		const nextRevision = parseTeachingProgram(
			{ ...revisionOneRequest, revisionRef: 'revision.2' },
			'node.logic',
		);

		if (sameRevision.ok || repeated.ok || nextRevision.ok) {
			throw new Error('unknown operation must produce scaffold diagnostics');
		}
		const first = moduleScaffoldRequestV1Schema.parse(sameRevision.diagnostics[0]?.details);
		const again = moduleScaffoldRequestV1Schema.parse(repeated.diagnostics[0]?.details);
		const next = moduleScaffoldRequestV1Schema.parse(nextRevision.diagnostics[0]?.details);
		expect(again).toEqual(first);
		expect(first.scope).toEqual({
			documentRef: revisionOneRequest.documentRef,
			revisionRef: 'revision.1',
			sourceRef: 'source.main',
		});
		expect(next.scope.revisionRef).toBe('revision.2');
		expect(next.requestRef).not.toBe(first.requestRef);
		expect(next.calls[0]?.callRef).not.toBe(first.calls[0]?.callRef);
	});

	it.each([
		'operations[name](1)',
		'(input?.fn ?? null)(1)',
		'factory()(1)',
		'tools?.clamp(1)',
		'clamp(...values)',
		'input.name.trim()',
		'output.name.trim()',
	])('keeps dynamic or optional calls as located syntax diagnostics: %s', (call) => {
		const source = `function transform(input) {
	const output = {};
	output.value = ${call};
	return output;
}`;
		const result = parseTeachingProgram(createTestRequest(source), 'node.logic');
		expect(result).toMatchObject({
			ok: false,
			diagnostics: [{ code: 'UNSUPPORTED_SYNTAX', details: { line: 3 } }],
		});
		if (!result.ok) {
			expect(
				result.diagnostics.some((diagnostic) => diagnostic.code === 'OPERATION_MODULE_MISSING'),
			).toBe(false);
		}
	});

	it('never resolves a runtime value method as a zero-argument operation module', () => {
		const source = `function transform(input) {
	const output = {};
	output.value = input.name.trim();
	return output;
}`;
		const runtimeMethodCatalog = createOperationModuleCatalogV1({
			apiVersion: 1,
			modules: [
				finalizeOperationModuleSpecV1({
					apiVersion: 1,
					requestRef: 'module-request.input-name-trim',
					operationRef: 'operation.input-name-trim.v1',
					implementationRef: null,
					qualifiedName: 'input.name.trim',
					arity: 0,
					version: '1.0.0',
					behaviorSummary: 'Returns a fixed value to expose accidental receiver loss.',
					execution: 'synchronous',
					determinism: 'deterministic',
					effects: 'none',
					dataFlow: 'json-to-json',
					parameters: [],
					output: { type: 'string', nullPolicy: 'reject' },
					expression: { kind: 'literal', value: 'constant' },
					testVectors: [
						{ name: 'constant-a', arguments: [], expected: 'constant' },
						{ name: 'constant-b', arguments: [], expected: 'constant' },
						{ name: 'constant-c', arguments: [], expected: 'constant' },
					],
				}),
			],
		});
		const result = parseTeachingProgram(
			{ ...createTestRequest(source), operationCatalog: runtimeMethodCatalog },
			'node.logic',
		);

		expect(result).toMatchObject({ ok: false, diagnostics: [{ code: 'UNSUPPORTED_SYNTAX' }] });
		if (!result.ok) {
			expect(
				result.diagnostics.some((diagnostic) => diagnostic.code === 'OPERATION_MODULE_MISSING'),
			).toBe(false);
		}
	});

	it('does not scaffold an unknown operation whose argument is outside LogicExpression', () => {
		const source = `function transform(input) {
	const output = {};
	output.value = outer(input.name.trim());
	return output;
}`;
		const result = parseTeachingProgram(createTestRequest(source), 'node.logic');

		expect(result.ok).toBe(false);
		if (result.ok) return;
		const missingNames = result.diagnostics
			.filter((diagnostic) => diagnostic.code === 'OPERATION_MODULE_MISSING')
			.map((diagnostic) => moduleScaffoldRequestV1Schema.parse(diagnostic.details).qualifiedName);
		expect(missingNames).toEqual([]);
		expect(result.diagnostics.some((diagnostic) => diagnostic.code === 'UNSUPPORTED_SYNTAX')).toBe(
			true,
		);
	});

	it('reports an unsupported arrow-function argument without emitting a misleading scaffold', () => {
		const source = `function transform(input) {
	const output = {};
	output.value = fn(() => 1);
	return output;
}`;
		const result = parseTeachingProgram(createTestRequest(source), 'node.logic');

		expect(result).toMatchObject({
			ok: false,
			diagnostics: [
				{
					code: 'UNSUPPORTED_SYNTAX',
					path: 'source.3.19',
					details: { line: 3, column: 19, startOffset: source.indexOf('() => 1') },
				},
			],
		});
		if (!result.ok) {
			expect(
				result.diagnostics.some((diagnostic) => diagnostic.code === 'OPERATION_MODULE_MISSING'),
			).toBe(false);
		}
	});

	it('keeps known conversion arity errors on the existing syntax route', () => {
		const source = `function transform(input) {
	const output = {};
	output.value = Number(1, 2);
	return output;
}`;
		const result = parseTeachingProgram(createTestRequest(source), 'node.logic');
		expect(result).toMatchObject({ ok: false, diagnostics: [{ code: 'UNSUPPORTED_SYNTAX' }] });
		if (!result.ok) {
			expect(
				result.diagnostics.some((diagnostic) => diagnostic.code === 'OPERATION_MODULE_MISSING'),
			).toBe(false);
		}
	});

	it.each(['javascript', 'typescript', 'arkts'] as const)(
		'parses the TypeScript-compatible subset as %s',
		(language) => {
			const result = parseTeachingProgram(createTestRequest(fullSource, language), 'node.logic');

			expect(result.ok).toBe(true);
			if (!result.ok) return;
			expect(result.parsed.logic.outputMode).toBe('copyInput');
			expect(result.parsed.logic.statements.map((statement) => statement.kind)).toEqual([
				'assert',
				'set',
				'set',
				'set',
				'set',
				'set',
				'set',
				'if',
			]);

			const scaled = result.parsed.logic.statements[1];
			expect(scaled).toMatchObject({
				kind: 'set',
				targetField: 'scaled',
				value: {
					kind: 'arithmetic',
					op: 'divide',
					right: { kind: 'arithmetic', op: 'power' },
				},
				source: { sourceRef: 'source.main', start: { line: 6, column: 1 } },
			});
			const allStatements = flattenLogicStatements(result.parsed.logic.statements);
			expect(allStatements.map((statement) => statement.kind)).toContain('delete');
			expect(new Set(allStatements.map((statement) => statement.stepRef)).size).toBe(
				allStatements.length,
			);
			expect(result.parsed.entrySpan.start).toEqual({ line: 1, column: 0, offset: 0 });
			expect(result.parsed.returnSpan.start.line).toBe(19);
		},
	);

	it('supports empty output, type-only syntax, throwing assertions, and normalized field reads', () => {
		const source = `interface Input { value: number; ok: boolean }
export function transform(input: Input) {
	const output: Record<string, unknown> = {} as Record<string, unknown>;
	output.value = ((input?.value ?? null) as number);
	if (!Boolean(input?.ok ?? null)) {
		throw new Error('input is ready');
	}
	return output;
}`;
		const result = parseTeachingProgram(createTestRequest(source), 'node.logic');

		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.parsed.logic).toMatchObject({
			outputMode: 'empty',
			statements: [
				{
					kind: 'set',
					targetField: 'value',
					value: { kind: 'input', path: 'value' },
				},
				{
					kind: 'assert',
					condition: {
						kind: 'convert',
						to: 'boolean',
						value: { kind: 'input', path: 'ok' },
					},
				},
			],
		});
	});

	it.each(["assert(Boolean(input?.ok ?? null), 'ready');", "console.assert(true, 'ready');"])(
		'rejects non-throwing assertion-call semantics: %s',
		(assertion) => {
			const source = `function transform(input) {
	const output = {};
	${assertion}
	return output;
}`;
			const result = parseTeachingProgram(createTestRequest(source), 'node.logic');

			expect(result).toMatchObject({
				ok: false,
				diagnostics: [{ code: 'SOURCE_SEMANTICS_MISMATCH', details: { line: 3 } }],
			});
		},
	);

	it('accepts only Number and String conversions whose primitive literal result matches Blockly', () => {
		const source = `function transform(input) {
	const output = {};
	output.count = Number('12');
	output.label = String(false);
	return output;
}`;
		const result = parseTeachingProgram(createTestRequest(source), 'node.logic');

		expect(result.ok).toBe(true);
	});

	it.each([
		['Number(null)', 'Number(null)'],
		['String(null)', 'String(null)'],
		['Number of a nullable input read', 'Number(input?.value ?? null)'],
		['String of a nullable input read', 'String(input?.value ?? null)'],
		['a missing-field-sensitive direct read', 'input.missing'],
		['a negative bracket index', '[10, 20][-1]'],
	] as const)('rejects %s before artifact generation', (_label, valueExpression) => {
		const source = `function transform(input) {
	const output = {};
	output.value = ${valueExpression};
	return output;
}`;
		const result = parseTeachingProgram(createTestRequest(source), 'node.logic');

		expect(result).toMatchObject({
			ok: false,
			diagnostics: [{ code: 'SOURCE_SEMANTICS_MISMATCH', details: { line: 3 } }],
		});
	});

	it.each([
		[
			'a nested assignment that would create a parent object',
			'const output = {};',
			"output.profile.name = 'Ada';",
		],
		[
			'a nested delete that the Blockly runtime would guard',
			'const output = {};',
			'delete output.profile.name;',
		],
		[
			'a nested write through a shallow-copy reference',
			'const output = { ...input };',
			"output.profile.name = 'Ada';",
		],
	] as const)('rejects %s', (_label, initializer, statement) => {
		const source = `function transform(input) {
	${initializer}
	${statement}
	return output;
}`;
		const result = parseTeachingProgram(createTestRequest(source), 'node.logic');

		expect(result).toMatchObject({
			ok: false,
			diagnostics: [{ code: 'SOURCE_SEMANTICS_MISMATCH', details: { line: 3 } }],
		});
	});

	it('rejects partially optional or non-normalized input paths and accepts the exact safe form', () => {
		const accepted = parseTeachingProgram(
			createTestRequest(`function transform(input) {
	const output = {};
	output.value = input?.profile?.values?.[0] ?? null;
	return output;
}`),
			'node.logic',
		);
		expect(accepted).toMatchObject({
			ok: true,
			parsed: {
				logic: {
					statements: [{ value: { kind: 'input', path: 'profile.values.0' } }],
				},
			},
		});

		for (const expression of ['input?.profile.value ?? null', 'input?.value']) {
			const result = parseTeachingProgram(
				createTestRequest(`function transform(input) {
	const output = {};
	output.value = ${expression};
	return output;
}`),
				'node.logic',
			);
			expect(result).toMatchObject({
				ok: false,
				diagnostics: [{ code: 'SOURCE_SEMANTICS_MISMATCH' }],
			});
		}
	});

	it('reports unsupported statements with line, column, and offsets', () => {
		const source = `function transform(input) {
	const output = {};
	for (const value of input.values) {
		output.value = value;
	}
	return output;
}`;
		const result = parseTeachingProgram(createTestRequest(source), 'node.logic');

		expect(result).toMatchObject({
			ok: false,
			diagnostics: [
				{
					code: 'UNSUPPORTED_SYNTAX',
					path: 'source.3.1',
					details: {
						sourceRef: 'source.main',
						line: 3,
						column: 1,
						startOffset: source.indexOf('for ('),
					},
				},
			],
		});
	});

	it('reports malformed source and ArkTS UI syntax as located parse diagnostics', () => {
		const malformed = `function transform(input) {
	const output = {};
	output.value = ;
	return output;
}`;
		const malformedResult = parseTeachingProgram(createTestRequest(malformed), 'node.logic');
		expect(malformedResult).toMatchObject({
			ok: false,
			diagnostics: [{ code: 'SOURCE_PARSE_ERROR', details: { line: 3 } }],
		});

		const arkUiResult = parseTeachingProgram(
			createTestRequest('@Entry\nstruct LessonView { build() {} }', 'arkts'),
			'node.logic',
		);
		expect(arkUiResult.ok).toBe(false);
		if (arkUiResult.ok) return;
		expect(
			arkUiResult.diagnostics.some(
				(diagnostic) => diagnostic.code === 'SOURCE_PARSE_ERROR' && diagnostic.details?.line === 2,
			),
		).toBe(true);
	});

	it('rejects a body that does not use the frozen output boundaries', () => {
		const source = `function transform(input) {
	let result = {};
	result.value = input.value;
	return result;
}`;
		const result = parseTeachingProgram(createTestRequest(source), 'node.logic');

		expect(result).toMatchObject({
			ok: false,
			diagnostics: [{ code: 'OUTPUT_INITIALIZER_INVALID' }, { code: 'OUTPUT_RETURN_INVALID' }],
		});
	});
});
