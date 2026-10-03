// @vitest-environment happy-dom
/**
 * 教学规格这一条线的状态机：**第二次调用**跑起来以后，三张画布各自拿到什么。
 *
 * 这一组守四件事：
 *
 * 1. **铺开序**：流程图从开始节点出发、节点先出边后；嵌套的块树深度优先、先父后子
 *    ——「一块块落进来」在嵌套的树上也成立；
 * 2. **一次成功的调用**：状态从 drawing 到 ready，规格进 `spec`，三条队列都拿到自己的序列；
 * 3. **失败不许静默**：形状不对要说清「哪儿不对」，传输坏了要说清是什么坏了，
 *    而且**不许**把上一份规格悄悄留着装作没事（`failure` 与 `spec` 是两个独立的事实）；
 * 4. **不碰声明**：跑完一轮，`store.declaration` 与它的 digest 一个字节都不变。
 *
 * 动效偏好在这组里被打成 `reduce`：于是三条队列一次推到满，断言不必等 130ms 的拍子
 * （拍子本身的行为由 `shell/step-playback.test.ts` 用手动时钟验）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { computeWorkflowDigest } from '@codecanvas/contracts';
import { loadSampleTask, useStudioDocument } from './document';
import { codeLinesOf, flowDrawOrder, runTeaching, useTeaching } from './teaching';
import { setSelectedDevice } from '../shell/devices';
import {
	SINGLE_BLOCK_SPEC,
	sseFrame,
	sseForSpec,
	sseResponse,
	SSE_DONE,
	TEACHING_SPEC_FIXTURE,
} from './__fixtures__/teaching-spec';

const doc = useStudioDocument();
const teaching = useTeaching();

const realMatchMedia = window.matchMedia;

/** 把动效偏好打成「关掉」：三条队列因此一次推满（见 `state/teaching.ts` 的 `prefersReducedMotion`）。 */
const stubReducedMotion = (): void => {
	Object.defineProperty(window, 'matchMedia', {
		configurable: true,
		writable: true,
		value: (query: string) => ({
			matches: query.includes('prefers-reduced-motion'),
			media: query,
			onchange: null,
			addEventListener: () => undefined,
			removeEventListener: () => undefined,
			addListener: () => undefined,
			removeListener: () => undefined,
			dispatchEvent: () => false,
		}),
	});
};

const stubFetch = (impl: (url: string, init?: RequestInit) => Promise<Response>): void => {
	vi.stubGlobal('fetch', vi.fn(impl));
};

beforeEach(() => {
	stubReducedMotion();
	setSelectedDevice('so101_sim');
	expect(loadSampleTask()).toBe(true);
});

afterEach(() => {
	vi.unstubAllGlobals();
	Object.defineProperty(window, 'matchMedia', { configurable: true, writable: true, value: realMatchMedia });
});

describe('流程图的铺开序', () => {
	it('从开始节点出发：节点先、它的出边随后', () => {
		const order = flowDrawOrder(TEACHING_SPEC_FIXTURE.flow);
		expect(order[0]?.key).toBe('node:start');
		expect(order[1]?.key).toBe('edge:start->observe:main');
		expect(order[2]?.key).toBe('node:observe');
	});

	it('一个分支的两条臂：「是」那一路先落，「否」那一路后落', () => {
		const order = flowDrawOrder(TEACHING_SPEC_FIXTURE.flow).map((item) => item.key);
		const thenEdge = order.indexOf('edge:seen->plan:then');
		const elseEdge = order.indexOf('edge:seen->again:else');
		expect(thenEdge).toBeGreaterThan(-1);
		expect(elseEdge).toBeGreaterThan(thenEdge);
	});

	it('走不到的节点也不会漏画：排在最后（宁可画在末尾，也不因为推不出顺序就少画一个）', () => {
		const graph = { ...TEACHING_SPEC_FIXTURE.flow, edges: [] };
		const order = flowDrawOrder(graph);
		expect(order.filter((item) => item.kind === 'node')).toHaveLength(graph.nodes.length);
	});
});

describe('跑一轮第二次调用', () => {
	it('成功：状态 ready、规格进 store、三条队列都铺满（动效关掉时一次到位）', async () => {
		stubFetch(async () => sseResponse(sseForSpec()));

		await runTeaching();

		expect(teaching.status.value).toBe('ready');
		expect(teaching.failure.value).toBeNull();
		expect(teaching.spec.value?.title).toBe(TEACHING_SPEC_FIXTURE.title);
		// 三条队列各自铺满：节点 + 边、块树（含值块）、代码行。
		expect(teaching.revealedFlowKeys.value.size).toBe(
			TEACHING_SPEC_FIXTURE.flow.nodes.length + TEACHING_SPEC_FIXTURE.flow.edges.length,
		);
		expect(teaching.revealedBlockItems.value.length).toBeGreaterThan(TEACHING_SPEC_FIXTURE.blocks.length);
		// 行序与视图同一处口径（`codeLinesOf`）：末尾的空行不算一格。
		expect(teaching.revealedCodeLines.value).toEqual(codeLinesOf(TEACHING_SPEC_FIXTURE.code));
	});

	it('跑一轮不动声明：digest 与节点一个字节都不变（教学不是命令）', async () => {
		const before = doc.declaration.value;
		expect(before).not.toBeNull();
		const digestBefore = before === null ? '' : computeWorkflowDigest(before);
		stubFetch(async () => sseResponse(sseForSpec()));

		await runTeaching();

		expect(doc.declaration.value).toEqual(before);
		expect(doc.declaration.value?.digest).toBe(before?.digest);
		expect(digestBefore).toBe(before?.digest);
	});

	it('形状不对：说出「哪儿不对」，并且不把这份规格当成画好了', async () => {
		stubFetch(async () => sseResponse(sseForSpec(SINGLE_BLOCK_SPEC)));

		await runTeaching();

		expect(teaching.status.value).toBe('failed');
		expect(teaching.spec.value).toBeNull();
		expect(teaching.failure.value?.issues.join('\n')).toContain('一块包全部');
	});

	it('第一次形状不对、第二次对了：重试一次就成（判据是整段说完了才看）', async () => {
		let call = 0;
		stubFetch(async () => {
			call += 1;
			return sseResponse(call === 1 ? sseForSpec(SINGLE_BLOCK_SPEC) : sseForSpec());
		});

		await runTeaching();

		expect(call).toBe(2);
		expect(teaching.status.value).toBe('ready');
		expect(teaching.attempt.value).toBe(2);
	});

	it('接口坏了：照实说是传输层坏了，并把已经收到的原文留着', async () => {
		stubFetch(async () => ({ ok: false, status: 502, statusText: 'Bad Gateway' }) as unknown as Response);

		await runTeaching();

		expect(teaching.status.value).toBe('failed');
		expect(teaching.failure.value?.message).toContain('502');
		expect(teaching.failure.value?.text).toBeNull();
	});

	it('流读一半断了：已经收到的部分要留着（拿到过什么就让人看得见）', async () => {
		stubFetch(async () => sseResponse(`${sseFrame('{"version":1,"title":"半截')}`));

		await runTeaching();

		expect(teaching.status.value).toBe('failed');
		expect(teaching.failure.value?.text).toContain('半截');
	});

	it('没有声明时不发请求，状态回到 idle（材料都凑不齐，发出去只会得到一份编的）', async () => {
		const fetchSpy = vi.fn();
		vi.stubGlobal('fetch', fetchSpy);
		// 把声明清掉：这一条量的是「凑不齐材料就什么都不做」。
		const declaration = doc.declaration.value;
		doc.declaration.value = null;

		await runTeaching();

		expect(fetchSpy).not.toHaveBeenCalled();
		expect(teaching.status.value).toBe('idle');

		doc.declaration.value = declaration;
	});

	it('状态是独立的两个事实：失败之后再成功一次，failure 要清掉', async () => {
		stubFetch(async () => sseResponse(sseForSpec(SINGLE_BLOCK_SPEC)));
		await runTeaching();
		expect(teaching.failure.value).not.toBeNull();

		stubFetch(async () => sseResponse(sseForSpec()));
		await runTeaching();
		expect(teaching.status.value).toBe('ready');
		expect(teaching.failure.value).toBeNull();
	});

	it('带 [DONE] 的整段流：解析出来的就是最后一版（哨兵不参与内容）', async () => {
		stubFetch(async () => sseResponse(`${sseFrame('{"version":1,')}${sseFrame('"title":"看一眼桌面",')}${SSE_DONE}`));
		await runTeaching();
		// 半截 JSON 自然是失败的——这一条要的是「失败也要有说法」，不是「半截能拼出来」。
		expect(teaching.status.value).toBe('failed');
		expect(teaching.failure.value?.message).toContain('不是 JSON');
	});
});
