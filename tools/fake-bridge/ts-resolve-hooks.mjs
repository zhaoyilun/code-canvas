/**
 * 让**裸 node** 直接加载我们这个仓库里的 TS 源码的两个解析/装载钩子。
 *
 * 为什么需要它：假 bridge 必须拿**真的** zod schema（`@codecanvas/robot-bridge` 的 `models.ts`）
 * 校验请求形状，也必须读**真的**目录（`@codecanvas/capabilities`）——手抄一份就失去了这次的意义。
 * 但那两个包是按 bundler/vitest 的口径写的，裸 node 直接 import 会撞两件事：
 *
 * 1. 包内部用**无扩展名的相对导入**（`./json`、`./roboframe`）——那是 TS 的 bundler 解析口径，
 *    ESM 不认（`ERR_MODULE_NOT_FOUND`）。这里给相对说明符补 `.ts` / `/index.ts`。
 *    （不去给那些文件加 `.ts` 后缀：那是别的包的目录，而这是开发替身的需要。）
 * 2. `import raw from './x.catalog.json'` 没有 import attribute，Node 会拒
 *    （`ERR_IMPORT_ATTRIBUTE_MISSING`）。这里把 `.json` 装载成 `export default <那份 JSON>`。
 *
 * 类型剥除用的是 node 自带的（v22.18 起缺省开；`process.features.typescript === 'strip'`），
 * 所以这里**没有**第三方依赖，也没有编译步骤。判据不在这个文件里——它只是把门打开。
 */

import { readFile } from 'node:fs/promises';

/** 相对/绝对说明符找不到时，补 TS 的两种常见落点（`./x` → `./x.ts`、`./dir` → `./dir/index.ts`）。 */
export async function resolve(specifier, context, nextResolve) {
	try {
		return await nextResolve(specifier, context);
	} catch (error) {
		if (specifier.startsWith('.') || specifier.startsWith('/')) {
			for (const suffix of ['.ts', '/index.ts']) {
				try {
					return await nextResolve(specifier + suffix, context);
				} catch {
					// 试下一种；两种都不行就把**原来那个**错误抛出去（别掩盖真因）
				}
			}
		}
		throw error;
	}
}

/** 把 `.json` 装成模块：省掉 import attribute（见文件头第 2 条）。 */
export async function load(url, context, nextLoad) {
	if (url.endsWith('.json')) {
		const source = await readFile(new URL(url), 'utf8');
		return { format: 'module', source: `export default ${source};`, shortCircuit: true };
	}
	return nextLoad(url, context);
}
