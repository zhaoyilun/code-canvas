// @vitest-environment happy-dom
/**
 * 上层入口带的验收：这是本阶段唯一的入口。
 *
 * 入口是「选设备 + 说一句话 + 生成」——任务 JSON 不再摆在顶上当主位，
 * 它要么由生成接口（默认走 dev server 反代到 LLM 的 `/llm`）产出来，
 * 要么从折起来的兜底入口塞进来。这里守住五件事：
 *
 * 1. 形态：常态只有设备下拉 + 一句话 + 生成按钮，JSON 文本框与接口地址都折起来；
 * 2. 设备：下拉列出目录里的设备，生成请求里带的是选中那台的 `catalogRef`；
 * 3. 生成：`POST { catalogRef, instruction, ... }` → 拿回任务 JSON（信封或裸任务都认）→
 *    走**现有的** `loadTaskJson`；模型偶尔给坏东西时重试一次；
 * 4. 失败：网络 / HTTP 非 2xx / 响应非 JSON / JSON 不合协议，四类都出诊断、真相不动、不弹窗；
 * 5. 兜底：接口还没就绪时，折起来的那条粘贴路照样能把任务灌进来（拖入文件同一条路）。
 *
 * 「三个视图同屏刷新」这一条的完整版在真浏览器里跑（见交付报告），
 * 这里守的是它成立的前提：唯一入口 + 失败不动真相。
 */
import { flushPromises, mount } from '@vue/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { nextTick } from 'vue';
import { loadSampleTask, useStudioDocument } from '../state/document';
import { SAMPLE_TASK_JSON } from '../state/sample-task';
import TaskInputBand from './TaskInputBand.vue';
import { DEVICE_CATALOGS, setSelectedCatalog } from './devices';
import { DEFAULT_LLM_ENDPOINT } from './llm-json';

const doc = useStudioDocument();

const sample = (): Record<string, unknown> => JSON.parse(SAMPLE_TASK_JSON) as Record<string, unknown>;

/** 改一处人类可读文本 + 一处数值——转换后视图上这两处都该变。 */
const editedJson = (): string => {
	const task = sample();
	task.description = '换成新任务：先转再停';
	const steps = task.steps as Array<Record<string, unknown>>;
	const first = steps[0];
	if (first === undefined) throw new Error('sample task must have steps');
	first.linear = 0.25;
	steps.pop(); // 顺带少一步：节点数也要跟着变
	return JSON.stringify(task, null, 2);
};

/** 非法：distance = 0 越出 `0 < distance ≤ 2.0`，任务层校验器会拦。 */
const illegalJson = (): string => {
	const task = sample();
	const steps = task.steps as Array<Record<string, unknown>>;
	const sensor = steps[1];
	if (sensor === undefined) throw new Error('sample task must have the obstacle step');
	sensor.distance = 0;
	return JSON.stringify(task, null, 2);
};

type Wrapper = ReturnType<typeof mount>;

const generateButton = (wrapper: Wrapper) => wrapper.get('[data-testid="task-generate"]');
const instructionInput = (wrapper: Wrapper) =>
	wrapper.get<HTMLInputElement>('[data-testid="instruction-input"]');
const deviceSelect = (wrapper: Wrapper) =>
	wrapper.get<HTMLSelectElement>('[data-testid="device-select"]');
const endpointInput = (wrapper: Wrapper) =>
	wrapper.get<HTMLInputElement>('[data-testid="task-endpoint-input"]');
const pasteInput = (wrapper: Wrapper) =>
	wrapper.get<HTMLTextAreaElement>('[data-testid="task-json-input"]');
const statusText = (wrapper: Wrapper): string =>
	wrapper.get('[data-testid="task-input-status"]').text();

/** 折起来的那两块的开关。 */
const togglePaste = async (wrapper: Wrapper): Promise<void> => {
	await wrapper.get('[data-testid="task-paste-toggle"]').trigger('click');
};
const toggleEndpoint = async (wrapper: Wrapper): Promise<void> => {
	await wrapper.get('[data-testid="task-endpoint-toggle"]').trigger('click');
};

const say = async (wrapper: Wrapper, text: string): Promise<void> => {
	await instructionInput(wrapper).setValue(text);
};

const dropFile = async (wrapper: Wrapper, name: string, text: string): Promise<void> => {
	const file = new File([text], name, { type: 'application/json' });
	const event = new Event('drop', { bubbles: true, cancelable: true });
	Object.defineProperty(event, 'dataTransfer', { value: { files: [file] } });
	wrapper.get('[data-testid="task-input-band"]').element.dispatchEvent(event);
	await flushPromises();
};

beforeEach(() => {
	expect(loadSampleTask()).toBe(true);
	setSelectedCatalog('phase1_robot');
	window.localStorage.clear();
});

afterEach(() => {
	vi.unstubAllGlobals();
});

describe('入口带 · 形态', () => {
	it('常态只有设备下拉 + 一句话 + 生成：JSON 文本框与接口地址都折起来', () => {
		const wrapper = mount(TaskInputBand);

		expect(wrapper.find('[data-testid="device-select"]').exists()).toBe(true);
		expect(wrapper.find('[data-testid="instruction-input"]').exists()).toBe(true);
		expect(wrapper.find('[data-testid="task-generate"]').exists()).toBe(true);

		// 旧的形态（一个大文本框 + 接口地址 + 获取）不许再占主位
		expect(wrapper.find('[data-testid="task-json-input"]').exists()).toBe(false);
		expect(wrapper.find('[data-testid="task-endpoint-input"]').exists()).toBe(false);
		expect(wrapper.find('[data-testid="task-fetch"]').exists()).toBe(false);

		// 两样次要入口都在，但都是折叠的
		expect(wrapper.find('[data-testid="task-paste-toggle"]').exists()).toBe(true);
		expect(wrapper.find('[data-testid="task-endpoint-toggle"]').exists()).toBe(true);
	});

	it('指令是「一句话」：一行高、占位就是图里那句例子', () => {
		const wrapper = mount(TaskInputBand);
		const input = instructionInput(wrapper);

		// input 而不是 textarea：它不该再吃掉小半屏
		expect(input.element.tagName).toBe('INPUT');
		expect(input.attributes('placeholder')).toBe('前进1米，避障后停止');
		expect(input.element.value).toBe('');
	});

	it('没写指令时生成按钮禁用；写了就可用', async () => {
		const wrapper = mount(TaskInputBand);
		expect(generateButton(wrapper).attributes('disabled')).toBeDefined();

		await say(wrapper, '前进1米，避障后停止');
		expect(generateButton(wrapper).attributes('disabled')).toBeUndefined();
	});

	it('两样次要入口点了才展开，再点收回去', async () => {
		const wrapper = mount(TaskInputBand);

		await toggleEndpoint(wrapper);
		expect(wrapper.find('[data-testid="task-endpoint-input"]').exists()).toBe(true);
		await toggleEndpoint(wrapper);
		expect(wrapper.find('[data-testid="task-endpoint-input"]').exists()).toBe(false);

		await togglePaste(wrapper);
		expect(wrapper.find('[data-testid="task-json-input"]').exists()).toBe(true);
		await togglePaste(wrapper);
		expect(wrapper.find('[data-testid="task-json-input"]').exists()).toBe(false);
	});
});

describe('入口带 · 设备下拉', () => {
	it('列出目录里的设备（一期只有一台），值是它的 catalogRef', () => {
		const wrapper = mount(TaskInputBand);
		const select = deviceSelect(wrapper);
		const options = wrapper.findAll('[data-testid="device-select"] option');

		expect(options).toHaveLength(DEVICE_CATALOGS.length);
		expect(options[0]?.attributes('value')).toBe('phase1_robot');
		expect(options[0]?.text()).toContain('一期设备（差速底盘 + 六轴臂）');
		// 默认选中第一条：入口一上来就是可选可生成的
		expect(select.element.value).toBe('phase1_robot');
	});

	it('不在册的设备不认：换成一个查不到的 ref，选中的还是原来那台', async () => {
		const wrapper = mount(TaskInputBand);

		// 目录外的 ref 是空操作——不许选中一个查不到的目录（那会让生成请求带上假 ref）
		setSelectedCatalog('nonexistent_device');
		await nextTick();

		expect(deviceSelect(wrapper).element.value).toBe('phase1_robot');
		expect(wrapper.findAll('[data-testid="device-select"] option')).toHaveLength(DEVICE_CATALOGS.length);
	});
});

/*
 * 生成：把 `{ catalogRef, instruction }`（连同 LLM 那几个字段）POST 给生成接口，拿回任务 JSON。
 *
 * 默认地址是同源的 `/llm`——dev server 反代到 LLM 服务并在服务端注入 key（浏览器里没有密钥）。
 * 这几条守的是「生成回来这一路也走同一个入口」：原型是 `loadTaskJson`，不是另写一条校验路径。
 * 失败分四类：网络 / 非 2xx、响应不是 JSON、JSON 不合协议；都只出诊断，不弹窗、不动真相。
 * 模型偶尔漏字段，所以默认重试一次（两次尝试）。
 */
describe('入口带 · 生成', () => {
	const CHAT_URL = `${DEFAULT_LLM_ENDPOINT}/chat/completions`;

	/** 假响应只带入口带用得到的几个成员，省得去凑一个完整的 Response。 */
	interface StubResponse {
		readonly ok: boolean;
		readonly status: number;
		readonly statusText: string;
		text(): Promise<string>;
	}

	interface FetchCall {
		readonly url: string;
		readonly init: RequestInit | undefined;
	}

	const calls: FetchCall[] = [];

	const okBody = (body: string): StubResponse => ({
		ok: true,
		status: 200,
		statusText: 'OK',
		text: async () => body,
	});

	/** OpenAI 信封（LLM 那条路的形状）。 */
	const envelope = (content: string): StubResponse =>
		okBody(JSON.stringify({ choices: [{ message: { role: 'assistant', content } }] }));

	const httpError = (status: number, statusText: string): StubResponse => ({
		ok: false,
		status,
		statusText,
		text: async () => '',
	});

	/** handler 抛异常 = 网络层直接失败（连不上、DNS 挂了）。 */
	const stubFetch = (handler: (url: string, init?: RequestInit) => Promise<StubResponse>): void => {
		calls.length = 0;
		vi.stubGlobal(
			'fetch',
			vi.fn((input: unknown, init?: RequestInit) => {
				const url = typeof input === 'string' ? input : String(input);
				calls.push({ url, init });
				return handler(url, init);
			}),
		);
	};

	/** 挂起中的请求：放行由测试自己决定，好在「进行中」那一刻做断言。 */
	const held: Array<(response: StubResponse) => void> = [];
	const stubPendingFetch = (): void => {
		stubFetch(
			() =>
				new Promise<StubResponse>((resolve) => {
					held.push(resolve);
				}),
		);
	};
	const releaseFetch = (response: StubResponse): void => {
		for (const resolve of held) resolve(response);
	};

	const sentBody = (call: FetchCall): Record<string, unknown> =>
		JSON.parse(String(call.init?.body ?? '{}')) as Record<string, unknown>;

	const chainState = (wrapper: Wrapper) => wrapper.get('[data-testid="translation-chain-state"]');
	const litNodes = (wrapper: Wrapper) =>
		wrapper.findAll('[data-testid="translation-chain"] .chain-node.is-lit');
	const liveNodes = (wrapper: Wrapper) =>
		wrapper.findAll('[data-testid="translation-chain"] .chain-node.is-live');
	const failedNodes = (wrapper: Wrapper) =>
		wrapper.findAll('[data-testid="translation-chain"] .chain-node.is-failed');
	const diagnosticTexts = (wrapper: Wrapper): string[] =>
		wrapper.findAll('[data-testid="task-input-diagnostic"]').map((row) => row.text());

	const clickGenerate = async (wrapper: Wrapper): Promise<void> => {
		await generateButton(wrapper).trigger('click');
		await flushPromises();
	};

	/** 跑完逐段点亮那 ~0.4s（但不越过成功后的 1.2s 停留）。 */
	const runReveal = async (): Promise<void> => {
		await vi.advanceTimersByTimeAsync(500);
		await nextTick();
	};

	/**
	 * 让「重试」那一次真的发生：第一次失败后有 200ms 的等待，
	 * 假定时器不推它，第二次尝试永远不会发出去。
	 */
	const runRetry = async (): Promise<void> => {
		await vi.advanceTimersByTimeAsync(600);
		await flushPromises();
		await nextTick();
	};

	beforeEach(() => {
		// 逐段点亮与重试等待用的都是真定时器；假掉它们，测试才不用真等。
		// 只假 setTimeout，setImmediate 留着——@vue/test-utils 的 flushPromises 靠它。
		vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it('生成请求打到 <地址>/chat/completions，体里带选中设备的 catalogRef 与那一句话', async () => {
		stubFetch(async () => envelope(editedJson()));
		const wrapper = mount(TaskInputBand);
		const before = doc.declaration.value;

		await say(wrapper, '前进1米，避障后停止');
		await clickGenerate(wrapper);
		await runReveal();

		expect(calls).toHaveLength(1);
		const call = calls[0];
		expect(call?.url).toBe(CHAT_URL);
		expect(call?.init?.method).toBe('POST');

		const body = sentBody(call as FetchCall);
		expect(body['catalogRef']).toBe(deviceSelect(wrapper).element.value);
		expect(body['catalogRef']).toBe('phase1_robot');
		expect(body['instruction']).toBe('前进1米，避障后停止');
		// 与通用通话层同一份请求体：模型、温度、上限、要 JSON
		expect(body['model']).toBe('deepseek-flash');
		expect(body['temperature']).toBe(0.1);
		expect(body['max_tokens']).toBe(512);
		expect(body['response_format']).toEqual({ type: 'json_object' });
		expect(body['messages']).toHaveLength(2);

		// 真相换了：三个视图都是从它派生的
		expect(doc.declaration.value).not.toBe(before);
		expect(doc.declaration.value?.meta.description).toBe('换成新任务：先转再停');
		expect(doc.declaration.value?.nodes).toHaveLength(3);

		// 终态明确：全亮 + 「已完成 · N 个节点」
		expect(litNodes(wrapper)).toHaveLength(4);
		expect(chainState(wrapper).text()).toContain('已完成');
		expect(chainState(wrapper).text()).toContain('3 个节点');
		expect(statusText(wrapper)).toContain('已生成');
		expect(wrapper.find('[data-testid="task-input-feedback"]').exists()).toBe(false);
	});

	it('设备组那条路也认：响应直接给任务 JSON（没有信封）', async () => {
		stubFetch(async () => okBody(editedJson()));
		const wrapper = mount(TaskInputBand);

		await say(wrapper, '一句话');
		await clickGenerate(wrapper);
		await runReveal();

		expect(doc.declaration.value?.meta.description).toBe('换成新任务：先转再停');
		expect(statusText(wrapper)).toContain('已生成');
	});

	it('模型把 JSON 包在 Markdown 围栏里 → 剥掉围栏照样过', async () => {
		stubFetch(async () => envelope(`\`\`\`json\n${editedJson()}\n\`\`\``));
		const wrapper = mount(TaskInputBand);

		await say(wrapper, '一句话');
		await clickGenerate(wrapper);
		await runReveal();

		expect(doc.declaration.value?.meta.description).toBe('换成新任务：先转再停');
		expect(statusText(wrapper)).toContain('已生成');
	});

	it('模型第一次给的东西不合协议 → 重试一次；第二次过了就是成功', async () => {
		let round = 0;
		stubFetch(async () => {
			round += 1;
			return envelope(round === 1 ? '{"schema_version":"1.0"}' : editedJson());
		});
		const wrapper = mount(TaskInputBand);

		await say(wrapper, '一句话');
		await clickGenerate(wrapper);
		await runRetry();
		await runReveal();

		expect(calls).toHaveLength(2);
		expect(doc.declaration.value?.meta.description).toBe('换成新任务：先转再停');
		expect(statusText(wrapper)).toContain('已生成');
	});

	it('生成回来的原文落到兜底框：拿到的是什么看得见', async () => {
		stubFetch(async () => envelope(editedJson()));
		const wrapper = mount(TaskInputBand);

		await say(wrapper, '一句话');
		await clickGenerate(wrapper);
		await runReveal();
		await togglePaste(wrapper);

		expect(pasteInput(wrapper).element.value).toContain('换成新任务：先转再停');
	});

	it('成功后的全亮只停一小会儿：链路回常态，「已完成」标记留着（不许一直闪）', async () => {
		stubFetch(async () => envelope(editedJson()));
		const wrapper = mount(TaskInputBand);

		await say(wrapper, '一句话');
		await clickGenerate(wrapper);
		await runReveal();
		expect(litNodes(wrapper)).toHaveLength(4);

		await vi.advanceTimersByTimeAsync(2000);
		await nextTick();

		expect(litNodes(wrapper)).toHaveLength(0);
		expect(liveNodes(wrapper)).toHaveLength(0);
		expect(chainState(wrapper).text()).toContain('已完成');
	});

	it('请求还挂着的时候链路是「进行中」：亮着、在呼吸，生成按钮禁用', async () => {
		stubPendingFetch();
		const wrapper = mount(TaskInputBand);

		await say(wrapper, '一句话');
		await clickGenerate(wrapper);

		expect(liveNodes(wrapper)).toHaveLength(1);
		expect(chainState(wrapper).text()).toContain('生成中');
		expect(generateButton(wrapper).attributes('disabled')).toBeDefined();

		// 放行，链路接着往下一段走
		releaseFetch(envelope(editedJson()));
		await flushPromises();
		await nextTick();
		expect(litNodes(wrapper)).toHaveLength(2);
	});

	it('地址连不上 → 入口下方出生成失败诊断（带尝试次数），真相一个字节都不动，停在第 1 段', async () => {
		const alert = vi.fn();
		vi.stubGlobal('alert', alert);
		stubFetch(async () => {
			throw new TypeError('Failed to fetch');
		});

		const wrapper = mount(TaskInputBand);
		const before = doc.declaration.value;

		await say(wrapper, '一句话');
		await clickGenerate(wrapper);
		await runRetry();

		expect(statusText(wrapper)).toContain('生成失败');
		const rows = diagnosticTexts(wrapper);
		expect(rows.some((text) => text.includes('task_input.generate_failed'))).toBe(true);
		expect(rows.some((text) => text.includes('Failed to fetch'))).toBe(true);
		expect(rows.some((text) => text.includes('已尝试 2 次'))).toBe(true);
		// 默认重试一次：两次都发了
		expect(calls).toHaveLength(2);

		expect(doc.declaration.value).toBe(before);
		expect(doc.declaration.value?.nodes).toHaveLength(4);

		// 红灯停在第 1 段（任务 JSON 就没生成出来），后面三段没亮
		expect(failedNodes(wrapper)).toHaveLength(1);
		expect(litNodes(wrapper)).toHaveLength(0);
		expect(chainState(wrapper).text()).toContain('第 1 段');
		// 诊断是给人看的，alert 不是
		expect(alert).not.toHaveBeenCalled();
	});

	it('接口在但回 404 → 同一类生成失败诊断', async () => {
		stubFetch(async () => httpError(404, 'Not Found'));
		const wrapper = mount(TaskInputBand);
		const before = doc.declaration.value;

		await say(wrapper, '一句话');
		await clickGenerate(wrapper);
		await runRetry();

		expect(statusText(wrapper)).toContain('生成失败');
		const rows = diagnosticTexts(wrapper);
		expect(rows.some((text) => text.includes('task_input.generate_failed'))).toBe(true);
		expect(rows.some((text) => text.includes('404'))).toBe(true);
		expect(doc.declaration.value).toBe(before);
	});

	it('响应不是 JSON（比如一段 HTML 错误页）→ 响应层诊断，真相不动', async () => {
		const html = '<html><body>502 Bad Gateway</body></html>';
		stubFetch(async () => okBody(html));
		const wrapper = mount(TaskInputBand);
		const before = doc.declaration.value;

		await say(wrapper, '一句话');
		await clickGenerate(wrapper);
		await runRetry();

		expect(statusText(wrapper)).toContain('生成失败');
		const rows = diagnosticTexts(wrapper);
		expect(rows.some((text) => text.includes('不是 JSON'))).toBe(true);
		expect(doc.declaration.value).toBe(before);
		expect(failedNodes(wrapper)).toHaveLength(1);
	});

	it('生成回来一个非法任务（distance = 0）→ 校验诊断，真相不动，红灯停在第 2 段', async () => {
		stubFetch(async () => envelope(illegalJson()));
		const wrapper = mount(TaskInputBand);
		const before = doc.declaration.value;

		await say(wrapper, '一句话');
		await clickGenerate(wrapper);
		await runRetry();

		expect(statusText(wrapper)).toContain('生成结果不合协议');
		const rows = diagnosticTexts(wrapper);
		expect(rows.some((text) => text.includes('distance'))).toBe(true);
		expect(doc.declaration.value).toBe(before);
		expect(doc.declaration.value?.nodes).toHaveLength(4);
		// 重试一次仍然不合协议
		expect(calls).toHaveLength(2);

		// 任务 JSON 到手了（第 1 段是亮的），积木那一段没产出（红灯）
		expect(litNodes(wrapper)).toHaveLength(1);
		expect(failedNodes(wrapper)).toHaveLength(1);
		expect(chainState(wrapper).text()).toContain('第 2 段');
	});

	it('失败路径不弹窗：诊断在带子里，alert / confirm 一次都不响', async () => {
		const alert = vi.fn();
		const confirm = vi.fn();
		vi.stubGlobal('alert', alert);
		vi.stubGlobal('confirm', confirm);
		stubFetch(async () => httpError(500, 'Server Error'));

		const wrapper = mount(TaskInputBand);
		await say(wrapper, '一句话');
		await clickGenerate(wrapper);
		await runRetry();

		expect(alert).not.toHaveBeenCalled();
		expect(confirm).not.toHaveBeenCalled();
		expect(wrapper.find('[data-testid="task-input-diagnostics"]').exists()).toBe(true);
	});

	it('生成还没回来就手动灌一份 → 在途那次自己让位：不覆盖手动结果，也不把按钮锁死', async () => {
		stubPendingFetch();
		const wrapper = mount(TaskInputBand);

		await say(wrapper, '一句话');
		await clickGenerate(wrapper);
		expect(generateButton(wrapper).attributes('disabled')).toBeDefined();

		await togglePaste(wrapper);
		await pasteInput(wrapper).setValue(editedJson());
		await wrapper.get('[data-testid="task-convert"]').trigger('click');
		expect(doc.declaration.value?.meta.description).toBe('换成新任务：先转再停');

		// 在途那次最后回来了，但席位已经换人——它只能退场（一个字节都不许进真相）
		releaseFetch(envelope(SAMPLE_TASK_JSON));
		await flushPromises();
		await runReveal();

		expect(doc.declaration.value?.meta.description).toBe('换成新任务：先转再停');
		expect(generateButton(wrapper).attributes('disabled')).toBeUndefined();
	});
});

describe('入口带 · 接口地址', () => {
	const ENDPOINT_KEY = 'codecanvas.task-endpoint';

	it('默认是同源 /llm；填一次就记进 localStorage，重新挂载还在', async () => {
		const wrapper = mount(TaskInputBand);
		await toggleEndpoint(wrapper);

		expect(endpointInput(wrapper).attributes('type')).toBe('url');
		expect(endpointInput(wrapper).attributes('placeholder')).toBe(DEFAULT_LLM_ENDPOINT);
		expect(endpointInput(wrapper).element.value).toBe(DEFAULT_LLM_ENDPOINT);

		await endpointInput(wrapper).setValue('http://127.0.0.1:9001');
		expect(window.localStorage.getItem(ENDPOINT_KEY)).toBe('http://127.0.0.1:9001');

		// 「刷新」= 重新挂一个全新的组件：它只认 localStorage
		const remounted = mount(TaskInputBand);
		await toggleEndpoint(remounted);
		expect(endpointInput(remounted).element.value).toBe('http://127.0.0.1:9001');
	});
});

describe('入口带 · 粘贴兜底', () => {
	it('折起来的粘贴路仍然能换真相：粘一份改过的任务 → 声明换掉，节点数与参数都跟着变', async () => {
		const wrapper = mount(TaskInputBand);
		const before = doc.declaration.value;
		expect(before?.nodes).toHaveLength(4);
		expect(before?.meta.description).toBe('前进，遇障停止后转向');

		await togglePaste(wrapper);
		await pasteInput(wrapper).setValue(editedJson());
		await wrapper.get('[data-testid="task-convert"]').trigger('click');

		const after = doc.declaration.value;
		expect(after).not.toBe(before);
		expect(after?.meta.description).toBe('换成新任务：先转再停');
		expect(after?.nodes).toHaveLength(3);
		expect(after?.nodes[0]?.parameters.linear).toBe(0.25);
		expect(statusText(wrapper)).toContain('已导入');
		expect(wrapper.find('[data-testid="task-input-diagnostics"]').exists()).toBe(false);
	});

	it('非法值（distance = 0）→ 诊断摆在入口下方，真相一个字节都不动', async () => {
		const wrapper = mount(TaskInputBand);
		const before = doc.declaration.value;

		await togglePaste(wrapper);
		await pasteInput(wrapper).setValue(illegalJson());
		await wrapper.get('[data-testid="task-convert"]').trigger('click');

		expect(statusText(wrapper)).toContain('转换失败');
		const rows = wrapper.findAll('[data-testid="task-input-diagnostic"]');
		expect(rows.length).toBeGreaterThan(0);
		expect(rows.some((row) => row.text().includes('distance'))).toBe(true);
		// 诊断在入口本体的**下方**（DOM 顺序，不是「也挤在这一带」）
		const entry = wrapper.get('.entry').element;
		const feedback = wrapper.get('[data-testid="task-input-feedback"]').element;
		expect(entry.compareDocumentPosition(feedback) & 4).toBeTruthy();

		expect(doc.declaration.value).toBe(before);
		expect(doc.declaration.value?.nodes).toHaveLength(4);
	});

	it('根本不是 JSON 的文本 → 解析诊断，真相不动', async () => {
		const wrapper = mount(TaskInputBand);
		const before = doc.declaration.value;

		await togglePaste(wrapper);
		await pasteInput(wrapper).setValue('这不是 JSON，是一句话。');
		await wrapper.get('[data-testid="task-convert"]').trigger('click');

		expect(statusText(wrapper)).toContain('转换失败');
		expect(wrapper.get('[data-testid="task-input-diagnostics"]').text()).toContain(
			'task_import.json_parse_error',
		);
		expect(doc.declaration.value).toBe(before);
	});

	it('失败路径不弹窗：诊断在带子里，alert / confirm 一次都不响', async () => {
		const alert = vi.fn();
		const confirm = vi.fn();
		vi.stubGlobal('alert', alert);
		vi.stubGlobal('confirm', confirm);

		const wrapper = mount(TaskInputBand);
		await togglePaste(wrapper);
		await pasteInput(wrapper).setValue(illegalJson());
		await wrapper.get('[data-testid="task-convert"]').trigger('click');

		expect(alert).not.toHaveBeenCalled();
		expect(confirm).not.toHaveBeenCalled();
		expect(wrapper.find('[data-testid="task-input-diagnostics"]').exists()).toBe(true);
	});

	it('空输入时转换按钮是禁用的（没东西可转就别给假入口）', async () => {
		const wrapper = mount(TaskInputBand);

		await togglePaste(wrapper);
		const button = wrapper.get('[data-testid="task-convert"]');
		expect(button.attributes('disabled')).toBeDefined();
		await pasteInput(wrapper).setValue('{}');
		expect(button.attributes('disabled')).toBeUndefined();
		await wrapper.get('[data-testid="task-clear"]').trigger('click');
		expect(button.attributes('disabled')).toBeDefined();
	});
});

describe('入口带 · 拖入文件', () => {
	it('拖一个 .json 进来 → 展开兜底框、读文本后走同一条转换路', async () => {
		const wrapper = mount(TaskInputBand);
		const before = doc.declaration.value;

		await dropFile(wrapper, 'task-obstacle.json', editedJson());

		expect(doc.declaration.value).not.toBe(before);
		expect(doc.declaration.value?.meta.description).toBe('换成新任务：先转再停');
		expect(doc.declaration.value?.nodes).toHaveLength(3);
		expect(statusText(wrapper)).toContain('已导入');
		// 读进来的文本落到兜底框，看得见自己拖了什么
		expect(pasteInput(wrapper).element.value).toContain('换成新任务：先转再停');
		expect(wrapper.get('[data-testid="task-input-file"]').text()).toBe('task-obstacle.json');
	});

	it('拖进来的文件是非法的 → 同样只出诊断，真相不动', async () => {
		const wrapper = mount(TaskInputBand);
		const before = doc.declaration.value;

		await dropFile(wrapper, 'broken.json', illegalJson());

		expect(doc.declaration.value).toBe(before);
		expect(statusText(wrapper)).toContain('转换失败');
		expect(wrapper.findAll('[data-testid="task-input-diagnostic"]').length).toBeGreaterThan(0);
	});
});

describe('入口带 · 转译链指示', () => {
	it('静态链条把「生成接口给 JSON、我们转三视图」说清楚', () => {
		const wrapper = mount(TaskInputBand);
		const chain = wrapper.get('[data-testid="translation-chain"]');

		expect(chain.text()).toContain('任务 JSON');
		expect(chain.text()).toContain('积木');
		expect(chain.text()).toContain('流程');
		expect(chain.text()).toContain('代码');
		expect(chain.findAll('.chain-arrow')).toHaveLength(1);
	});

	it('链条不冒充入口：它不带按钮，也不改真相', () => {
		const wrapper = mount(TaskInputBand);
		expect(wrapper.get('[data-testid="translation-chain"]').findAll('button')).toHaveLength(0);
		expect(wrapper.get('[data-testid="translation-chain"]').findAll('textarea')).toHaveLength(0);
		expect(wrapper.get('[data-testid="translation-chain"]').findAll('input')).toHaveLength(0);
	});
});
