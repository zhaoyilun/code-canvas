#!/usr/bin/env node

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { repositoryRoot } from './generic-dual-canvas-example.mjs';
import {
	createSnippetRequest,
	positiveSnippetSpecs,
	verifyPositiveSnippet,
} from './generic-snippet-matrix.mjs';

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const runtimeHelperPath = resolve(repositoryRoot, 'scripts/blockly-v1/runtime-acceptance.mjs');
const numericSpec = positiveSnippetSpecs.find(({ caseRef }) => caseRef === 'numeric-calculation');

assert.ok(numericSpec, 'numeric-calculation spec is missing from the generic snippet matrix');

export const numericSourcePath = resolve(
	repositoryRoot,
	'docs/education/examples/generic-snippets/numeric-calculation.ts',
);
export const numericWorkflowId = 'education-numeric-calculation-runtime-v1';
export const blocklyNodeType = 'n8n-nodes-blockly-code.blocklyCode';
export const expectedNumericInput = { price: 12.5, quantity: 4 };
export const expectedNumericOutput = { total: 52 };

const require = createRequire(import.meta.url);
const importer = require(
	resolve(repositoryRoot, 'packages/@n8n/dual-canvas-typescript-importer/dist/index.js'),
);
const core = require(resolve(repositoryRoot, 'packages/@n8n/dual-canvas-core/dist/index.js'));
const dataTransform = require(
	resolve(repositoryRoot, 'packages/@n8n/blockly-data-transform/dist/index.js'),
);

export function createNumericImportRequest(source) {
	return importer.typeScriptImportRequestV1Schema.parse(
		createSnippetRequest(numericSpec, source, numericSourcePath),
	);
}

export function generateNumericRuntimeArtifacts() {
	const source = readFileSync(numericSourcePath, 'utf8');
	const matrixGate = verifyPositiveSnippet(numericSpec);
	const request = createNumericImportRequest(source);
	const first = importer.importTypeScriptSource(request);
	assert.equal(first.ok, true, formatDiagnostics(first));
	const second = importer.importTypeScriptSource(request);
	assert.equal(second.ok, true, formatDiagnostics(second));
	assert.equal(
		serializeJson(first.value),
		serializeJson(second.value),
		'importer output must be byte-identical',
	);

	const visualProgramIR = core.visualProgramIRV1Schema.parse(first.value.program);
	const workflowFragment = core.workflowFragmentV1Schema.parse(first.value.workflow);
	const document = core.dualCanvasDocumentV1Schema.parse(first.value.document);
	const workspace = structuredClone(first.value.generatedCanvas.workspace);
	const parsedPayload = dataTransform.parseBlocklyDataPayload(
		first.value.generatedCanvas.blocklyPayload,
	);
	assert.equal(parsedPayload.ok, true, parsedPayload.error);
	assert.deepEqual(parsedPayload.payload.workspace, workspace);
	const compiled = dataTransform.compileBlocklyWorkspace(workspace);
	assert.equal(compiled.ok, true, compiled.error);
	assert.equal(compiled.javascript, first.value.generatedCanvas.javascript);

	const workflow = assembleNumericN8nWorkflow(
		workflowFragment,
		first.value.generatedCanvas.blocklyPayload,
	);
	validateNumericWorkflow(workflow, first.value.generatedCanvas.blocklyPayload);

	return {
		source,
		request,
		visualProgramIR,
		workspace,
		workflowFragment,
		document,
		workflow,
		matrixGate,
		generatedJavaScript: compiled.javascript,
	};
}

export function assembleNumericN8nWorkflow(workflowFragment, blocklyPayload) {
	const manualTrigger = workflowFragment.nodes.find(
		({ bindingRef }) => bindingRef === 'manualTrigger',
	);
	const blocklyCode = workflowFragment.nodes.find(({ bindingRef }) => bindingRef === 'blocklyCode');
	assert.ok(manualTrigger, 'imported workflow must contain the manualTrigger binding');
	assert.ok(blocklyCode, 'imported workflow must contain the blocklyCode binding');
	assert.deepEqual(
		workflowFragment.nodes.map(({ nodeRef }) => nodeRef),
		[manualTrigger.nodeRef, blocklyCode.nodeRef],
	);
	assert.equal(blocklyCode.nodeType, blocklyNodeType);
	assert.equal(blocklyCode.parameters.blocklyPayload, blocklyPayload);
	assert.deepEqual(workflowFragment.entryNodeRefs, [manualTrigger.nodeRef]);
	assert.deepEqual(workflowFragment.exitNodeRefs, [blocklyCode.nodeRef]);
	assert.deepEqual(workflowFragment.connections, [
		{
			connectionRef: workflowFragment.connections[0]?.connectionRef,
			from: { nodeRef: manualTrigger.nodeRef, port: 'main', index: 0 },
			to: { nodeRef: blocklyCode.nodeRef, port: 'main', index: 0 },
		},
	]);

	const triggerName = manualTrigger.label;
	const seedName = 'Seed numeric input';
	const blocklyName = blocklyCode.label;
	assert.equal(new Set([triggerName, seedName, blocklyName]).size, 3, 'node names must be unique');

	return {
		id: numericWorkflowId,
		name: 'Education — imported numeric calculation runtime',
		active: false,
		settings: {},
		nodes: [
			{
				id: manualTrigger.nodeRef,
				name: triggerName,
				type: manualTrigger.nodeType,
				typeVersion: manualTrigger.typeVersion,
				position: [240, 300],
				parameters: structuredClone(manualTrigger.parameters),
			},
			{
				id: 'input-7f214697-8748-5814-b464-f64a9c4df985',
				name: seedName,
				type: 'n8n-nodes-base.set',
				typeVersion: 3.4,
				position: [500, 300],
				parameters: {
					options: {},
					assignments: {
						assignments: [
							{
								id: 'input-price',
								name: 'price',
								type: 'number',
								value: expectedNumericInput.price,
							},
							{
								id: 'input-quantity',
								name: 'quantity',
								type: 'number',
								value: expectedNumericInput.quantity,
							},
						],
					},
				},
			},
			{
				id: blocklyCode.nodeRef,
				name: blocklyName,
				type: blocklyCode.nodeType,
				typeVersion: blocklyCode.typeVersion,
				position: [760, 300],
				parameters: structuredClone(blocklyCode.parameters),
			},
		],
		connections: {
			[triggerName]: { main: [[{ node: seedName, type: 'main', index: 0 }]] },
			[seedName]: { main: [[{ node: blocklyName, type: 'main', index: 0 }]] },
		},
	};
}

export function validateNumericWorkflow(workflow, blocklyPayload) {
	assert.equal(workflow.id, numericWorkflowId);
	assert.equal(workflow.active, false);
	assert.deepEqual(
		workflow.nodes.map(({ type }) => type),
		['n8n-nodes-base.manualTrigger', 'n8n-nodes-base.set', blocklyNodeType],
	);
	const seedNode = getSingleNodeByType(workflow, 'n8n-nodes-base.set');
	assert.deepEqual(seedNode.parameters.assignments.assignments, [
		{ id: 'input-price', name: 'price', type: 'number', value: expectedNumericInput.price },
		{
			id: 'input-quantity',
			name: 'quantity',
			type: 'number',
			value: expectedNumericInput.quantity,
		},
	]);
	const blocklyNode = getSingleNodeByType(workflow, blocklyNodeType);
	assert.equal(blocklyNode.parameters.blocklyPayload, blocklyPayload);
	assert.ok(!serializeJson(workflow).includes('"CUSTOM.'));
	return {
		workflowId: workflow.id,
		nodeType: blocklyNode.type,
		blocklyNodeName: blocklyNode.name,
		seedNodeName: seedNode.name,
	};
}

export function verifyNumericExecution(execution, workflow) {
	assert.equal(execution.status, 'success');
	assert.equal(execution.finished, true);
	const { blocklyNodeName, seedNodeName } = validateNumericWorkflow(
		workflow,
		getSingleNodeByType(workflow, blocklyNodeType).parameters.blocklyPayload,
	);
	const runData = execution.data?.resultData?.runData;
	assert.ok(runData && typeof runData === 'object', 'execution runData is missing');

	const seedRuns = runData[seedNodeName];
	assert.ok(Array.isArray(seedRuns) && seedRuns.length === 1, 'seed node must run exactly once');
	assert.equal(seedRuns[0].executionStatus, 'success');
	assert.deepEqual(seedRuns[0].data?.main?.[0]?.[0]?.json, expectedNumericInput);

	const blocklyRuns = runData[blocklyNodeName];
	assert.ok(
		Array.isArray(blocklyRuns) && blocklyRuns.length === 1,
		'Blockly node must run exactly once',
	);
	assert.equal(blocklyRuns[0].executionStatus, 'success');
	const outputItems = blocklyRuns[0].data?.main?.[0];
	assert.deepEqual(outputItems, [
		{
			json: expectedNumericOutput,
			pairedItem: { item: 0 },
		},
	]);

	return {
		status: 'passed',
		workflowId: workflow.id,
		nodeType: blocklyNodeType,
		input: expectedNumericInput,
		output: expectedNumericOutput,
		pairedItem: 0,
	};
}

export function writeNumericArtifactEvidence(evidenceDir, artifacts) {
	mkdirSync(evidenceDir, { recursive: true });
	const evidence = {
		source: writeEvidenceFile(evidenceDir, 'source.ts', artifacts.source, false),
		request: writeEvidenceFile(evidenceDir, 'import-request.json', artifacts.request),
		visualProgramIR: writeEvidenceFile(
			evidenceDir,
			'visual-program-ir.json',
			artifacts.visualProgramIR,
		),
		workspace: writeEvidenceFile(evidenceDir, 'blockly-workspace.json', artifacts.workspace),
		workflowFragment: writeEvidenceFile(
			evidenceDir,
			'workflow-fragment.json',
			artifacts.workflowFragment,
		),
		document: writeEvidenceFile(evidenceDir, 'dual-canvas-document.json', artifacts.document),
		workflow: writeEvidenceFile(evidenceDir, 'workflow.json', artifacts.workflow),
	};
	writeEvidenceFile(evidenceDir, 'artifact-manifest.json', evidence);
	return evidence;
}

export function parseArguments(arguments_) {
	let checkOnly = false;
	let runtimeDir;
	for (let index = 0; index < arguments_.length; index++) {
		const argument = arguments_[index];
		if (argument === '--check') {
			checkOnly = true;
		} else if (argument === '--runtime-dir') {
			runtimeDir = arguments_[++index];
			if (!runtimeDir) throw new Error('--runtime-dir requires a path');
		} else if (argument.startsWith('--runtime-dir=')) {
			runtimeDir = argument.slice('--runtime-dir='.length);
			if (!runtimeDir) throw new Error('--runtime-dir requires a path');
		} else {
			throw new Error(
				'Usage: node scripts/education/numeric-runtime-acceptance.mjs [--check] [--runtime-dir=<path>]',
			);
		}
	}
	return { checkOnly, runtimeDir };
}

async function main() {
	const options = parseArguments(process.argv.slice(2));
	const first = generateNumericRuntimeArtifacts();
	const second = generateNumericRuntimeArtifacts();
	assert.equal(
		serializeJson(first.workflow),
		serializeJson(second.workflow),
		'generated n8n workflow must be byte-identical',
	);
	if (options.checkOnly) {
		console.log(
			JSON.stringify({
				status: 'passed',
				mode: 'check',
				workflowId: first.workflow.id,
				nodeType: blocklyNodeType,
				input: expectedNumericInput,
				expectedOutput: expectedNumericOutput,
				workflowSha256: sha256(serializeJson(first.workflow)),
			}),
		);
		return;
	}

	const runtimeDirectory = resolve(
		options.runtimeDir ?? join(scriptDirectory, '.runtime', 'numeric-acceptance', runtimeName()),
	);

	const runtimeHelper = await import(pathToFileURL(runtimeHelperPath).href);
	assert.equal(
		typeof runtimeHelper.runWorkflowAcceptance,
		'function',
		'runtime helper must export runWorkflowAcceptance',
	);
	const runtimeResult = await runtimeHelper.runWorkflowAcceptance({
		runtimeDir: runtimeDirectory,
		workflow: first.workflow,
		workflowPath: join(runtimeDirectory, 'evidence', 'workflow.json'),
		executionPath: join(runtimeDirectory, 'evidence', 'execution.json'),
		logDirectory: join(runtimeDirectory, 'evidence', 'runtime-logs'),
		stageEvidence: ({ evidenceDir }) => writeNumericArtifactEvidence(evidenceDir, first),
	});
	const { evidenceDir } = runtimeResult;
	const verification = verifyNumericExecution(runtimeResult.execution, first.workflow);
	const result = {
		...verification,
		n8nPort: runtimeResult.n8nPort,
		brokerPort: runtimeResult.brokerPort,
		runnersMode: runtimeResult.runnersMode,
		runnersInsecureMode: runtimeResult.runnersInsecureMode,
		...runtimeResult.taskRunnerEvidence,
		evidenceDir,
	};
	writeEvidenceFile(evidenceDir, 'result.json', result);
	console.log(JSON.stringify(result));
	console.log(`PASS: importer-generated workflow returned total=${expectedNumericOutput.total}`);
	console.log(`Evidence retained at: ${evidenceDir}`);
}

function getSingleNodeByType(workflow, nodeType) {
	const matches = workflow.nodes.filter(({ type }) => type === nodeType);
	assert.equal(matches.length, 1, `workflow requires exactly one ${nodeType} node`);
	return matches[0];
}

function writeEvidenceFile(evidenceDir, name, value, json = true) {
	const bytes = json ? serializeJson(value) : value;
	const path = join(evidenceDir, name);
	writeFileSync(path, bytes, 'utf8');
	return {
		path,
		bytes: Buffer.byteLength(bytes),
		sha256: sha256(bytes),
	};
}

function serializeJson(value) {
	return `${JSON.stringify(value, null, 2)}\n`;
}

function sha256(value) {
	return createHash('sha256').update(value).digest('hex').toUpperCase();
}

function formatDiagnostics(result) {
	return result.ok ? '' : result.diagnostics.map(({ message }) => message).join('\n');
}

function runtimeName() {
	return `${new Date().toISOString().replace(/[-:.]/g, '')}-${process.pid}`;
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
	main().catch((error) => {
		console.error(error instanceof Error ? error.stack : error);
		process.exitCode = 1;
	});
}
