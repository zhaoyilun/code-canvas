import { copyFile, mkdir, readFile, rm } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { build } from 'esbuild';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const target = resolve(packageRoot, 'dist/nodes/BlocklyCode/BlocklyCode.node.js');
const bundleDirectory = resolve(packageRoot, '.bundle-runtime');
const bundled = resolve(bundleDirectory, 'BlocklyCode.node.js');

await rm(bundleDirectory, { force: true, recursive: true });
await mkdir(bundleDirectory, { recursive: true });

try {
	await build({
		absWorkingDir: packageRoot,
		entryPoints: [target],
		outdir: bundleDirectory,
		entryNames: 'BlocklyCode.node',
		bundle: true,
		platform: 'node',
		format: 'cjs',
		target: 'node22',
		external: ['n8n-workflow'],
		sourcemap: 'linked',
		legalComments: 'none',
		logLevel: 'warning',
	});

	const output = await readFile(bundled, 'utf8');
	if (/require\(["']@n8n\/blockly-data-transform["']\)/.test(output))
		throw new Error('Shared Blockly compiler was not bundled');
	if (/require\(["']@n8n\/dual-canvas-operation-runtime["']\)/.test(output))
		throw new Error('Operation module runtime was not bundled');

	await copyFile(bundled, target);
	await copyFile(`${bundled}.map`, `${target}.map`);
} finally {
	await rm(bundleDirectory, { force: true, recursive: true });
}
