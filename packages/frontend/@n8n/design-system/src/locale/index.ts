import { shallowRef } from 'vue';

import type { N8nLocale, N8nLocaleTranslateFn } from '../types';
import createFormatTemplate from './format';
import defaultLang from '../locale/lang/en';

// import { ElementLocale } from 'element-plus';
// import ElementLang from 'element-plus/lib/locale/lang/en';
//
// ElementLocale.use(ElementLang);

const format = createFormatTemplate();
const lang = shallowRef<N8nLocale>(defaultLang);

let i18nHandler: N8nLocaleTranslateFn;

export const t = function (
	path: Parameters<typeof i18nHandler>[0],
	options: Parameters<typeof i18nHandler>[1],
) {
	if (typeof i18nHandler === 'function') {
		const value = i18nHandler(path, options);

		if (value !== null && value !== undefined && value !== path) {
			return String(value);
		}
	}

	// only support flat keys
	if (lang.value[path] !== undefined) {
		return format(lang.value[path], ...(options ? [options] : []));
	}

	return '';
};

export async function use(l: string) {
	try {
		const ndsLang = (await import(`./lang/${l}.ts`)) as { default: N8nLocale };

		lang.value = ndsLang.default;

		// todo breaks select empty data
		// const elLang = require(`element-ui/lib/locale/lang/${l}`);;
		// ElementLocale.use(elLang);
	} catch (e) {}
}

export function i18n(fn: N8nLocaleTranslateFn) {
	i18nHandler = fn || i18nHandler;
}

export default { use, t, i18n };
