import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const repositoryRoot = resolve(import.meta.dirname, '..', '..');
const coreTarball = resolve(
	process.argv[2] ??
		join(repositoryRoot, 'packages/@n8n/dual-canvas-core/.pack/n8n-dual-canvas-core-0.1.0.tgz'),
);
const dataTransformTarball = resolve(
	process.argv[3] ??
		join(
			repositoryRoot,
			'packages/@n8n/blockly-data-transform/.pack/n8n-blockly-data-transform-0.1.0.tgz',
		),
);
const temporaryDirectory = mkdtempSync(join(tmpdir(), 'n8n-dual-canvas-esm-smoke-'));

try {
	const coreFile = pathToFileURL(coreTarball).href;
	const dataTransformFile = pathToFileURL(dataTransformTarball).href;
	writeFileSync(
		join(temporaryDirectory, 'package.json'),
		`${JSON.stringify(
			{
				private: true,
				type: 'module',
				dependencies: {
					'@n8n/blockly-data-transform': dataTransformFile,
					'@n8n/dual-canvas-core': coreFile,
				},
				pnpm: { overrides: { '@n8n/blockly-data-transform': dataTransformFile } },
			},
			null,
			2,
		)}\n`,
	);
	writeFileSync(
		join(temporaryDirectory, 'smoke.mjs'),
		`import { workflowVisualProgrammingProfileV1Schema } from '@n8n/dual-canvas-core';
const valid = workflowVisualProgrammingProfileV1Schema.safeParse({
  schemaVersion: 1,
  profileId: 'sample',
  displayName: 'Sample',
  stages: [{ id: 'run', label: 'Run', nodeTypes: ['installed.sample.run'] }],
}).success;
if (!valid) throw new Error('packed schema import failed');
console.log('PACKED_ESM_IMPORT_OK');
`,
	);

	run('pnpm', ['install', '--offline', '--ignore-workspace'], temporaryDirectory);
	run(process.execPath, [join(temporaryDirectory, 'smoke.mjs')], temporaryDirectory);
	run(
		'pnpm',
		[
			'--filter',
			'@n8n/blockly-capability-plan',
			'exec',
			'esbuild',
			join(temporaryDirectory, 'smoke.mjs'),
			'--bundle',
			'--platform=node',
			'--format=cjs',
			`--outfile=${join(temporaryDirectory, 'bundle.cjs')}`,
		],
		repositoryRoot,
	);
	run(process.execPath, [join(temporaryDirectory, 'bundle.cjs')], temporaryDirectory);

	const packedManifest = readFileSync(
		join(temporaryDirectory, 'node_modules/@n8n/blockly-data-transform/package.json'),
		'utf8',
	);
	const manifest = JSON.parse(packedManifest);
	if (
		manifest.module !== 'dist/index.js' ||
		manifest.exports?.['.']?.default !== './dist/index.js'
	) {
		throw new Error('packed data-transform entry points do not resolve to dist');
	}
	console.log(
		`PACKED_ESM_BUNDLE_OK core=${basename(coreTarball)} data=${basename(dataTransformTarball)}`,
	);
} finally {
	rmSync(temporaryDirectory, { recursive: true, force: true });
}

function run(command, args, cwd) {
	const result = spawnSync(command, args, {
		cwd,
		encoding: 'utf8',
		shell: process.platform === 'win32' && command === 'pnpm',
		stdio: 'pipe',
	});
	if (result.stdout) process.stdout.write(result.stdout);
	if (result.stderr) process.stderr.write(result.stderr);
	if (result.status !== 0) {
		throw new Error(`${command} ${args.join(' ')} exited with ${result.status ?? 'no status'}`);
	}
}
