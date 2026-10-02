// @vitest-environment happy-dom
/**
 * 上层入口带的验收：这是本阶段唯一的入口。
 *
 * 入口是「选设备 + 说一句话 + 生成」——任务 JSON 不再摆在顶上当主位，
 * 它要么由生成接口（默认走 dev server 反代到 LLM 的 `/llm`）产出来，
 * 要么从折起来的兜底入口塞进来。这里守住五件事：
 *
 * 1. 形态：常态只有设备下拉 + 一句话 + 生成按钮，JSON 文本框与接口地址都折起来；
 * 2. 设备：下拉列出**登记在册的每一台**（值是 `deviceRef`），生成请求里带的是选中那台的
 *    `deviceRef` / `formatRef` / `catalogRef`——发给谁、按哪把尺子编、词汇表是哪一份；
 * 3. 生成：`POST { deviceRef, formatRef, catalogRef, instruction, ... }` → 拿回任务 JSON
 *    （信封或裸任务都认）→ 走**现有的** `loadTaskJson`；模型偶尔给坏东西时重试一次；
 * 4. 失败：网络 / HTTP 非 2xx / 响应非 JSON / JSON 不合协议，四类都出诊断、真相不动、不弹窗；
 * 5. 兜底：接口还没就绪时，折起来的那条粘贴路照样能把任务灌进来（拖入文件同一条路）。
 *
 * 「三个视图同屏刷新」这一条的完整版在真浏览器里跑（见交付报告），
 * 这里守的是它成立的前提：唯一入口 + 失败不动真相。
 */
import { flushPromises, mount } from '@vue/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { nextTick } from 'vue';
import { ROBOFRAME_SO101_CATALOG } from '@codecanvas/capabilities';
import { loadSampleTask, useStudioDocument } from '../state/document';
import { SAMPLE_SKILL_PLAN_JSON } from '../state/sample-skill-plan';
import { SAMPLE_TASK_JSON } from '../state/sample-task';
import TaskInputBand from './TaskInputBand.vue';
import { DEVICES, findDevice, setSelectedDevice } from './devices';
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

/**
 * 链块与它的徽标。
 *
 * 新形态下链块**只在「正在跑」与「跑失败」时露头**，而且里面只剩徽标那一行字——
 * 胶囊名单（任务 JSON / 积木 / 流程 / 代码）已经删掉，于是「逐段点亮」这类断言没有了观察对象；
 * 徽标报的是**结论**（生成中 / 失败停在第几段），不再报过程。
 */
const chainBlock = (wrapper: Wrapper) => wrapper.find('[data-testid="translation-chain"]');
const chainState = (wrapper: Wrapper) => wrapper.get('[data-testid="translation-chain-state"]');

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
	// 示例样例跟当前设备的格式走，所以先把设备切到一期那台，再灌一期那份。
	setSelectedDevice('phase1_robot');
	expect(loadSampleTask()).toBe(true);
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

	it('指令是「一句话」：一行高、占位就是图里那句例子', async () => {
		const wrapper = mount(TaskInputBand);
		const input = instructionInput(wrapper);

		// input 而不是 textarea：它不该再吃掉小半屏
		expect(input.element.tagName).toBe('INPUT');
		// 例子跟着设备格式走：一期那台听「前进1米」，SO-101 听技能话。
		expect(input.attributes('placeholder')).toBe('前进1米，避障后停止');
		setSelectedDevice('so101_robot');
		await nextTick();
		expect(input.attributes('placeholder')).toBe('看一眼桌面，再挥挥手打个招呼');
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
	it('列出登记在册的每一台设备：值是 deviceRef，显示的是设备名', () => {
		const wrapper = mount(TaskInputBand);
		const select = deviceSelect(wrapper);
		const options = wrapper.findAll('[data-testid="device-select"] option');

		expect(options).toHaveLength(DEVICES.length);
		// 顺序就是登记顺序，值与名一一对上（值与显示名不是同一个东西）
		expect(options.map((option) => option.attributes('value'))).toEqual(
			DEVICES.map((device) => device.deviceRef),
		);
		expect(options.map((option) => option.text())).toEqual(DEVICES.map((device) => device.label));
		// 下拉绑的是共享的选中设备：beforeEach 选了一期那台，这里就该是它
		expect(select.element.value).toBe('phase1_robot');
	});

	it('虚拟设备那条带仿真标记，真机那几条没有', () => {
		const wrapper = mount(TaskInputBand);
		const options = wrapper.findAll('[data-testid="device-select"] option');

		const virtual = DEVICES.filter((device) => device.virtual);
		expect(virtual.length).toBeGreaterThan(0);
		// 标记挂在**那一条**上，不是随手给所有选项都盖上
		const marked = options.filter((option) => option.attributes('data-virtual') === 'true');
		expect(marked.map((option) => option.attributes('value'))).toEqual(
			virtual.map((device) => device.deviceRef),
		);
		expect(options.filter((option) => option.attributes('data-virtual') === 'false')).toHaveLength(
			DEVICES.length - virtual.length,
		);
	});

	it('不在册的设备不认：换成一个查不到的 ref，选中的还是原来那台', async () => {
		const wrapper = mount(TaskInputBand);

		// 设备表外的 ref 是空操作——不许选中一个查不到的设备（那会让生成请求带上假 ref）
		setSelectedDevice('nonexistent_device');
		await nextTick();

		expect(deviceSelect(wrapper).element.value).toBe('phase1_robot');
		expect(wrapper.findAll('[data-testid="device-select"] option')).toHaveLength(DEVICES.length);
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
		/*
		 * 每条挂起用例从**自己这一批**开始记。`held` 是这一组共用的，不清空的话，
		 * 上一条用例没来得及放行的那次请求会留在里面——下一条用例 `releaseFetch` 时
		 * 它跟着被放行，那条**已经被丢掉的旧组件**就会往共享的 doc 里灌一份结果，
		 * 把这一条用例刚灌进去的东西盖掉（真发生过：失败表现在看起来毫不相干的地方）。
		 */
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

	const sentBody = (call: FetchCall): Record<string, unknown> =>
		JSON.parse(String(call.init?.body ?? '{}')) as Record<string, unknown>;

	const diagnosticTexts = (wrapper: Wrapper): string[] =>
		wrapper.findAll('[data-testid="task-input-diagnostic"]').map((row) => row.text());

	const clickGenerate = async (wrapper: Wrapper): Promise<void> => {
		await generateButton(wrapper).trigger('click');
		await flushPromises();
	};

	/** 推过生成落定前那段 ~0.4s 的等待（跨过它，但不到成功之后那次停留 1.2s）。 */
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

	it('生成请求打到 <地址>/chat/completions，体里带选中设备的 deviceRef / formatRef 与那一句话', async () => {
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
		// 设备那三件：发给谁、按哪把尺子编、词汇表是哪一份
		expect(body['deviceRef']).toBe(deviceSelect(wrapper).element.value);
		expect(body['deviceRef']).toBe('phase1_robot');
		expect(body['formatRef']).toBe('phase1_task');
		expect(body['catalogRef']).toBe(findDevice('phase1_robot')?.catalog.catalogRef);
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

		// 终态明确，但**不留状态线**：跑完了结果本身就在三个视图里，不必再摆一条链。
		// 「3 个节点」这条事实没丢——它挪到入口本体那行字上（`已生成 · N 个节点`）。
		expect(chainBlock(wrapper).exists()).toBe(false);
		expect(statusText(wrapper)).toContain('已生成');
		expect(statusText(wrapper)).toContain('3 个节点');
		expect(wrapper.find('[data-testid="task-input-feedback"]').exists()).toBe(false);
	});

	it('切到虚拟设备后，请求体里的 deviceRef / formatRef 跟着换（发给谁、按哪把尺子编）', async () => {
		// 这台设备说的是技能话：回的也是技能计划的样例，才是能收下的东西（同一份目录的技能名）
		stubFetch(async () => envelope(SAMPLE_SKILL_PLAN_JSON));
		setSelectedDevice('so101_sim');
		const wrapper = mount(TaskInputBand);

		await say(wrapper, '看一眼桌面再往前挪一点');
		await clickGenerate(wrapper);
		await runReveal();

		const body = sentBody(calls[0] as FetchCall);
		expect(body['deviceRef']).toBe('so101_sim');
		expect(body['formatRef']).toBe('skill_plan');
		expect(body['catalogRef']).toBe(ROBOFRAME_SO101_CATALOG.catalogRef);
		// 技能计划要写明编给哪台机器人（目录里的原名）
		expect(body['robot']).toBe(ROBOFRAME_SO101_CATALOG.robotName);

		// 同一份目录的技能名收得下：这一趟真的换掉了真相
		expect(statusText(wrapper)).toContain('已生成');
		expect(doc.declaration.value?.nodes.length).toBeGreaterThan(0);
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

	it('请求还挂着的时候链路是「进行中」：链块在、徽标说生成中，生成按钮禁用', async () => {
		stubPendingFetch();
		const wrapper = mount(TaskInputBand);

		await say(wrapper, '一句话');
		await clickGenerate(wrapper);

		// 只有请求还在飞这一段时间该有状态线——这正是链块留下来说的那一件事
		expect(chainBlock(wrapper).exists()).toBe(true);
		expect(chainState(wrapper).text()).toContain('生成中');
		expect(generateButton(wrapper).attributes('disabled')).toBeDefined();

		// 放行：结果落定，链块整块退场（不再是「回常态」，而是根本不留）
		releaseFetch(envelope(editedJson()));
		await flushPromises();
		await runReveal();
		await flushPromises();

		expect(chainBlock(wrapper).exists()).toBe(false);
		expect(statusText(wrapper)).toContain('已生成');
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

		// 红灯停在第 1 段（任务 JSON 就没生成出来）——失败那一条**留着**，
		// 它指出停在哪一段，底下紧跟着具体诊断（分了段的点亮已经没了，只报结论）
		expect(chainBlock(wrapper).exists()).toBe(true);
		expect(chainState(wrapper).text()).toContain('失败');
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
		// 响应层没拿到任务 JSON：和第 1 段那类失败同一个落点（红灯不在协议层）
		expect(chainBlock(wrapper).exists()).toBe(true);
		expect(chainState(wrapper).text()).toContain('第 1 段');
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

		// 停在第 2 段 = 任务 JSON 到手了、积木那一段没产出。
		// 「第 1 段是亮的」这种分段点亮已经没有观察对象了——徽标只报停在**哪一段**。
		expect(chainBlock(wrapper).exists()).toBe(true);
		expect(chainState(wrapper).text()).toContain('停在第 2 段');
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
		// 手工那一下已经把链块收到终态；在途那次回来也不许把它重新挂回屏幕上
		expect(chainBlock(wrapper).exists()).toBe(false);
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

/**
 * 链块（原「转译链」）现在是**一条只在「正在跑」或「跑失败」时露头的状态线**：
 * 名字还在，里面只剩徽标那一行字——四段胶囊的清单删了。
 *
 * 所以这里守的是新形态下真的还成立的两件事：静止时它**不存在**（标签不该常在），
 * 露头时它也只是读指示——不带任何控件，也不动真相。
 */
describe('入口带 · 转译链指示', () => {
	it('静止时不摆状态线；露头时也不冒充入口：不带按钮 / 输入框，也不改真相', async () => {
		const wrapper = mount(TaskInputBand);

		// 没跑过就是静止：链块不该存在（四个胶囊删掉之后，它就只剩「跑着/跑败」这两种出场理由）
		expect(chainBlock(wrapper).exists()).toBe(false);

		// 把请求挂住，让链块露头；这一刻真相还一个字节都没动
		vi.stubGlobal('fetch', vi.fn(() => new Promise<never>(() => undefined)));
		const before = doc.declaration.value;
		await say(wrapper, '一句话');
		await generateButton(wrapper).trigger('click');
		await flushPromises();

		const chain = chainBlock(wrapper);
		expect(chain.exists()).toBe(true);
		// 它是指示，不是第二个入口：按钮 / 输入 / 文本域 / 下拉一个都不许有
		expect(chain.findAll('button')).toHaveLength(0);
		expect(chain.findAll('input')).toHaveLength(0);
		expect(chain.findAll('textarea')).toHaveLength(0);
		expect(chain.findAll('select')).toHaveLength(0);
		expect(doc.declaration.value).toBe(before);
	});
});
