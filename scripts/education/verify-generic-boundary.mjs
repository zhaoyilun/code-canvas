#!/usr/bin/env node

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, extname, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const defaultRoot = resolve(scriptDirectory, '../..');

const legacyImplementationGroups = [
	{
		name: 'RoboFrame community nodes',
		paths: ['custom-nodes/n8n-nodes-roboframe'],
	},
	{
		name: 'domain Blockly and competition generators',
		paths: ['packages/@n8n/blockly-robot-skills', 'packages/@n8n/competition-designer'],
	},
	{
		name: 'hardware bridge',
		paths: ['services/roboframe-bridge'],
	},
	{
		name: 'device deployment',
		paths: ['deploy/rk3588'],
	},
	{
		name: 'domain delivery assets',
		paths: [
			'docs/competition',
			'docs/roboframe',
			'scripts/competition',
			'.agents/specs/roboframe-integration-v1.md',
		],
	},
];

const productionEntries = [
	'custom-nodes',
	'packages/@n8n/blockly-data-transform/src',
	'packages/@n8n/blockly-capability-plan/src',
	'packages/@n8n/dual-canvas-core/src',
	'packages/@n8n/dual-canvas-typescript-importer/src',
	'packages/frontend/editor-ui/src/app/components/MainHeader/MainHeader.vue',
	'packages/frontend/editor-ui/src/app/components/workbench',
	'packages/frontend/editor-ui/src/app/css/_workflow-workbench.scss',
	'packages/frontend/editor-ui/src/app/css/index.scss',
	'packages/frontend/editor-ui/src/features/ndv/parameters/components/ParameterInput.vue',
	'packages/frontend/editor-ui/src/features/shared/editors/components/BlocklyEditor',
	'packages/frontend/editor-ui/src/features/workflows/canvas/components/WorkflowCanvas.vue',
	'packages/frontend/editor-ui/src/features/workflows/canvas/components/WorkflowCanvas.workbench.scss',
	'packages/workflow/src/interfaces.ts',
	'services',
	'deploy',
	'scripts/blockly-v1',
];

const manifestEntries = [
	'package.json',
	'custom-nodes',
	'packages/@n8n',
	'packages/frontend/editor-ui/package.json',
	'packages/workflow/package.json',
];

const fixtureEntries = [
	'scripts/blockly-v1/fixtures',
	'custom-nodes/n8n-nodes-blockly-code/fixtures',
	'packages/@n8n/blockly-data-transform/examples',
	'packages/@n8n/blockly-capability-plan/examples',
	'packages/@n8n/dual-canvas-core/examples',
	'packages/@n8n/dual-canvas-typescript-importer/examples',
	'packages/@n8n/dual-canvas-typescript-importer/fixtures',
];

const forbiddenPatterns = [
	{ name: 'legacy Blockly domain package', pattern: /@n8n\/blockly-robot-skills/g },
	{ name: 'device catalog snapshot', pattern: /SO101_CATALOG_SNAPSHOT/g },
	{ name: 'legacy editor profile', pattern: /robot-skills/g },
	{ name: 'domain Blockly block type', pattern: /\brobot_[A-Za-z0-9_]+\b/g },
	{ name: 'legacy custom robot node type', pattern: /\bCUSTOM\.robot[A-Za-z0-9_.-]*\b/g },
	{ name: 'legacy competition package', pattern: /@n8n\/competition-designer/g },
];

const textExtensions = new Set([
	'.cjs',
	'.css',
	'.html',
	'.js',
	'.json',
	'.json5',
	'.mjs',
	'.py',
	'.scss',
	'.sh',
	'.toml',
	'.ts',
	'.tsx',
	'.vue',
	'.yaml',
	'.yml',
]);

const excludedDirectoryNames = new Set([
	'.git',
	'.pack',
	'coverage',
	'dist',
	'node_modules',
	'test',
	'tests',
	'__tests__',
]);

const testFilePattern = /(?:^|\.)((?:spec)|(?:test))\.[^.]+$/;
const generatedWorkflowPattern = /\bCUSTOM\.[A-Za-z0-9_.-]+\b/g;

export function verifyGenericBoundary(rootDirectory = defaultRoot) {
	const root = resolve(rootDirectory);
	const errors = [];
	const scannedFiles = new Set();

	for (const group of legacyImplementationGroups) {
		for (const path of group.paths) {
			if (existsSync(resolveInsideRoot(root, path))) {
				errors.push(`legacy implementation remains (${group.name}): ${path}`);
			}
		}
	}

	for (const entry of productionEntries) {
		for (const file of collectProductionFiles(root, entry)) scannedFiles.add(file);
	}
	for (const entry of manifestEntries) {
		for (const file of collectManifestFiles(root, entry)) scannedFiles.add(file);
	}
	for (const entry of fixtureEntries) {
		for (const file of collectFixtureFiles(root, entry)) scannedFiles.add(file);
	}

	for (const file of [...scannedFiles].sort()) {
		const content = readFileSync(file, 'utf8');
		for (const rule of forbiddenPatterns) {
			for (const match of content.matchAll(rule.pattern)) {
				const position = locate(content, match.index ?? 0);
				errors.push(
					`${rule.name}: ${toRepositoryPath(root, file)}:${position.line}:${position.column} (${match[0]})`,
				);
			}
		}
	}

	const workflowFiles = collectWorkflowFixtures(root);
	for (const file of workflowFiles) {
		const content = readFileSync(file, 'utf8');
		for (const match of content.matchAll(generatedWorkflowPattern)) {
			const position = locate(content, match.index ?? 0);
			errors.push(
				`project workflow uses a CUSTOM.* node type: ${toRepositoryPath(root, file)}:${position.line}:${position.column} (${match[0]})`,
			);
		}
	}

	return {
		ok: errors.length === 0,
		errors,
		scannedFileCount: scannedFiles.size,
		workflowFileCount: workflowFiles.length,
	};
}

function collectProductionFiles(root, entry) {
	return collectFiles(root, entry, (file) => {
		const name = file.split(/[\\/]/).at(-1) ?? '';
		return textExtensions.has(extname(name)) && !testFilePattern.test(name);
	});
}

function collectManifestFiles(root, entry) {
	return collectFiles(root, entry, (file) => file.split(/[\\/]/).at(-1) === 'package.json');
}

function collectFixtureFiles(root, entry) {
	return collectFiles(root, entry, (file) => textExtensions.has(extname(file)));
}

function collectWorkflowFixtures(root) {
	const files = new Set();
	for (const entry of fixtureEntries) {
		for (const file of collectFiles(root, entry, (candidate) =>
			candidate.endsWith('.workflow.json'),
		)) {
			files.add(file);
		}
	}
	return [...files].sort();
}

function collectFiles(root, entry, acceptsFile) {
	const start = resolveInsideRoot(root, entry);
	if (!existsSync(start)) return [];
	if (statSync(start).isFile()) return acceptsFile(start) ? [start] : [];

	const files = [];
	const pending = [start];
	while (pending.length > 0) {
		const current = pending.pop();
		if (!current) break;
		for (const child of readdirSync(current, { withFileTypes: true })) {
			const path = resolve(current, child.name);
			if (child.isDirectory()) {
				if (!excludedDirectoryNames.has(child.name)) pending.push(path);
			} else if (child.isFile() && acceptsFile(path)) {
				files.push(path);
			}
		}
	}
	return files;
}

function resolveInsideRoot(root, path) {
	const resolved = resolve(root, path);
	const prefix = root.endsWith(sep) ? root : `${root}${sep}`;
	if (resolved !== root && !resolved.startsWith(prefix)) {
		throw new Error(`path escapes repository root: ${path}`);
	}
	return resolved;
}

function locate(content, index) {
	const before = content.slice(0, index);
	const lines = before.split(/\r?\n/);
	return { line: lines.length, column: (lines.at(-1)?.length ?? 0) + 1 };
}

function toRepositoryPath(root, file) {
	return relative(root, file).split(sep).join('/');
}

function parseRootArgument(arguments_) {
	const argument = arguments_.find((value) => value.startsWith('--root='));
	return argument ? resolve(argument.slice('--root='.length)) : defaultRoot;
}

function runCli() {
	const report = verifyGenericBoundary(parseRootArgument(process.argv.slice(2)));
	if (!report.ok) {
		console.error(`FAIL: generic boundary has ${report.errors.length} violation(s)`);
		for (const error of report.errors) console.error(`- ${error}`);
		process.exitCode = 1;
		return;
	}

	console.log(
		`PASS: generic boundary verified (${report.scannedFileCount} production/manifest/fixture files, ${report.workflowFileCount} workflow fixtures)`,
	);
	console.log(
		'PASS: five legacy implementation groups are absent and project workflows use installed node types',
	);
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) runCli();
