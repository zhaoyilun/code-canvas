import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = new URL('../..', import.meta.url);
const verifier = new URL('./verify-execution.mjs', import.meta.url);
const workflowFixture = new URL('./fixtures/blockly-data-transform-v1.workflow.json', import.meta.url);
const expectedFixture = new URL('./fixtures/expected-output.json', import.meta.url);

test('accepts a complete execution record bound to the tampered workflow', () => {
	const runtime = mkdtempSync(join(tmpdir(), 'blockly-v1-verification-'));
	try {
		const workflowPath = join(runtime, 'tampered-workflow.json');
		const executionPath = join(runtime, 'execution-record.json');
		const workflow = createTamperedWorkflow();
		writeFileSync(workflowPath, JSON.stringify(workflow));
		writeFileSync(executionPath, JSON.stringify(createExecutionRecord(workflow)));

		const result = runVerifier(executionPath, workflowPath);
		assert.match(result, /PASS: tampered preview was ignored/);
	} finally {
		rmSync(runtime, { recursive: true, force: true });
	}
});

test('rejects ordinary output cross-paired with a tampered workflow', () => {
	const runtime = mkdtempSync(join(tmpdir(), 'blockly-v1-verification-'));
	try {
		const workflowPath = join(runtime, 'tampered-workflow.json');
		const rawOutputPath = join(runtime, 'raw-output.json');
		writeFileSync(workflowPath, JSON.stringify(createTamperedWorkflow()));
		const rawOutput = createExecutionRecord();
		delete rawOutput.workflowId;
		delete rawOutput.workflowData;
		writeFileSync(rawOutputPath, JSON.stringify(rawOutput));

		assert.throws(
			() => runVerifier(rawOutputPath, workflowPath),
			/tamper evidence is missing execution\.workflowId/,
		);
	} finally {
		rmSync(runtime, { recursive: true, force: true });
	}
});

test('rejects an execution snapshot cross-paired with a different Blockly payload', () => {
	const runtime = mkdtempSync(join(tmpdir(), 'blockly-v1-verification-'));
	try {
		const workflowPath = join(runtime, 'tampered-workflow.json');
		const executionPath = join(runtime, 'execution-record.json');
		const workflow = createTamperedWorkflow();
		const execution = createExecutionRecord(structuredClone(workflow));
		const canonicalWorkflow = JSON.parse(readFileSync(workflowFixture, 'utf8'));
		const canonicalBlocklyNode = canonicalWorkflow.nodes.find(
			(node) => node.type === 'n8n-nodes-blockly-code.blocklyCode',
		);
		const executedBlocklyNode = execution.workflowData.nodes.find(
			(node) => node.type === 'n8n-nodes-blockly-code.blocklyCode',
		);
		executedBlocklyNode.parameters.blocklyPayload = canonicalBlocklyNode.parameters.blocklyPayload;
		writeFileSync(workflowPath, JSON.stringify(workflow));
		writeFileSync(executionPath, JSON.stringify(execution));

		assert.throws(
			() => runVerifier(executionPath, workflowPath),
			/execution workflowData Blockly payload does not match --workflow/,
		);
	} finally {
		rmSync(runtime, { recursive: true, force: true });
	}
});

function createTamperedWorkflow() {
	const workflow = JSON.parse(readFileSync(workflowFixture, 'utf8'));
	workflow.id = 'tampered-preview-workflow';
	const blocklyNode = workflow.nodes.find(
		(node) => node.type === 'n8n-nodes-blockly-code.blocklyCode',
	);
	const payload = JSON.parse(blocklyNode.parameters.blocklyPayload);
	payload.javascript = 'return { json: { tampered: true } };';
	blocklyNode.parameters.blocklyPayload = JSON.stringify(payload);
	return workflow;
}

function createExecutionRecord(workflow) {
	const expected = JSON.parse(readFileSync(expectedFixture, 'utf8'));
	return {
		workflowId: workflow?.id ?? 'ordinary-workflow',
		workflowData: workflow ?? { id: 'ordinary-workflow', nodes: [] },
		status: 'success',
		finished: true,
		data: {
			resultData: {
				runData: {
					'Blockly Data Transform': [
						{ data: { main: [expected.map((json, item) => ({ json, pairedItem: { item } }))] } },
					],
				},
			},
		},
	};
}

function runVerifier(executionPath, workflowPath) {
	return execFileSync(
		process.execPath,
		[
			fileURLToPath(verifier),
			executionPath,
			`--workflow=${workflowPath}`,
			'--expect-tampered-preview',
		],
		{ cwd: fileURLToPath(root), encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
	);
}
