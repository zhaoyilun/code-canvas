import {
	compileBlocklyWorkspace,
	parseBlocklyDataPayload,
	serializeBlocklyDataPayload,
} from '@n8n/blockly-data-transform';
import {
	canvasArtifactV1Schema,
	dualCanvasDocumentV1Schema,
	visualProgramIRV1Schema,
	workflowFragmentV1Schema,
} from '@n8n/dual-canvas-core';
import { createOperationBlockTypeV1 } from '@n8n/dual-canvas-operation-runtime';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
	TYPE_SCRIPT_IMPORTER_REF,
	TYPE_SCRIPT_IMPORTER_OPERATION_REF,
	TYPE_SCRIPT_IMPORTER_SEMANTICS_REF,
	importTypeScriptSource,
	typescriptSourceImporterV1,
} from './importer';
import { createTestRequest, scoreOperationCatalog } from './test-support';

const clampScoreOperation = scoreOperationCatalog.modules.find(
	(module) => module.qualifiedName === 'clampScore',
);
if (clampScoreOperation === undefined) throw new Error('clamp operation fixture is missing');

const exampleSource = readFileSync(resolve(__dirname, '../examples/score-normalizer.ts'), 'utf8');

describe('TypeScript source importer', () => {
	it('builds valid linked IR, Blockly, workflow, and document artifacts', () => {
		const result = importTypeScriptSource(createTestRequest(exampleSource));

		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(visualProgramIRV1Schema.safeParse(result.value.program).success).toBe(true);
		expect(canvasArtifactV1Schema.safeParse(result.value.canvas).success).toBe(true);
		expect(workflowFragmentV1Schema.safeParse(result.value.workflow).success).toBe(true);
		expect(dualCanvasDocumentV1Schema.safeParse(result.value.document).success).toBe(true);

		expect(result.value.workflow.nodes).toHaveLength(2);
		expect(result.value.workflow.nodes.map((node) => node.nodeType)).toEqual([
			'example.nodes.start',
			'example.nodes.transform',
		]);
		expect(result.value.workflow.connections).toHaveLength(1);
		expect(result.value.workflow.connections[0]?.from.nodeRef).toBe(
			result.value.workflow.entryNodeRefs[0],
		);
		expect(result.value.workflow.connections[0]?.to.nodeRef).toBe(
			result.value.workflow.exitNodeRefs[0],
		);
		expect(result.value.canvas.ownerNodeRef).toBe(result.value.workflow.exitNodeRefs[0]);
		expect(result.value.program.nodes[1]?.logic).toEqual(result.value.logic);
		expect(result.value.document.canvases).toEqual([result.value.canvas]);
		expect(result.value.program.metadata).toMatchObject({
			importerRef: TYPE_SCRIPT_IMPORTER_REF,
			sourceSemanticsRef: TYPE_SCRIPT_IMPORTER_SEMANTICS_REF,
		});

		const blockMappings = result.value.program.sourceMap.filter(
			(mapping) => mapping.artifact.kind === 'canvasBlock',
		);
		expect(blockMappings).toHaveLength(9);
		expect(blockMappings.every((mapping) => mapping.source?.sourceRef === 'source.main')).toBe(
			true,
		);
		expect(result.value.program.sourceMap).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					artifact: { kind: 'workflowNode', ref: result.value.logic.nodeRef },
				}),
				expect.objectContaining({
					artifact: { kind: 'canvas', ref: result.value.canvas.canvasRef },
				}),
			]),
		);
	});

	it('implements SourceImporterV1 and returns only VisualProgramIRV1 through the core contract', () => {
		const request = createTestRequest(exampleSource);
		const result = typescriptSourceImporterV1.importSource({
			apiVersion: 1,
			documentRef: request.documentRef,
			revisionRef: request.revisionRef,
			profileRef: request.profileRef,
			source: request.source,
			options: {
				apiVersion: 1,
				title: request.title,
				entryFunction: request.entryFunction,
				operationCatalog: request.operationCatalog,
			},
		});

		expect(typescriptSourceImporterV1).toMatchObject({
			apiVersion: 1,
			importerRef: TYPE_SCRIPT_IMPORTER_REF,
			supportedLanguages: ['javascript', 'typescript', 'arkts'],
		});
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(visualProgramIRV1Schema.safeParse(result.value).success).toBe(true);
		expect(result.value).not.toHaveProperty('program');
		expect(result.value.nodes).toHaveLength(1);
		expect(result.value.edges).toEqual([]);
		expect(result.value.nodes[0]).toMatchObject({
			operationRef: TYPE_SCRIPT_IMPORTER_OPERATION_REF,
			parameters: {},
		});
		expect(result.value.nodes[0]?.logic?.nodeRef).toBe(result.value.nodes[0]?.nodeRef);
		expect(result.value.nodes[0]?.metadata).not.toHaveProperty('canvasRef');
		expect(JSON.stringify(result.value)).not.toContain('blocklyPayload');
		expect(JSON.stringify(result.value)).not.toContain('example.nodes');
	});

	it('imports a registered pure operation as one dynamic Blockly block and recompiles it', () => {
		const source = `function transform(input) {
	const output = {};
	output.score = clampScore(input?.score ?? null, 0, 100);
	return output;
}`;
		const result = importTypeScriptSource({
			...createTestRequest(source),
			operationCatalog: scoreOperationCatalog,
		});

		if (!result.ok) throw new Error(JSON.stringify(result.diagnostics, null, 2));
		expect(result.value.logic.statements[0]).toMatchObject({
			kind: 'set',
			value: {
				kind: 'operationCall',
				operationRef: 'operation.clamp-score.v1',
				implementationRef: clampScoreOperation.implementationRef,
				qualifiedName: 'clampScore',
			},
		});
		const parsedPayload = parseBlocklyDataPayload(result.value.generatedCanvas.blocklyPayload);
		expect(parsedPayload.ok).toBe(true);
		if (!parsedPayload.ok) return;
		expect(parsedPayload.payload.operationCatalog).toEqual(scoreOperationCatalog);
		const workspaceJson = JSON.stringify(parsedPayload.payload.workspace);
		expect(workspaceJson).toContain(
			createOperationBlockTypeV1(
				'operation.clamp-score.v1',
				clampScoreOperation.implementationRef,
				'1.0.0',
			),
		);
		expect(workspaceJson).toContain(
			`"IMPLEMENTATION_REF":"${clampScoreOperation.implementationRef}"`,
		);
		expect(workspaceJson).toContain('"QUALIFIED_NAME":"clampScore"');
		const operationMapping = result.value.generatedCanvas.sourceMap.find(
			(mapping) => mapping.context?.expressionKind === 'operationCall',
		);
		expect(operationMapping).toMatchObject({
			artifact: { kind: 'canvasBlock' },
			source: { sourceRef: 'source.main', start: { offset: source.indexOf('clampScore(') } },
			context: {
				operationRef: 'operation.clamp-score.v1',
				implementationRef: clampScoreOperation.implementationRef,
			},
		});
		const compiled = compileBlocklyWorkspace(
			parsedPayload.payload.workspace,
			parsedPayload.payload.operationCatalog,
		);
		expect(compiled).toMatchObject({
			ok: true,
			javascript: result.value.generatedCanvas.javascript,
		});
	});

	it('keeps workflow bindings and canvas configuration out of core importer options', () => {
		const request = createTestRequest(exampleSource);
		const result = typescriptSourceImporterV1.importSource({
			apiVersion: 1,
			documentRef: request.documentRef,
			revisionRef: request.revisionRef,
			profileRef: request.profileRef,
			source: request.source,
			options: {
				apiVersion: 1,
				title: request.title,
				entryFunction: request.entryFunction,
				operationCatalog: request.operationCatalog,
				bindings: request.bindings,
			},
		});

		expect(result).toMatchObject({
			ok: false,
			diagnostics: [{ code: 'SOURCE_IMPORT_OPTIONS_INVALID' }],
		});
	});

	it('returns options diagnostics through SourceImporterV1 without starting high-level generation', () => {
		const request = createTestRequest(exampleSource);
		const result = typescriptSourceImporterV1.importSource({
			apiVersion: 1,
			documentRef: request.documentRef,
			revisionRef: request.revisionRef,
			profileRef: request.profileRef,
			source: request.source,
		});

		expect(result).toMatchObject({
			ok: false,
			diagnostics: [{ code: 'SOURCE_IMPORT_OPTIONS_INVALID' }],
		});
	});

	it('round-trips the canonical Blockly payload and compiled preview', () => {
		const result = importTypeScriptSource(createTestRequest(exampleSource));
		expect(result.ok).toBe(true);
		if (!result.ok) return;

		const parsed = parseBlocklyDataPayload(result.value.generatedCanvas.blocklyPayload);
		expect(parsed.ok).toBe(true);
		if (!parsed.ok) return;
		expect(
			serializeBlocklyDataPayload(parsed.payload.workspace, parsed.payload.operationCatalog),
		).toBe(result.value.generatedCanvas.blocklyPayload);
		const compiled = compileBlocklyWorkspace(
			parsed.payload.workspace,
			parsed.payload.operationCatalog,
		);
		expect(compiled).toMatchObject({
			ok: true,
			javascript: result.value.generatedCanvas.javascript,
		});
		expect(result.value.canvas.preview).toBe(result.value.generatedCanvas.javascript);
	});

	it('is deterministic and scopes every generated identity to the document', () => {
		const request = createTestRequest(exampleSource);
		const first = importTypeScriptSource(request);
		const second = importTypeScriptSource(request);
		const other = importTypeScriptSource({
			...request,
			documentRef: 'lesson.score-normalizer.second',
		});

		expect(first).toEqual(second);
		expect(first.ok).toBe(true);
		expect(other.ok).toBe(true);
		if (!first.ok || !other.ok) return;
		expect(first.value.workflow.fragmentRef).not.toBe(other.value.workflow.fragmentRef);
		expect(first.value.generatedCanvas.blocklyPayload).not.toBe(
			other.value.generatedCanvas.blocklyPayload,
		);
		expect(first.value.program.sourceMap).not.toEqual(other.value.program.sourceMap);
	});

	it('returns binding diagnostics before producing a workflow fragment', () => {
		const request = createTestRequest(exampleSource);
		const result = importTypeScriptSource({
			...request,
			bindings: {
				...request.bindings,
				nodeTypes: { manual: 'example.nodes.start' },
			},
		});

		expect(result).toEqual({
			ok: false,
			diagnostics: [
				expect.objectContaining({
					code: 'NODE_TYPE_BINDING_MISSING',
					path: 'nodeTypes.logic',
				}),
			],
		});
	});

	it('returns structured request and source diagnostics', () => {
		const invalidRequest = importTypeScriptSource({ apiVersion: 1 });
		expect(invalidRequest.ok).toBe(false);
		if (invalidRequest.ok) return;
		expect(invalidRequest.diagnostics[0]).toMatchObject({
			code: 'IMPORT_REQUEST_INVALID',
			severity: 'error',
		});

		const result = importTypeScriptSource(
			createTestRequest(`function transform(input) {
	const output = {};
	while (input.pending) output.value = input.value;
	return output;
}`),
		);
		expect(result).toMatchObject({
			ok: false,
			diagnostics: [
				{
					code: 'UNSUPPORTED_SYNTAX',
					path: 'source.3.1',
					details: { line: 3, column: 1 },
				},
			],
		});
	});
});
