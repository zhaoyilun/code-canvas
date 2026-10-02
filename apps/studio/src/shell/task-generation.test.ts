// @vitest-environment happy-dom
/**
 * 「一句话 → 任务 JSON」这一层的验收（`task-generation.ts`）。
 *
 * 最重要的一条：**系统提示词必须与 `docs/reference/llm_client.py` 逐字一致**。
 * 那边已经把七种动作、参数范围、`sensors` 取值、默认 `limits` 全写死了；两处一漂移，
 * 模型就会开始产出「过不了校验器」的任务。所以这里直接把那个文件读进来对账，
 * 而不是再抄一份字符串当期望值（抄一份等于把漂移合法化）。
 */
import { describe, expect, it } from 'vitest';
// 参考实现是那份「已经在用」的脚本；`?raw` 把它当文本读进来对账（不去解析 Python）。
import referenceClient from '../../../../docs/reference/llm_client.py?raw';
import { SYSTEM_PROMPT, generateTask, taskMessages } from './task-generation';

/**
 * 从参考实现里抠出 SYSTEM_PROMPT 的**值**。
 *
 * 那边是 Python 的三引号字面量，源码里 `\"1.0\"` 这种转义写出来的是普通的引号——
 * 所以这里把转义解掉再比：比的是两边的运行期取值，不是源码字节。
 */
const referencePrompt = (): string => {
	const match = /SYSTEM_PROMPT = """([\s\S]*?)"""/.exec(referenceClient);
	if (match === null || match[1] === undefined) throw new Error('参考实现里没有 SYSTEM_PROMPT');
	return match[1].replace(/\\"/g, '"').replace(/\\n/g, '\n');
};

const responseOf = (body: string, init: { ok?: boolean; status?: number; statusText?: string } = {}): Response =>
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

const envelope = (content: string): Response =>
	responseOf(JSON.stringify({ choices: [{ message: { content } }] }));

const noWait = async (): Promise<void> => {};

const VALID_TASK = JSON.stringify({
	schema_version: '1.0',
	task_id: 'task-llm-1',
	description: '前进1米，避障后停止',
	steps: [
		{ id: 's1', action: 'move', linear: 0.2, angular: 0, duration: 5 },
		{ id: 's2', action: 'stop_if_obstacle', sensors: ['/scan0'], distance: 0.5 },
	],
	limits: { max_linear: 0.3, max_angular: 1.2, max_duration: 30, require_confirmation: true },
});

const bodyOf = (call: Call | undefined): Record<string, unknown> =>
	JSON.parse(String(call?.init?.body ?? '{}')) as Record<string, unknown>;

describe('任务生成 · 提示词', () => {
	it('SYSTEM_PROMPT 与 docs/reference/llm_client.py 逐字一致', () => {
		expect(SYSTEM_PROMPT).toBe(referencePrompt());
	});

	it('对话就是「system = 那段提示词，user = 用户那句话」', () => {
		const messages = taskMessages('前进1米，避障后停止');
		expect(messages).toHaveLength(2);
		expect(messages[0]?.role).toBe('system');
		expect(messages[0]?.content).toBe(SYSTEM_PROMPT);
		expect(messages[1]?.role).toBe('user');
		// 原文进 user，不改写、不加料
		expect(messages[1]?.content).toBe('前进1米，避障后停止');
	});
});

describe('任务生成 · 请求与结果', () => {
	it('请求打到 <地址>/chat/completions，体里既有 messages 也有设备组要的那两个字段', async () => {
		const { impl, calls } = fetchRecorder(async () => envelope(VALID_TASK));

		const result = await generateTask({
			endpoint: '/llm',
			catalogRef: 'phase1_robot',
			instruction: '前进1米，避障后停止',
			accept: () => true,
			fetchImpl: impl,
			wait: noWait,
		});

		expect(result.ok).toBe(true);
		expect(calls[0]?.url).toBe('/llm/chat/completions');
		const body = bodyOf(calls[0]);
		expect(body['catalogRef']).toBe('phase1_robot');
		expect(body['instruction']).toBe('前进1米，避障后停止');
		expect((body['messages'] as unknown[])[0]).toEqual({ role: 'system', content: SYSTEM_PROMPT });
		expect(body['model']).toBe('deepseek-flash');
	});

	it('模型把 JSON 包在 Markdown 围栏里 → 剥掉后交给判据的是纯 JSON 文本', async () => {
		const { impl } = fetchRecorder(async () => envelope(`\`\`\`json\n${VALID_TASK}\n\`\`\``));
		const seen: string[] = [];

		const result = await generateTask({
			endpoint: '/llm',
			catalogRef: 'phase1_robot',
			instruction: '一句话',
			accept: (text) => {
				seen.push(text);
				return true;
			},
			fetchImpl: impl,
			wait: noWait,
		});

		expect(result.ok).toBe(true);
		expect(seen[0]?.startsWith('{')).toBe(true);
		expect(seen[0]).not.toContain('```');
	});

	it('判据说不行 → 再试一次；第二次过了就是成功，attempts 记 2', async () => {
		let round = 0;
		const { impl, calls } = fetchRecorder(async () => {
			round += 1;
			return envelope(round === 1 ? '{"schema_version":"1.0"}' : VALID_TASK);
		});
		const accept = (text: string): boolean => text.includes('"steps"');

		const result = await generateTask({
			endpoint: '/llm',
			catalogRef: 'phase1_robot',
			instruction: '一句话',
			accept,
			fetchImpl: impl,
			wait: noWait,
		});

		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.attempts).toBe(2);
		expect(calls).toHaveLength(2);
	});

	it('两次都坏 → ok:false，kind 说明坏在哪一层，原文（如果有）留着', async () => {
		const { impl } = fetchRecorder(async () => {
			throw new TypeError('Failed to fetch');
		});

		const result = await generateTask({
			endpoint: '/llm',
			catalogRef: 'phase1_robot',
			instruction: '一句话',
			accept: () => true,
			fetchImpl: impl,
			wait: noWait,
		});

		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.kind).toBe('transport');
		expect(result.message).toContain('Failed to fetch');
		expect(result.attempts).toBe(2);
		expect(result.text).toBeNull();
	});
});
