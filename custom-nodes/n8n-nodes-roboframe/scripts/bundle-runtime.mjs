import { copyFile, mkdir, readdir, readFile, rm } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { build } from 'esbuild';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const nodesRoot = resolve(packageRoot, 'dist/nodes');
const bundleDirectory = resolve(packageRoot, '.bundle-runtime');

// Every dist JS that references a shared generation package gets the same
// treatment as BlocklyCode.node.js in n8n-nodes-blockly-code: bundle the
// workspace dependency into the file so the deployed dist has no external
// @n8n/* require left. n8n-workflow stays external (provided by n8n runtime).
const runtimePackages = ['@n8n/blockly-robot-skills', '@n8n/competition-designer'];
const targets = [];
for (const entry of await readdir(nodesRoot, { recursive: true, withFileTypes: true })) {
	if (!entry.isFile() || !entry.name.endsWith('.js') || entry.name.endsWith('.test.js')) continue;
	const path = resolve(entry.path, entry.name);
	const source = await readFile(path, 'utf8');
	if (runtimePackages.some((packageName) => referencesPackage(source, packageName))) {
		targets.push(path);
	}
}

if (targets.length === 0) throw new Error('No dist file references a workspace runtime package');

await rm(bundleDirectory, { force: true, recursive: true });
await mkdir(bundleDirectory, { recursive: true });

try {
	for (const target of targets) {
		const relative = target.slice(nodesRoot.length + 1);
		await build({
			absWorkingDir: packageRoot,
			entryPoints: [target],
			outdir: resolve(bundleDirectory, dirname(relative)),
			entryNames: '[name]',
			bundle: true,
			platform: 'node',
			format: 'cjs',
			target: 'node22',
			external: ['n8n-workflow'],
			sourcemap: 'linked',
			legalComments: 'none',
			logLevel: 'warning',
		});
		const bundled = resolve(bundleDirectory, relative);
		const output = await readFile(bundled, 'utf8');
		for (const packageName of runtimePackages) {
			if (referencesPackage(output, packageName)) {
				throw new Error(`Workspace runtime ${packageName} was not bundled into ${relative}`);
			}
		}
		await copyFile(bundled, target);
		await copyFile(`${bundled}.map`, `${target}.map`);
	}
	console.log(`Bundled workspace runtime packages into ${targets.length} file(s):`);
	for (const t of targets) console.log(`  ${t.slice(packageRoot.length + 1)}`);
} finally {
	await rm(bundleDirectory, { force: true, recursive: true });
}

function referencesPackage(source, packageName) {
	return (
		source.includes(`require(\"${packageName}\")`) ||
		source.includes(`require('${packageName}')`)
	);
}
