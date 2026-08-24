#!/usr/bin/env node

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { compileFunction } from 'node:vm';

import {
	assertFreshBuildOutputs,
	getBuildOutputProblems,
	runWorkflowAcceptance,
} from '../blockly-v1/runtime-acceptance.mjs';

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
export const repositoryRoot = resolve(scriptDirectory, '../..');
const require = createRequire(import.meta.url);

const packageDirectory = (name) => resolve(repositoryRoot, 'packages/@n8n', name);
const packageOutput = (name) => resolve(packageDirectory(name), 'dist/index.js');
const packageBuildMarker = (name) => resolve(packageDirectory(name), 'dist/build.tsbuildinfo');
const operationRuntimeBuildMarker = packageBuildMarker('dual-canvas-operation-runtime');
const coreBuildMarker = packageBuildMarker('dual-canvas-core');
const operationSdkBuildMarker = packageBuildMarker('dual-canvas-operation-sdk');

export const unknownOperationBuildRequirements = [
	createPackageBuildRequirement(
		'dual-canvas-operation-runtime',
		'@n8n/dual-canvas-operation-runtime',
	),
	createPackageBuildRequirement('dual-canvas-core', '@n8n/dual-canvas-core', [
		operationRuntimeBuildMarker,
	]),
	createPackageBuildRequirement('dual-canvas-operation-sdk', '@n8n/dual-canvas-operation-sdk', [
		operationRuntimeBuildMarker,
	]),
	createPackageBuildRequirement(
		'dual-canvas-typescript-importer',
		'@n8n/dual-canvas-typescript-importer',
		[coreBuildMarker, operationSdkBuildMarker, operationRuntimeBuildMarker],
	),
	createPackageBuildRequirement('blockly-data-transform', '@n8n/blockly-data-transform', [
		operationRuntimeBuildMarker,
	]),
];

ensureFreshPackageBuilds();

const importer = require(
	resolve(repositoryRoot, 'packages/@n8n/dual-canvas-typescript-importer/dist/index.js'),
);
const core = require(resolve(repositoryRoot, 'packages/@n8n/dual-canvas-core/dist/index.js'));
const operationSdk = require(
	resolve(repositoryRoot, 'packages/@n8n/dual-canvas-operation-sdk/dist/index.js'),
);
const operationRuntime = require(
	resolve(repositoryRoot, 'packages/@n8n/dual-canvas-operation-runtime/dist/index.js'),
);
const dataTransform = require(
	resolve(repositoryRoot, 'packages/@n8n/blockly-data-transform/dist/index.js'),
);

export const clampSourcePath = resolve(
	repositoryRoot,
	'docs/education/examples/unknown-operation-clamp.ts',
);
export const clampWorkflowId = 'education-unknown-operation-clamp-runtime-v1';
export const blocklyNodeType = 'n8n-nodes-blockly-code.blocklyCode';
export const expectedClampInput = { score: 125 };
export const expectedClampOutput = { score: 100 };

const emptyOperationCatalog = Object.freeze({ apiVersion: 1, modules: [] });

function createGenericImportRequest(source) {
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
				manualTrigger: 'n8n-nodes-base.manualTrigger',
				blocklyCode: blocklyNodeType,
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
		operationCatalog: emptyOperationCatalog,
	};
}

export function createClampImportRequest(source, operationCatalog = emptyOperationCatalog) {
	const base = createGenericImportRequest(source);
	return importer.typeScriptImportRequestV1Schema.parse({
		...base,
		documentRef: 'education.unknown-operation-clamp',
		revisionRef: 'revision.1',
		title: 'Generated clamp operation',
		profileRef: 'education.generic-operation-module',
		source: {
			...base.source,
			sourceRef: 'source.unknown-operation-clamp',
			content: source,
			uri: 'docs/education/examples/unknown-operation-clamp.ts',
		},
		workflow: {
			...base.workflow,
			blocklyCode: { ...base.workflow.blocklyCode, label: 'Clamp score' },
		},
		operationCatalog,
	});
}

export function createClampModuleDraft(scaffoldRequest) {
	const template = operationSdk.createOperationModuleTemplateV1(scaffoldRequest);
	const [value, minimum, maximum] = template.parameters;
	assert.ok(value && minimum && maximum, 'clamp template must expose three parameters');

	const parameter = (parameterRef) => ({ kind: 'parameter', parameterRef });
	const literal = (literalValue) => ({ kind: 'literal', value: literalValue });
	const compare = (operator, left, right) => ({ kind: 'binary', operator, left, right });
	const conditional = (condition, whenTrue, whenFalse) => ({
		kind: 'conditional',
		condition,
		whenTrue,
		whenFalse,
	});

	return operationSdk.operationModuleDraftSpecV1Schema.parse({
		apiVersion: 1,
		requestRef: scaffoldRequest.requestRef,
		operationRef: template.identity.operationRef,
		implementationRef: null,
		qualifiedName: scaffoldRequest.qualifiedName,
		arity: scaffoldRequest.arity,
		version: '1.0.0',
		behaviorSummary:
			'Return null for null input; otherwise constrain a number to inclusive bounds.',
		execution: 'synchronous',
		determinism: 'deterministic',
		effects: 'none',
		dataFlow: 'json-to-json',
		parameters: [
			{ parameterRef: value.parameterRef, name: 'value', type: 'number', nullPolicy: 'allow' },
			{
				parameterRef: minimum.parameterRef,
				name: 'minimum',
				type: 'number',
				nullPolicy: 'reject',
			},
			{
				parameterRef: maximum.parameterRef,
				name: 'maximum',
				type: 'number',
				nullPolicy: 'reject',
			},
		],
		output: { type: 'number', nullPolicy: 'allow' },
		expression: conditional(
			compare('eq', parameter(value.parameterRef), literal(null)),
			literal(null),
			conditional(
				compare('lt', parameter(value.parameterRef), parameter(minimum.parameterRef)),
				parameter(minimum.parameterRef),
				conditional(
					compare('gt', parameter(value.parameterRef), parameter(maximum.parameterRef)),
					parameter(maximum.parameterRef),
					parameter(value.parameterRef),
				),
			),
		),
		testVectors: [
			{ name: 'below minimum', arguments: [-2, 0, 10], expected: 0 },
			{ name: 'inside range', arguments: [6, 0, 10], expected: 6 },
			{ name: 'above maximum', arguments: [12, 0, 10], expected: 10 },
			{ name: 'null propagation', arguments: [null, 0, 10], expected: null },
		],
	});
}

export function finalizeClampModuleDraft(draftInput) {
	const draft = operationSdk.operationModuleDraftSpecV1Schema.parse(draftInput);
	return operationSdk.finalizeOperationModuleSpecV1(draft);
}

export function createClampModuleSpec(scaffoldRequest) {
	return finalizeClampModuleDraft(createClampModuleDraft(scaffoldRequest));
}

export function createClampBlockDescriptor(moduleSpec) {
	return operationRuntime.createOperationBlockDescriptorV1(moduleSpec);
}

export function createClampOperationCatalog(moduleSpec) {
	return operationRuntime.createOperationModuleCatalogV1({
		apiVersion: 1,
		modules: [moduleSpec],
	});
}

export function generateUnknownOperationArtifacts() {
	const source = readFileSync(clampSourcePath, 'utf8');
	const initialRequest = createClampImportRequest(source);
	const firstInitialImport = importer.importTypeScriptSource(initialRequest);
	const secondInitialImport = importer.importTypeScriptSource(initialRequest);
	assert.equal(firstInitialImport.ok, false, 'first import must discover the unknown operation');
	assert.equal(secondInitialImport.ok, false, 'repeated first import must remain diagnostic');
	assert.equal(serializeJson(firstInitialImport), serializeJson(secondInitialImport));
	assert.equal(firstInitialImport.diagnostics.length, 1);
	assert.equal(firstInitialImport.diagnostics[0]?.code, 'OPERATION_MODULE_MISSING');

	const scaffoldRequest = operationSdk.moduleScaffoldRequestV1Schema.parse(
		firstInitialImport.diagnostics[0]?.details,
	);
	assert.equal(scaffoldRequest.qualifiedName, 'clampScore');
	assert.equal(scaffoldRequest.arity, 3);
	assert.equal(scaffoldRequest.calls.length, 1);
	const moduleTemplate = operationSdk.createOperationModuleTemplateV1(scaffoldRequest);
	const moduleDraft = createClampModuleDraft(scaffoldRequest);
	assert.equal(moduleTemplate.identity.implementationRef, null);
	assert.equal(moduleDraft.implementationRef, null);
	const moduleSpec = finalizeClampModuleDraft(moduleDraft);
	for (const vector of moduleSpec.testVectors) {
		assert.equal(vector.expected, clampOracle(...vector.arguments));
	}
	const moduleAdmission = operationSdk.operationModuleAdmissionV1Schema.parse({
		request: scaffoldRequest,
		spec: moduleSpec,
	});
	const moduleTestResults = operationRuntime.verifyOperationModuleTestVectorsV1(moduleSpec);
	const operationCatalog = createClampOperationCatalog(moduleSpec);
	const blockDescriptor = createClampBlockDescriptor(moduleSpec);
	assert.equal(blockDescriptor.implementationRef, moduleSpec.implementationRef);

	const registeredRequest = createClampImportRequest(source, operationCatalog);
	const firstRegisteredImport = importer.importTypeScriptSource(registeredRequest);
	const secondRegisteredImport = importer.importTypeScriptSource(registeredRequest);
	assert.equal(firstRegisteredImport.ok, true, formatDiagnostics(firstRegisteredImport));
	assert.equal(secondRegisteredImport.ok, true, formatDiagnostics(secondRegisteredImport));
	assert.equal(serializeJson(firstRegisteredImport), serializeJson(secondRegisteredImport));

	const artifact = firstRegisteredImport.value;
	const visualProgramIR = core.visualProgramIRV1Schema.parse(artifact.program);
	const workflowFragment = core.workflowFragmentV1Schema.parse(artifact.workflow);
	const document = core.dualCanvasDocumentV1Schema.parse(artifact.document);
	const operationCalls = collectByKind(artifact.logic, 'operationCall');
	assert.equal(operationCalls.length, 1);
	assert.equal(operationCalls[0].qualifiedName, moduleSpec.qualifiedName);
	assert.equal(operationCalls[0].operationRef, moduleSpec.operationRef);
	assert.equal(operationCalls[0].implementationRef, moduleSpec.implementationRef);
	assert.equal(operationCalls[0].callRef, scaffoldRequest.calls[0]?.callRef);

	const operationBlocks = collectBlocks(artifact.generatedCanvas.workspace).filter(
		(block) => block.type === blockDescriptor.blockType,
	);
	assert.equal(operationBlocks.length, 1);
	assert.equal(operationBlocks[0].fields?.OPERATION_REF, moduleSpec.operationRef);
	assert.equal(operationBlocks[0].fields?.IMPLEMENTATION_REF, moduleSpec.implementationRef);
	assert.equal(operationBlocks[0].fields?.VERSION, moduleSpec.version);
	assert.equal(operationBlocks[0].fields?.QUALIFIED_NAME, moduleSpec.qualifiedName);
	assert.deepEqual(Object.keys(operationBlocks[0].inputs ?? {}).sort(), ['ARG0', 'ARG1', 'ARG2']);

	const callMappings = artifact.program.sourceMap.filter(
		(mapping) => mapping.semanticRef === scaffoldRequest.calls[0]?.callRef,
	);
	assert.equal(callMappings.length, 1);
	assert.equal(callMappings[0].artifact.ref, operationBlocks[0].id);
	assert.deepEqual(callMappings[0].source, scaffoldRequest.calls[0]?.source);

	const parsedPayload = dataTransform.parseBlocklyDataPayload(
		artifact.generatedCanvas.blocklyPayload,
	);
	assert.equal(parsedPayload.ok, true, parsedPayload.error);
	assert.deepEqual(parsedPayload.payload.operationCatalog, operationCatalog);
	assert.equal(
		parsedPayload.payload.operationCatalog.modules[0]?.implementationRef,
		moduleSpec.implementationRef,
	);
	const payloadOperationBlocks = collectBlocks(parsedPayload.payload.workspace).filter(
		(block) => block.type === blockDescriptor.blockType,
	);
	assert.equal(payloadOperationBlocks.length, 1);
	assert.equal(payloadOperationBlocks[0].fields?.IMPLEMENTATION_REF, moduleSpec.implementationRef);
	const compiled = dataTransform.compileBlocklyWorkspace(
		parsedPayload.payload.workspace,
		parsedPayload.payload.operationCatalog,
	);
	assert.equal(compiled.ok, true, compiled.error);
	assert.equal(compiled.javascript, artifact.generatedCanvas.javascript);

	const moduleOutput = operationRuntime.evaluateOperationModuleV1(moduleSpec, [
		expectedClampInput.score,
		0,
		100,
	]);
	const oracleOutput = clampOracle(expectedClampInput.score, 0, 100);
	const sourceOutput = compileFunction(`"use strict";\n${source}\nreturn transform(input);`, [
		'input',
		'clampScore',
	])(expectedClampInput, clampOracle);
	const generatedOutput = compileFunction(compiled.javascript, ['$json'])(expectedClampInput);
	assert.equal(oracleOutput, expectedClampOutput.score);
	assert.equal(moduleOutput, expectedClampOutput.score);
	assert.deepEqual(sourceOutput, expectedClampOutput);
	assert.deepEqual(generatedOutput, { json: expectedClampOutput });

	const nodeVmEquivalence = {
		status: 'passed',
		input: expectedClampInput,
		oracleOutput,
		moduleOutput,
		sourceOutput,
		generatedOutput,
	};
	const workflow = assembleClampN8nWorkflow(
		workflowFragment,
		artifact.generatedCanvas.blocklyPayload,
	);

	return {
		source,
		initialRequest,
		initialImportDiagnostic: firstInitialImport,
		scaffoldRequest,
		moduleTemplate,
		moduleDraft,
		moduleSpec,
		moduleAdmission,
		moduleTestResults,
		operationCatalog,
		blockDescriptor,
		registeredRequest,
		visualProgramIR,
		logic: structuredClone(artifact.logic),
		workspace: structuredClone(artifact.generatedCanvas.workspace),
		blocklyPayload: parsedPayload.payload,
		sourceMap: artifact.program.sourceMap,
		workflowFragment,
		document,
		workflow,
		nodeVmEquivalence,
		generatedJavaScript: compiled.javascript,
	};
}

export function assembleClampN8nWorkflow(workflowFragment, blocklyPayload) {
	const manualTrigger = workflowFragment.nodes.find(
		({ bindingRef }) => bindingRef === 'manualTrigger',
	);
	const blocklyCode = workflowFragment.nodes.find(({ bindingRef }) => bindingRef === 'blocklyCode');
	assert.ok(manualTrigger && blocklyCode, 'imported workflow bindings are incomplete');
	assert.equal(blocklyCode.nodeType, blocklyNodeType);
	const triggerName = manualTrigger.label;
	const seedName = 'Seed unclamped score';
	const blocklyName = blocklyCode.label;
	assert.equal(new Set([triggerName, seedName, blocklyName]).size, 3);

	return {
		id: clampWorkflowId,
		name: 'Education — generated clamp operation runtime',
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
				id: 'input-unknown-operation-clamp-v1',
				name: seedName,
				type: 'n8n-nodes-base.set',
				typeVersion: 3.4,
				position: [500, 300],
				parameters: {
					options: {},
					assignments: {
						assignments: [
							{
								id: 'input-score',
								name: 'score',
								type: 'number',
								value: expectedClampInput.score,
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
				parameters: { blocklyPayload },
			},
		],
		connections: {
			[triggerName]: { main: [[{ node: seedName, type: 'main', index: 0 }]] },
			[seedName]: { main: [[{ node: blocklyName, type: 'main', index: 0 }]] },
		},
	};
}

export function verifyClampExecution(execution, workflow) {
	assert.equal(execution.status, 'success');
	assert.equal(execution.finished, true);
	const blocklyNode = getSingleNodeByType(workflow, blocklyNodeType);
	const runData = execution.data?.resultData?.runData;
	assert.ok(runData && typeof runData === 'object');
	const blocklyRuns = runData[blocklyNode.name];
	assert.ok(Array.isArray(blocklyRuns) && blocklyRuns.length === 1);
	assert.equal(blocklyRuns[0].executionStatus, 'success');
	assert.deepEqual(blocklyRuns[0].data?.main?.[0], [
		{ json: expectedClampOutput, pairedItem: { item: 0 } },
	]);
	return {
		status: 'passed',
		workflowId: workflow.id,
		nodeType: blocklyNodeType,
		input: expectedClampInput,
		output: expectedClampOutput,
		pairedItem: 0,
	};
}

export function writeUnknownOperationEvidence(evidenceDir, artifacts) {
	mkdirSync(evidenceDir, { recursive: true });
	const entries = {
		source: writeEvidenceFile(evidenceDir, 'source.ts', artifacts.source, false),
		initialRequest: writeEvidenceFile(
			evidenceDir,
			'initial-import-request.json',
			artifacts.initialRequest,
		),
		initialDiagnostic: writeEvidenceFile(
			evidenceDir,
			'initial-import-diagnostic.json',
			artifacts.initialImportDiagnostic,
		),
		scaffoldRequest: writeEvidenceFile(
			evidenceDir,
			'module-scaffold-request.json',
			artifacts.scaffoldRequest,
		),
		moduleTemplate: writeEvidenceFile(
			evidenceDir,
			'module-template.json',
			artifacts.moduleTemplate,
		),
		moduleDraft: writeEvidenceFile(evidenceDir, 'module-draft.json', artifacts.moduleDraft),
		moduleSpec: writeEvidenceFile(evidenceDir, 'module-spec.json', artifacts.moduleSpec),
		moduleAdmission: writeEvidenceFile(
			evidenceDir,
			'module-admission.json',
			artifacts.moduleAdmission,
		),
		moduleTests: writeEvidenceFile(
			evidenceDir,
			'module-test-results.json',
			artifacts.moduleTestResults,
		),
		operationCatalog: writeEvidenceFile(
			evidenceDir,
			'operation-registry.json',
			artifacts.operationCatalog,
		),
		registeredRequest: writeEvidenceFile(
			evidenceDir,
			'registered-import-request.json',
			artifacts.registeredRequest,
		),
		visualProgramIR: writeEvidenceFile(
			evidenceDir,
			'visual-program-ir.json',
			artifacts.visualProgramIR,
		),
		logic: writeEvidenceFile(evidenceDir, 'logic-ir.json', artifacts.logic),
		workspace: writeEvidenceFile(evidenceDir, 'blockly-workspace.json', artifacts.workspace),
		blocklyPayload: writeEvidenceFile(
			evidenceDir,
			'blockly-payload.json',
			artifacts.blocklyPayload,
		),
		sourceMap: writeEvidenceFile(evidenceDir, 'source-map.json', artifacts.sourceMap),
		nodeVmEquivalence: writeEvidenceFile(
			evidenceDir,
			'node-vm-equivalence.json',
			artifacts.nodeVmEquivalence,
		),
		workflow: writeEvidenceFile(evidenceDir, 'workflow.json', artifacts.workflow),
	};
	writeEvidenceFile(evidenceDir, 'artifact-manifest.json', entries);
	return entries;
}

export function parseArguments(arguments_) {
	let checkOnly = false;
	let runtimeDir;
	for (let index = 0; index < arguments_.length; index += 1) {
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
				'Usage: node scripts/education/unknown-operation-runtime-acceptance.mjs [--check] [--runtime-dir=<path>]',
			);
		}
	}
	return { checkOnly, runtimeDir };
}

async function main() {
	const options = parseArguments(process.argv.slice(2));
	const first = generateUnknownOperationArtifacts();
	const second = generateUnknownOperationArtifacts();
	assert.equal(serializeJson(first.workflow), serializeJson(second.workflow));
	assert.equal(serializeJson(first.operationCatalog), serializeJson(second.operationCatalog));
	if (options.checkOnly) {
		console.log(
			JSON.stringify({
				status: 'passed',
				mode: 'check',
				workflowId: first.workflow.id,
				operation: first.moduleSpec.qualifiedName,
				implementationRef: first.moduleSpec.implementationRef,
				blockType: first.blockDescriptor.blockType,
				input: expectedClampInput,
				expectedOutput: expectedClampOutput,
				catalogSha256: sha256(serializeJson(first.operationCatalog)),
				workflowSha256: sha256(serializeJson(first.workflow)),
			}),
		);
		return;
	}

	const runtimeDirectory = resolve(
		options.runtimeDir ?? join(scriptDirectory, '.runtime', 'unknown-operation', runtimeName()),
	);
	const runtimeResult = await runWorkflowAcceptance({
		runtimeDir: runtimeDirectory,
		workflow: first.workflow,
		workflowPath: join(runtimeDirectory, 'evidence', 'workflow.json'),
		executionPath: join(runtimeDirectory, 'evidence', 'execution.json'),
		logDirectory: join(runtimeDirectory, 'evidence', 'runtime-logs'),
		stageEvidence: ({ evidenceDir }) => writeUnknownOperationEvidence(evidenceDir, first),
	});
	const verification = verifyClampExecution(runtimeResult.execution, first.workflow);
	const result = {
		...verification,
		operation: first.moduleSpec.qualifiedName,
		implementationRef: first.moduleSpec.implementationRef,
		blockType: first.blockDescriptor.blockType,
		n8nPort: runtimeResult.n8nPort,
		brokerPort: runtimeResult.brokerPort,
		runnersMode: runtimeResult.runnersMode,
		runnersInsecureMode: runtimeResult.runnersInsecureMode,
		...runtimeResult.taskRunnerEvidence,
		evidenceDir: runtimeResult.evidenceDir,
	};
	writeEvidenceFile(runtimeResult.evidenceDir, 'result.json', result);
	console.log(JSON.stringify(result));
	console.log('PASS: generated clampScore module executed through the real n8n runtime');
	console.log(`Evidence retained at: ${runtimeResult.evidenceDir}`);
}

function collectByKind(value, kind, matches = []) {
	if (Array.isArray(value)) {
		for (const entry of value) collectByKind(entry, kind, matches);
		return matches;
	}
	if (!value || typeof value !== 'object') return matches;
	if (value.kind === kind) matches.push(value);
	for (const child of Object.values(value)) collectByKind(child, kind, matches);
	return matches;
}

function collectBlocks(value, matches = []) {
	if (Array.isArray(value)) {
		for (const entry of value) collectBlocks(entry, matches);
		return matches;
	}
	if (!value || typeof value !== 'object') return matches;
	if (typeof value.type === 'string') matches.push(value);
	for (const child of Object.values(value)) collectBlocks(child, matches);
	return matches;
}

function getSingleNodeByType(workflow, nodeType) {
	const matches = workflow.nodes.filter(({ type }) => type === nodeType);
	assert.equal(matches.length, 1);
	return matches[0];
}

function writeEvidenceFile(evidenceDir, name, value, json = true) {
	const bytes = json ? serializeJson(value) : value;
	const path = join(evidenceDir, name);
	writeFileSync(path, bytes, 'utf8');
	return { path, bytes: Buffer.byteLength(bytes), sha256: sha256(bytes) };
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

function clampOracle(value, minimum, maximum) {
	if (value === null) return null;
	return value < minimum ? minimum : value > maximum ? maximum : value;
}

export function getUnknownOperationBuildProblems() {
	return getBuildOutputProblems(unknownOperationBuildRequirements);
}

export function ensureFreshPackageBuilds() {
	assertFreshBuildOutputs(unknownOperationBuildRequirements);
}

function createPackageBuildRequirement(directoryName, packageName, dependencyOutputs = []) {
	const directory = packageDirectory(directoryName);
	return {
		path: packageOutput(directoryName),
		freshnessMarker: packageBuildMarker(directoryName),
		inputs: [resolve(directory, 'src'), resolve(directory, 'package.json'), ...dependencyOutputs],
		command: `pnpm --filter ${packageName} exec tsc -b tsconfig.build.json --force`,
	};
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
	main().catch((error) => {
		console.error(error instanceof Error ? error.stack : error);
		process.exitCode = 1;
	});
}
