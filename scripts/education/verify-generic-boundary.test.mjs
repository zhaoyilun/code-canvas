import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';

import { verifyGenericBoundary } from './verify-generic-boundary.mjs';

test('accepts a generic project and ignores tests, build outputs, and education boundary docs', () => {
	withFixture((root) => {
		write(root, 'packages/@n8n/dual-canvas-core/src/index.ts', 'export const kind = "generic";');
		write(root, 'packages/@n8n/dual-canvas-core/src/legacy.test.ts', 'robot_example');
		write(root, 'packages/@n8n/dual-canvas-core/dist/index.js', 'CUSTOM.robotTask');
		write(
			root,
			'packages/@n8n/dual-canvas-core/.pack/package/package.json',
			'{"name":"robot-skills"}',
		);
		write(root, 'docs/education/boundary.md', '@n8n/blockly-robot-skills');
		write(
			root,
			'scripts/blockly-v1/fixtures/example.workflow.json',
			JSON.stringify({ nodes: [{ type: 'n8n-nodes-blockly-code.blocklyCode' }] }),
		);

		const report = verifyGenericBoundary(root);
		assert.equal(report.ok, true, report.errors.join('\n'));
		assert.equal(report.workflowFileCount, 1);
	});
});

test('reports all five legacy implementation groups', () => {
	withFixture((root) => {
		for (const path of [
			'custom-nodes/n8n-nodes-roboframe',
			'packages/@n8n/blockly-robot-skills',
			'services/roboframe-bridge',
			'deploy/rk3588',
			'docs/competition',
		]) {
			write(root, `${path}/placeholder.txt`, 'legacy');
		}

		const report = verifyGenericBoundary(root);
		assert.equal(report.ok, false);
		for (const group of [
			'RoboFrame community nodes',
			'domain Blockly and competition generators',
			'hardware bridge',
			'device deployment',
			'domain delivery assets',
		]) {
			assert.ok(
				report.errors.some((error) => error.includes(group)),
				group,
			);
		}
	});
});

test('reports forbidden domain markers in production code and package manifests', () => {
	withFixture((root) => {
		write(
			root,
			'packages/@n8n/dual-canvas-core/src/leak.ts',
			[
				'@n8n/blockly-robot-skills',
				'SO101_CATALOG_SNAPSHOT',
				'robot-skills',
				'robot_move',
				'CUSTOM.robotTask',
				'@n8n/competition-designer',
			].join('\n'),
		);
		write(
			root,
			'packages/frontend/editor-ui/package.json',
			JSON.stringify({ dependencies: { '@n8n/blockly-robot-skills': 'workspace:*' } }),
		);

		const report = verifyGenericBoundary(root);
		assert.equal(report.ok, false);
		for (const marker of [
			'@n8n/blockly-robot-skills',
			'SO101_CATALOG_SNAPSHOT',
			'robot-skills',
			'robot_move',
			'CUSTOM.robotTask',
			'@n8n/competition-designer',
		]) {
			assert.ok(
				report.errors.some((error) => error.includes(marker)),
				marker,
			);
		}
	});
});

test('reports CUSTOM.* node types in project workflow fixtures', () => {
	withFixture((root) => {
		write(
			root,
			'scripts/blockly-v1/fixtures/example.workflow.json',
			JSON.stringify({ nodes: [{ type: 'CUSTOM.blocklyCode' }] }),
		);

		const report = verifyGenericBoundary(root);
		assert.equal(report.ok, false);
		assert.ok(report.errors.some((error) => error.includes('project workflow uses a CUSTOM.*')));
	});
});

function withFixture(run) {
	const root = mkdtempSync(join(tmpdir(), 'n8n-generic-boundary-'));
	try {
		run(root);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
}

function write(root, path, content) {
	const destination = join(root, path);
	mkdirSync(dirname(destination), { recursive: true });
	writeFileSync(destination, content);
}
