// @vitest-environment happy-dom
/**
 * 流程画布：画的是一张**真流程图**（节点 + 箭头），而且是一笔一笔画出来的。
 *
 * 这一组守三件事：
 * 1. 图上有的东西都在 DOM 里可核对——节点带 `data-kind`、边带 `data-arm`、分支两条臂各有各的线；
 * 2. **铺开是有节奏的**：刚拿到规格时只有第一笔在，往后按拍子一格格出（拍子本身在
 *    `shell/step-playback.test.ts` 里用手动时钟验，这里验「视图确实只画已经放出来的那些」）；
 * 3. 画不出来时**不许**退回旧那套（从声明推的卡片链）顶上——那套已经不是屏幕上的真相了。
 */
import { mount, type VueWrapper } from '@vue/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import FlowView from './FlowView.vue';
import { runTeaching, useTeaching } from '../../state/teaching';
import { setSelectedDevice } from '../../shell/devices';
import { loadSampleTask } from '../../state/document';
import {
	loadTeachingFixture,
	sseForSpec,
	sseResponse,
	SINGLE_BLOCK_SPEC,
	TEACHING_SPEC_FIXTURE,
} from '../../state/__fixtures__/teaching-spec';

const teaching = useTeaching();
const realMatchMedia = window.matchMedia;

const stubMotion = (reduce: boolean): void => {
	Object.defineProperty(window, 'matchMedia', {
		configurable: true,
		writable: true,
		value: (query: string) => ({
			matches: reduce && query.includes('prefers-reduced-motion'),
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

/**
 * 画出来的节点数 = **看得见**的那些。
 *
 * 为什么不能直接数元素：铺开用的是 `v-show`（隐藏的块也留在 DOM 里，只是 `display:none`）
 * ——那是为了让已经画好的位置一个像素都不动。所以「画到第几笔」要按可见性数。
 */
const visibleCount = (wrapper: VueWrapper, testid: string): number =>
	wrapper
		.findAll(`[data-testid="${testid}"]`)
		.filter((element) => !(element.attributes('style') ?? '').includes('display: none')).length;

const wrappers: VueWrapper[] = [];
const mountView = (): VueWrapper => {
	const wrapper = mount(FlowView);
	wrappers.push(wrapper);
	return wrapper;
};

afterEach(() => {
	for (const wrapper of wrappers.splice(0)) wrapper.unmount();
	vi.unstubAllGlobals();
	Object.defineProperty(window, 'matchMedia', { configurable: true, writable: true, value: realMatchMedia });
});

describe('还没有规格时', () => {
	it('空状态说清楚这张图是什么、从哪来（不留空白，也不画一份推出来的链）', () => {
		stubMotion(true);
		const wrapper = mountView();
		expect(wrapper.find('[data-testid="flow-empty"]').exists()).toBe(true);
		expect(wrapper.find('[data-testid="flow-chart"]').exists()).toBe(false);
		expect(wrapper.text()).toContain('流程画布画的是一张真流程图');
	});
});

describe('规格到手之后', () => {
	beforeEach(async () => {
		stubMotion(true);
		await loadTeachingFixture();
	});

	it('节点与边都在：种类、分支臂、线上的字都对得上规格', () => {
		const wrapper = mountView();
		const nodes = wrapper.findAll('[data-testid="flow-node"]');
		const edges = wrapper.findAll('[data-testid="flow-edge"]');
		expect(nodes).toHaveLength(TEACHING_SPEC_FIXTURE.flow.nodes.length);
		expect(edges).toHaveLength(TEACHING_SPEC_FIXTURE.flow.edges.length);

		const kinds = nodes.map((node) => node.attributes('data-kind'));
		expect(kinds).toEqual(['start', 'action', 'decision', 'action', 'wait', 'end']);

		const arms = edges.map((edge) => edge.attributes('data-arm'));
		expect(arms).toContain('then');
		expect(arms).toContain('else');
		// 分支的两条臂在图上写着「看到了 / 否」——模型给的 label 用它，没给的那条按臂写。
		expect(wrapper.text()).toContain('看到了');
		expect(wrapper.text()).toContain('否');
	});

	it('连线是 SVG 路径（能做 dash 画出来的那种），不是 div', () => {
		const wrapper = mountView();
		const paths = wrapper.findAll('svg[data-testid="flow-chart"] path.flow-edge-line');
		expect(paths).toHaveLength(TEACHING_SPEC_FIXTURE.flow.edges.length);
		for (const path of paths) {
			expect(path.attributes('d')?.startsWith('M ')).toBe(true);
			// `pathLength=1` 是把长度归一化的那一手：dash 动画因此与线多长无关。
			expect(path.attributes('pathLength')).toBe('1');
		}
	});

	it('标题说的是这一份规格的名字', () => {
		const wrapper = mountView();
		expect(wrapper.get('[data-testid="flow-title"]').text()).toBe(TEACHING_SPEC_FIXTURE.title);
	});

	it('铺开：刚拿到时只有第一笔，拍子往后走才一格一格全出来', async () => {
		vi.unstubAllGlobals();
		vi.useFakeTimers();
		try {
			// 这一条要的是**节奏**，所以动效偏好不关（关掉是一次推满）。
			stubMotion(false);
			vi.stubGlobal(
				'fetch',
				vi.fn(async () => sseResponse(sseForSpec())),
			);
			setSelectedDevice('so101_sim');
			loadSampleTask();
			await runTeaching();

			const total = TEACHING_SPEC_FIXTURE.flow.nodes.length + TEACHING_SPEC_FIXTURE.flow.edges.length;
			// 第一格是立刻落的（队列空着时来的这一批），其余还在排队。
			expect(teaching.revealedFlowKeys.value.size).toBe(1);
			const wrapper = mountView();
			expect(visibleCount(wrapper, 'flow-node')).toBe(1);
			expect(visibleCount(wrapper, 'flow-edge')).toBe(0);

			vi.advanceTimersByTime(2000);
			await wrapper.vm.$nextTick();
			expect(visibleCount(wrapper, 'flow-node')).toBe(TEACHING_SPEC_FIXTURE.flow.nodes.length);
			expect(visibleCount(wrapper, 'flow-edge')).toBe(TEACHING_SPEC_FIXTURE.flow.edges.length);
			expect(teaching.revealedFlowKeys.value.size).toBe(total);
		} finally {
			vi.useRealTimers();
		}
	});
});

describe('画不出来时', () => {
	it('照实说，并把「哪儿不对」逐条摆出来；**不画**一份推出来的旧链顶上', async () => {
		stubMotion(true);
		vi.stubGlobal(
			'fetch',
			vi.fn(async () => sseResponse(sseForSpec(SINGLE_BLOCK_SPEC))),
		);
		await runTeaching();

		const wrapper = mountView();
		expect(wrapper.find('[data-testid="flow-failed"]').exists()).toBe(true);
		expect(wrapper.get('[data-testid="flow-failed-message"]').text()).toContain('模型没画出来');
		expect(wrapper.get('[data-testid="flow-failed-issues"]').text()).toContain('一块包全部');
		// 画布上什么都没有：没有图，也没有旧那套卡片。
		expect(wrapper.find('[data-testid="flow-chart"]').exists()).toBe(false);
		expect(wrapper.find('[data-testid="flow-canvas"]').exists()).toBe(false);
		expect(wrapper.find('[data-testid="flow-retry"]').exists()).toBe(true);
	});

	it('正在画：说出「正在画…」，画布上还没有东西', () => {
		stubMotion(true);
		let release: (() => void) | null = null;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		vi.stubGlobal(
			'fetch',
			vi.fn(async () => {
				await gate;
				return sseResponse(sseForSpec());
			}),
		);
		const wrapper = mountView();
		void runTeaching();

		return Promise.resolve()
			.then(() => wrapper.vm.$nextTick())
			.then(() => {
				expect(wrapper.find('[data-testid="flow-drawing"]').exists()).toBe(true);
				expect(wrapper.find('[data-testid="flow-chart"]').exists()).toBe(false);
				release?.();
			});
	});
});
