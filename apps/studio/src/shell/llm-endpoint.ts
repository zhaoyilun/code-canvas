/**
 * 「生成接口地址」这一个数的唯一来源。
 *
 * 为什么单独一个文件：两次调用（一句话 → 任务 JSON、任务 JSON → 教学规格）必须打**同一个**
 * 地址——第一次生成完、第二次却发到别处，是最难查的一类偏差。地址本身不是真相的一部分，
 * 所以它只进 `localStorage`（`TaskInputBand` 的接口设置里填一次），不进任何 store。
 *
 * 隐私模式下 `localStorage` 会直接抛：地址记不住是小事，不该把整条链弄挂，所以读失败就退到默认。
 */
import { DEFAULT_LLM_ENDPOINT } from './llm-json';

/** 存地址用的键（`TaskInputBand` 的接口设置读写的是同一个）。 */
export const ENDPOINT_STORAGE_KEY = 'codecanvas.task-endpoint';

/** 现在该往哪儿发。空字符串与读不到都退到默认——绝不返回一个空地址。 */
export const readTaskEndpoint = (): string => {
	try {
		const stored = window.localStorage.getItem(ENDPOINT_STORAGE_KEY);
		return stored === null || stored.trim() === '' ? DEFAULT_LLM_ENDPOINT : stored;
	} catch {
		return DEFAULT_LLM_ENDPOINT;
	}
};
