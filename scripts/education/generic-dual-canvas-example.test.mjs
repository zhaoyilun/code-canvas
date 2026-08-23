import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

import {
	generateGenericDualCanvasExample,
	outputPath,
	serializeGenericDualCanvasExample,
	validateGenericDualCanvasExample,
	verifyRuntimeDependencyBoundary,
} from './generic-dual-canvas-example.mjs';

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const scriptPath = resolve(scriptDirectory, 'generic-dual-canvas-example.mjs');

test('generates and validates the complete generic source-to-dual-canvas chain', () => {
	const example = generateGenericDualCanvasExample();
	const validation = validateGenericDualCanvasExample(example);

	assert.equal(validation.nodeCount, 2);
	assert.equal(validation.statementCount, 9);
	assert.equal(validation.sourceMapCount, 12);
	assert.ok(validation.blockCount > validation.statementCount);
});

test('keeps the checked-in JSON export importable and byte-stable', () => {
	const first = generateGenericDualCanvasExample();
	const second = generateGenericDualCanvasExample();
	const firstBytes = serializeGenericDualCanvasExample(first);
	const secondBytes = serializeGenericDualCanvasExample(second);

	assert.equal(firstBytes, secondBytes);
	assert.deepEqual(JSON.parse(firstBytes), first);
	assert.equal(readFileSync(outputPath, 'utf8'), firstBytes);
});

test('runs from an empty working directory with only the generic runtime dependency closure', () => {
	assert.deepEqual(verifyRuntimeDependencyBoundary(), {
		workspaceRuntimeDependencies: ['@n8n/blockly-data-transform', '@n8n/dual-canvas-core'],
	});

	const emptyWorkingDirectory = mkdtempSync(join(tmpdir(), 'generic-dual-canvas-'));
	try {
		const result = spawnSync(process.execPath, [scriptPath, '--check'], {
			cwd: emptyWorkingDirectory,
			encoding: 'utf8',
			env: { ...process.env, NODE_PATH: '' },
		});
		assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
		const report = JSON.parse(result.stdout.trim());
		assert.equal(report.mode, 'check');
		assert.equal(report.nodeCount, 2);
		assert.deepEqual(report.workspaceRuntimeDependencies, [
			'@n8n/blockly-data-transform',
			'@n8n/dual-canvas-core',
		]);
	} finally {
		rmdirSync(emptyWorkingDirectory);
	}
});
