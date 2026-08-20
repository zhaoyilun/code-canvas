#!/usr/bin/env node

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const fixturePath = resolve(
	process.argv[2] ?? new URL('./fixtures/blockly-code-demo.workflow.json', import.meta.url).pathname,
);

try {
	const parsed = JSON.parse(readFileSync(fixturePath, 'utf8'));
	const workflow = Array.isArray(parsed) ? parsed[0] : parsed;
	if (Array.isArray(parsed) && parsed.length !== 1) {
		fail('workflow export must contain exactly one workflow');
	}
	if (!isRecord(workflow) || !Array.isArray(workflow.nodes)) fail('workflow.nodes must be an array');

	const node = workflow.nodes.find(
		(candidate) => isRecord(candidate) && candidate.type === 'CUSTOM.blocklyCode',
	);
	if (!node || !isRecord(node.parameters)) fail('missing Blockly Code node or parameters');

	const rawPayload = node.parameters.blocklyPayload;
	if (typeof rawPayload !== 'string') fail('Blockly Code parameter blocklyPayload must be a string');

	const payload = JSON.parse(rawPayload);
	if (!isRecord(payload)) fail('Blockly payload must be a JSON object');
	if (payload.schemaVersion !== 1) fail('Blockly payload schemaVersion must be 1');
	if (!isRecord(payload.workspace)) fail('Blockly payload workspace must be a JSON object');
	if (payload.javascript !== 'return [{ json: { result: 42 } }];') {
		fail('Blockly payload javascript must return result 42');
	}

	const blocks = payload.workspace.blocks;
	if (!isRecord(blocks) || !Array.isArray(blocks.blocks)) {
		fail('Blockly workspace must contain a blocks array');
	}

	const returnBlock = blocks.blocks.find(
		(candidate) => isRecord(candidate) && candidate.type === 'n8n_return_output',
	);
	if (!returnBlock || !isRecord(returnBlock.inputs)) fail('missing n8n_return_output inputs');

	const valueInput = returnBlock.inputs.VALUE;
	if (!isRecord(valueInput) || !isRecord(valueInput.block)) {
		fail('n8n_return_output.VALUE must contain a block');
	}
	if (valueInput.block.type !== 'math_number' || !isRecord(valueInput.block.fields)) {
		fail('n8n_return_output.VALUE must connect to math_number');
	}
	if (valueInput.block.fields.NUM !== 42) fail('math_number NUM must be 42');

	console.log(`PASS: ${fixturePath}`);
	console.log('PASS: Blockly payload connects n8n_return_output.VALUE to math_number=42');
	console.log('PASS: generated JavaScript returns result 42');
} catch (error) {
	fail(error instanceof Error ? error.message : String(error));
}

function isRecord(value) {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function fail(message) {
	console.error(`FAIL: ${message}`);
	process.exit(1);
}
