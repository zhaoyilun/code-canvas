#!/usr/bin/env node

import assert from 'node:assert/strict';
import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readdirSync,
	rmSync,
	utimesSync,
	writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
	createFixtureEnvironment,
	createRuntimeEnvironment,
	extractExecutionJson,
	findNewestProductionInput,
	formatBuildOutputProblems,
	getBuildOutputProblems,
	parseArguments,
	runWorkflowAcceptance,
	runtimeBuildRequirements,
	selectBrokerPort,
	validateWorkflowFixture,
	verifyTaskRunnerLog,
} from './runtime-acceptance.mjs';

const EXECUTION = {
	data: { resultData: { runData: { 'Blockly Data Transform': [] } } },
	finished: true,
	status: 'success',
};

test('extracts execution JSON after structured and plain startup logs', () => {
	const output = [
		'Warning: startup detail {not valid JSON}',
		'{"event":"runner-ready","port":15679}',
		JSON.stringify(EXECUTION, null, 2),
	].join('\n');
	assert.deepEqual(extractExecutionJson(output), EXECUTION);
});

test('ignores braces and escaped quotes inside execution strings', () => {
	const execution = structuredClone(EXECUTION);
	execution.data.resultData.message = 'value { with "quotes" }';
	assert.deepEqual(
		extractExecutionJson(`prefix\n${JSON.stringify(execution)}\ntrailer`),
		execution,
	);
});

test('rejects logs without an execution record', () => {
	assert.throws(
		() => extractExecutionJson('{"event":"runner-ready"}'),
		/execution JSON was not found/,
	);
});

test('requires secure JavaScript Task Runner registration on the selected broker port', () => {
	const logs = [
		'n8n Task Broker ready on 127.0.0.1, port 15679',
		'Registered runner "JS Task Runner" (runner-id)',
	].join('\n');
	assert.deepEqual(verifyTaskRunnerLog(logs, 15679), {
		taskBrokerReady: true,
		jsTaskRunnerRegistered: true,
		insecureWarningPresent: false,
	});
	assert.throws(() => verifyTaskRunnerLog(logs, 15680), /readiness/);
	assert.throws(
		() => verifyTaskRunnerLog(`${logs}\nTASK RUNNER CONFIGURED TO START IN INSECURE MODE`, 15679),
		/insecure Task Runner/,
	);
});

test('requires the package-qualified Blockly node type', () => {
	assert.deepEqual(
		validateWorkflowFixture({
			id: 'workflow-id',
			nodes: [{ type: 'n8n-nodes-blockly-code.blocklyCode' }],
		}),
		{ workflowId: 'workflow-id', nodeType: 'n8n-nodes-blockly-code.blocklyCode' },
	);
	assert.throws(
		() => validateWorkflowFixture({ id: 'workflow-id', nodes: [{ type: 'example.blocklyCode' }] }),
		/package-qualified|exactly one/,
	);
});

test('parses check and runtime directory options', () => {
	assert.deepEqual(parseArguments(['--check', '--runtime-dir=tmp/run']), {
		checkOnly: true,
		runtimeDir: 'tmp/run',
	});
	assert.throws(() => parseArguments(['--runtime-dir']), /requires a path/);
});

test('selects an available broker port other than 8080', async () => {
	const port = await selectBrokerPort(new Set([8080]));
	assert.ok(Number.isInteger(port) && port > 0 && port < 65536);
	assert.notEqual(port, 8080);
});

test('rejects a reused runtime directory before staging or overwriting evidence', async () => {
	const runtimeDirectory = mkdtempSync(join(tmpdir(), 'blockly-runtime-reused-'));
	const evidenceDirectory = join(runtimeDirectory, 'evidence');
	mkdirSync(evidenceDirectory);
	const sentinelPath = join(evidenceDirectory, 'sentinel.txt');
	writeFileSync(sentinelPath, 'keep-this-byte-for-byte', 'utf8');
	let staged = false;
	try {
		await assert.rejects(
			runWorkflowAcceptance({
				runtimeDir: runtimeDirectory,
				workflow: {
					id: 'runtime-reuse-test',
					nodes: [{ type: 'n8n-nodes-blockly-code.blocklyCode' }],
				},
				stageEvidence: () => {
					staged = true;
				},
			}),
			/new or empty/,
		);
		assert.equal(staged, false);
		assert.deepEqual(readdirSync(runtimeDirectory), ['evidence']);
		assert.deepEqual(readdirSync(evidenceDirectory), ['sentinel.txt']);
		assert.equal(readFileSync(sentinelPath, 'utf8'), 'keep-this-byte-for-byte');
	} finally {
		rmSync(runtimeDirectory, { force: true, recursive: true });
	}
});

test('builds an isolated runtime environment from an n8n and database whitelist', () => {
	const environment = createRuntimeEnvironment('/tmp/n8n-user', 15679, {
		PATH: '/usr/bin',
		N8N_PORT: '8080',
		N8N_CUSTOM_EXTENSIONS: '/outside/custom',
		N8N_COMMUNITY_PACKAGES_MANAGED_BY_ENV: 'true',
		DB_SQLITE_DATABASE: '/outside/database.sqlite',
		EXECUTIONS_MODE: 'queue',
		NODES_EXCLUDE: 'n8n-nodes-base.manualTrigger',
		EXTERNAL_HOOK_FILES: '/outside/hooks.js',
		OFFLOAD_MANUAL_EXECUTIONS_TO_WORKERS: 'true',
	});
	assert.equal(environment.PATH, '/usr/bin');
	assert.equal(environment.N8N_PORT, '5678');
	assert.equal(environment.N8N_RUNNERS_BROKER_PORT, '15679');
	assert.equal(environment.DB_SQLITE_DATABASE, 'database.sqlite');
	assert.equal(environment.N8N_CUSTOM_EXTENSIONS, undefined);
	assert.equal(environment.N8N_COMMUNITY_PACKAGES_MANAGED_BY_ENV, undefined);
	assert.equal(environment.EXECUTIONS_MODE, undefined);
	assert.equal(environment.NODES_EXCLUDE, undefined);
	assert.equal(environment.EXTERNAL_HOOK_FILES, undefined);
	assert.equal(environment.OFFLOAD_MANUAL_EXECUTIONS_TO_WORKERS, undefined);
});

test('fixture verification always uses the repository compiler', () => {
	const environment = createFixtureEnvironment({
		PATH: '/usr/bin',
		N8N_BLOCKLY_COMPILER_MODULE: '/outside/compiler.js',
	});
	assert.equal(environment.PATH, '/usr/bin');
	assert.equal(environment.N8N_BLOCKLY_COMPILER_MODULE, undefined);
});

test('build output guidance includes ordered executable commands', () => {
	const message = formatBuildOutputProblems([
		{
			path: '/repo/dist/file.js',
			command: 'pnpm --filter package build',
			reason: 'missing',
		},
	]);
	assert.match(message, /\/repo\/dist\/file\.js/);
	assert.match(message, /pnpm --filter package build/);
});

test('freshness gate tracks production source and manifests, ignores tests, and propagates upstream staleness', () => {
	const directory = mkdtempSync(join(tmpdir(), 'blockly-build-freshness-'));
	try {
		const sourceDirectory = join(directory, 'src');
		const outputDirectory = join(directory, 'dist');
		mkdirSync(sourceDirectory);
		mkdirSync(outputDirectory);
		const productionSource = join(sourceDirectory, 'index.ts');
		const testSource = join(sourceDirectory, 'index.test.ts');
		const manifest = join(directory, 'package.json');
		const upstreamOutput = join(outputDirectory, 'index.js');
		const upstreamBuildMarker = join(outputDirectory, 'build.tsbuildinfo');
		const downstreamOutput = join(outputDirectory, 'consumer.js');
		for (const path of [
			productionSource,
			testSource,
			manifest,
			upstreamOutput,
			upstreamBuildMarker,
			downstreamOutput,
		]) {
			writeFileSync(path, path, 'utf8');
		}

		const at = (seconds) => new Date(seconds * 1000);
		utimesSync(productionSource, at(100), at(100));
		utimesSync(manifest, at(100), at(100));
		utimesSync(upstreamOutput, at(150), at(150));
		utimesSync(upstreamBuildMarker, at(200), at(200));
		utimesSync(downstreamOutput, at(300), at(300));
		utimesSync(testSource, at(400), at(400));

		const requirements = [
			{
				path: upstreamOutput,
				freshnessMarker: upstreamBuildMarker,
				inputs: [sourceDirectory, manifest],
				command: 'pnpm --filter upstream build',
			},
			{
				path: downstreamOutput,
				inputs: [upstreamBuildMarker],
				command: 'pnpm --filter downstream build',
			},
		];
		assert.equal(findNewestProductionInput(sourceDirectory)?.path, productionSource);
		assert.deepEqual(getBuildOutputProblems(requirements), []);

		utimesSync(manifest, at(500), at(500));
		assert.deepEqual(
			getBuildOutputProblems(requirements).map(({ reason, path, inputPath }) => ({
				reason,
				path,
				inputPath,
			})),
			[
				{ reason: 'stale', path: upstreamOutput, inputPath: manifest },
				{ reason: 'upstream-stale', path: downstreamOutput, inputPath: upstreamBuildMarker },
			],
		);
	} finally {
		rmSync(directory, { force: true, recursive: true });
	}
});

test('runtime package gate binds the packed community node to sources and bundled runtimes', () => {
	const communityNode = runtimeBuildRequirements.find(
		({ command }) => command === 'pnpm --filter n8n-nodes-blockly-code build',
	);
	assert.ok(communityNode);
	assert.ok(communityNode.inputs.some((path) => path.endsWith('package.json')));
	assert.ok(communityNode.inputs.some((path) => path.endsWith('nodes')));
	assert.ok(
		communityNode.inputs.some((path) =>
			path.endsWith(join('dual-canvas-operation-runtime', 'dist', 'build.tsbuildinfo')),
		),
	);
	assert.ok(
		communityNode.inputs.some((path) =>
			path.endsWith(join('blockly-data-transform', 'dist', 'build.tsbuildinfo')),
		),
	);
});
