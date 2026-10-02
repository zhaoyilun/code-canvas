// @vitest-environment happy-dom
/**
 * 「一句话 → 任务 JSON」这一层的验收（`task-generation.ts`）。
 *
 * 最重要的一条：**一期那份系统提示词必须与 `docs/reference/llm_client.py` 逐字一致**。
 * 那边已经把七种动作、参数范围、`sensors` 取值、默认 `limits` 全写死了；两处一漂移，
 * 模型就会开始产出「过不了校验器」的任务。所以这里直接把那个文件读进来对账，
 * 而不是再抄一份字符串当期望值（抄一份等于把漂移合法化）。
 *
 * 另一半守的是「提示词按设备格式切」：技能计划那份**由目录生成**，所以这里遍历目录断言
 * 每个技能都在提示词里——不写死清单，目录改了测试跟着改（写死清单等于把漂移合法化，同上）。
 */
import { describe, expect, it } from 'vitest';
// 参考实现是那份「已经在用」的脚本；`?raw` 把它当文本读进来对账（不去解析 Python）。
import referenceClient from '../../../../docs/reference/llm_client.py?raw';
import { ROBOFRAME_SO101_CATALOG } from '@codecanvas/capabilities';
import { SKILL_PLAN_SCHEMA_VERSION } from '@codecanvas/contracts';
import { findDevice, type StudioDevice } from './devices';
import { SYSTEM_PROMPT, generateTask, skillPlanSystemPrompt, taskMessages } from './task-generation';

/** 按 ref 取一台在册设备。测试里写死的是「哪台」，不是它的字段——字段归 `devices.ts` 管。 */
const deviceOf = (deviceRef: string): StudioDevice => {
	const device = findDevice(deviceRef);
	if (device === null) throw new Error(`devices.ts 里没有设备 ${deviceRef}`);
	return device;
};

const PHASE1_DEVICE = deviceOf('phase1_robot');
const SO101_DEVICE = deviceOf('so101_robot');

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

/**
 * 这一台设备在请求里要带的那三样。写成一个函数而不是手抄三遍：
 * 「请求里带的是哪台」正是几条测试的重点，抄错了会静默变成另一件事。
 */
const deviceFields = (
	device: StudioDevice,
): { deviceRef: string; formatRef: StudioDevice['formatRef']; catalog: StudioDevice['catalog'] } => ({
	deviceRef: device.deviceRef,
	formatRef: device.formatRef,
	catalog: device.catalog,
});

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

/*
 * 技能计划那份提示词**由目录生成**——所以这里遍历目录断言，不写死技能清单：
 * 写死清单等于把「提示词与目录漂移」合法化，而漂移的后果是模型照着过期清单编、
 * 校验器拿真目录一条条拒。目录改了，这几条应该照样绿。
 */
describe('任务生成 · 技能计划的提示词', () => {
	it('目录里每个技能都列出来了：名字、中文名、以及它声明的参数（名字 + 类型）', () => {
		const prompt = skillPlanSystemPrompt(ROBOFRAME_SO101_CATALOG);

		expect(ROBOFRAME_SO101_CATALOG.capabilities.length).toBeGreaterThan(0);
		for (const capability of ROBOFRAME_SO101_CATALOG.capabilities) {
			expect(prompt).toContain(capability.capabilityRef);
			expect(prompt).toContain(capability.label);
			for (const parameter of capability.parameters) {
				expect(prompt).toContain(parameter.name);
				expect(prompt).toContain(parameter.type);
			}
		}
	});

	it('规矩齐了：只给 JSON、版本是 1、robot 是目录里那个名字、plan 步的形状写清楚', () => {
		const prompt = skillPlanSystemPrompt(ROBOFRAME_SO101_CATALOG);

		expect(prompt).toContain('JSON');
		expect(prompt).toContain('Markdown');
		expect(prompt).toContain(`schemaVersion=${String(SKILL_PLAN_SCHEMA_VERSION)}`);
		expect(prompt).toContain(String(ROBOFRAME_SO101_CATALOG.robotName));
		expect(prompt).toContain('"step":"skill"');
		expect(prompt).toContain('"params"');
		expect(prompt).toContain('timeoutSec');
		expect(prompt).toContain('description');
	});

	it('两台设备的提示词不是同一份：技能计划那份不出现一期写死的动作', () => {
		// 反证：词汇表不一样，一份提示词盖不了两种格式
		expect(skillPlanSystemPrompt(ROBOFRAME_SO101_CATALOG)).not.toContain('arm6_joints');
		expect(SYSTEM_PROMPT).not.toContain('inspect_scene');
	});
});

describe('任务生成 · 请求与结果', () => {
	it('请求打到 <地址>/chat/completions，体里既有 messages 也有设备组要的那两个字段', async () => {
		const { impl, calls } = fetchRecorder(async () => envelope(VALID_TASK));

		const result = await generateTask({
			endpoint: '/llm',
			...deviceFields(PHASE1_DEVICE),
			instruction: '前进1米，避障后停止',
			accept: () => true,
			fetchImpl: impl,
			wait: noWait,
		});

		expect(result.ok).toBe(true);
		expect(calls[0]?.url).toBe('/llm/chat/completions');
		const body = bodyOf(calls[0]);
		expect(body['catalogRef']).toBe('phase1_robot');
		expect(body['deviceRef']).toBe('phase1_robot');
		expect(body['formatRef']).toBe('phase1_task');
		// 一期协议里没有「机器人名」这一栏，不编一个空字符串糊上去
		expect(body['robot']).toBeUndefined();
		expect(body['instruction']).toBe('前进1米，避障后停止');
		expect((body['messages'] as unknown[])[0]).toEqual({ role: 'system', content: SYSTEM_PROMPT });
		expect(body['model']).toBe('deepseek-flash');
	});

	it('模型把 JSON 包在 Markdown 围栏里 → 剥掉后交给判据的是纯 JSON 文本', async () => {
		const { impl } = fetchRecorder(async () => envelope(`\`\`\`json\n${VALID_TASK}\n\`\`\``));
		const seen: string[] = [];

		const result = await generateTask({
			endpoint: '/llm',
			...deviceFields(PHASE1_DEVICE),
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
			...deviceFields(PHASE1_DEVICE),
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
			...deviceFields(PHASE1_DEVICE),
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

	it('技能计划那次请求：extras 带的是那把尺子（formatRef / deviceRef），并且写明 robot', async () => {
		const { impl, calls } = fetchRecorder(async () => envelope(VALID_TASK));

		const result = await generateTask({
			endpoint: '/llm',
			...deviceFields(SO101_DEVICE),
			instruction: '看一眼桌面，往前挪一点',
			accept: () => true,
			fetchImpl: impl,
			wait: noWait,
		});

		expect(result.ok).toBe(true);
		const body = bodyOf(calls[0]);
		expect(body['formatRef']).toBe('skill_plan');
		expect(body['deviceRef']).toBe('so101_robot');
		expect(body['robot']).toBe(ROBOFRAME_SO101_CATALOG.robotName);
		// catalogRef 从目录里推，不另开入参：设备与它的目录必须对得上
		expect(body['catalogRef']).toBe(ROBOFRAME_SO101_CATALOG.catalogRef);
		expect(body['instruction']).toBe('看一眼桌面，往前挪一点');

		// system 那段是这份目录现生成的，不是一期那份
		const messages = body['messages'] as Array<{ role: string; content: string }>;
		expect(messages[0]?.role).toBe('system');
		expect(messages[0]?.content).toBe(skillPlanSystemPrompt(ROBOFRAME_SO101_CATALOG));
		expect(messages[1]?.content).toBe('看一眼桌面，往前挪一点');
	});
});

describe('技能计划的提示词要说清怎么分叉', () => {
	const prompt = skillPlanSystemPrompt(ROBOFRAME_SO101_CATALOG);

	it('写出了 if 步的形状与条件的三段取值', () => {
		expect(prompt).toContain('"step":"if"');
		expect(prompt).toContain('"then"');
		expect(prompt).toContain('"else"');
		// 条件只有一种：上一步成没成。模型不许自己发明别的字段。
		expect(prompt).toContain('"field":"last.success"');
		expect(prompt).toContain('"op"');
		expect(prompt).toContain('"value"');
	});

	it('说了两臂的约束（then 非空、else 可无但给了不能空、能嵌套）', () => {
		expect(prompt).toMatch(/then[^。\n]*至少一步/);
		expect(prompt).toMatch(/else[^。\n]*可以不给/);
		expect(prompt).toMatch(/嵌套|再套|八层/);
	});

	it('没有为分叉手写任何技能名——技能清单照旧只有目录那一份', () => {
		// 提示词里出现过的技能名，必须每一个都在目录里；反过来目录里的每一个也都要出现。
		for (const capability of ROBOFRAME_SO101_CATALOG.capabilities) {
			expect(prompt).toContain(capability.capabilityRef);
		}
	});
});
