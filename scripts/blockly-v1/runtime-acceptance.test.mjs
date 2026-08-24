#!/usr/bin/env node

import assert from 'node:assert/strict';
import test from 'node:test';

import {
	createFixtureEnvironment,
	createRuntimeEnvironment,
	extractExecutionJson,
	formatMissingBuildOutputs,
	parseArguments,
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

test('missing build output guidance includes an executable redirected command', () => {
	const message = formatMissingBuildOutputs([
		{
			path: '/repo/dist/file.js',
			command: 'pnpm --filter package build',
			logName: 'package-build.log',
		},
	]);
	assert.match(message, /\/repo\/dist\/file\.js/);
	assert.match(
		message,
		/pnpm --filter package build > scripts\/blockly-v1\/\.runtime\/package-build\.log 2>&1/,
	);
});
