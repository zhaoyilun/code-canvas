#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const rawPath = process.argv.slice(2).find((argument) => !argument.startsWith('--'));
const workflowArgument = process.argv.find((argument) => argument.startsWith('--workflow='));
const expectTamperedPreview = process.argv.includes('--expect-tampered-preview');

if (!rawPath) fail('Usage: verify-execution.mjs <raw-output> [--workflow=<path>] [--expect-tampered-preview]');
if (expectTamperedPreview && !workflowArgument)
	fail('--expect-tampered-preview requires --workflow=<path>');

const execution = parseExecution(readFileSync(resolve(rawPath), 'utf8'));
const expected = readJson(new URL('./fixtures/expected-output.json', import.meta.url));
assert(execution.status === 'success' && execution.finished === true, 'execution did not succeed');

const runData = execution.data?.resultData?.runData?.['Blockly Data Transform'];
assert(Array.isArray(runData) && runData.length === 1, 'Blockly node run data is missing');
const items = runData[0]?.data?.main?.[0];
assert(Array.isArray(items) && items.length === expected.length, 'Blockly output count is invalid');
for (const item of items) {
	assert(isRecord(item) && isRecord(item.json), 'Blockly output must contain a JSON object');
	assert(
		Object.keys(item).every((key) => key === 'json' || key === 'pairedItem'),
		'Blockly output contains unsupported data',
	);
}
assert(
	JSON.stringify(items.map(({ json }) => json)) === JSON.stringify(expected),
	'Blockly output does not match expected business data',
);
assert(
	JSON.stringify(items.map(({ pairedItem }) => pairedItem?.item)) === '[0,1,2]',
	'Blockly paired-item metadata is invalid',
);

if (workflowArgument) {
	const workflow = readJson(resolve(workflowArgument.slice('--workflow='.length)));
	const document = Array.isArray(workflow) ? workflow[0] : workflow;
	assert(isRecord(document) && Array.isArray(document.nodes), 'workflow is malformed');
	const blocklyNode = document.nodes.find(
		(node) => isRecord(node) && node.type === 'CUSTOM.blocklyCode',
	);
	assert(isRecord(blocklyNode) && isRecord(blocklyNode.parameters), 'Blockly node is missing');
	assert(typeof blocklyNode.parameters.blocklyPayload === 'string', 'Blockly payload is missing');
	const payload = JSON.parse(blocklyNode.parameters.blocklyPayload);
	assert(isRecord(payload) && isRecord(payload.workspace), 'Blockly payload is malformed');
	assert(typeof payload.javascript === 'string', 'Blockly preview is missing');
	const compilerPath = resolve(
		new URL('../../packages/@n8n/blockly-data-transform/dist/index.js', import.meta.url).pathname,
	);
	const compiler = await import(pathToFileURL(compilerPath).href);
	const compiled = compiler.compileBlocklyWorkspace(payload.workspace);
	assert(compiled.ok === true, 'shared compiler rejected the workflow');
	if (expectTamperedPreview)
		assert(payload.javascript !== compiled.javascript, 'workflow preview is not tampered');
}

console.log(
	expectTamperedPreview
		? 'PASS: tampered preview was ignored and 3 canonical workspace outputs matched'
		: 'PASS: execution returned 3 expected one-to-one Blockly outputs',
);

function parseExecution(raw) {
	try {
		return JSON.parse(raw);
	} catch {
		const start = raw.indexOf('{\n  "data"');
		if (start < 0) fail('n8n execution JSON was not found');
		return JSON.parse(raw.slice(start));
	}
}

function readJson(path) {
	try {
		return JSON.parse(readFileSync(path, 'utf8'));
	} catch {
		fail(`invalid JSON: ${String(path)}`);
	}
}

function isRecord(value) {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function assert(condition, message) {
	if (!condition) fail(message);
}

function fail(message) {
	console.error(`FAIL: ${message}`);
	process.exit(1);
}
