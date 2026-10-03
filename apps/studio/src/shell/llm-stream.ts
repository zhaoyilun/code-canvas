/**
 * 与 LLM 的一次「**边说边给我 JSON**」通话：`llm-json.ts` 的流式兄弟。
 *
 * 为什么要另开一份而不是改那个函数：非流式那条路还在用（设备组接口、将来别处），
 * 它的行为一个字节都不该动。两者共用的是**同一套约定**——地址是基地址、请求体那几个字段
 * （`requestBody`，含 `reasoning_effort: 'none'` 那一手）、以及正文与失败原文的口径。
 * 所以这里只从 `llm-json.ts` 取共享件，不抄第二份；唯一实质差别是 `stream: true` 与读法：
 *
 * - 请求：`POST <基地址>/chat/completions`，体里 `stream: true`（其余字段与非流式完全一样）；
 * - 响应：SSE。每一行 `data: {...}` 是一个分片，`choices[0].delta.content` 是**增量**文本，
 *   最后一行是 `data: [DONE]`。累积文本每来一段就通过 `onDelta` 报一次。
 *
 * **失败一律不抛**：流读一半断了、代理回 502、正文里夹着乱码，全部收成一条带稳定码的
 * `jsonStreamDiagnostic`，并把**已经收到的部分**当成失败原文交回去（界面拿它填兜底框——
 * 与 `generateJson` 那条路同一个口径：拿到过什么就让人看得见）。
 *
 * 中止有两层：`options.signal` 是调用方自己的（界面上的 `runId` 一变、组件一卸载就该断），
 * 另外还有一个**空闲超时**——服务端接了连接却不再吐字时，光等 `signal` 是等不到的。
 */
import type { Diagnostic, JsonObject } from '@codecanvas/contracts';
import {
	chatCompletionsUrl,
	DEFAULT_LLM_ENDPOINT,
	DEFAULT_LLM_MODEL,
	requestBody,
	stripCodeFence,
	type GenerationMessage,
} from './llm-json';

/**
 * 积木式 SSE 分片那条路的收尾哨兵。
 * 它不是一个 JSON 值，所以认它是**唯一能宣布「这次生成正常说完了」**的信号——
 * 连接自然结束（`done`）与它的区别见下面 `finish`。
 */
const STREAM_DONE = '[DONE]';

/** `data:` 之后那一格空格是 SSE 的约定（`data: {...}`），有则去掉、无则不动。 */
const DATA_PREFIX = 'data:';

/**
 * 卡住的判据：这么多毫秒内一个分片都没来。
 *
 * 为什么要有它：代理把连接接住之后不回字（上游挂了但没关连接），是**看不到尽头的等**——
 * 界面会一直停在「生成中…」。30 秒足够慢模型的第一个 token（实测完整响应 1.3s），
 * 又不至于让人对着一个死连接发呆几分钟。
 */
export const STREAM_IDLE_TIMEOUT_MS = 30_000;

/** 流式那几条失败的稳定码。界面按码判断，不去匹配 message（与全仓的纪律一致）。 */
export const STREAM_CODES = {
	/** 传输层：连不上、非 2xx、流中途断开。 */
	transport: 'task_stream.transport_failed',
	/** 响应形状：不是一个能读的流（没有 body）。 */
	response: 'task_stream.response_failed',
	/** 卡住：空闲超过 `STREAM_IDLE_TIMEOUT_MS`。 */
	stalled: 'task_stream.stalled',
	/** 调用方自己中止的（新一轮生成 / 组件卸载）——不是错误，是主动放弃。 */
	aborted: 'task_stream.aborted',
} as const;

export type JsonStreamFailureKind = 'transport' | 'response' | 'stalled' | 'aborted';

export interface JsonStreamOptions {
	/** 完整对话：system 定规矩，user 给这一句话。与非流式那条路同一形状。 */
	readonly messages: readonly GenerationMessage[];
	/** 基地址；缺省 `DEFAULT_LLM_ENDPOINT`。请求打到 `<基地址>/chat/completions`。 */
	readonly endpoint?: string;
	readonly model?: string;
	/** 额外塞进请求体的字段（`catalogRef` / `deviceRef` / `instruction` 那些）。 */
	readonly extras?: JsonObject;
	/** 每收到一段就报**累积到此刻的全文**（界面那行原始文本读的就是它）。 */
	readonly onDelta?: (accumulated: string) => void;
	/** 调用方的中止信号（新一轮生成、组件卸载）。 */
	readonly signal?: AbortSignal;
	/** 测试用：换掉 fetch 与空闲计时。 */
	readonly fetchImpl?: typeof fetch;
	readonly idleTimeoutMs?: number;
}

export type JsonStreamResult =
	| {
			readonly ok: true;
			/** 累积出来的全文（**不剥围栏**——剥围栏是导入那一步的事，见 `llm-json.ts`）。 */
			readonly text: string;
			/** 是不是看到了 `[DONE]`。false = 流被自然关闭，文本可能不完整。 */
			readonly done: boolean;
			/**
			 * 内容是不是**真的流式来的**（一块一块读回来的）。
			 *
			 * false 只有一种情形：对方没给 `body`（不是流），整段一次性读完——设备组的接口
			 * 可以直接给一份任务 JSON，那时它不认 `stream` 这个字段，也就没有分片可读。
			 * 界面据此知道"这一次没有中途可看的东西"，而不是把"没吐字"当成卡住。
			 */
			readonly streamed: boolean;
	  }
	| {
			readonly ok: false;
			readonly kind: JsonStreamFailureKind;
			readonly error: string;
			/** 已经收到的部分（传输层就没收到过任何分片时是 null）——落进兜底框。 */
			readonly text: string | null;
	  };

/** 流式失败的那条诊断。界面直接把它摆出来，码是上面的 `STREAM_CODES`。 */
export const jsonStreamDiagnostic = (code: string, message: string, ref?: string): Diagnostic => ({
	code,
	severity: 'error',
	message,
	...(ref === undefined ? {} : { ref }),
});

/** 一部分分片能不能当文本用：空 delta（第一片往往只有 role）不算内容，也不算失败。 */
const deltaTextOf = (payload: string): string | null => {
	let parsed: unknown;
	try {
		parsed = JSON.parse(payload);
	} catch {
		// 半个分片、心跳注释、非 JSON 行：**跳过它继续读**。一行读不懂不该把整次生成判死。
		return null;
	}
	if (typeof parsed !== 'object' || parsed === null) return null;
	const choices = (parsed as { choices?: unknown }).choices;
	if (!Array.isArray(choices) || choices.length === 0) return null;
	const first: unknown = choices[0];
	if (typeof first !== 'object' || first === null) return null;
	const delta = (first as { delta?: unknown }).delta;
	if (typeof delta !== 'object' || delta === null) return null;
	const content = (delta as { content?: unknown }).content;
	return typeof content === 'string' ? content : null;
};

/** OpenAI 信封里那个字段的**字面量**开头。剥正文时从这里往后解。 */
const CONTENT_MARKER = '"content":"';
const CONTENT_MARKER_SPACED = '"content": "';

/** 解一个**可能还没写完**的 JSON 字符串字面量；读到结尾或出错就停下（已经读到的照样给）。 */
const decodeJsonStringFrom = (text: string, from: number): string => {
	let value = '';
	let index = from;
	while (index < text.length) {
		const char = text.charAt(index);
		if (char === '"') break;
		if (char !== '\\') {
			value += char;
			index += 1;
			continue;
		}
		const escaped = text.charAt(index + 1);
		if (escaped === '') break; // 断在转义符后面
		if (escaped === 'u') {
			const hex = text.slice(index + 2, index + 6);
			if (!/^[0-9a-fA-F]{4}$/.test(hex)) break; // 转义还没写完：停在它前面，别猜码点
			value += String.fromCharCode(Number.parseInt(hex, 16));
			index += 6;
			continue;
		}
		value += JSON.parse(`"\\${escaped}"`) as string;
		index += 2;
	}
	return value;
};

/**
 * 累积文本 → **正文**：剥掉围栏，再取出信封里那一段（`choices[0].message.content`）。
 *
 * 两步的顺序与判据都照非流式那条路（`jsonFromResponse` = 剥围栏 → `JSON.parse` → 取
 * `choices[0].message.content` → 再剥一次围栏），区别只在于这里**不等整段回来**：
 *
 * - **剥围栏**：有些模型把整段 JSON 包在 ``` 里。围栏是**整体**的记号——收尾那三个反引号
 *   要等流说完才出现，所以流到一半时 `stripCodeFence` 剥不掉它（它只在首尾都在时才动手）。
 *   于是这里额外做一次**开头的围栏**处理：` ```json\n{…` 这种开头里，第一行不是 JSON 的一部分。
 *   不清掉它，后面找 `"content"` 与界面上那行原始文本看到的都是围栏。
 * - **信封**：从 `"content":"` 往后按转义规则解到哪里算哪里（见下）。
 *
 * 不是信封（设备组的接口直接给任务 JSON）时没有那个标记，整段就是正文。
 */
export const envelopeContentOf = (text: string): string => {
	// 先剥开头那三个反引号，否则不是信封时（设备组那条路）整段带着围栏交出去。
	const unfenced = stripOpeningFence(stripCodeFence(text));
	const at = unfenced.indexOf(CONTENT_MARKER);
	const spaced = unfenced.indexOf(CONTENT_MARKER_SPACED);
	const content =
		at >= 0
			? decodeJsonStringFrom(unfenced, at + CONTENT_MARKER.length)
			: spaced >= 0
				? decodeJsonStringFrom(unfenced, spaced + CONTENT_MARKER_SPACED.length)
				: unfenced;
	// 取出正文之后再走一遍与非流式那边**逐字相同**的那一步（`stripCodeFence`）：
	// 收尾围栏那时可能已经来了，它判的正是"整段被包住"。
	return stripCodeFence(content);
};

/**
 * 剥掉**开头的**围栏（含 `json` 标记）与它后面那个换行；字符串中间的反引号一个字不动。
 *
 * 为什么单独要这一手：`stripCodeFence` 判的是"整段被围栏包住"，而流到一半时收尾那三个
 * 反引号还没来——于是它不动手，围栏就黏在正文前面（`"plan"` 那个键也就找不到）。
 */
const stripOpeningFence = (text: string): string => {
	if (!text.startsWith('```')) return text;
	const afterMarker = text.startsWith('```json') ? text.slice(7) : text.slice(3);
	return afterMarker.replace(/^\r?\n/, '');
};

/** 一行是不是 `data: [DONE]`（两种写法都认：带不带那一格空格）。 */
const isDoneLine = (line: string): boolean => {
	if (!line.startsWith(DATA_PREFIX)) return false;
	return line.slice(DATA_PREFIX.length).trim() === STREAM_DONE;
};

/** 一行的载荷：`data: {...}` → `{...}`；不是 data 行（空行、`event:`、注释）就是 null。 */
const dataPayloadOf = (line: string): string | null => {
	if (!line.startsWith(DATA_PREFIX)) return null;
	const payload = line.slice(DATA_PREFIX.length).trim();
	return payload === '' ? null : payload;
};

/**
 * 正文能不能当 JSON 解析。
 *
 * 为什么这条检查只在**说完了**之后做（见调用点）：流到一半的 JSON 必然解析不了，
 * 拿它判死等于把每一次生成都判死。而一段流完了还解析不了，那就不是"没写完"，
 * 是这一趟真没给 JSON（代理回了一段 HTML 错误页，模型回了一段解释）——
 * 非流式那条路（`jsonFromResponse`）对同一件事给的也是响应层失败：**可以重试**。
 * 两边口径一致，重试一次的收益才一样。
 */
const isParsableJson = (text: string): boolean => {
	try {
		JSON.parse(text);
		return true;
	} catch {
		return false;
	}
};

/** 正文开头一小段，塞进错误消息里让人认得出拿回来的是什么（与非流式那边同一口径）。 */
const preview = (raw: string): string => {
	const text = raw.trim().replace(/\s+/g, ' ');
	return text.length <= 80 ? text : `${text.slice(0, 80)}…`;
};

/** 正文不是 JSON 时那条失败：与非流式那边同一句话，省得两处诊断各说各的。 */
const notJsonFailure = (text: string): JsonStreamResult => ({
	ok: false,
	kind: 'response',
	error: `模型返回的内容不是 JSON（剥掉围栏后仍解析不了：${preview(text)}）`,
	text: text === '' ? null : text,
});

const reason = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/**
 * 读一次 SSE 流，边读边把累积文本报出去。
 *
 * 结束时三种情形，一律以结果对象收场（不抛）：
 * - 看到 `[DONE]` → `ok: true, done: true`；
 * - 流被自然关闭（没看到哨兵）→ `ok: true, done: false`，文本就是收到的那些；
 * - 读的过程中断了 / 卡住 / 调用方中止 → `ok: false`，`text` 是**已经收到的部分**。
 */
export async function generateJsonStream(options: JsonStreamOptions): Promise<JsonStreamResult> {
	const url = chatCompletionsUrl(options.endpoint ?? DEFAULT_LLM_ENDPOINT);
	const model = options.model ?? DEFAULT_LLM_MODEL;
	// `stream: true` 覆写掉共享请求体里那个 false，其余字段（temperature / max_tokens /
	// response_format / reasoning_effort）与非流式那条路逐字相同。
	const body = JSON.stringify({
		...requestBody(options.messages, model, options.extras ?? {}),
		stream: true,
	});
	const send = options.fetchImpl ?? fetch;
	const idleTimeoutMs = options.idleTimeoutMs ?? STREAM_IDLE_TIMEOUT_MS;

	const external = options.signal;
	/** 两个中止来源合成一个：调用方给的，加上这里的空闲超时。 */
	const controller = new AbortController();
	let idleTimer: ReturnType<typeof setTimeout> | null = null;
	let stalled = false;
	let aborted = external?.aborted === true;

	const abortByCaller = (): void => {
		aborted = true;
		controller.abort();
	};
	if (external !== undefined) {
		if (external.aborted) abortByCaller();
		else external.addEventListener('abort', abortByCaller, { once: true });
	}
	/** 每收到一段就重置：空闲计时量的是「距离上一段多久」，不是整次生成多久。 */
	const bumpIdle = (): void => {
		if (idleTimer !== null) clearTimeout(idleTimer);
		idleTimer = setTimeout(() => {
			stalled = true;
			controller.abort();
		}, idleTimeoutMs);
	};
	const stopIdle = (): void => {
		if (idleTimer !== null) clearTimeout(idleTimer);
		idleTimer = null;
	};

	let accumulated = '';
	let sawDone = false;
	/**
	 * 失败时它是「拿到过什么」的证据，也是交回给调用方的失败原文。
	 *
	 * 它与 `accumulated` 不同：`accumulated` 是模型吐出来的原文（可能还裹着整个响应信封），
	 * 这个存的是**已经剥好的正文**——失败时把它交给兜底框，人看到的才是任务 JSON 本身，
	 * 而不是一层 SSE 信封（与非流式那条路失败时交 `text` 而不是交整段响应体是同一个道理）。
	 * 传输层就没收到过任何分片时保持 null。
	 */
	let received: string | null = null;

	try {
		const response = await send(url, {
			method: 'POST',
			headers: { 'content-type': 'application/json', accept: 'text/event-stream' },
			body,
			signal: controller.signal,
		});
		if (!response.ok) {
			stopIdle();
			return {
				ok: false,
				kind: 'transport',
				error: `HTTP ${String(response.status)} ${response.statusText}`,
				text: null,
			};
		}
		const stream = response.body;
		if (stream === null || stream === undefined) {
			/*
			 * 没有流可读：对方给的是**一整份**响应（设备组的接口就是这么给的）。
			 * 这不是错误——它只是"这一趟没有中途可看的东西"。整段收下，按"说完了"交回去。
			 */
			stopIdle();
			const whole = typeof response.text === 'function' ? await response.text() : '';
			const content = envelopeContentOf(whole);
			if (whole !== '') {
				accumulated = whole;
				received = content;
				options.onDelta?.(content);
				// 一整份回来了：这时候它就该是一份 JSON（流式那边只能等等到说完，见 `isParsableJson`）。
				if (!isParsableJson(content)) return notJsonFailure(content);
			}
			return { ok: true, text: content, done: true, streamed: false };
		}

		const reader = stream.getReader();
		const decoder = new TextDecoder();
		let buffer = '';

		/*
		 * 中止要能把**挂在 read() 上的那一次等待**叫醒。
		 *
		 * 光把 `signal` 交给 fetch 是不够的：请求已经发出去了，`fetch` 那一步早就 resolve 了，
		 * 现在挂在 `reader.read()` 上等下一块——只有取消 reader，这个 promise 才会落定。
		 * 空闲超时与调用方中止都从这里过（两者都会 abort 那个合成 controller）。
		 */
		const cancelOnAbort = (): void => {
			void reader.cancel().catch(() => undefined);
		};
		if (controller.signal.aborted) cancelOnAbort();
		else controller.signal.addEventListener('abort', cancelOnAbort, { once: true });

		/** 一行一行地吃；`flush` 是收尾（最后一行可能没有换行符）。 */
		const eatLines = (chunk: string, flush: boolean): void => {
			buffer += chunk;
			const parts = buffer.split('\n');
			// 没 flush 时最后一段是「还没写完的那一行」，留着等下一块；flush 时全都是完整的。
			const lines = flush ? parts : parts.slice(0, -1);
			buffer = flush ? '' : (parts[parts.length - 1] ?? '');
			for (const raw of lines) {
				const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
				if (line.trim() === '') continue;
				if (isDoneLine(line)) {
					sawDone = true;
					continue;
				}
				const payload = dataPayloadOf(line);
				if (payload === null) continue;
				const delta = deltaTextOf(payload);
				if (delta === null || delta === '') continue;
				accumulated += delta;
				// 对外报的是**正文**（信封里那一段），与非流式那条路的口径一致（见 `envelopeContentOf`）。
				options.onDelta?.(envelopeContentOf(accumulated));
			}
		};

		for (;;) {
			const step = await reader.read();
			// 哨兵到了就不必再等流自己关：有些代理收完就跑，read() 会一直挂着。
			if (step.done) {
				eatLines(decoder.decode(), true);
				break;
			}
			bumpIdle();
			eatLines(decoder.decode(step.value, { stream: true }), false);
			/*
			 * 每吃下一块就把「已经收到的部分」更新一次——**不能只在解析出 delta 时更新**：
			 * 断了的那一刻，最后那一块里的尾巴（一个还没写完的对象、半个字符串）也是实实在在
			 * 收到过的内容，失败时该跟前面的一起留给兜底框（"拿到过什么就让人看得见"）。
			 */
			if (accumulated !== '') received = envelopeContentOf(accumulated);
			if (sawDone) {
				await reader.cancel().catch(() => undefined);
				break;
			}
		}
		controller.signal.removeEventListener('abort', cancelOnAbort);
		stopIdle();
		/*
		 * 中止要在这里也看一眼：`reader.cancel()` 会把挂在 `read()` 上的那一次等待**正常**落定
		 * （`{ done: true }`），于是循环是"读完"而不是"抛错"出来的。不看这一眼，一次被中止的
		 * 生成会被当成"流被自然关闭"交回去（`ok: true`），界面上就是凭空多了一趟成功的假象。
		 */
		if (stalled || aborted) {
			return stalled
				? {
						ok: false,
						kind: 'stalled',
						error: `流卡住了：${String(idleTimeoutMs)} 毫秒内没有再收到任何分片`,
						text: received,
					}
				: { ok: false, kind: 'aborted', error: '这次生成已被中止', text: received };
		}
		const content = envelopeContentOf(accumulated);
		/*
		 * 看到了 `[DONE]` = 这次生成**说完了**，那就该是一份 JSON。说完了还解析不了，
		 * 不是"没写完"而是这一趟没给（模型回了一段解释），照响应层失败处理：**可以重试**。
		 * 没看到哨兵时**不查**：流被自然关闭（代理把连接收了、服务端崩了）完全可能截在中间，
		 * 那时文本是不是完整 JSON 说明不了任何事——要不要它，由调用方的 `accept` 说（与非流式那条路一样）。
		 */
		if (sawDone && !isParsableJson(content)) return notJsonFailure(content);
		return { ok: true, text: content, done: sawDone, streamed: true };
	} catch (error) {
		stopIdle();
		if (stalled) {
			return {
				ok: false,
				kind: 'stalled',
				error: `流卡住了：${String(idleTimeoutMs)} 毫秒内没有再收到任何分片`,
				text: received,
			};
		}
		if (aborted || external?.aborted === true) {
			// 调用方主动放弃（跑新一轮、组件卸载）：不是故障，也不该出诊断。
			return { ok: false, kind: 'aborted', error: '这次生成已被中止', text: received };
		}
		return { ok: false, kind: 'transport', error: reason(error), text: received };
	} finally {
		stopIdle();
		external?.removeEventListener('abort', abortByCaller);
	}
}
