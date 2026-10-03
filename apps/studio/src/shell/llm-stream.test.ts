// @vitest-environment happy-dom
/**
 * 流式那一层的验收（`llm-stream.ts`）：读 SSE、逐步回调、失败不抛。
 *
 * 守五件事：
 *
 * 1. **分片**：`data: {...}` 一行一段，`choices[0].delta.content` 是增量；回调拿到的必须是
 *    **累积文本**（"我收到了什么"），而不是这一段的增量——界面那行原始文本就是这么用的。
 * 2. **收尾**：`data: [DONE]` 是"说完了"的唯一信号，看到它就不再等连接关（代理收完就挂是常事）。
 * 3. **脏行**：非 JSON 的 `data:` 行、`event:`/心跳行、空行一律跳过——一行读不懂不该把整次生成判死。
 * 4. **失败**：流读一半断掉、HTTP 非 2xx、卡住（空闲超时）、调用方中止，都收成带稳定码的结果，
 *    **已经收到的部分原样交回去**（界面拿它填兜底框，与 `generateJson` 那条路同一个口径）。
 * 5. **与非流式那件事口径一致**：正文是信封里的 `content`、剥围栏的判据也一样
 *    （`envelopeContentOf`）——不然两条路拿回来的"原文"会不一样。
 *
 * fetch、空闲计时、中止都从参数注入，所以这里不 stub 全局、也不用假定时器。
 */
import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_LLM_ENDPOINT } from './llm-json';
import {
	STREAM_CODES,
	STREAM_IDLE_TIMEOUT_MS,
	envelopeContentOf,
	generateJsonStream,
	type JsonStreamOptions,
} from './llm-stream';

/** 一段分片文本（`delta.content` 的**值**），拼成 SSE 那一行。 */
const frame = (delta: string): string =>
	`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: delta } }] })}\n\n`;

const DONE = 'data: [DONE]\n\n';

/** 一串分片 → 一个可以逐块读的响应。 */
const streamResponse = (chunks: readonly string[]): Response => {
	const encoder = new TextEncoder();
	const stream = new ReadableStream<Uint8Array>({
		start(controller) {
			for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
			controller.close();
		},
	});
	return { ok: true, status: 200, statusText: 'OK', body: stream } as unknown as Response;
};

/** 一整份响应（没有 body：设备组那种接口就是这样给的）。 */
const wholeResponse = (body: string, init: { ok?: boolean; status?: number; statusText?: string } = {}): Response =>
	({
		ok: init.ok ?? true,
		status: init.status ?? 200,
		statusText: init.statusText ?? 'OK',
		text: async () => body,
	}) as unknown as Response;

interface Call {
	readonly url: string;
	readonly init: RequestInit | undefined;
}

/** 记账的假 fetch；`respond` 拿到调用时的 signal（中止那几条靠它触发）。 */
const fetchRecorder = (
	respond: (call: Call) => Response | Promise<Response>,
): { impl: typeof fetch; calls: Call[] } => {
	const calls: Call[] = [];
	const impl = ((input: unknown, init?: RequestInit) => {
		const call: Call = { url: String(input), init };
		calls.push(call);
		return Promise.resolve(respond(call));
	}) as unknown as typeof fetch;
	return { impl, calls };
};

const messages = [{ role: 'user' as const, content: '给我一份计划' }];

/** 默认那一套：一句对话 + 调用方给的假 fetch（其余按需覆写）。 */
const options = (overrides: Partial<JsonStreamOptions> & Pick<JsonStreamOptions, 'fetchImpl'>): JsonStreamOptions => ({
	messages,
	...overrides,
});

const bodyOf = (call: Call | undefined): Record<string, unknown> =>
	JSON.parse(String(call?.init?.body ?? '{}')) as Record<string, unknown>;

describe('流式 · 读分片与回调', () => {
	it('逐段回调**累积文本**，最后拼成正文（信封里那一段）', async () => {
		const { impl, calls } = fetchRecorder(() =>
			streamResponse([frame('{"schemaVersion"'), frame(':1,"robot":"so101"'), frame(',"plan":[]}'), DONE]),
		);
		const seen: string[] = [];

		const result = await generateJsonStream(
			options({ fetchImpl: impl, onDelta: (text) => seen.push(text) }),
		);

		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.text).toBe('{"schemaVersion":1,"robot":"so101","plan":[]}');
		expect(result.done).toBe(true);
		expect(result.streamed).toBe(true);
		// 累积而不是增量：每一段都比前一段长，且都以第一段开头
		expect(seen).toEqual([
			'{"schemaVersion"',
			'{"schemaVersion":1,"robot":"so101"',
			'{"schemaVersion":1,"robot":"so101","plan":[]}',
		]);

		// 请求体：与非流式那条路同一份，只是 stream: true
		expect(calls[0]?.url).toBe(`${DEFAULT_LLM_ENDPOINT}/chat/completions`);
		const body = bodyOf(calls[0]);
		expect(body['stream']).toBe(true);
		expect(body['reasoning_effort']).toBe('none');
		expect(body['response_format']).toEqual({ type: 'json_object' });
	});

	it('看到 [DONE] 就收尾：后面就算还挂着连接也不再等', async () => {
		// 三块：两段内容 + 哨兵；哨兵之后**没有**关流（`start` 里不 close）
		const encoder = new TextEncoder();
		const stream = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(encoder.encode(frame('{"a"') + frame(':1}')));
				controller.enqueue(encoder.encode(DONE));
				// 故意不 close：真代理收完就跑，read() 会一直挂着
			},
		});
		const { impl } = fetchRecorder(() => ({ ok: true, status: 200, statusText: 'OK', body: stream }) as unknown as Response);

		const result = await generateJsonStream(options({ fetchImpl: impl }));

		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.done).toBe(true);
		expect(result.text).toBe('{"a":1}');
	});

	it('脏行一律跳过：非 JSON 的 data 行、event 行、注释行、空行都不影响正文', async () => {
		const { impl } = fetchRecorder(() =>
			streamResponse([
				': keep-alive\n\n',
				'event: ping\n',
				'data: 这不是 JSON\n\n',
				frame('{"ok"'),
				'\n',
				'data: {"choices":[]}\n\n',
				frame(':true}'),
				DONE,
			]),
		);
		const seen: string[] = [];

		const result = await generateJsonStream(options({ fetchImpl: impl, onDelta: (text) => seen.push(text) }));

		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.text).toBe('{"ok":true}');
		// 只有两段真内容，回调就两次（脏行不该造出空回调）
		expect(seen).toEqual(['{"ok"', '{"ok":true}']);
	});

	it('分片边界切在多字节字符中间：解码器接得回来', async () => {
		const payload = frame('{"note":"看一眼桌面"}');
		const bytes = new TextEncoder().encode(payload);
		// 在"看"字的三个字节中间切一刀
		const cut = payload.indexOf('看') + 1;
		const stream = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(bytes.slice(0, cut));
				controller.enqueue(bytes.slice(cut));
				controller.enqueue(new TextEncoder().encode(DONE));
				controller.close();
			},
		});
		const { impl } = fetchRecorder(() => ({ ok: true, status: 200, statusText: 'OK', body: stream }) as unknown as Response);

		const result = await generateJsonStream(options({ fetchImpl: impl }));

		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.text).toBe('{"note":"看一眼桌面"}');
	});

	it('没有 body（设备组那种整份响应）：整段收下，streamed 说明不是流来的', async () => {
		const { impl } = fetchRecorder(() => wholeResponse('{"schema_version":"1.0"}'));
		const seen: string[] = [];

		const result = await generateJsonStream(options({ fetchImpl: impl, onDelta: (text) => seen.push(text) }));

		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.text).toBe('{"schema_version":"1.0"}');
		expect(result.streamed).toBe(false);
		expect(seen).toEqual(['{"schema_version":"1.0"}']);
	});

	it('说完之后正文仍不是 JSON → 响应层失败（可重试），原文交回去', async () => {
		const html = '<html><body>502 Bad Gateway</body></html>';
		const { impl } = fetchRecorder(() => wholeResponse(html));

		const result = await generateJsonStream(options({ fetchImpl: impl }));

		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.kind).toBe('response');
		expect(result.error).toContain('不是 JSON');
		expect(result.text).toBe(html);
	});

	it('流被自然关闭（没看到 [DONE]）→ ok，但 done:false：文本可能不完整', async () => {
		const { impl } = fetchRecorder(() => streamResponse([frame('{"a"')]));

		const result = await generateJsonStream(options({ fetchImpl: impl }));

		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.done).toBe(false);
		expect(result.text).toBe('{"a"');
	});
});

describe('流式 · 失败一律不抛', () => {
	it('流读一半断了：给传输层失败，已经收到的部分原样交回', async () => {
		const encoder = new TextEncoder();
		// 先吐一块（这一块是**有效内容**），然后才断——断的是"读到一半"那一下。
		// 顺序不能反：同一块里既 `enqueue` 又 `error` 的话，那一块根本到不了读的人手里。
		const stream = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(encoder.encode(frame('{"schemaVersion":1,"pla')));
			},
			pull(controller) {
				controller.error(new TypeError('network error'));
			},
		});
		const { impl } = fetchRecorder(() => ({ ok: true, status: 200, statusText: 'OK', body: stream }) as unknown as Response);

		const result = await generateJsonStream(options({ fetchImpl: impl }));

		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.kind).toBe('transport');
		expect(result.error).toContain('network error');
		expect(result.text).toBe('{"schemaVersion":1,"pla');
	});

	it('HTTP 502：传输层失败，没有原文可交（text 是 null）', async () => {
		const { impl } = fetchRecorder(() => wholeResponse('', { ok: false, status: 502, statusText: 'Bad Gateway' }));

		const result = await generateJsonStream(options({ fetchImpl: impl }));

		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.kind).toBe('transport');
		expect(result.error).toContain('502');
		expect(result.text).toBeNull();
	});

	it('fetch 自己抛（连不上）也是传输层失败，不冒泡', async () => {
		const { impl } = fetchRecorder(() => {
			throw new TypeError('Failed to fetch');
		});

		const result = await generateJsonStream(options({ fetchImpl: impl }));

		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.kind).toBe('transport');
		expect(result.text).toBeNull();
	});

	it('卡住（空闲超过给的那一档）→ 说清是卡住，已经收到的部分留着', async () => {
		// 第一块之后流不再吐字、也不关：只有空闲计时能把它救出来。
		const encoder = new TextEncoder();
		let push: ((chunk: string) => void) | null = null;
		const stream = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(encoder.encode(frame('{"a"')));
				push = (chunk: string) => controller.enqueue(encoder.encode(chunk));
			},
		});
		void push;
		const { impl } = fetchRecorder(() => ({ ok: true, status: 200, statusText: 'OK', body: stream }) as unknown as Response);

		const result = await generateJsonStream(options({ fetchImpl: impl, idleTimeoutMs: 5 }));

		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.kind).toBe('stalled');
		expect(result.error).toContain('卡住');
		expect(result.text).toBe('{"a"');
	});

	it('调用方中止（新一轮生成 / 组件卸载）：kind 是 aborted，不是故障', async () => {
		const encoder = new TextEncoder();
		const stream = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(encoder.encode(frame('{"a"')));
				// 不再吐字，等外面中止
			},
		});
		const { impl } = fetchRecorder(() => ({ ok: true, status: 200, statusText: 'OK', body: stream }) as unknown as Response);
		const controller = new AbortController();
		setTimeout(() => controller.abort(), 0);

		const result = await generateJsonStream(options({ fetchImpl: impl, signal: controller.signal }));

		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.kind).toBe('aborted');
		// 中止不是故障：不该被当成"这个地址没给 JSON"报出来
		expect(result.kind).not.toBe('transport');
	});
});

describe('流式 · 与非流式同一套正文口径', () => {
	it('剥围栏：开头的围栏与收尾的围栏都剥掉，字符串中间的反引号不动', () => {
		expect(envelopeContentOf('```json\n{"a":1}\n```')).toBe('{"a":1}');
		expect(envelopeContentOf('```\n{"a":1}\n```')).toBe('{"a":1}');
		// 流到一半：收尾围栏还没来，开头那三个反引号也得剥掉（否则界面上看到的是围栏）
		expect(envelopeContentOf('```json\n{"a"')).toBe('{"a"');
		expect(envelopeContentOf('{"a":1}')).toBe('{"a":1}');
		// 字符串里的反引号不是围栏
		expect(envelopeContentOf('{"note":"```"}')).toBe('{"note":"```"}');
	});

	it('信封与裸 JSON 都认，且都是"剥好的正文"', () => {
		const enveloped = JSON.stringify({ choices: [{ message: { content: '```json\n{"a":1}\n```' } }] });
		expect(envelopeContentOf(enveloped)).toBe('{"a":1}');
		// 流到一半的信封：外面那层 JSON 还没闭合，照样解得出来
		expect(envelopeContentOf('{"choices":[{"delta":{"content":"{\\"a\\"')).toBe('{"a"');
		// 不是信封（设备组那条路）：原样返回
		expect(envelopeContentOf('{"schema_version":"1.0"}')).toBe('{"schema_version":"1.0"}');
	});

	it('传输层出错的码是稳定的那几个（界面按码判断，不匹配 message）', () => {
		expect(STREAM_CODES.transport).toBe('task_stream.transport_failed');
		expect(STREAM_CODES.response).toBe('task_stream.response_failed');
		expect(STREAM_CODES.stalled).toBe('task_stream.stalled');
		expect(STREAM_CODES.aborted).toBe('task_stream.aborted');
		expect(STREAM_IDLE_TIMEOUT_MS).toBeGreaterThan(1000);
	});

	it('额外字段（设备组要的 catalogRef / instruction）与非流式那条路一起进同一个请求体', async () => {
		const { impl, calls } = fetchRecorder(() => streamResponse([frame('{}'), DONE]));

		await generateJsonStream(
			options({ fetchImpl: impl, extras: { catalogRef: 'roboframe_so101_single_arm', instruction: '挥挥手' } }),
		);

		const body = bodyOf(calls[0]);
		expect(body['catalogRef']).toBe('roboframe_so101_single_arm');
		expect(body['instruction']).toBe('挥挥手');
		expect(body['messages']).toHaveLength(1);
	});
});

// 一条护栏：`vi` 在这一组里只用来记账，不该被用来 stub 全局（这一层全靠注入）。
void vi;
