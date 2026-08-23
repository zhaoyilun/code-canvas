#!/usr/bin/env node
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const fixturePath = resolve(
	process.argv.slice(2).find((arg) => !arg.startsWith('--')) ??
		fileURLToPath(new URL('./fixtures/blockly-data-transform-v1.workflow.json', import.meta.url)),
);
const requireCompiler = process.argv.includes('--require-compiler');
const refreshPreview = process.argv.includes('--refresh-preview');
if (
	refreshPreview &&
	fixturePath !==
		resolve(fileURLToPath(new URL('./fixtures/blockly-data-transform-v1.workflow.json', import.meta.url)))
) {
	fail('--refresh-preview only permits the repository fixture');
}

const document = readJson(fixturePath, 'workflow fixture');
const workflow = Array.isArray(document) ? document[0] : document;
if (Array.isArray(document))
	assert(document.length === 1, 'workflow export must contain exactly one workflow');
assertRecord(workflow, 'workflow must be an object');
assert(Array.isArray(workflow.nodes), 'workflow.nodes must be an array');
assertNoArbitraryCode(workflow);
const { node: blocklyNode, payload } = validateWorkflow(workflow);
const expected = readJson(
	new URL('./fixtures/expected-output.json', import.meta.url),
	'expected output',
);
validateExpectedOutput(expected);
const compiler = await loadCompiler();

if (!compiler) {
	if (requireCompiler || refreshPreview)
		fail('shared compiler is unavailable; build packages/@n8n/blockly-data-transform first');
	assert(payload.javascript === '', 'without the shared compiler, fixture preview must stay empty');
	console.log(`PASS: ${fixturePath}`);
	console.log(
		'PASS: schema 2 workspace, approved blocks, three inputs, and three expected one-to-one outputs are valid',
	);
	console.log(
		'SKIP: shared compiler is unavailable; run pnpm --filter @n8n/blockly-data-transform build, then rerun with --refresh-preview',
	);
	process.exit(0);
}

const result = compiler.compileBlocklyWorkspace(payload.workspace);
assertRecord(result, 'shared compiler returned an invalid result');
assert(
	result.ok === true,
	`shared compiler rejected fixture: ${typeof result.error === 'string' ? result.error : 'unknown error'}`,
);
assert(
	typeof result.javascript === 'string' && result.javascript !== '',
	'shared compiler returned empty JavaScript',
);
if (refreshPreview) {
	payload.javascript = result.javascript;
	blocklyNode.parameters.blocklyPayload = JSON.stringify(payload, null, 2);
	writeFileSync(fixturePath, `${JSON.stringify(workflow, null, 2)}\n`);
	console.log(`REFRESHED: ${fixturePath}`);
}
assert(
	payload.javascript === result.javascript,
	'payload.javascript is not the shared compiler canonical result; rerun with --refresh-preview',
);
console.log(`PASS: ${fixturePath}`);
console.log(`PASS: shared compiler preview matches canonical output (${result.blockCount} blocks)`);

function validateWorkflow(workflow) {
	const byName = new Map(workflow.nodes.map((node) => [node?.name, node]));
	for (const name of [
		"When clicking 'Execute workflow'",
		'Seed three business orders',
		'Split orders into three items',
		'Blockly Data Transform',
	])
		assert(byName.has(name), `missing node: ${name}`);
	assert(
		workflow.nodes.length === 4,
		'fixture must contain only trigger, seed, split, and Blockly nodes',
	);
	assertMainTarget(workflow, "When clicking 'Execute workflow'", 'Seed three business orders');
	assertMainTarget(workflow, 'Seed three business orders', 'Split orders into three items');
	assertMainTarget(workflow, 'Split orders into three items', 'Blockly Data Transform');
	assert(
		!workflow.connections?.['Blockly Data Transform'],
		'Blockly Data Transform must be the terminal node',
	);
	const seed = byName.get('Seed three business orders');
	assert(seed.type === 'n8n-nodes-base.set', 'seed node must be Edit Fields');
	const assignment = seed.parameters?.assignments?.assignments?.[0];
	assert(
		assignment?.name === 'orders' &&
			assignment.type === 'array' &&
			typeof assignment.value === 'string',
		'seed node must contain orders array',
	);
	const inputs = JSON.parse(assignment.value);
	assert(
		Array.isArray(inputs) && inputs.length === 3,
		'fixture must produce exactly three business input items',
	);
	assert(
		JSON.stringify(inputs) === JSON.stringify(expectedInputs()),
		'business input items do not match the asserted fixture data',
	);
	const split = byName.get('Split orders into three items');
	assert(
		split.type === 'n8n-nodes-base.splitOut' && split.parameters?.fieldToSplitOut === 'orders',
		'split node must split orders',
	);
	const node = byName.get('Blockly Data Transform');
	assert(
		node.type === 'n8n-nodes-blockly-code.blocklyCode',
		'missing Blockly Data Transform node',
	);
	assert(typeof node.parameters?.blocklyPayload === 'string', 'blocklyPayload must be a string');
	const payload = JSON.parse(node.parameters.blocklyPayload);
	assertRecord(payload, 'payload must be an object');
	assert(payload.schemaVersion === 2, 'payload must use schemaVersion 2');
	assertRecord(payload.workspace, 'payload.workspace must be an object');
	assert(typeof payload.javascript === 'string', 'payload.javascript must be a string');
	const top = payload.workspace.blocks?.blocks;
	assert(
		Array.isArray(top) && top.length === 1 && top[0]?.type === 'n8n_transform_item',
		'workspace must have exactly one n8n_transform_item root',
	);
	const types = collectBlockTypes(top[0]);
	const approvedTypes = new Set([
		'n8n_transform_item',
		'n8n_set_field',
		'n8n_get_field',
		'math_number',
		'math_arithmetic',
		'text',
		'text_join',
		'logic_boolean',
		'logic_compare',
		'logic_operation',
		'logic_negate',
		'logic_ternary',
	]);
	assert(
		!types.some((type) => !approvedTypes.has(type)),
		'workspace contains a block outside the approved grammar',
	);
	for (const type of [
		'n8n_transform_item',
		'n8n_set_field',
		'n8n_get_field',
		'text_join',
		'text',
		'math_arithmetic',
		'math_number',
		'logic_ternary',
		'logic_compare',
	])
		assert(types.includes(type), `workspace missing ${type}`);
	assert(
		!types.some((type) => type === 'n8n_return_output' || type === 'n8n_code'),
		'schema 1 or arbitrary-code block is forbidden',
	);
	assert(
		types.filter((type) => type === 'n8n_set_field').length === 3,
		'workspace must set exactly three output fields',
	);
	assert(
		JSON.stringify(setKeys(top[0].inputs?.STATEMENTS?.block)) ===
			JSON.stringify(['customerLabel', 'orderTotal', 'grade']),
		'workspace output fields must be customerLabel, orderTotal, grade in order',
	);
	return { node, payload };
}

function assertNoArbitraryCode(value, path = '$') {
	if (Array.isArray(value))
		return value.forEach((entry, index) => assertNoArbitraryCode(entry, `${path}[${index}]`));
	if (!isRecord(value)) return;
	for (const [key, entry] of Object.entries(value)) {
		const next = `${path}.${key}`;
		if (['code', 'jsCode', 'functionCode', 'pythonCode'].includes(key))
			fail(`arbitrary code field is forbidden: ${next}`);
		if (key === 'javascript') fail(`arbitrary JavaScript field is forbidden: ${next}`);
		assertNoArbitraryCode(entry, next);
	}
}
function collectBlockTypes(block, types = []) {
	if (!isRecord(block)) return types;
	if (typeof block.type === 'string') types.push(block.type);
	for (const value of Object.values(block.inputs ?? {}))
		if (isRecord(value) && isRecord(value.block)) collectBlockTypes(value.block, types);
	if (isRecord(block.next) && isRecord(block.next.block))
		collectBlockTypes(block.next.block, types);
	return types;
}
function assertMainTarget(workflow, source, target) {
	const main = workflow.connections?.[source]?.main;
	assert(
		Array.isArray(main) &&
			main.length === 1 &&
			Array.isArray(main[0]) &&
			main[0].length === 1 &&
			main[0][0]?.node === target &&
			main[0][0]?.type === 'main' &&
			main[0][0]?.index === 0,
		`invalid main connection: ${source} -> ${target}`,
	);
}
function setKeys(block, keys = []) {
	if (!isRecord(block)) return keys;
	if (block.type === 'n8n_set_field') keys.push(block.fields?.KEY);
	const next = block.next?.block;
	return isRecord(next) ? setKeys(next, keys) : keys;
}
function expectedInputs() {
	return [
		{ customer: { name: 'Ada Lovelace' }, amount: 50, quantity: 3 },
		{ customer: { name: 'Grace Hopper' }, amount: 20, quantity: 4 },
		{ customer: { name: 'Lin Qian' }, amount: 120, quantity: 1 },
	];
}
function validateExpectedOutput(value) {
	assert(
		Array.isArray(value) && value.length === 3,
		'expected output must assert exactly three items',
	);
	const expected = [
		{
			customer: { name: 'Ada Lovelace' },
			amount: 50,
			quantity: 3,
			customerLabel: 'Customer: Ada Lovelace',
			orderTotal: 150,
			grade: 'gold',
		},
		{
			customer: { name: 'Grace Hopper' },
			amount: 20,
			quantity: 4,
			customerLabel: 'Customer: Grace Hopper',
			orderTotal: 80,
			grade: 'standard',
		},
		{
			customer: { name: 'Lin Qian' },
			amount: 120,
			quantity: 1,
			customerLabel: 'Customer: Lin Qian',
			orderTotal: 120,
			grade: 'gold',
		},
	];
	assert(
		JSON.stringify(value) === JSON.stringify(expected),
		'expected output does not match the three asserted transformations',
	);
}
async function loadCompiler() {
	const modulePath = process.env.N8N_BLOCKLY_COMPILER_MODULE
		? resolve(process.env.N8N_BLOCKLY_COMPILER_MODULE)
		: resolve(root, 'packages/@n8n/blockly-data-transform/dist/index.js');
	if (!existsSync(modulePath)) return null;
	const module = await import(pathToFileURL(modulePath).href);
	assert(
		typeof module.compileBlocklyWorkspace === 'function',
		`compiler export missing: ${modulePath}`,
	);
	return module;
}
function readJson(path, label) {
	try {
		return JSON.parse(readFileSync(path, 'utf8'));
	} catch (error) {
		fail(`${label} is invalid JSON: ${error.message}`);
	}
}
function assertRecord(value, message) {
	assert(isRecord(value), message);
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
