/**
 * 与 LLM 的一次「给我 JSON」通话：**通用**，不认识机器人任务，也不认识积木。
 *
 * 谁要用模型产出一段 JSON，就把 messages 递进来、拿回解析好的值。目前有两个调用点
 * （一句话 → 任务 JSON；任务 JSON → 能力实现），将来还会有别的——所以这里一条业务假设都不写。
 *
 * 四条约定，与 `docs/reference/llm_client.py`（那边已经在用的那份实现）对齐：
 *
 * 1. **地址是基地址**：请求打到 `<基地址>/chat/completions`。默认 `/llm` 是**同源相对路径**，
 *    dev server 把它反代到 LLM 服务并在**服务端**注入 Authorization——API key 从不进浏览器。
 *    联调时把地址换成设备组的基地址即可，两条路走的是同一个函数。
 * 2. **请求体**：`temperature: 0.1`、`max_tokens: 512`、`response_format: {type:'json_object'}`、
 *    `stream: false`，加上调用方给的 `messages`（与可选的额外字段）。另有一处刻意加料：
 *    `reasoning_effort: 'none'`——默认模型是推理模型，不关掉「思考」就会把预算全吃光、
 *    返回空内容（见 `REASONING_OFF` 上的实测记录）。
 * 3. **响应**：OpenAI 信封取 `choices[0].message.content` → 剥掉可能的 Markdown 围栏 →
 *    `JSON.parse`（老实现在 `_strip_code_fence`）。没有信封时，响应体本身就是那个 JSON 值
 *    （设备组接口可以直接给任务 JSON）。
 * 4. **重试两次**（第一次 + 一次重试，照那个脚本的 `retries=2` 与 `time.sleep(0.2)`）：
 *    传输层、响应形状、以及「调用方的判据说不行」都算。
 *
 * ⚠ 这里**不做业务校验**。要不要这份 JSON 由调用方通过 `accept` 说——校验永远只有一条路
 * （任务那条路就是 `state/document.ts` 的 `loadTaskJson`）。
 */
import type { JsonObject } from '@codecanvas/contracts';

/** 默认地址：同源相对路径，走 dev server 的反代（key 在服务端注入）。 */
export const DEFAULT_LLM_ENDPOINT = '/llm';
/** 默认模型：账户里可用的是它（DeepSeek-V4.1-Flash）。换模型改这一处，或用 options.model。 */
export const DEFAULT_LLM_MODEL = 'deepseek-flash';
/** 总尝试次数（照 `llm_client.py` 的 `retries=2`：第一次 + 一次重试）。 */
export const GENERATION_ATTEMPTS = 2;
/** 两次尝试之间的等待（照那个脚本的 `time.sleep(0.2)`）。 */
export const RETRY_DELAY_MS = 200;
/** 说话的长度上限（照那个脚本的 `max_tokens=512`）。 */
export const MAX_TOKENS = 512;
/**
 * 关掉「思考」那一档。
 *
 * ⚠ 这是相对 `llm_client.py` 的**唯一一处刻意加料**，因为默认模型换了：账户里可用的是
 * `deepseek-flash`（推理模型），而那份脚本当初对接的是非推理模型。实测（`/llm` 反代，
 * 系统提示词 + 「前进1米，避障后停止」）：
 *   - 不带这个字段、`max_tokens` 512/768/1024/2048 一律 `finish_reason: length`、
 *     `content` 长度为 0（预算全被 reasoning 吃掉，只有 `reasoning_content`）；
 *   - 带上 `reasoning_effort: "none"`：1.3s 返回完整任务 JSON，`reasoning_content` 为 0。
 * 非推理端点（设备组那条路）会忽略这个多余字段。
 */
export const REASONING_OFF = 'none';

export interface GenerationMessage {
	readonly role: 'system' | 'user';
	readonly content: string;
}

export interface JsonGenerationOptions {
	/** 完整对话：system 定规矩，user 给这一句话。 */
	readonly messages: readonly GenerationMessage[];
	/** 基地址；缺省 `DEFAULT_LLM_ENDPOINT`。 */
	readonly endpoint?: string;
	readonly model?: string;
	readonly attempts?: number;
	/**
	 * 「这份值能不能用」。返回 false 就再试一次（模型偶尔漏个字段，重试一次的收益是实打实的）。
	 * 参数是解析出来的值与它对应的文本——两条路各取所需（任务路要文本，别的路要值）。
	 */
	readonly accept?: (value: unknown, text: string) => boolean;
	/** 额外塞进请求体的字段（例如设备组接口要的 `catalogRef` / `instruction`）。 */
	readonly extras?: JsonObject;
	/** 每次真的要发请求之前报一下（界面拿它写「第 N 次」）。 */
	readonly onAttempt?: (attempt: number, total: number) => void;
	/** 测试用：换掉 fetch 与等待。 */
	readonly fetchImpl?: typeof fetch;
	readonly wait?: (ms: number) => Promise<void>;
}

export type JsonGenerationFailureKind = 'transport' | 'response' | 'rejected';

export type JsonGenerationResult =
	| {
			readonly ok: true;
			/** 解析出来的 JSON 值（信封里那份，或响应体本身）。 */
			readonly value: unknown;
			/** 对应的文本（剥过围栏）——任务那条路要把它原样交给导入器。 */
			readonly text: string;
			readonly attempts: number;
	  }
	| {
			readonly ok: false;
			/** 哪一层坏的：传输 / 响应形状 / 拿回来了但调用方判据不过。 */
			readonly kind: JsonGenerationFailureKind;
			readonly error: string;
			/** 最后拿到的那份原文（传输层就没拿到过就是 null）。 */
			readonly text: string | null;
			readonly attempts: number;
	  };

/** 传输层失败（网络、HTTP 非 2xx）。 */
class TransportFailure extends Error {}

/** 响应形状不对（不是 JSON、信封里没有 content、content 剥完围栏不是 JSON）。 */
class ResponseFailure extends Error {}

const reason = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/**
 * 基地址 → 请求地址。`/llm` → `/llm/chat/completions`。
 *
 * 约定是「填基地址」。两种例外原样用，不再接路径：
 * 已经指到 `/chat/completions` 的；以及带查询串的（`…?delay=700` 那种完整端点——
 * 往后接一段会把查询串切成 `?delay=700/chat/completions`，那是个坏 URL）。
 */
export const chatCompletionsUrl = (endpoint: string): string => {
	const base = endpoint.trim().replace(/\/+$/, '');
	if (base.endsWith('/chat/completions')) return base;
	if (base.includes('?')) return base;
	return `${base}/chat/completions`;
};

/** 照 `llm_client.py` 的 `_strip_code_fence`：整段被 ``` 包住时剥掉围栏（含 `json` 标记）。 */
export const stripCodeFence = (content: string): string => {
	let text = content.trim();
	if (text.startsWith('```') && text.endsWith('```')) {
		text = text.slice(3);
		if (text.startsWith('json')) text = text.slice(4);
		text = text.replace(/`+$/, '').trim();
	}
	return text;
};

/** 请求体：OpenAI 兼容的那几个字段 + 调用方给的额外字段。 */
export const requestBody = (
	messages: readonly GenerationMessage[],
	model: string,
	extras: JsonObject = {},
): JsonObject => ({
	model,
	stream: false,
	messages: messages.map((message) => ({ role: message.role, content: message.content })),
	temperature: 0.1,
	max_tokens: MAX_TOKENS,
	response_format: { type: 'json_object' },
	reasoning_effort: REASONING_OFF,
	...extras,
});

/** 正文开头一小段，塞进错误消息里让人认得出拿回来的是什么。 */
const preview = (raw: string): string => {
	const text = raw.trim().replace(/\s+/g, ' ');
	return text.length <= 80 ? text : `${text.slice(0, 80)}…`;
};

/**
 * 响应体 → `{ value, text }`。
 *
 * 两种形状都认：OpenAI 信封（`choices[0].message.content`）与裸 JSON。
 * 两样都不是就是响应层失败——可以重试，且错误消息里带正文开头，省得对着「失败了」发呆。
 */
export const jsonFromResponse = (raw: string): { value: unknown; text: string } => {
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		throw new ResponseFailure(`响应不是 JSON（正文开头：${preview(raw)}）`);
	}

	const choices = (parsed as { choices?: unknown }).choices;
	if (!Array.isArray(choices) || choices.length === 0) {
		// 没有信封：响应体本身就是那个值（设备组接口可以这么给）。
		return { value: parsed, text: raw };
	}

	const first = choices[0] as { message?: { content?: unknown; reasoning_content?: unknown } };
	const content = first.message?.content;
	if (typeof content !== 'string') {
		throw new ResponseFailure('响应里没有 choices[0].message.content');
	}
	// 空 content 在推理模型上是「预算被思考吃光」的典型症状——说清楚，省得对着空白发呆。
	if (content.trim() === '') {
		throw new ResponseFailure(
			'模型返回了空内容（多半是推理把 max_tokens 吃光了：finish_reason 往往是 length）',
		);
	}

	const text = stripCodeFence(content);
	try {
		return { value: JSON.parse(text) as unknown, text };
	} catch {
		throw new ResponseFailure(`模型返回的内容不是 JSON（剥掉围栏后仍解析不了：${preview(text)}）`);
	}
};

const defaultWait = (ms: number): Promise<void> =>
	new Promise((resolve) => {
		setTimeout(resolve, ms);
	});

/**
 * 要一份 JSON。最多 `attempts` 次（默认 2，与那份参考实现一致）。
 *
 * 三类失败都会重试：传输层、响应形状、以及「拿回来了但 `accept` 说不」。
 * 全坏掉时返回最后一次的失败原因与原文——诊断由调用方摆出来，界面不动任何真相。
 */
export async function generateJson(options: JsonGenerationOptions): Promise<JsonGenerationResult> {
	const url = chatCompletionsUrl(options.endpoint ?? DEFAULT_LLM_ENDPOINT);
	const model = options.model ?? DEFAULT_LLM_MODEL;
	const body = JSON.stringify(requestBody(options.messages, model, options.extras ?? {}));
	const attempts = Math.max(1, options.attempts ?? GENERATION_ATTEMPTS);
	const send = options.fetchImpl ?? fetch;
	const wait = options.wait ?? defaultWait;

	let failure: { kind: JsonGenerationFailureKind; message: string } = {
		kind: 'transport',
		message: '没有发起请求',
	};
	let lastText: string | null = null;

	for (let attempt = 1; attempt <= attempts; attempt += 1) {
		options.onAttempt?.(attempt, attempts);
		try {
			const response = await send(url, {
				method: 'POST',
				headers: { 'content-type': 'application/json', accept: 'application/json' },
				body,
			});
			// 非 2xx 也归到传输层：调用方看到的都是「这个地址没给回 JSON」。
			if (!response.ok) {
				throw new TransportFailure(`HTTP ${String(response.status)} ${response.statusText}`);
			}
			const raw = await response.text();
			const { value, text } = jsonFromResponse(raw);
			lastText = text;
			if (options.accept === undefined || options.accept(value, text)) {
				return { ok: true, value, text, attempts: attempt };
			}
			failure = { kind: 'rejected', message: '模型给的 JSON 没通过调用方的判据' };
		} catch (error) {
			if (error instanceof TransportFailure || error instanceof ResponseFailure) {
				failure = {
					kind: error instanceof TransportFailure ? 'transport' : 'response',
					message: error.message,
				};
			} else {
				// fetch 自己抛的（连不上、DNS、CORS）= 传输层。
				failure = { kind: 'transport', message: reason(error) };
			}
		}
		if (attempt < attempts) await wait(RETRY_DELAY_MS);
	}

	return { ok: false, kind: failure.kind, error: failure.message, text: lastText, attempts };
}
