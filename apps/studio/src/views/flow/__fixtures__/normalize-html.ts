/**
 * 渲染基准的比对口径（只给测试用）：把 HTML 里**生成出来的**那几样抹掉，剩下的逐字比较。
 *
 *   - `data-v-*`：Vue 作用域样式的哈希，动一句 CSS 就变，与画面无关；
 *   - HTML 注释：模板里给维护者看的说明与 `v-if` 的占位，用户看不见；
 *   - `nd_<ULID>`：导入时生成的节点 id，每次运行都不同（按出现顺序编号，位置信息因此还在）。
 *
 * 于是「没有分支时渲染结果与改动前一致」这句话有了可核对的证据：
 * 与 `__fixtures__/*-baseline.html`（**改动前**那一版的产物）逐字比一遍。
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

export const normalizeRenderedHtml = (html: string): string => {
	let counter = 0;
	const placeholders = new Map<string, string>();
	return html
		.replace(/ data-v-[0-9a-f]+=""/g, '')
		.replace(/<!--[\s\S]*?-->/g, '')
		.replace(/\n\s*/g, '')
		.replace(/nd_[0-9A-HJKMNP-TV-Z]{26}/g, (id) => {
			const known = placeholders.get(id);
			if (known !== undefined) return known;
			counter += 1;
			const placeholder = `nd_ID${String(counter)}`;
			placeholders.set(id, placeholder);
			return placeholder;
		});
};

/** 读一份基准文件（路径相对 studio 包根）。 */
export const readBaseline = (relativePath: string): string =>
	readFileSync(resolve(process.cwd(), relativePath), 'utf8').trim();
