// @vitest-environment happy-dom
/**
 * 与 LLM 通话那一层的验收（`llm-json.ts`）：**通用**部分，不认识机器人任务。
 *
 * 守五件事：
 * 1. 地址是基地址——请求打到 `<基地址>/chat/completions`（默认 `/llm`，同源、key 不在浏览器里）；
 * 2. 请求体就是 `docs/reference/llm_client.py` 那份的 web 版：model / stream / messages /
 *    temperature 0.1 / max_tokens 512 / response_format json_object，外加调用方的额外字段；
 * 3. 响应两种形状都认：OpenAI 信封（含 Markdown 围栏）与裸 JSON；
 * 4. 三类失败重试两次：传输、响应形状、调用方判据说不行；
 * 5. 「不行」的判据在调用方手里（这里是 `accept`），这一层不做业务校验。
 *
 * fetch 与等待都从参数注入，所以这里不 stub 全局、也不用假定时器。
 */
import { describe, expect, it, vi } from 'vitest';
import {
	DEFAULT_LLM_ENDPOINT,
	DEFAULT_LLM_MODEL,
	chatCompletionsUrl,
	generateJson,
	jsonFromResponse,
	stripCodeFence,
	type GenerationMessage,
} from './llm-json';

/** 假响应只带这一层用得到的成员。 */
const responseOf = (
	body: string,
	init: { ok?: boolean; status?: number; statusText?: string } = {},
): Response =>
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

/** 一个记账的假 fetch；handler 抛异常 = 网络层失败。 */
const fetchRecorder = (
	handler: (call: Call) => Promise<Response>,
): { impl: typeof fetch; calls: Call[] } => {
	const calls: Call[] = [];
	const impl = ((input: unknown, init?: RequestInit) => {
		const call: Call = { url: String(input), init };
		calls.push(call);
		return handler(call);
	}) as unknown as typeof fetch;
	return { impl, calls };
};

const okEnvelope = (content: string): Response =>
	responseOf(JSON.stringify({ choices: [{ message: { role: 'assistant', content } }] }));

const messages: readonly GenerationMessage[] = [{ role: 'user', content: '给我一个 JSON' }];
/** 重试不真等：0 毫秒。 */
const noWait = async (): Promise<void> => {};

const bodyOf = (call: Call | undefined): Record<string, unknown> =>
	JSON.parse(String(call?.init?.body ?? '{}')) as Record<string, unknown>;

describe('LLM JSON 通话 · 地址与请求体', () => {
	it('默认地址是同源相对路径 /llm，请求打到 <基地址>/chat/completions', () => {
		expect(DEFAULT_LLM_ENDPOINT).toBe('/llm');
		expect(chatCompletionsUrl('/llm')).toBe('/llm/chat/completions');
		expect(chatCompletionsUrl('/llm/')).toBe('/llm/chat/completions');
		// 已经指到那一段的地址原样用，不叠成 /chat/completions/chat/completions
		expect(chatCompletionsUrl('/llm/chat/completions')).toBe('/llm/chat/completions');
		expect(chatCompletionsUrl('http://127.0.0.1:8787/')).toBe('http://127.0.0.1:8787/chat/completions');
		// 带查询串的是「一个完整端点」，原样用（往后接一段会把查询串切坏）
		expect(chatCompletionsUrl('http://localhost:8123/task.json?delay=700')).toBe(
			'http://localhost:8123/task.json?delay=700',
		);
	});

	it('请求体照参考实现：model / stream / messages / temperature / max_tokens / response_format', async () => {
		const { impl, calls } = fetchRecorder(async () => okEnvelope('{"ok":true}'));
		const attempt = vi.fn();

		const result = await generateJson({
			messages,
			fetchImpl: impl,
			wait: noWait,
			onAttempt: attempt,
		});

		expect(result.ok).toBe(true);
		expect(calls).toHaveLength(1);
		expect(calls[0]?.url).toBe('/llm/chat/completions');
		expect(calls[0]?.init?.method).toBe('POST');

		const body = bodyOf(calls[0]);
		expect(body['model']).toBe(DEFAULT_LLM_MODEL);
		expect(DEFAULT_LLM_MODEL).toBe('deepseek-flash');
		expect(body['stream']).toBe(false);
		expect(body['temperature']).toBe(0.1);
		expect(body['max_tokens']).toBe(512);
		expect(body['response_format']).toEqual({ type: 'json_object' });
		// 推理模型上不关掉「思考」就会返回空内容（见 REASONING_OFF 上的实测记录）
		expect(body['reasoning_effort']).toBe('none');
		expect(body['messages']).toEqual([{ role: 'user', content: '给我一个 JSON' }]);
		// 每次真发请求之前报一下（界面拿它写「第 N 次」）
		expect(attempt).toHaveBeenCalledWith(1, 2);
	});

	it('额外字段与 messages 一起进同一个请求体（设备组接口的两个字段就是这么带的）', async () => {
		const { impl, calls } = fetchRecorder(async () => responseOf('{"steps":[]}'));

		await generateJson({
			messages,
			extras: { catalogRef: 'phase1_robot', instruction: '前进1米，避障后停止' },
			fetchImpl: impl,
			wait: noWait,
		});

		const body = bodyOf(calls[0]);
		expect(body['catalogRef']).toBe('phase1_robot');
		expect(body['instruction']).toBe('前进1米，避障后停止');
		expect(body['messages']).toHaveLength(1);
	});

	it('可以换地址与模型（联调时只改地址，不换代码）', async () => {
		const { impl, calls } = fetchRecorder(async () => responseOf('{"steps":[]}'));

		await generateJson({
			messages,
			endpoint: 'http://127.0.0.1:8787',
			model: '别的模型',
			fetchImpl: impl,
			wait: noWait,
		});

		expect(calls[0]?.url).toBe('http://127.0.0.1:8787/chat/completions');
		expect(bodyOf(calls[0])['model']).toBe('别的模型');
	});
});

describe('LLM JSON 通话 · 响应解析', () => {
	it('剥围栏：整段被 ``` 包住时剥掉（含 json 标记），其余原样', () => {
		expect(stripCodeFence('{"a":1}')).toBe('{"a":1}');
		expect(stripCodeFence('```json\n{"a":1}\n```')).toBe('{"a":1}');
		expect(stripCodeFence('```\n{"a":1}\n```')).toBe('{"a":1}');
		// 只有半边围栏不算围栏（老实现在也是这么判的）
		expect(stripCodeFence('```json\n{"a":1}')).toBe('```json\n{"a":1}');
	});

	it('信封里取 choices[0].message.content；没有信封时响应体本身就是那个值', () => {
		const enveloped = jsonFromResponse(JSON.stringify({ choices: [{ message: { content: '```json\n{"a":1}\n```' } }] }));
		expect(enveloped.value).toEqual({ a: 1 });
		expect(enveloped.text).toBe('{"a":1}');

		const bare = jsonFromResponse('{"schema_version":"1.0"}');
		expect(bare.value).toEqual({ schema_version: '1.0' });
		expect(bare.text).toBe('{"schema_version":"1.0"}');
	});

	it('拿回来一份带围栏的 JSON → 解析成值，文本也剥好了', async () => {
		const { impl } = fetchRecorder(async () => okEnvelope('```json\n{"task_id":"t1"}\n```'));

		const result = await generateJson({ messages, fetchImpl: impl, wait: noWait });

		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.value).toEqual({ task_id: 't1' });
		expect(result.text).toBe('{"task_id":"t1"}');
	});
});

describe('LLM JSON 通话 · 重试与失败口径', () => {
	it('传输层挂一次就重试，第二次成功 → attempts 记 2', async () => {
		let round = 0;
		const { impl, calls } = fetchRecorder(async () => {
			round += 1;
			if (round === 1) throw new TypeError('Failed to fetch');
			return okEnvelope('{"ok":true}');
		});

		const result = await generateJson({ messages, fetchImpl: impl, wait: noWait });

		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.attempts).toBe(2);
		expect(calls).toHaveLength(2);
	});

	it('HTTP 非 2xx 也算传输层失败，两次都坏 → ok:false，原文是 null', async () => {
		const { impl, calls } = fetchRecorder(async () => responseOf('', { ok: false, status: 500, statusText: 'Server Error' }));

		const result = await generateJson({ messages, fetchImpl: impl, wait: noWait });

		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.kind).toBe('transport');
		expect(result.error).toContain('500');
		expect(result.text).toBeNull();
		expect(result.attempts).toBe(2);
		expect(calls).toHaveLength(2);
	});

	it('响应不是 JSON（HTML 错误页）→ 响应层失败，两次都坏，错误里带正文开头', async () => {
		const { impl } = fetchRecorder(async () => responseOf('<html><body>502 Bad Gateway</body></html>'));

		const result = await generateJson({ messages, fetchImpl: impl, wait: noWait });

		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.kind).toBe('response');
		expect(result.error).toContain('不是 JSON');
		expect(result.error).toContain('<html>');
	});

	it('信封里有 content 但不是 JSON → 响应层失败（可以重试）', async () => {
		const { impl } = fetchRecorder(async () => okEnvelope('我不知道该怎么写。'));

		const result = await generateJson({ messages, fetchImpl: impl, wait: noWait });

		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.kind).toBe('response');
		expect(result.error).toContain('不是 JSON');
	});

	it('content 是空的（推理把预算吃光）→ 响应层失败，且说清是这个原因', async () => {
		const { impl } = fetchRecorder(async () => okEnvelope(''));

		const result = await generateJson({ messages, fetchImpl: impl, wait: noWait });

		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.kind).toBe('response');
		expect(result.error).toContain('空内容');
		expect(result.error).toContain('max_tokens');
	});

	it('调用方的判据说不行 → 也重试；第二次过了就 ok', async () => {
		let round = 0;
		const { impl, calls } = fetchRecorder(async () => {
			round += 1;
			return okEnvelope(round === 1 ? '{"steps":[]}' : '{"steps":[{"id":"s1"}]}');
		});
		const accept = (value: unknown): boolean =>
			Array.isArray((value as { steps?: unknown[] }).steps) && (value as { steps: unknown[] }).steps.length > 0;

		const result = await generateJson({ messages, accept, fetchImpl: impl, wait: noWait });

		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.attempts).toBe(2);
		expect(calls).toHaveLength(2);
	});

	it('两次都过不了判据 → rejected，原文留着（看得见拿回来的是什么）', async () => {
		const { impl } = fetchRecorder(async () => okEnvelope('{"steps":[]}'));

		const result = await generateJson({
			messages,
			accept: () => false,
			fetchImpl: impl,
			wait: noWait,
		});

		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.kind).toBe('rejected');
		expect(result.text).toBe('{"steps":[]}');
		expect(result.attempts).toBe(2);
	});

	it('没有 accept 时拿到 JSON 就算成功（这一层不做业务校验）', async () => {
		const { impl } = fetchRecorder(async () => responseOf('{"随便":"什么"}'));

		const result = await generateJson({ messages, fetchImpl: impl, wait: noWait });

		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.value).toEqual({ 随便: '什么' });
	});
});
