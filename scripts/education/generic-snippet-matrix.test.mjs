import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

import {
	generateGenericSnippetMatrixReport,
	matrixReportPath,
	negativeSnippetSpecs,
	positiveSnippetSpecs,
	serializeGenericSnippetMatrixReport,
	verifyNegativeSnippet,
	verifyPositiveSnippet,
} from './generic-snippet-matrix.mjs';

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const scriptPath = resolve(scriptDirectory, 'generic-snippet-matrix.mjs');

for (const spec of positiveSnippetSpecs) {
	test(`converts and executes the generic positive snippet: ${spec.caseRef}`, () => {
		const result = verifyPositiveSnippet(spec);
		assert.equal(result.caseRef, spec.caseRef);
		assert.ok(result.statementCount > 0);
		assert.ok(result.blockCount >= result.statementCount);
		assert.equal(result.executionCount, spec.executions.length);
	});
}

for (const spec of negativeSnippetSpecs) {
	test(`rejects the V1 semantic mismatch before artifact generation: ${spec.caseRef}`, () => {
		const result = verifyNegativeSnippet(spec);
		assert.equal(result.caseRef, spec.caseRef);
		assert.equal(result.diagnostic.code, 'SOURCE_SEMANTICS_MISMATCH');
	});
}

test('covers the complete basic teaching matrix and remains deterministic', () => {
	const first = generateGenericSnippetMatrixReport();
	const second = generateGenericSnippetMatrixReport();
	assert.equal(
		serializeGenericSnippetMatrixReport(first),
		serializeGenericSnippetMatrixReport(second),
	);
	assert.deepEqual(first.totals, {
		positiveCases: 7,
		negativeCases: 3,
		runtimeExecutions: 9,
		statements: 13,
		sourceMappings: 34,
		blocks: 57,
	});
	assert.deepEqual(first.executionBoundary, {
		generatedJavaScript: 'node:vm compileFunction',
		n8nNodeRuntime: 'separate acceptance gate',
	});
	assert.deepEqual(first.coverage, [
		'array-construction',
		'boolean-conversion',
		'conditional-branch',
		'field-copy',
		'field-delete',
		'field-rename',
		'number-conversion',
		'numeric-calculation',
		'object-construction',
		'string-conversion',
		'throwing-assertion',
	]);
});

test('keeps the checked-in matrix report byte-stable and CLI-checkable', () => {
	const expected = serializeGenericSnippetMatrixReport(generateGenericSnippetMatrixReport());
	assert.equal(readFileSync(matrixReportPath, 'utf8'), expected);
	assert.deepEqual(JSON.parse(expected), generateGenericSnippetMatrixReport());

	const result = spawnSync(process.execPath, [scriptPath, '--check'], {
		cwd: scriptDirectory,
		encoding: 'utf8',
	});
	assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
	const cliReport = JSON.parse(result.stdout.trim());
	assert.equal(cliReport.mode, 'check');
	assert.equal(cliReport.positiveCases, 7);
	assert.equal(cliReport.negativeCases, 3);
});
