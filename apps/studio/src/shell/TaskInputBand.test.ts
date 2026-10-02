// @vitest-environment happy-dom
/**
 * 上层输入带的验收：这是本阶段唯一的真实输入口。
 *
 * 1. 粘贴改过的任务 JSON → 转换 → 真相换掉（三个视图都是从真相派生的，所以它们一起刷新）；
 * 2. 非法值（distance = 0）→ 诊断摆在输入区下方，**真相不动**；
 * 3. 根本不是 JSON 的文本 → 解析诊断，同样不动真相；
 * 4. 拖入 .json 文件 → 走的是同一条路（读文本 → `loadTaskJson`）；
 * 5. 从接口取 → 同样汇到 `loadTaskJson`，失败分「网络 / 不是 JSON / 不合协议」三类；
 * 6. 失败路径一律不弹窗（诊断是给人看的，alert 不是）。
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

const input = (wrapper: ReturnType<typeof mount>) =>
	wrapper.get<HTMLTextAreaElement>('[data-testid="task-json-input"]');
const statusText = (wrapper: ReturnType<typeof mount>): string =>
	wrapper.get('[data-testid="task-input-status"]').text();

const paste = async (wrapper: ReturnType<typeof mount>, text: string): Promise<void> => {
	await input(wrapper).setValue(text);
};

const dropFile = async (wrapper: ReturnType<typeof mount>, name: string, text: string): Promise<void> => {
	const file = new File([text], name, { type: 'application/json' });
	const event = new Event('drop', { bubbles: true, cancelable: true });
	Object.defineProperty(event, 'dataTransfer', { value: { files: [file] } });
	wrapper.get('[data-testid="task-input-band"]').element.dispatchEvent(event);
	await flushPromises();
};

beforeEach(() => {
	expect(loadSampleTask()).toBe(true);
});

afterEach(() => {
	vi.unstubAllGlobals();
});

describe('输入带 · 转换', () => {
	it('粘一份改过的任务 JSON 点转换 → 声明换掉，节点数与参数都跟着变', async () => {
		const wrapper = mount(TaskInputBand);
		const before = doc.declaration.value;
		expect(before?.nodes).toHaveLength(4);
		expect(before?.meta.description).toBe('前进，遇障停止后转向');

		await paste(wrapper, editedJson());
		await wrapper.get('[data-testid="task-convert"]').trigger('click');

		const after = doc.declaration.value;
		expect(after).not.toBe(before);
		expect(after?.meta.description).toBe('换成新任务：先转再停');
		expect(after?.nodes).toHaveLength(3);
		expect(after?.nodes[0]?.parameters.linear).toBe(0.25);
		expect(after?.digest).not.toBe(before?.digest);

		expect(statusText(wrapper)).toContain('已转换');
		expect(statusText(wrapper)).toContain('3 个节点');
		// 成功且无话可说时不该冒出诊断列表
		expect(wrapper.find('[data-testid="task-input-diagnostics"]').exists()).toBe(false);
	});

	it('非法值（distance = 0）→ 诊断摆在输入区下方，真相一个字节都不动', async () => {
		const wrapper = mount(TaskInputBand);
		const before = doc.declaration.value;

		await paste(wrapper, illegalJson());
		await wrapper.get('[data-testid="task-convert"]').trigger('click');

		expect(statusText(wrapper)).toContain('转换失败');
		const rows = wrapper.findAll('[data-testid="task-input-diagnostic"]');
		expect(rows.length).toBeGreaterThan(0);
		expect(rows.some((row) => row.text().includes('distance'))).toBe(true);
		// 诊断在输入区的**下方**（DOM 顺序，不是「也挤在这一带」）
		const intake = wrapper.get('.intake').element;
		const feedback = wrapper.get('[data-testid="task-input-feedback"]').element;
		expect(intake.compareDocumentPosition(feedback) & 4).toBeTruthy();

		expect(doc.declaration.value).toBe(before);
		expect(doc.declaration.value?.nodes).toHaveLength(4);
	});

	it('根本不是 JSON 的文本 → 解析诊断，真相不动', async () => {
		const wrapper = mount(TaskInputBand);
		const before = doc.declaration.value;

		await paste(wrapper, '这不是 JSON，是一句话。');
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
		await paste(wrapper, illegalJson());
		await wrapper.get('[data-testid="task-convert"]').trigger('click');

		expect(alert).not.toHaveBeenCalled();
		expect(confirm).not.toHaveBeenCalled();
		expect(wrapper.find('[data-testid="task-input-diagnostics"]').exists()).toBe(true);
	});

	it('空输入时转换按钮是禁用的（没东西可转就别给假入口）', async () => {
		const wrapper = mount(TaskInputBand);
		const button = wrapper.get('[data-testid="task-convert"]');

		expect(button.attributes('disabled')).toBeUndefined();
		await wrapper.get('[data-testid="task-clear"]').trigger('click');
		expect(button.attributes('disabled')).toBeDefined();
	});
});

describe('输入带 · 拖入文件', () => {
	it('拖一个 .json 进来 → 读文本后走同一条转换路，三个视图的数据跟着变', async () => {
		const wrapper = mount(TaskInputBand);
		const before = doc.declaration.value;

		await dropFile(wrapper, 'task-obstacle.json', editedJson());

		expect(doc.declaration.value).not.toBe(before);
		expect(doc.declaration.value?.meta.description).toBe('换成新任务：先转再停');
		expect(doc.declaration.value?.nodes).toHaveLength(3);
		expect(statusText(wrapper)).toContain('已转换');
		// 读进来的文本落到输入框，看得见自己拖了什么
		expect(input(wrapper).element.value).toContain('换成新任务：先转再停');
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

describe('输入带 · 转译链指示', () => {
	it('静态链条把「上游生成、我们转三视图」说清楚', () => {
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
	});
});

/*
 * 从接口取：上游生成器把任务生成好放在一个地址上，这里只负责取回来。
 *
 * 这几条守的是「取回来这一路也走同一个入口」——原型是 `loadTaskJson`，
 * 不是另写一条校验路径。失败分三类：网络（连不上 / 非 2xx）、响应不是 JSON、
 * JSON 不合协议；三类都只出诊断，不弹窗、不动真相。
 */
describe('输入带 · 从接口获取', () => {
	const ENDPOINT_KEY = 'codecanvas.task-endpoint';
	const DEFAULT_ENDPOINT = 'http://localhost:8000/task';

	/** 假响应只带输入带用得到的几个成员，省得去凑一个完整的 Response。 */
	interface StubResponse {
		readonly ok: boolean;
		readonly status: number;
		readonly statusText: string;
		text(): Promise<string>;
	}

	const okBody = (body: string): StubResponse => ({
		ok: true,
		status: 200,
		statusText: 'OK',
		text: async () => body,
	});

	const httpError = (status: number, statusText: string): StubResponse => ({
		ok: false,
		status,
		statusText,
		text: async () => '',
	});

	/** handler 抛异常 = 网络层直接失败（连不上、DNS 挂了）。 */
	const stubFetch = (handler: (url: string) => Promise<StubResponse>): void => {
		vi.stubGlobal(
			'fetch',
			vi.fn((input: unknown) => handler(String(input))),
		);
	};

	/** 挂起中的请求：放行由测试自己决定，好在「进行中」那一刻做断言。 */
	const held: Array<(response: StubResponse) => void> = [];
	const stubPendingFetch = (): void => {
		held.length = 0;
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

	const endpointInput = (wrapper: ReturnType<typeof mount>) =>
		wrapper.get<HTMLInputElement>('[data-testid="task-endpoint-input"]');
	const fetchButton = (wrapper: ReturnType<typeof mount>) =>
		wrapper.get('[data-testid="task-fetch"]');
	const chainState = (wrapper: ReturnType<typeof mount>) =>
		wrapper.get('[data-testid="translation-chain-state"]');
	/** 亮了 / 正亮着（呼吸）/ 停在红灯上，各数一数就知道链路走到哪一段。 */
	const litNodes = (wrapper: ReturnType<typeof mount>) =>
		wrapper.findAll('[data-testid="translation-chain"] .chain-node.is-lit');
	const liveNodes = (wrapper: ReturnType<typeof mount>) =>
		wrapper.findAll('[data-testid="translation-chain"] .chain-node.is-live');
	const failedNodes = (wrapper: ReturnType<typeof mount>) =>
		wrapper.findAll('[data-testid="translation-chain"] .chain-node.is-failed');
	const diagnosticCodes = (wrapper: ReturnType<typeof mount>): string[] =>
		wrapper.findAll('[data-testid="task-input-diagnostic"]').map((row) => row.text());

	const setEndpoint = async (wrapper: ReturnType<typeof mount>, url: string): Promise<void> => {
		await endpointInput(wrapper).setValue(url);
		await nextTick();
	};

	const clickFetch = async (wrapper: ReturnType<typeof mount>): Promise<void> => {
		await fetchButton(wrapper).trigger('click');
		await flushPromises();
	};

	/** 跑完逐段点亮那 ~0.4s（但不越过成功后的 1.2s 停留）。 */
	const runReveal = async (): Promise<void> => {
		await vi.advanceTimersByTimeAsync(500);
		await nextTick();
	};

	beforeEach(() => {
		window.localStorage.clear();
		// 逐段点亮用的是真定时器；假掉它们，测试才不用真等 0.4s。
		// 只假 setTimeout，setImmediate 留着——@vue/test-utils 的 flushPromises 靠它。
		vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it('接口地址有像样的占位，填一次就记进 localStorage，重新挂载还在', async () => {
		const wrapper = mount(TaskInputBand);
		expect(endpointInput(wrapper).attributes('type')).toBe('url');
		expect(endpointInput(wrapper).attributes('placeholder')).toBe(DEFAULT_ENDPOINT);
		expect(endpointInput(wrapper).element.value).toBe(DEFAULT_ENDPOINT);

		await setEndpoint(wrapper, 'http://127.0.0.1:9001/task');
		expect(window.localStorage.getItem(ENDPOINT_KEY)).toBe('http://127.0.0.1:9001/task');

		// 「刷新」= 重新挂一个全新的组件：它只认 localStorage
		const remounted = mount(TaskInputBand);
		expect(endpointInput(remounted).element.value).toBe('http://127.0.0.1:9001/task');
	});

	it('取回一份可用的任务 → 换掉真相（三视图从真相派生），内容也落进输入框', async () => {
		stubFetch(async () => okBody(editedJson()));
		const wrapper = mount(TaskInputBand);
		const before = doc.declaration.value;

		await setEndpoint(wrapper, DEFAULT_ENDPOINT);
		await clickFetch(wrapper);
		await runReveal();

		expect(doc.declaration.value).not.toBe(before);
		expect(doc.declaration.value?.meta.description).toBe('换成新任务：先转再停');
		expect(doc.declaration.value?.nodes).toHaveLength(3);
		// 拿到的是什么，输入框里看得见
		expect(input(wrapper).element.value).toContain('换成新任务：先转再停');
		// 成功：链路全亮，标记写「已完成」
		expect(litNodes(wrapper)).toHaveLength(4);
		expect(chainState(wrapper).text()).toContain('已完成');
		expect(wrapper.find('[data-testid="task-input-feedback"]').exists()).toBe(false);
	});

	it('成功后全亮只停一小会儿：链路回常态，「已完成」标记留着（不许一直闪）', async () => {
		stubFetch(async () => okBody(editedJson()));
		const wrapper = mount(TaskInputBand);

		await setEndpoint(wrapper, DEFAULT_ENDPOINT);
		await clickFetch(wrapper);
		await runReveal();
		expect(litNodes(wrapper)).toHaveLength(4);

		await vi.advanceTimersByTimeAsync(2000);
		await nextTick();

		expect(litNodes(wrapper)).toHaveLength(0);
		expect(liveNodes(wrapper)).toHaveLength(0);
		expect(chainState(wrapper).text()).toContain('已完成');
	});

	it('请求还挂着的时候链路是「进行中」：亮着、在呼吸，按钮禁用', async () => {
		stubPendingFetch();
		const wrapper = mount(TaskInputBand);

		await setEndpoint(wrapper, DEFAULT_ENDPOINT);
		await clickFetch(wrapper);

		expect(liveNodes(wrapper)).toHaveLength(1);
		expect(chainState(wrapper).text()).toContain('获取中');
		expect(fetchButton(wrapper).attributes('disabled')).toBeDefined();

		// 放行，链路接着往下一段走
		releaseFetch(okBody(editedJson()));
		await flushPromises();
		await nextTick();
		expect(litNodes(wrapper)).toHaveLength(2);
	});

	it('地址连不上 → 输入区下方出网络失败诊断，真相一个字节都不动，链路停在第 1 段', async () => {
		const alert = vi.fn();
		vi.stubGlobal('alert', alert);
		stubFetch(async () => {
			throw new TypeError('Failed to fetch');
		});

		const wrapper = mount(TaskInputBand);
		const before = doc.declaration.value;

		await setEndpoint(wrapper, 'http://localhost:59999/task');
		await clickFetch(wrapper);

		expect(statusText(wrapper)).toContain('获取失败');
		const rows = diagnosticCodes(wrapper);
		expect(rows.some((text) => text.includes('task_input.fetch_failed'))).toBe(true);
		expect(rows.some((text) => text.includes('Failed to fetch'))).toBe(true);
		expect(doc.declaration.value).toBe(before);
		expect(doc.declaration.value?.nodes).toHaveLength(4);

		// 红灯停在第 1 段（任务 JSON 就没取到），后面三段没亮
		expect(failedNodes(wrapper)).toHaveLength(1);
		expect(litNodes(wrapper)).toHaveLength(0);
		expect(chainState(wrapper).text()).toContain('第 1 段');
		// 诊断是给人看的，alert 不是
		expect(alert).not.toHaveBeenCalled();
	});

	it('地址在但回 404 → 同一类网络失败诊断', async () => {
		stubFetch(async () => httpError(404, 'Not Found'));
		const wrapper = mount(TaskInputBand);
		const before = doc.declaration.value;

		await setEndpoint(wrapper, 'http://localhost:8000/nope');
		await clickFetch(wrapper);

		expect(statusText(wrapper)).toContain('获取失败');
		const rows = diagnosticCodes(wrapper);
		expect(rows.some((text) => text.includes('task_input.fetch_failed'))).toBe(true);
		expect(rows.some((text) => text.includes('404'))).toBe(true);
		expect(doc.declaration.value).toBe(before);
	});

	it('响应不是 JSON（比如一段 HTML 错误页）→ 解析诊断，原文照样落进输入框，真相不动', async () => {
		const html = '<html><body>502 Bad Gateway</body></html>';
		stubFetch(async () => okBody(html));
		const wrapper = mount(TaskInputBand);
		const before = doc.declaration.value;

		await setEndpoint(wrapper, DEFAULT_ENDPOINT);
		await clickFetch(wrapper);
		await runReveal();

		// 传输是通的（HTTP 200），坏在内容上——所以是「转换失败」，诊断码指出是解析那一条
		expect(statusText(wrapper)).toContain('转换失败');
		const rows = diagnosticCodes(wrapper);
		expect(rows.some((text) => text.includes('task_import.json_parse_error'))).toBe(true);
		// 拿到的是什么看得见——哪怕它根本不是 JSON
		expect(input(wrapper).element.value).toBe(html);
		expect(doc.declaration.value).toBe(before);
		// 文本都不是 JSON，「任务 JSON」这一段就没过
		expect(failedNodes(wrapper)).toHaveLength(1);
	});

	it('拉回一个非法任务（distance = 0）→ 校验诊断，真相不动，红灯停在第 2 段', async () => {
		stubFetch(async () => okBody(illegalJson()));
		const wrapper = mount(TaskInputBand);
		const before = doc.declaration.value;

		await setEndpoint(wrapper, DEFAULT_ENDPOINT);
		await clickFetch(wrapper);
		await runReveal();

		expect(statusText(wrapper)).toContain('转换失败');
		const rows = diagnosticCodes(wrapper);
		expect(rows.some((text) => text.includes('distance'))).toBe(true);
		expect(doc.declaration.value).toBe(before);
		expect(doc.declaration.value?.nodes).toHaveLength(4);

		// 任务 JSON 到手了（第 1 段是亮的），积木那一段没产出（红灯）
		expect(litNodes(wrapper)).toHaveLength(1);
		expect(failedNodes(wrapper)).toHaveLength(1);
		expect(chainState(wrapper).text()).toContain('第 2 段');
	});

	it('取回来的内容可以接着手改再转换——接口不是另一条独立的路径', async () => {
		stubFetch(async () => okBody(editedJson()));
		const wrapper = mount(TaskInputBand);

		await setEndpoint(wrapper, DEFAULT_ENDPOINT);
		await clickFetch(wrapper);
		await runReveal();

		const task = JSON.parse(input(wrapper).element.value) as Record<string, unknown>;
		task.description = '取回来又改过的描述';
		await paste(wrapper, JSON.stringify(task));
		await wrapper.get('[data-testid="task-convert"]').trigger('click');

		expect(doc.declaration.value?.meta.description).toBe('取回来又改过的描述');
		expect(statusText(wrapper)).toContain('已转换');
	});

	it('获取还没回来就手动转换 → 在途那次自己让位：不覆盖手动结果，也不把按钮锁死', async () => {
		stubPendingFetch();
		const wrapper = mount(TaskInputBand);

		await setEndpoint(wrapper, DEFAULT_ENDPOINT);
		await clickFetch(wrapper);
		expect(fetchButton(wrapper).attributes('disabled')).toBeDefined();

		// 等不及了，直接拿输入框里的示例任务转一次
		await wrapper.get('[data-testid="task-convert"]').trigger('click');
		expect(doc.declaration.value?.meta.description).toBe('前进，遇障停止后转向');

		// 在途那次最后回来了，但席位已经换人——它只能退场
		releaseFetch(okBody(editedJson()));
		await flushPromises();
		await runReveal();

		expect(doc.declaration.value?.meta.description).toBe('前进，遇障停止后转向');
		expect(input(wrapper).element.value).not.toContain('换成新任务：先转再停');
		expect(fetchButton(wrapper).attributes('disabled')).toBeUndefined();
	});
});
