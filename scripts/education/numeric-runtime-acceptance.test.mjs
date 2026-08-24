#!/usr/bin/env node

import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
	assembleNumericN8nWorkflow,
	blocklyNodeType,
	createNumericImportRequest,
	expectedNumericInput,
	expectedNumericOutput,
	generateNumericRuntimeArtifacts,
	numericWorkflowId,
	parseArguments,
	validateNumericWorkflow,
	verifyNumericExecution,
	writeNumericArtifactEvidence,
} from './numeric-runtime-acceptance.mjs';

test('imports numeric-calculation.ts into deterministic IR, workspace, and workflow artifacts', () => {
	const first = generateNumericRuntimeArtifacts();
	const second = generateNumericRuntimeArtifacts();

	assert.equal(first.source, second.source);
	assert.deepEqual(first.visualProgramIR, second.visualProgramIR);
	assert.deepEqual(first.workspace, second.workspace);
	assert.deepEqual(first.workflow, second.workflow);
	assert.equal(first.matrixGate.caseRef, 'numeric-calculation');
	assert.deepEqual(first.matrixGate.coverage, ['numeric-calculation']);
	assert.deepEqual(first.matrixGate.executionCount, 1);
	assert.match(first.generatedJavaScript, /output\["total"\]/);
});

test('preserves the source, source map, block refs, and package-qualified node binding', () => {
	const artifacts = generateNumericRuntimeArtifacts();
	const request = createNumericImportRequest(artifacts.source);
	assert.equal(request.source.content, artifacts.source);
	assert.equal(
		request.source.uri,
		'docs/education/examples/generic-snippets/numeric-calculation.ts',
	);
	assert.equal(request.bindings.nodeTypes.blocklyCode, blocklyNodeType);

	const workspaceBlockRefs = collectBlocklyBlockRefs(artifacts.workspace);
	const mappedBlockRefs = artifacts.visualProgramIR.sourceMap
		.filter(({ artifact }) => artifact.kind === 'canvasBlock')
		.map(({ artifact }) => artifact.ref);
	assert.equal(mappedBlockRefs.length, artifacts.matrixGate.statementCount);
	assert.ok(mappedBlockRefs.every((blockRef) => workspaceBlockRefs.has(blockRef)));
	assert.equal(artifacts.document.sources[0].content, artifacts.source);
});

test('assembles the real n8n workflow with one fixed numeric input item', () => {
	const { workflow, workflowFragment } = generateNumericRuntimeArtifacts();
	const importedBlocklyNode = workflowFragment.nodes.find(
		({ bindingRef }) => bindingRef === 'blocklyCode',
	);
	assert.ok(importedBlocklyNode);
	assert.deepEqual(
		validateNumericWorkflow(workflow, importedBlocklyNode.parameters.blocklyPayload),
		{
			workflowId: numericWorkflowId,
			nodeType: blocklyNodeType,
			blocklyNodeName: 'Numeric calculation',
			seedNodeName: 'Seed numeric input',
		},
	);
	assert.equal(
		workflow.nodes.find(({ type }) => type === blocklyNodeType)?.parameters.blocklyPayload,
		importedBlocklyNode.parameters.blocklyPayload,
	);
});

test('stops assembly when the importer fragment is no longer Manual Trigger to Blockly', () => {
	const { workflowFragment } = generateNumericRuntimeArtifacts();
	const changedFragment = structuredClone(workflowFragment);
	changedFragment.connections[0].from.nodeRef = changedFragment.exitNodeRefs[0];
	assert.throws(() =>
		assembleNumericN8nWorkflow(
			changedFragment,
			changedFragment.nodes.find(({ bindingRef }) => bindingRef === 'blocklyCode').parameters
				.blocklyPayload,
		),
	);
});

test('accepts only total 52 with pairedItem zero from the Blockly execution', () => {
	const { workflow } = generateNumericRuntimeArtifacts();
	const execution = createSuccessfulExecution(workflow);
	assert.deepEqual(verifyNumericExecution(execution, workflow), {
		status: 'passed',
		workflowId: numericWorkflowId,
		nodeType: blocklyNodeType,
		input: expectedNumericInput,
		output: expectedNumericOutput,
		pairedItem: 0,
	});

	const wrongTotal = structuredClone(execution);
	wrongTotal.data.resultData.runData['Numeric calculation'][0].data.main[0][0].json.total = 50;
	assert.throws(() => verifyNumericExecution(wrongTotal, workflow));

	const wrongPairing = structuredClone(execution);
	wrongPairing.data.resultData.runData['Numeric calculation'][0].data.main[0][0].pairedItem.item =
		1;
	assert.throws(() => verifyNumericExecution(wrongPairing, workflow));

	const extraOutputField = structuredClone(execution);
	extraOutputField.data.resultData.runData['Numeric calculation'][0].data.main[0][0].json.input =
		expectedNumericInput;
	assert.throws(() => verifyNumericExecution(extraOutputField, workflow));
});

test('writes source, IR, workspace, workflow, and an auditable artifact manifest', () => {
	const runtimeDirectory = mkdtempSync(join(tmpdir(), 'numeric-runtime-evidence-'));
	try {
		const evidence = writeNumericArtifactEvidence(
			runtimeDirectory,
			generateNumericRuntimeArtifacts(),
		);
		assert.deepEqual(
			readdirSync(runtimeDirectory).sort(),
			[
				'artifact-manifest.json',
				'blockly-workspace.json',
				'dual-canvas-document.json',
				'import-request.json',
				'source.ts',
				'visual-program-ir.json',
				'workflow-fragment.json',
				'workflow.json',
			].sort(),
		);
		assert.equal(readFileSync(evidence.source.path, 'utf8').includes('output.total'), true);
		assert.equal(JSON.parse(readFileSync(evidence.workflow.path, 'utf8')).id, numericWorkflowId);
		assert.equal(evidence.source.sha256.length, 64);
		assert.equal(evidence.visualProgramIR.sha256.length, 64);
		assert.equal(evidence.workspace.sha256.length, 64);
		assert.equal(evidence.workflow.sha256.length, 64);
	} finally {
		rmSync(runtimeDirectory, { force: true, recursive: true });
	}
});

test('parses check and isolated runtime directory options', () => {
	assert.deepEqual(parseArguments(['--check', '--runtime-dir=tmp/numeric']), {
		checkOnly: true,
		runtimeDir: 'tmp/numeric',
	});
	assert.deepEqual(parseArguments([]), { checkOnly: false, runtimeDir: undefined });
	assert.throws(() => parseArguments(['--runtime-dir']), /requires a path/);
	assert.throws(() => parseArguments(['--port=8080']), /Usage/);
});

function createSuccessfulExecution(workflow) {
	const seedName = workflow.nodes.find(({ type }) => type === 'n8n-nodes-base.set').name;
	const blocklyName = workflow.nodes.find(({ type }) => type === blocklyNodeType).name;
	return {
		status: 'success',
		finished: true,
		data: {
			resultData: {
				runData: {
					[seedName]: [
						{
							executionStatus: 'success',
							data: { main: [[{ json: expectedNumericInput, pairedItem: { item: 0 } }]] },
						},
					],
					[blocklyName]: [
						{
							executionStatus: 'success',
							data: {
								main: [[{ json: expectedNumericOutput, pairedItem: { item: 0 } }]],
							},
						},
					],
				},
			},
		},
	};
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
		if (!value || typeof value !== 'object') continue;
		if (typeof value.type === 'string' && typeof value.id === 'string') refs.add(value.id);
		pending.push(...Object.values(value));
	}
	return refs;
}
