#!/usr/bin/env node

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { compileFunction } from 'node:vm';

import { createGenericImportRequest, repositoryRoot } from './generic-dual-canvas-example.mjs';

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const snippetDirectory = resolve(repositoryRoot, 'docs/education/examples/generic-snippets');
export const matrixReportPath = resolve(
	repositoryRoot,
	'docs/education/examples/generic-snippet-matrix.report.json',
);

const require = createRequire(import.meta.url);
const importer = require(
	resolve(repositoryRoot, 'packages/@n8n/dual-canvas-typescript-importer/dist/index.js'),
);
const core = require(resolve(repositoryRoot, 'packages/@n8n/dual-canvas-core/dist/index.js'));
const dataTransform = require(
	resolve(repositoryRoot, 'packages/@n8n/blockly-data-transform/dist/index.js'),
);

const expectedNodeTypes = ['n8n-nodes-base.manualTrigger', 'n8n-nodes-blockly-code.blocklyCode'];

export const positiveSnippetSpecs = [
	{
		caseRef: 'field-copy-rename',
		title: 'Field copy and rename',
		fileName: 'field-copy-rename.ts',
		coverage: ['field-copy', 'field-rename'],
		executions: [
			{
				input: { name: 'Ada', age: 36 },
				expectedOutput: { age: 36, customerName: 'Ada' },
			},
		],
	},
	{
		caseRef: 'numeric-calculation',
		title: 'Numeric calculation',
		fileName: 'numeric-calculation.ts',
		coverage: ['numeric-calculation'],
		executions: [{ input: { price: 12.5, quantity: 4 }, expectedOutput: { total: 52 } }],
	},
	{
		caseRef: 'scalar-conversion',
		title: 'String number and boolean conversion',
		fileName: 'scalar-conversion.ts',
		coverage: ['number-conversion', 'string-conversion', 'boolean-conversion'],
		executions: [
			{
				input: { enabled: 'yes' },
				expectedOutput: { asNumber: 42.5, asText: 'false', isEnabled: true },
			},
		],
	},
	{
		caseRef: 'conditional-branch',
		title: 'Conditional branch',
		fileName: 'conditional-branch.ts',
		coverage: ['conditional-branch'],
		executions: [
			{ input: { score: 75, active: true }, expectedOutput: { level: 'pass' } },
			{ input: { score: 75, active: false }, expectedOutput: { level: 'review' } },
		],
	},
	{
		caseRef: 'array-object-construction',
		title: 'Array and object construction',
		fileName: 'array-object-construction.ts',
		coverage: ['array-construction', 'object-construction'],
		executions: [
			{
				input: { score: 88 },
				expectedOutput: { summary: { label: 'basic', values: [1, 88, true] } },
			},
		],
	},
	{
		caseRef: 'field-delete',
		title: 'Field deletion',
		fileName: 'field-delete.ts',
		coverage: ['field-delete'],
		executions: [
			{
				input: { id: 7, secret: 'remove-me' },
				expectedOutput: { id: 7 },
			},
		],
	},
	{
		caseRef: 'throwing-assertion',
		title: 'Throwing assertion',
		fileName: 'throwing-assertion.ts',
		coverage: ['throwing-assertion'],
		executions: [
			{ input: { score: 80 }, expectedOutput: { score: 80, checked: true } },
			{ input: { score: 120 }, expectedError: 'score must be between 0 and 100' },
		],
	},
];

export const negativeSnippetSpecs = [
	{
		caseRef: 'negative-direct-input-read',
		title: 'Direct input read without null normalization',
		fileName: 'negative-direct-input-read.ts',
		expectedCode: 'SOURCE_SEMANTICS_MISMATCH',
		reason: 'A missing property is undefined in source but is normalized to null by the V1 blocks.',
	},
	{
		caseRef: 'negative-nested-output-write',
		title: 'Nested output write',
		fileName: 'negative-nested-output-write.ts',
		expectedCode: 'SOURCE_SEMANTICS_MISMATCH',
		reason:
			'The V1 blocks create and clone parent objects, which changes source reference semantics.',
	},
	{
		caseRef: 'negative-nullable-number-conversion',
		title: 'Number conversion of a nullable input read',
		fileName: 'negative-nullable-number-conversion.ts',
		expectedCode: 'SOURCE_SEMANTICS_MISMATCH',
		reason: 'Number(null) and the V1 null-preserving number block produce different values.',
	},
];

export function verifyPositiveSnippet(spec) {
	const sourcePath = resolve(snippetDirectory, spec.fileName);
	const source = readFileSync(sourcePath, 'utf8');
	const request = createSnippetRequest(spec, source, sourcePath);
	const first = importer.importTypeScriptSource(request);
	assert.equal(first.ok, true, formatDiagnostics(first));
	const second = importer.importTypeScriptSource(request);
	assert.equal(second.ok, true, formatDiagnostics(second));
	assert.equal(
		serializeImportEnvelope(spec.caseRef, request, first.value),
		serializeImportEnvelope(spec.caseRef, request, second.value),
		`${spec.caseRef} must generate byte-identical artifacts`,
	);

	const envelopeBytes = serializeImportEnvelope(spec.caseRef, request, first.value);
	const roundTripped = JSON.parse(envelopeBytes);
	assert.deepEqual(roundTripped, {
		apiVersion: 1,
		caseRef: spec.caseRef,
		request,
		artifact: first.value,
	});

	const parsedRequest = importer.typeScriptImportRequestV1Schema.parse(roundTripped.request);
	const program = core.visualProgramIRV1Schema.parse(roundTripped.artifact.program);
	const workflow = core.workflowFragmentV1Schema.parse(roundTripped.artifact.workflow);
	const document = core.dualCanvasDocumentV1Schema.parse(roundTripped.artifact.document);
	const canvas = core.canvasArtifactV1Schema.parse(roundTripped.artifact.canvas);
	assert.deepEqual(document.workflow, workflow);
	assert.deepEqual(document.canvases, [canvas]);
	assert.deepEqual(program.sources, [parsedRequest.source]);
	assert.deepEqual(document.sources, [parsedRequest.source]);
	assert.deepEqual(program.sourceMap, document.sourceMap);
	assert.deepEqual(
		workflow.nodes.map((node) => node.nodeType),
		expectedNodeTypes,
	);
	assert.equal(workflow.connections.length, 1);
	assert.ok(workflow.nodes.every((node) => !node.nodeType.startsWith('CUSTOM.')));

	const logicNode = program.nodes.find((node) => node.nodeRef === workflow.exitNodeRefs[0]);
	assert.ok(logicNode?.logic, `${spec.caseRef} requires embedded logic in VisualProgramIRV1`);
	const statements = core.flattenLogicStatements(logicNode.logic.statements);
	const workspaceBlockRefs = collectBlocklyBlockRefs(
		roundTripped.artifact.generatedCanvas.workspace,
	);
	const generatedBlockRefs = roundTripped.artifact.generatedCanvas.blockRefs;
	assert.equal(new Set(generatedBlockRefs).size, generatedBlockRefs.length);
	assert.deepEqual([...generatedBlockRefs].sort(), [...workspaceBlockRefs].sort());
	assert.deepEqual([...canvas.blockRefs].sort(), [...workspaceBlockRefs].sort());

	const blockMappings = program.sourceMap.filter(
		(mapping) => mapping.artifact.kind === 'canvasBlock',
	);
	assert.equal(blockMappings.length, statements.length);
	for (const statement of statements) {
		const matchingMappings = blockMappings.filter(
			(mapping) => mapping.semanticRef === statement.stepRef,
		);
		assert.equal(matchingMappings.length, 1, `${statement.stepRef} requires one block mapping`);
		const [mapping] = matchingMappings;
		assert.equal(mapping.source?.sourceRef, parsedRequest.source.sourceRef);
		assert.deepEqual(mapping.source, statement.source);
		assert.ok(workspaceBlockRefs.has(mapping.artifact.ref));
	}
	assert.deepEqual(
		canvas.sourceMap.map((mapping) => mapping.mappingRef),
		program.sourceMap
			.filter(
				(mapping) => mapping.artifact.kind === 'canvas' || mapping.artifact.kind === 'canvasBlock',
			)
			.map((mapping) => mapping.mappingRef),
	);

	assert.equal(canvas.payload, roundTripped.artifact.generatedCanvas.blocklyPayload);
	const parsedPayload = dataTransform.parseBlocklyDataPayload(canvas.payload);
	assert.equal(parsedPayload.ok, true, parsedPayload.error);
	const compiled = dataTransform.compileBlocklyWorkspace(
		parsedPayload.payload.workspace,
		parsedPayload.payload.operationCatalog,
	);
	assert.equal(compiled.ok, true, compiled.error);
	assert.equal(compiled.javascript, roundTripped.artifact.generatedCanvas.javascript);
	assert.equal(canvas.preview, compiled.javascript);
	assert.deepEqual(
		parsedPayload.payload.workspace,
		roundTripped.artifact.generatedCanvas.workspace,
	);

	for (const execution of spec.executions) {
		const sourceExecution = executeSource(source, execution.input);
		const generatedExecution = executeGenerated(compiled.javascript, execution.input);
		assert.deepEqual(generatedExecution, sourceExecution, `${spec.caseRef} runtime equivalence`);
		if ('expectedError' in execution) {
			assert.deepEqual(sourceExecution, { ok: false, error: execution.expectedError });
		} else {
			assert.deepEqual(sourceExecution, { ok: true, value: execution.expectedOutput });
		}
	}

	return {
		caseRef: spec.caseRef,
		title: spec.title,
		sourceFile: toRepositoryPath(sourcePath),
		sourceSha256: sha256(source),
		coverage: spec.coverage,
		statementCount: statements.length,
		sourceMapCount: program.sourceMap.length,
		blockCount: workspaceBlockRefs.size,
		executionCount: spec.executions.length,
		artifactSha256: sha256(envelopeBytes),
	};
}

export function verifyNegativeSnippet(spec) {
	const sourcePath = resolve(snippetDirectory, spec.fileName);
	const source = readFileSync(sourcePath, 'utf8');
	const request = createSnippetRequest(spec, source, sourcePath);
	const first = importer.importTypeScriptSource(request);
	const second = importer.importTypeScriptSource(request);
	assert.equal(first.ok, false, `${spec.caseRef} must stop before artifact generation`);
	assert.equal(second.ok, false, `${spec.caseRef} must stop before artifact generation`);
	assert.equal(
		JSON.stringify(first),
		JSON.stringify(second),
		`${spec.caseRef} diagnostics must be stable`,
	);
	assert.deepEqual(JSON.parse(JSON.stringify(first)), first);
	assert.ok(!Object.hasOwn(first, 'value'));
	const diagnostic = first.diagnostics.find(({ code }) => code === spec.expectedCode);
	assert.ok(diagnostic, `${spec.caseRef} requires ${spec.expectedCode}`);
	assert.equal(typeof diagnostic.path, 'string');
	assert.ok(Number.isInteger(diagnostic.details?.line));
	assert.ok(Number.isInteger(diagnostic.details?.column));
	assert.ok(Number.isInteger(diagnostic.details?.startOffset));

	return {
		caseRef: spec.caseRef,
		title: spec.title,
		sourceFile: toRepositoryPath(sourcePath),
		sourceSha256: sha256(source),
		expectedCode: spec.expectedCode,
		reason: spec.reason,
		diagnostic: {
			code: diagnostic.code,
			path: diagnostic.path,
			line: diagnostic.details.line,
			column: diagnostic.details.column,
		},
	};
}

export function generateGenericSnippetMatrixReport() {
	const positiveCases = positiveSnippetSpecs.map(verifyPositiveSnippet);
	const negativeCases = negativeSnippetSpecs.map(verifyNegativeSnippet);
	const coverage = [...new Set(positiveCases.flatMap((entry) => entry.coverage))].sort();
	return {
		apiVersion: 1,
		matrixRef: 'education.generic-snippet-matrix.v1',
		pipeline: [
			'TypeScript source',
			'VisualProgramIRV1',
			'n8n workflow fragment',
			'Blockly payload compile',
			'JSON round-trip',
			'isolated source/generated JavaScript equivalence',
		],
		executionBoundary: {
			generatedJavaScript: 'node:vm compileFunction',
			n8nNodeRuntime: 'separate acceptance gate',
		},
		positiveCases,
		negativeCases,
		coverage,
		totals: {
			positiveCases: positiveCases.length,
			negativeCases: negativeCases.length,
			runtimeExecutions: positiveCases.reduce((sum, entry) => sum + entry.executionCount, 0),
			statements: positiveCases.reduce((sum, entry) => sum + entry.statementCount, 0),
			sourceMappings: positiveCases.reduce((sum, entry) => sum + entry.sourceMapCount, 0),
			blocks: positiveCases.reduce((sum, entry) => sum + entry.blockCount, 0),
		},
	};
}

export function serializeGenericSnippetMatrixReport(report) {
	return `${JSON.stringify(report, null, 2)}\n`;
}

export function writeGenericSnippetMatrixReport() {
	const report = generateGenericSnippetMatrixReport();
	const bytes = serializeGenericSnippetMatrixReport(report);
	writeFileSync(matrixReportPath, bytes, 'utf8');
	return { report, bytes };
}

export function createSnippetRequest(spec, source, sourcePath) {
	const base = createGenericImportRequest(source);
	return {
		...base,
		documentRef: `education.generic-snippet.${spec.caseRef}`,
		title: spec.title,
		source: {
			...base.source,
			sourceRef: `source.generic-snippet.${spec.caseRef}`,
			content: source,
			uri: toRepositoryPath(sourcePath),
		},
		workflow: {
			...base.workflow,
			blocklyCode: { ...base.workflow.blocklyCode, label: spec.title },
		},
	};
}

function serializeImportEnvelope(caseRef, request, artifact) {
	return `${JSON.stringify({ apiVersion: 1, caseRef, request, artifact }, null, 2)}\n`;
}

function executeSource(source, input) {
	return execute(() => {
		const run = compileFunction(`'use strict';\n${source}\nreturn transform(input);`, ['input']);
		return run(cloneJson(input));
	});
}

function executeGenerated(javascript, input) {
	return execute(() => {
		const run = compileFunction(`'use strict';\n${javascript}`, ['$json']);
		const result = run(cloneJson(input));
		assert.deepEqual(Object.keys(result), ['json']);
		return result.json;
	});
}

function execute(action) {
	try {
		return { ok: true, value: cloneJson(action()) };
	} catch (error) {
		return { ok: false, error: error instanceof Error ? error.message : String(error) };
	}
}

function cloneJson(value) {
	return JSON.parse(JSON.stringify(value));
}

function collectBlocklyBlockRefs(workspace) {
	const refs = new Set();
	const pending = [workspace];
	while (pending.length > 0) {
		const value = pending.pop();
		if (Array.isArray(value)) {
			pending.push(...value);
			continue;
		}
		if (value === null || typeof value !== 'object') continue;
		if (typeof value.type === 'string' && typeof value.id === 'string') refs.add(value.id);
		pending.push(...Object.values(value));
	}
	return refs;
}

function sha256(value) {
	return createHash('sha256').update(value).digest('hex').toUpperCase();
}

function formatDiagnostics(result) {
	return result.ok ? '' : result.diagnostics.map((diagnostic) => diagnostic.message).join('\n');
}

function toRepositoryPath(path) {
	return relative(repositoryRoot, path).split(sep).join('/');
}

function runCli() {
	const checkOnly = process.argv.includes('--check');
	const report = generateGenericSnippetMatrixReport();
	const bytes = serializeGenericSnippetMatrixReport(report);
	if (checkOnly) {
		assert.equal(readFileSync(matrixReportPath, 'utf8'), bytes, 'checked-in report is stale');
	} else {
		writeFileSync(matrixReportPath, bytes, 'utf8');
	}
	console.log(
		JSON.stringify({
			mode: checkOnly ? 'check' : 'write',
			...report.totals,
			coverage: report.coverage,
			reportSha256: sha256(bytes),
		}),
	);
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) runCli();
