import { flattenLogicStatements } from '@n8n/dual-canvas-core';
import { describe, expect, it } from 'vitest';

import { parseTeachingProgram } from './parser';
import { createTestRequest } from './test-support';

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
