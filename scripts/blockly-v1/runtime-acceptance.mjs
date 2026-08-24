#!/usr/bin/env node

import { spawn, spawnSync } from 'node:child_process';
import {
	createWriteStream,
	existsSync,
	mkdirSync,
	readFileSync,
	readdirSync,
	writeFileSync,
} from 'node:fs';
import { createServer } from 'node:net';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = resolve(SCRIPT_DIR, '../..');
const FIXTURE_PATH = join(SCRIPT_DIR, 'fixtures', 'blockly-data-transform-v1.workflow.json');
const VERIFY_V1_PATH = join(SCRIPT_DIR, 'verify-v1.mjs');
const VERIFY_EXECUTION_PATH = join(SCRIPT_DIR, 'verify-execution.mjs');
const PACKAGE_DIR = join(ROOT_DIR, 'custom-nodes', 'n8n-nodes-blockly-code');
const EXPECTED_NODE_TYPE = 'n8n-nodes-blockly-code.blocklyCode';
const RUNTIME_ENVIRONMENT_PREFIXES = [
	'N8N_',
	'DB_',
	'EXECUTIONS_',
	'QUEUE_',
	'NODES_',
	'EXTERNAL_HOOK_',
	'NODE_FUNCTION_',
];
const RUNTIME_ENVIRONMENT_KEYS = new Set(['OFFLOAD_MANUAL_EXECUTIONS_TO_WORKERS']);

const BUILD_OUTPUTS = [
	{
		path: join(ROOT_DIR, 'packages', '@n8n', 'blockly-data-transform', 'dist', 'index.js'),
		command: 'pnpm --filter @n8n/blockly-data-transform build',
		logName: 'shared-compiler-build.log',
	},
	{
		path: join(PACKAGE_DIR, 'dist', 'nodes', 'BlocklyCode', 'BlocklyCode.node.js'),
		command: 'pnpm --filter n8n-nodes-blockly-code build',
		logName: 'community-node-build.log',
	},
	{
		path: join(
			ROOT_DIR,
			'packages',
			'nodes-base',
			'dist',
			'nodes',
			'ManualTrigger',
			'ManualTrigger.node.js',
		),
		command: 'pnpm --filter n8n-nodes-base build',
		logName: 'nodes-base-build.log',
	},
	{
		path: join(ROOT_DIR, 'packages', '@n8n', 'task-runner', 'dist', 'start.js'),
		command: 'pnpm --filter @n8n/task-runner build',
		logName: 'task-runner-build.log',
	},
	{
		path: join(ROOT_DIR, 'packages', 'cli', 'dist', 'command-registry.js'),
		command: 'pnpm --filter n8n build',
		logName: 'cli-build.log',
	},
];

export function getMissingBuildOutputs() {
	return BUILD_OUTPUTS.filter(({ path }) => !existsSync(path));
}

export function validateWorkflowFixture(workflow) {
	if (!workflow || typeof workflow !== 'object' || Array.isArray(workflow)) {
		throw new Error('Workflow fixture must be a JSON object');
	}
	if (typeof workflow.id !== 'string' || workflow.id.length === 0) {
		throw new Error('Workflow fixture must have a stable id');
	}
	if (!Array.isArray(workflow.nodes)) throw new Error('Workflow fixture nodes are missing');

	const blocklyNodes = workflow.nodes.filter((node) => node?.type === EXPECTED_NODE_TYPE);
	if (blocklyNodes.length !== 1) {
		throw new Error(`Workflow fixture must contain exactly one ${EXPECTED_NODE_TYPE} node`);
	}

	return { workflowId: workflow.id, nodeType: blocklyNodes[0].type };
}

export function extractExecutionJson(rawOutput) {
	for (let start = rawOutput.indexOf('{'); start >= 0; start = rawOutput.indexOf('{', start + 1)) {
		const end = findJsonObjectEnd(rawOutput, start);
		if (end < 0) continue;
		try {
			const candidate = JSON.parse(rawOutput.slice(start, end + 1));
			if (
				candidate &&
				typeof candidate === 'object' &&
				typeof candidate.status === 'string' &&
				candidate.data?.resultData?.runData
			) {
				return candidate;
			}
		} catch {
			// This opening brace belonged to a log line rather than the execution record.
		}
	}
	throw new Error('n8n execution JSON was not found after the startup log prefix');
}

export function verifyTaskRunnerLog(rawOutput, brokerPort) {
	if (!rawOutput.includes(`Task Broker ready on 127.0.0.1, port ${brokerPort}`)) {
		throw new Error(`Task Broker readiness for port ${brokerPort} was not found in execution logs`);
	}
	if (!rawOutput.includes('Registered runner "JS Task Runner"')) {
		throw new Error('JavaScript Task Runner registration was not found in execution logs');
	}
	if (rawOutput.includes('TASK RUNNER CONFIGURED TO START IN INSECURE MODE')) {
		throw new Error('Execution logs report an insecure Task Runner');
	}
	return {
		taskBrokerReady: true,
		jsTaskRunnerRegistered: true,
		insecureWarningPresent: false,
	};
}

export async function selectBrokerPort(excludedPorts = new Set([8080])) {
	for (;;) {
		const port = await reserveEphemeralPort();
		if (!excludedPorts.has(port)) return port;
	}
}

export function parseArguments(arguments_) {
	let checkOnly = false;
	let runtimeDir;
	for (let index = 0; index < arguments_.length; index++) {
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
				'Usage: node scripts/blockly-v1/runtime-acceptance.mjs [--check] [--runtime-dir=<path>]',
			);
		}
	}
	return { checkOnly, runtimeDir };
}

async function main() {
	const options = parseArguments(process.argv.slice(2));
	const workflow = JSON.parse(readFileSync(FIXTURE_PATH, 'utf8'));
	const fixture = validateWorkflowFixture(workflow);
	const missingOutputs = getMissingBuildOutputs();
	if (missingOutputs.length > 0) {
		throw new Error(formatMissingBuildOutputs(missingOutputs));
	}

	if (options.checkOnly) {
		runFixtureCheck();
		console.log(`PASS: build outputs and ${fixture.nodeType} fixture are ready`);
		return;
	}

	const runtimeDir = resolve(
		options.runtimeDir ?? join(SCRIPT_DIR, '.runtime', 'acceptance', runtimeName()),
	);
	if (existsSync(runtimeDir) && readdirSync(runtimeDir).length > 0) {
		throw new Error(`Runtime directory must be new or empty: ${runtimeDir}`);
	}
	const evidenceDir = join(runtimeDir, 'evidence');
	const packageOutputDir = join(runtimeDir, 'package');
	const userFolder = join(runtimeDir, 'n8n-user');
	const nodeModulesDir = join(userFolder, '.n8n', 'nodes', 'node_modules');
	const installedPackageDir = join(nodeModulesDir, 'n8n-nodes-blockly-code');
	for (const directory of [evidenceDir, packageOutputDir, installedPackageDir]) {
		mkdirSync(directory, { recursive: true });
	}

	const brokerPort = await selectBrokerPort();
	const runtimeEnvironment = createRuntimeEnvironment(userFolder, brokerPort);
	writeJson(join(evidenceDir, 'runtime-config.json'), {
		runtimeDir,
		userFolder,
		communityPackageDirectory: installedPackageDir,
		workflowId: fixture.workflowId,
		nodeType: fixture.nodeType,
		brokerPort,
		n8nPort: runtimeEnvironment.N8N_PORT,
		communityPackagesEnabled: runtimeEnvironment.N8N_COMMUNITY_PACKAGES_ENABLED,
		unverifiedPackagesEnabled: runtimeEnvironment.N8N_UNVERIFIED_PACKAGES_ENABLED,
		communityPackagesPreventLoading: runtimeEnvironment.N8N_COMMUNITY_PACKAGES_PREVENT_LOADING,
		runnersMode: runtimeEnvironment.N8N_RUNNERS_MODE,
		runnersInsecureMode: runtimeEnvironment.N8N_RUNNERS_INSECURE_MODE,
	});

	console.log(`Runtime: ${runtimeDir}`);
	console.log(`Evidence: ${evidenceDir}`);
	console.log(`Task Runner broker port: ${brokerPort}`);

	await runRequiredCommand(
		'pnpm',
		['--dir', PACKAGE_DIR, 'pack', '--pack-destination', packageOutputDir],
		{
			cwd: ROOT_DIR,
			env: { ...process.env, CI: '1' },
			logPrefix: join(evidenceDir, '01-pack'),
		},
	);
	const tarballs = readdirSync(packageOutputDir).filter((name) => name.endsWith('.tgz'));
	if (tarballs.length !== 1)
		throw new Error('Package step did not produce exactly one .tgz archive');
	const tarballPath = join(packageOutputDir, tarballs[0]);

	await runRequiredCommand(
		'tar',
		['-xzf', tarballPath, '--strip-components=1', '-C', installedPackageDir],
		{
			cwd: ROOT_DIR,
			env: process.env,
			logPrefix: join(evidenceDir, '02-unpack'),
		},
	);
	const installedManifest = JSON.parse(
		readFileSync(join(installedPackageDir, 'package.json'), 'utf8'),
	);
	if (installedManifest.name !== 'n8n-nodes-blockly-code') {
		throw new Error('Installed package manifest has an unexpected package name');
	}
	if (installedManifest.n8n?.nodes?.[0] !== 'dist/nodes/BlocklyCode/BlocklyCode.node.js') {
		throw new Error('Installed package manifest has an unexpected n8n node entry');
	}
	writeJson(join(evidenceDir, 'installed-package.json'), {
		name: installedManifest.name,
		version: installedManifest.version,
		nodeEntry: installedManifest.n8n.nodes[0],
		tarball: basename(tarballPath),
	});

	await runRequiredCommand(process.execPath, [VERIFY_V1_PATH, FIXTURE_PATH, '--require-compiler'], {
		cwd: ROOT_DIR,
		env: createFixtureEnvironment(),
		logPrefix: join(evidenceDir, '03-fixture'),
	});

	const n8nBin = join(ROOT_DIR, 'packages', 'cli', 'bin', 'n8n');
	await runRequiredCommand(
		process.execPath,
		[n8nBin, 'import:workflow', `--input=${FIXTURE_PATH}`],
		{
			cwd: ROOT_DIR,
			env: runtimeEnvironment,
			logPrefix: join(evidenceDir, '04-import'),
		},
	);

	const execution = await runRequiredCommand(
		process.execPath,
		[n8nBin, 'execute', `--id=${fixture.workflowId}`, '--rawOutput'],
		{
			cwd: ROOT_DIR,
			env: runtimeEnvironment,
			logPrefix: join(evidenceDir, '05-execute'),
		},
	);
	let executionRecord;
	const taskRunnerEvidence = verifyTaskRunnerLog(
		`${execution.stdout}\n${execution.stderr}`,
		brokerPort,
	);
	try {
		executionRecord = extractExecutionJson(execution.stdout);
	} catch {
		executionRecord = extractExecutionJson(`${execution.stdout}\n${execution.stderr}`);
	}
	const executionPath = join(evidenceDir, 'execution.json');
	writeJson(executionPath, executionRecord);

	const verification = await runRequiredCommand(
		process.execPath,
		[VERIFY_EXECUTION_PATH, executionPath, `--workflow=${FIXTURE_PATH}`],
		{
			cwd: ROOT_DIR,
			env: process.env,
			logPrefix: join(evidenceDir, '06-verify'),
		},
	);
	const verificationMessage = verification.stdout.trim().split(/\r?\n/).at(-1);
	writeJson(join(evidenceDir, 'result.json'), {
		status: 'passed',
		workflowId: fixture.workflowId,
		nodeType: fixture.nodeType,
		n8nPort: runtimeEnvironment.N8N_PORT,
		brokerPort,
		...taskRunnerEvidence,
		packageDirectory: installedPackageDir,
		executionPath,
		verification: verificationMessage,
	});

	console.log(verificationMessage);
	console.log(
		`PASS: real n8n runtime loaded ${fixture.nodeType} from the isolated community package`,
	);
	console.log(`Evidence retained at: ${evidenceDir}`);
}

export function createRuntimeEnvironment(userFolder, brokerPort, baseEnvironment = process.env) {
	const environment = Object.fromEntries(
		Object.entries(baseEnvironment).filter(([name]) => {
			const normalizedName = name.toUpperCase();
			return (
				!RUNTIME_ENVIRONMENT_KEYS.has(normalizedName) &&
				!RUNTIME_ENVIRONMENT_PREFIXES.some((prefix) => normalizedName.startsWith(prefix))
			);
		}),
	);
	Object.assign(environment, {
		CI: '1',
		NO_COLOR: '1',
		N8N_USER_FOLDER: userFolder,
		N8N_PORT: '5678',
		N8N_COMMUNITY_PACKAGES_ENABLED: 'true',
		N8N_UNVERIFIED_PACKAGES_ENABLED: 'true',
		N8N_COMMUNITY_PACKAGES_PREVENT_LOADING: 'false',
		N8N_RUNNERS_MODE: 'internal',
		N8N_RUNNERS_INSECURE_MODE: 'false',
		N8N_RUNNERS_BROKER_PORT: String(brokerPort),
		N8N_RUNNERS_BROKER_LISTEN_ADDRESS: '127.0.0.1',
		N8N_DIAGNOSTICS_ENABLED: 'false',
		N8N_VERSION_NOTIFICATIONS_ENABLED: 'false',
		N8N_TEMPLATES_ENABLED: 'false',
		N8N_PERSONALIZATION_ENABLED: 'false',
		N8N_LOG_LEVEL: 'info',
		DB_TYPE: 'sqlite',
		DB_SQLITE_DATABASE: 'database.sqlite',
		DB_SQLITE_POOL_SIZE: '1',
	});
	return environment;
}

export function createFixtureEnvironment(baseEnvironment = process.env) {
	return Object.fromEntries(
		Object.entries(baseEnvironment).filter(
			([name]) => name.toUpperCase() !== 'N8N_BLOCKLY_COMPILER_MODULE',
		),
	);
}

function runFixtureCheck() {
	const result = spawnSync(process.execPath, [VERIFY_V1_PATH, FIXTURE_PATH, '--require-compiler'], {
		cwd: ROOT_DIR,
		env: createFixtureEnvironment(),
		stdio: 'inherit',
		windowsHide: true,
	});
	if (result.error) throw new Error(`Failed to start fixture verifier: ${result.error.message}`);
	if (result.status !== 0) throw new Error(`Fixture verifier exited with ${result.status}`);
}

async function runRequiredCommand(command, arguments_, options) {
	const result = await runLoggedCommand(command, arguments_, options);
	if (result.exitCode !== 0) {
		throw new Error(
			`${command} exited with ${result.exitCode}; inspect ${options.logPrefix}.stdout.log and ${options.logPrefix}.stderr.log`,
		);
	}
	return result;
}

function runLoggedCommand(command, arguments_, { cwd, env, logPrefix }) {
	return new Promise((resolvePromise, rejectPromise) => {
		const stdoutPath = `${logPrefix}.stdout.log`;
		const stderrPath = `${logPrefix}.stderr.log`;
		const stdoutFile = createWriteStream(stdoutPath);
		const stderrFile = createWriteStream(stderrPath);
		const child = spawn(command, arguments_, { cwd, env, windowsHide: true });
		const stdoutChunks = [];
		const stderrChunks = [];

		child.stdout.on('data', (chunk) => {
			stdoutChunks.push(chunk);
			stdoutFile.write(chunk);
		});
		child.stderr.on('data', (chunk) => {
			stderrChunks.push(chunk);
			stderrFile.write(chunk);
		});
		child.once('error', (error) => {
			stdoutFile.end();
			stderrFile.end();
			rejectPromise(new Error(`Failed to start ${command}: ${error.message}`));
		});
		child.once('close', (exitCode) => {
			stdoutFile.end();
			stderrFile.end();
			resolvePromise({
				exitCode,
				stdout: Buffer.concat(stdoutChunks).toString('utf8'),
				stderr: Buffer.concat(stderrChunks).toString('utf8'),
			});
		});
	});
}

function findJsonObjectEnd(value, start) {
	let depth = 0;
	let inString = false;
	let escaped = false;
	for (let index = start; index < value.length; index++) {
		const character = value[index];
		if (inString) {
			if (escaped) escaped = false;
			else if (character === '\\') escaped = true;
			else if (character === '"') inString = false;
			continue;
		}
		if (character === '"') inString = true;
		else if (character === '{') depth++;
		else if (character === '}' && --depth === 0) return index;
	}
	return -1;
}

function reserveEphemeralPort() {
	return new Promise((resolvePromise, rejectPromise) => {
		const server = createServer();
		server.unref();
		server.once('error', rejectPromise);
		server.listen(0, '127.0.0.1', () => {
			const address = server.address();
			if (!address || typeof address === 'string') {
				server.close();
				rejectPromise(new Error('Failed to reserve a local broker port'));
				return;
			}
			server.close((error) => {
				if (error) rejectPromise(error);
				else resolvePromise(address.port);
			});
		});
	});
}

export function formatMissingBuildOutputs(missingOutputs) {
	const paths = missingOutputs.map(({ path }) => `- ${path}`).join('\n');
	const commands = missingOutputs
		.map(({ command, logName }) => `  ${command} > scripts/blockly-v1/.runtime/${logName} 2>&1`)
		.join('\n');
	return `Required build outputs are missing:\n${paths}\nBuild them from ${ROOT_DIR}:\n  node -e "require('node:fs').mkdirSync('scripts/blockly-v1/.runtime',{recursive:true})"\n${commands}`;
}

function runtimeName() {
	return `${new Date().toISOString().replaceAll(/[-:.]/g, '')}-${process.pid}`;
}

function writeJson(path, value) {
	writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
	main().catch((error) => {
		console.error(`FAIL: ${error instanceof Error ? error.message : String(error)}`);
		process.exitCode = 1;
	});
}
