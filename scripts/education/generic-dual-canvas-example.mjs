#!/usr/bin/env node

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
export const repositoryRoot = resolve(scriptDirectory, '../..');
export const sourcePath = resolve(
	repositoryRoot,
	'docs/education/examples/generic-score-normalizer.ts',
);
export const outputPath = resolve(
	repositoryRoot,
	'docs/education/examples/generic-score-normalizer.dual-canvas.json',
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

export function createGenericImportRequest(source) {
	return {
		apiVersion: 1,
		documentRef: 'education.generic-score-normalizer',
		revisionRef: 'revision.1',
		title: 'Generic score normalizer',
		profileRef: 'education.generic-data-transform',
		entryFunction: 'transform',
		source: {
			apiVersion: 1,
			sourceRef: 'source.generic-score-normalizer',
			language: 'typescript',
			content: source,
			uri: 'docs/education/examples/generic-score-normalizer.ts',
		},
		bindings: {
			apiVersion: 1,
			packageName: 'n8n-nodes-blockly-code',
			nodeTypes: {
				manualTrigger: expectedNodeTypes[0],
				blocklyCode: expectedNodeTypes[1],
			},
		},
		workflow: {
			manualTrigger: {
				bindingRef: 'manualTrigger',
				typeVersion: 1,
				label: 'Start',
			},
			blocklyCode: {
				bindingRef: 'blocklyCode',
				typeVersion: 1,
				label: 'Normalize score',
			},
		},
		canvasAdapterRef: 'blockly.data-transform.v1',
	};
}

export function generateGenericDualCanvasExample() {
	const source = readFileSync(sourcePath, 'utf8');
	const request = createGenericImportRequest(source);
	const result = importer.importTypeScriptSource(request);
	assert.equal(result.ok, true, formatDiagnostics(result));
	const importerManifest = readManifest(
		'packages/@n8n/dual-canvas-typescript-importer/package.json',
	);

	const example = {
		apiVersion: 1,
		exampleRef: 'education.generic-score-normalizer',
		generatedBy: `${importerManifest.name}@${importerManifest.version}`,
		sourceFile: toRepositoryPath(sourcePath),
		request,
		visualProgramIR: result.value.program,
		generatedLogicCanvas: result.value.generatedCanvas,
		dualCanvasDocument: result.value.document,
	};
	validateGenericDualCanvasExample(example);
	return example;
}

export function validateGenericDualCanvasExample(example) {
	assert.equal(example.apiVersion, 1);
	assert.equal(example.exampleRef, 'education.generic-score-normalizer');

	const request = importer.typeScriptImportRequestV1Schema.parse(example.request);
	const program = core.visualProgramIRV1Schema.parse(example.visualProgramIR);
	const document = core.dualCanvasDocumentV1Schema.parse(example.dualCanvasDocument);
	const workflow = core.workflowFragmentV1Schema.parse(document.workflow);
	assert.equal(document.canvases.length, 1);
	const canvas = core.canvasArtifactV1Schema.parse(document.canvases[0]);

	assert.equal(program.documentRef, request.documentRef);
	assert.equal(document.documentRef, request.documentRef);
	assert.deepEqual(program.sources, [request.source]);
	assert.deepEqual(document.sources, [request.source]);
	assert.deepEqual(program.sourceMap, document.sourceMap);

	assert.deepEqual(
		workflow.nodes.map((node) => node.nodeType),
		expectedNodeTypes,
	);
	assert.deepEqual(
		workflow.nodes.map((node) => node.bindingRef),
		['manualTrigger', 'blocklyCode'],
	);
	assert.equal(workflow.connections.length, 1);
	assert.equal(workflow.connections[0].from.nodeRef, workflow.entryNodeRefs[0]);
	assert.equal(workflow.connections[0].to.nodeRef, workflow.exitNodeRefs[0]);
	assert.equal(canvas.ownerNodeRef, workflow.exitNodeRefs[0]);
	assert.ok(workflow.nodes.every((node) => !node.nodeType.startsWith('CUSTOM.')));

	const logicNode = program.nodes.find((node) => node.nodeRef === workflow.exitNodeRefs[0]);
	assert.ok(logicNode?.logic, 'VisualProgramIRV1 requires embedded logic for the Blockly node');
	const statements = core.flattenLogicStatements(logicNode.logic.statements);
	const workspaceBlockIds = collectBlocklyBlockIds(example.generatedLogicCanvas.workspace);
	const blockMappings = program.sourceMap.filter(
		(mapping) => mapping.artifact.kind === 'canvasBlock',
	);
	assert.equal(blockMappings.length, statements.length);
	for (const statement of statements) {
		const mapping = blockMappings.find((entry) => entry.semanticRef === statement.stepRef);
		assert.ok(mapping, `source mapping is required for ${statement.stepRef}`);
		assert.equal(mapping.source?.sourceRef, request.source.sourceRef);
		assert.ok(workspaceBlockIds.has(mapping.artifact.ref));
	}

	const sourceMappedKinds = new Set(
		program.sourceMap
			.filter((mapping) => mapping.source?.sourceRef === request.source.sourceRef)
			.map((mapping) => mapping.artifact.kind),
	);
	assert.ok(sourceMappedKinds.has('workflowNode'));
	assert.ok(sourceMappedKinds.has('canvas'));
	assert.ok(sourceMappedKinds.has('canvasBlock'));
	assert.deepEqual(
		canvas.sourceMap.map((mapping) => mapping.mappingRef),
		program.sourceMap
			.filter(
				(mapping) => mapping.artifact.kind === 'canvas' || mapping.artifact.kind === 'canvasBlock',
			)
			.map((mapping) => mapping.mappingRef),
	);

	assert.equal(canvas.payload, example.generatedLogicCanvas.blocklyPayload);
	assert.equal(canvas.preview, example.generatedLogicCanvas.javascript);
	const parsedPayload = dataTransform.parseBlocklyDataPayload(canvas.payload);
	assert.equal(parsedPayload.ok, true, parsedPayload.error);
	const compiled = dataTransform.compileBlocklyWorkspace(parsedPayload.payload.workspace);
	assert.equal(compiled.ok, true, compiled.error);
	assert.equal(compiled.javascript, example.generatedLogicCanvas.javascript);
	assert.deepEqual(parsedPayload.payload.workspace, example.generatedLogicCanvas.workspace);

	const serialized = serializeGenericDualCanvasExample(example);
	assert.deepEqual(JSON.parse(serialized), example);
	assert.ok(!serialized.includes('"CUSTOM.'));

	return {
		nodeCount: workflow.nodes.length,
		statementCount: statements.length,
		sourceMapCount: program.sourceMap.length,
		blockCount: workspaceBlockIds.size,
	};
}

export function serializeGenericDualCanvasExample(example) {
	return `${JSON.stringify(example, null, 2)}\n`;
}

export function verifyRuntimeDependencyBoundary() {
	const manifests = [
		readManifest('packages/@n8n/dual-canvas-typescript-importer/package.json'),
		readManifest('packages/@n8n/dual-canvas-core/package.json'),
		readManifest('packages/@n8n/blockly-data-transform/package.json'),
	];
	const workspaceRuntimeDependencies = [
		...new Set(
			manifests.flatMap((manifest) =>
				Object.keys(manifest.dependencies ?? {}).filter((name) => name.startsWith('@n8n/')),
			),
		),
	].sort();
	assert.deepEqual(workspaceRuntimeDependencies, [
		'@n8n/blockly-data-transform',
		'@n8n/dual-canvas-core',
	]);
	return { workspaceRuntimeDependencies };
}

export function writeGenericDualCanvasExample() {
	const first = generateGenericDualCanvasExample();
	const second = generateGenericDualCanvasExample();
	const firstBytes = serializeGenericDualCanvasExample(first);
	const secondBytes = serializeGenericDualCanvasExample(second);
	assert.equal(firstBytes, secondBytes, 'repeated generation must be byte-identical');
	assert.deepEqual(JSON.parse(firstBytes), first);
	verifyRuntimeDependencyBoundary();

	mkdirSync(dirname(outputPath), { recursive: true });
	writeFileSync(outputPath, firstBytes, 'utf8');
	return {
		...validateGenericDualCanvasExample(first),
		outputPath,
		bytes: Buffer.byteLength(firstBytes),
		sha256: createHash('sha256').update(firstBytes).digest('hex').toUpperCase(),
	};
}

function collectBlocklyBlockIds(workspace) {
	const ids = new Set();
	const pending = [workspace];
	while (pending.length > 0) {
		const value = pending.pop();
		if (Array.isArray(value)) {
			pending.push(...value);
			continue;
		}
		if (!value || typeof value !== 'object') continue;
		if (typeof value.type === 'string' && typeof value.id === 'string') ids.add(value.id);
		pending.push(...Object.values(value));
	}
	return ids;
}

function readManifest(repositoryPath) {
	return JSON.parse(readFileSync(resolve(repositoryRoot, repositoryPath), 'utf8'));
}

function formatDiagnostics(result) {
	return result.ok ? '' : result.diagnostics.map((diagnostic) => diagnostic.message).join('\n');
}

function toRepositoryPath(path) {
	return relative(repositoryRoot, path).split(sep).join('/');
}

function runCli() {
	const checkOnly = process.argv.includes('--check');
	const first = generateGenericDualCanvasExample();
	const firstBytes = serializeGenericDualCanvasExample(first);
	const secondBytes = serializeGenericDualCanvasExample(generateGenericDualCanvasExample());
	assert.equal(firstBytes, secondBytes, 'repeated generation must be byte-identical');
	const dependencyBoundary = verifyRuntimeDependencyBoundary();
	const validation = validateGenericDualCanvasExample(first);
	const report = checkOnly
		? {
				...validation,
				mode: 'check',
				sha256: createHash('sha256').update(firstBytes).digest('hex').toUpperCase(),
				...dependencyBoundary,
			}
		: { ...writeGenericDualCanvasExample(), mode: 'write', ...dependencyBoundary };
	console.log(JSON.stringify(report));
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) runCli();
