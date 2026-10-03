// @vitest-environment happy-dom
/**
 * 流式那一路在**界面上**的验收：入口带的原始文本、流程画布的幽灵卡、定稿那一刻的切换。
 *
 * 这一组守的是三条边界（它们是这一版全部的风险所在）：
 *
 * 1. **原始文本与状态行是两件事**：一个说"我收到了什么"，一个说"我在干什么"，两句都要在；
 * 2. **幽灵卡不是真相**：生成途中画的是半成品（虚线 + 「未校验」），而 `store.declaration`
 *    与它的 digest 全程一个字节都不动——任务 JSON 面板那几行也必须还是**上一份定稿**；
 * 3. **切换是一次**：定稿一到（或失败一来），幽灵态整块消失，不逐块替换、不留残影。
 *
 * ## 这一组的流为什么要"握手"
 *
 * `ReadableStream` 的每一块什么时候到读者手上，不由推的人说了算（水位线是 1，满了
 * `enqueue` 会抛；`close()` 又会把还没被拿走的块丢掉）。第一版夹具在这里反复栽跟头：
 * "我推了三块"与"读者已经吃到三块"之间差着几轮微任务与一次拉取，于是断言看到的永远是
 * 上一块那一刻的样子，而失败信息看着像被测代码漏读。
 *
 * 所以这里的夹具**每写一块都等读者认领**（把 `getReader()` 包一层，`read()` 落定就放行
 * 写的那一侧）。于是"生成途中"是一个真的停得住的状态：写一块、断言一次，顺序由测试说了算。
 */
import { flushPromises, mount } from '@vue/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { computeWorkflowDigest } from '@codecanvas/contracts';
import { loadSampleTask, useStudioDocument } from '../state/document';
import { SAMPLE_SKILL_PLAN_JSON } from '../state/sample-skill-plan';
import TaskJsonPanel from '../views/right/task-json/TaskJsonPanel.vue';
import FlowView from '../views/flow/FlowView.vue';
import TaskInputBand from './TaskInputBand.vue';
import { setSelectedDevice } from './devices';
import { provisionalGenerating } from './provisional-declaration';

const doc = useStudioDocument();

/** 一段 `delta.content` → SSE 的一行。 */
const frame = (delta: string): string =>
	`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: delta } }] })}\n\n`;

const DONE = 'data: [DONE]\n\n';

type Wrapper = ReturnType<typeof mount>;

/** 手的另一头：写一块、等读者认领，再写下一块。 */
interface Hand {
	readonly response: Response;
	write(chunk: string): Promise<void>;
	finish(): void;
	breaker(error: Error): void;
}

const linkedHand = (): Hand => {
	const encoder = new TextEncoder();
	/** 写的那一侧在等"这一块被领走"时挂在这里。 */
	const pending: Array<() => void> = [];
	let controller: ReadableStreamDefaultController<Uint8Array> | null = null;
	let finished = false;

	const body = new ReadableStream<Uint8Array>({
		start(inner) {
			controller = inner;
		},
	});

	/** 每读一块就把写的那一侧叫醒（认领）。 */
	const response = {
		ok: true,
		status: 200,
		statusText: 'OK',
		body: {
			getReader: () => {
				const reader = body.getReader();
				return {
					read: async () => {
						const step = await reader.read();
						const resolve = pending.shift();
						resolve?.();
						return step;
					},
					cancel: async () => reader.cancel(),
					releaseLock: () => reader.releaseLock(),
				};
			},
		},
	} as unknown as Response;

	return {
		response,
		write: (chunk: string) =>
			new Promise<void>((resolve) => {
				if (finished || controller === null) {
					resolve();
					return;
				}
				pending.push(resolve);
				try {
					controller.enqueue(encoder.encode(chunk));
				} catch {
					// 读者已经取消（看到 `[DONE]` 就走了）：这一块没人收，直接放行
					const wake = pending.shift();
					wake?.();
				}
			}),
		finish: () => {
			if (finished) return;
			finished = true;
			// 还挂在等认领的那几块不会再有人认领了（流要关了）：先放行，免得测试悬着
			for (const resolve of pending.splice(0)) resolve();
			try {
				controller?.close();
			} catch {
				// 已经关了/被取消了
			}
		},
		breaker: (error: Error) => {
			if (finished) return;
			finished = true;
			for (const resolve of pending.splice(0)) resolve();
			try {
				controller?.error(error);
			} catch {
				// 同上
			}
		},
	};
};

/** 等所有排着队的微任务跑完。 */
const settle = async (): Promise<void> => {
	for (let round = 0; round < 8; round += 1) await flushPromises();
};

/**
 * 等「重试那一次」发出来。
 *
 * 两层之间真等 `RETRY_DELAY_MS`（200ms），而那一等是 `setTimeout`——微任务推不动它，
 * 只能真等一小会儿。只在这一处等，别的断言都走 `settle`。
 */
const waitForRetry = async (): Promise<void> => {
	for (let round = 0; round < 40; round += 1) {
		await new Promise((resolve) => setTimeout(resolve, 25));
		await settle();
		if (handCount() >= 2) return;
	}
};

/** 由各条用例自己覆盖：数一数一共发出去几次请求。 */
let handCount = (): number => 0;

/**
 * 等某个条件成立（用在"要等重试跑完"的地方）。
 *
 * 为什么不用固定睡一觉：两层之间那次等待（`RETRY_DELAY_MS`）之后还有一串微任务，
 * 固定睡 260ms 在一台机器上够、在另一台上可能刚好差一点；这一组里"最终落点"本来就是
 * 一个会稳定下来的状态，等它出现比猜时间稳。
 */
const waitUntil = async (condition: () => boolean, label: string): Promise<void> => {
	for (let round = 0; round < 60; round += 1) {
		if (condition()) return;
		await new Promise((resolve) => setTimeout(resolve, 25));
		await settle();
	}
	throw new Error(`等不到：${label}`);
};

const totalNodesOf = (): number => doc.declaration.value?.nodes.length ?? -1;

/** 当前真相的指纹：digest 的算法再走一遍，能对出"一个字节都没变"。 */
const truthFingerprint = (): string => {
	const declaration = doc.declaration.value;
	if (declaration === null) return 'null';
	return `${declaration.digest}|${computeWorkflowDigest(declaration)}`;
};

const rawRow = (wrapper: Wrapper) => wrapper.find('[data-testid="task-raw-stream"]');
const rawText = (wrapper: Wrapper): string => wrapper.find('[data-testid="task-raw-text"]').text();
const ghostCards = (wrapper: Wrapper) =>
	wrapper.findAll('[data-testid="flow-node-card"][data-provisional="true"]');

const say = async (wrapper: Wrapper, text: string): Promise<void> => {
	await wrapper.get<HTMLInputElement>('[data-testid="instruction-input"]').setValue(text);
};

const generate = async (wrapper: Wrapper): Promise<void> => {
	await wrapper.get('[data-testid="task-generate"]').trigger('click');
	await settle();
};

beforeEach(() => {
	// 技能计划那条路才有半成品解析（幽灵卡），设备与样例都要跟着切过去。
	setSelectedDevice('so101_sim');
	expect(loadSampleTask()).toBe(true);
});

afterEach(async () => {
	/*
	 * 给在途的收尾留一点时间再放掉全局 fetch。
	 *
	 * 这一版**默认重试一次**，而重试之间真等 200ms：上一条用例没跑完的 async 链会跨到
	 * 下一条里，用**新**的 fetch 再发一次请求——于是下一条的"一共发了几次"就被污染了。
	 * 这不是被测代码的毛病，是用例之间共享模块级状态（store / 临时预览）的必然。
	 */
	await new Promise((resolve) => setTimeout(resolve, 260));
	vi.unstubAllGlobals();
});

describe('生成途中 · 入口带的原始文本', () => {
	it('那一行在生成中出现、写着「正在生成，尚未校验」，内容是**此刻**收到的原文', async () => {
		const stream = linkedHand();
		vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(stream.response)));
		const wrapper = mount(TaskInputBand);

		expect(rawRow(wrapper).exists()).toBe(false);

		await say(wrapper, '看一眼桌面');
		await generate(wrapper);

		// 半截：`plan` 还没出现，幽灵卡一张都没有——但有原文，这一行就该在
		await stream.write(frame('{"schemaVersion":1,"robot":"so101_sing'));
		await settle();

		expect(rawRow(wrapper).exists()).toBe(true);
		expect(rawRow(wrapper).text()).toContain('正在生成，尚未校验');
		expect(rawText(wrapper)).toBe('{"schemaVersion":1,"robot":"so101_sing');
		// 状态行那句「生成中…」也在：一个说我在干什么，一个说我收到了什么
		expect(wrapper.get('[data-testid="translation-chain-state"]').text()).toContain('生成中');
		// 这一刻真相没动（"尚未校验"不是说着好听的）
		expect(totalNodesOf()).toBe(3);

		// 收尾给的是一份**能过校验**的计划（目录里的真技能名），这一趟才真的落定
		await stream.write(
			frame('le_arm","description":"看一眼桌面","plan":[{"step":"skill","skill":"inspect_scene"}]}'),
		);
		await stream.write(DONE);
		stream.finish();
		await settle();

		// 定稿之后这一行整块退场（它的东西已经变成三个视图里的结果了）
		expect(rawRow(wrapper).exists()).toBe(false);
		expect(wrapper.get('[data-testid="task-input-status"]').text()).toContain('已生成');
	});
});

describe('生成途中 · 流程画布上的幽灵卡', () => {
	it('步骤一闭合就长出幽灵卡：虚线标记 + 「未校验」，且它**不是**真相', async () => {
		const stream = linkedHand();
		vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(stream.response)));
		const band = mount(TaskInputBand);
		const flow = mount(FlowView, { attachTo: document.body });
		const json = mount(TaskJsonPanel);

		const before = truthFingerprint();
		const beforeNodes = totalNodesOf();
		// 上一份定稿在 JSON 面板上的样子（生成途中它必须一个字都不变）
		const jsonBefore = json.get('[data-testid="task-json-scroll"]').text();
		expect(jsonBefore).toContain('so101_single_arm');

		await say(band, '看一眼桌面');
		await generate(band);

		// 先给骨架（还没有步骤）
		await stream.write(
			frame('{"schemaVersion":1,"robot":"so101_single_arm","description":"看一眼桌面","plan":['),
		);
		await settle();
		expect(ghostCards(flow)).toHaveLength(0);
		expect(truthFingerprint()).toBe(before);

		// 第一个步骤闭合 → 第一张幽灵卡
		await stream.write(frame('{"step":"skill","skill":"inspect_scene"}'));
		await settle();
		expect(ghostCards(flow)).toHaveLength(1);
		expect(ghostCards(flow)[0]?.text()).toContain('未校验');
		expect(ghostCards(flow)[0]?.text()).toContain('inspect_scene');
		// 整块也有标记与那行字
		expect(flow.get('[data-testid="flow-provisional"]').attributes('data-provisional')).toBe('true');

		// 真相一个字节没动：digest 与节点数都不变，JSON 面板还是上一份定稿
		expect(truthFingerprint()).toBe(before);
		expect(totalNodesOf()).toBe(beforeNodes);
		expect(json.get('[data-testid="task-json-scroll"]').text()).toBe(jsonBefore);

		// 再来一步：幽灵卡跟着长出来（这是"随步骤长出来"那一条）
		await stream.write(frame(',{"step":"wait","seconds":2}'));
		await settle();
		expect(ghostCards(flow)).toHaveLength(2);
		expect(totalNodesOf()).toBe(beforeNodes);

		// 定稿：整块换掉，幽灵态一张不剩，真相换成新的
		await stream.write(frame(']}'));
		await stream.write(DONE);
		stream.finish();
		await settle();

		expect(ghostCards(flow)).toHaveLength(0);
		expect(flow.find('[data-testid="flow-provisional"]').exists()).toBe(false);
		expect(totalNodesOf()).toBe(2);
		expect(truthFingerprint()).not.toBe(before);
		// 定稿卡上没有任何"未校验"的字
		expect(flow.get('[data-testid="flow-canvas"]').text()).not.toContain('未校验');

		json.unmount();
		flow.unmount();
	});

	it('半成品有非法内容也照画（这一步不校验）：查不到的技能照样是一张幽灵卡', async () => {
		const stream = linkedHand();
		vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(stream.response)));
		const band = mount(TaskInputBand);
		const flow = mount(FlowView, { attachTo: document.body });
		const before = truthFingerprint();

		await say(band, '一句话');
		await generate(band);

		await stream.write(
			frame('{"schemaVersion":1,"robot":"so101_single_arm","plan":[{"step":"skill","skill":"目录里没有的技能"}]'),
		);
		await settle();

		expect(ghostCards(flow)).toHaveLength(1);
		expect(ghostCards(flow)[0]?.text()).toContain('目录里没有的技能');
		// 校验真没发生：非法内容既没被拦、也没改真相
		expect(truthFingerprint()).toBe(before);

		await stream.write(frame(']}'));
		await stream.write(DONE);
		stream.finish();
		await settle();

		flow.unmount();
	});
});

describe('失败路径 · 幽灵态清掉、真相不动、诊断照旧', () => {
	it('流读一半断了：诊断出来、幽灵态消失、声明与 digest 一个字节不变', async () => {
		/*
		 * 每次 fetch 都发一只**新的**手。
		 *
		 * 为什么不能共用：流读过就废了，而这一层默认重试一次。复用同一只的话，
		 * 第二次尝试拿到的是一个已经用完的流——那报的错是"流用完了"，不是这条测试想验的
		 * "网络断了"，诊断看着对、含义却错。
		 */
		const hands: Hand[] = [];
		handCount = () => hands.length;
		vi.stubGlobal(
			'fetch',
			vi.fn(() => {
				const stream = linkedHand();
				hands.push(stream);
				return Promise.resolve(stream.response);
			}),
		);
		const band = mount(TaskInputBand);
		const flow = mount(FlowView, { attachTo: document.body });
		const before = truthFingerprint();
		const beforeNodes = totalNodesOf();

		await say(band, '一句话');
		await generate(band);

		const first = hands[0];
		if (first === undefined) throw new Error('第一次请求没发出去');
		await first.write(
			frame('{"schemaVersion":1,"robot":"so101_single_arm","plan":[{"step":"skill","skill":"inspect_scene"}]'),
		);
		await settle();
		expect(ghostCards(flow)).toHaveLength(1);

		// 断了：这一次读到的内容本身是合法的，但流"没说完就说不了了"
		first.breaker(new TypeError('network error'));
		await waitForRetry();
		expect(hands.length).toBe(2);
		const second = hands[1];
		if (second === undefined) throw new Error('重试那次请求没发出去');
		second.breaker(new TypeError('network error'));
		await settle();

		// 幽灵态清掉，回到上一份定稿
		expect(ghostCards(flow)).toHaveLength(0);
		expect(flow.find('[data-testid="flow-provisional"]').exists()).toBe(false);
		expect(rawRow(band).exists()).toBe(false);
		expect(truthFingerprint()).toBe(before);
		expect(totalNodesOf()).toBe(beforeNodes);

		// 诊断照旧（传输层那一条）
		const diagnostics = band.findAll('[data-testid="task-input-diagnostic"]').map((row) => row.text());
		expect(diagnostics.some((text) => text.includes('task_input.generate_failed'))).toBe(true);
		expect(band.get('[data-testid="task-input-status"]').text()).toContain('生成失败');

		// 已经收到的部分落进兜底框（失败原文看得见）。交出的是**正文**（信封里那一段），
		// 不是整个 SSE 响应体——与非流式那条路同一个口径。
		await band.get('[data-testid="task-paste-toggle"]').trigger('click');
		const salvaged = band.get<HTMLTextAreaElement>('[data-testid="task-json-input"]').element.value;
		expect(salvaged).toContain('inspect_scene');
		expect(salvaged.startsWith('{"schemaVersion"')).toBe(true);

		// 两个都要拆：留着挂载的组件会在下一条用例里继续跑（它的 async 链还没结束）
		band.unmount();
		flow.unmount();
	});

	it('HTTP 502：没有原文可交，幽灵态从没长出来，诊断说清是 502', async () => {
		vi.stubGlobal(
			'fetch',
			vi.fn(() =>
				Promise.resolve({
					ok: false,
					status: 502,
					statusText: 'Bad Gateway',
					text: async () => '',
				} as unknown as Response),
			),
		);
		const band = mount(TaskInputBand);
		const flow = mount(FlowView, { attachTo: document.body });
		const before = truthFingerprint();

		await say(band, '一句话');
		await generate(band);
		// 诊断要等两次都坏掉才出（两层之间真等 200ms）：等它出现，不猜时间
		await waitUntil(
			() => band.findAll('[data-testid="task-input-diagnostic"]').length > 0,
			'失败诊断出来',
		);

		expect(ghostCards(flow)).toHaveLength(0);
		expect(truthFingerprint()).toBe(before);
		const diagnostics = band.findAll('[data-testid="task-input-diagnostic"]').map((row) => row.text());
		expect(diagnostics.some((text) => text.includes('502'))).toBe(true);

		band.unmount();
		flow.unmount();
	});
});

describe('入口带的兜底：粘贴一份 JSON 时幽灵态立刻退场', () => {
	it('手工灌一份就不要再画在途那次的幽灵卡', async () => {
		const stream = linkedHand();
		vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(stream.response)));
		const band = mount(TaskInputBand);
		const flow = mount(FlowView, { attachTo: document.body });

		await say(band, '一句话');
		await generate(band);
		await stream.write(
			frame('{"schemaVersion":1,"robot":"so101_single_arm","plan":[{"step":"skill","skill":"inspect_scene"}]'),
		);
		await settle();
		expect(ghostCards(flow)).toHaveLength(1);

		await band.get('[data-testid="task-paste-toggle"]').trigger('click');
		await band.get<HTMLTextAreaElement>('[data-testid="task-json-input"]').setValue(SAMPLE_SKILL_PLAN_JSON);
		await band.get('[data-testid="task-convert"]').trigger('click');
		await settle();

		expect(ghostCards(flow)).toHaveLength(0);
		// 手工那份进了真相（3 步）
		expect(totalNodesOf()).toBe(3);
		expect(provisionalGenerating.value).toBe(false);

		band.unmount();
		flow.unmount();
	});
});
