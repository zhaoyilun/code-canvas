// @vitest-environment happy-dom
/**
 * 动线的**接线**验收：`runningPlanPath` 一变，属于那一步的线进 `is-flowing`，别的线不进；
 * 清掉之后没有一条线还在跑，刚下来的那一条停在 `is-settled`。
 *
 * 为什么挂在组件上量而不是只在 `run-trace.test.ts` 里量纯函数：
 * 「哪条线」是拿 `nodeId` 认的，而 `nodeId` 是量出来的（`measure.ts`），
 * 中间还夹着 `nodeAtPlanPath` 那一步路径换算。这里把整条链一起钉住。
 *
 * 三件在 happy-dom 里必须自己搭的事，都不是被测对象的性质：
 *   1. **没有排版**：`getBoundingClientRect()` 一律全 0，所以框得逐个桩上去
 *      （`measure()` 见到 0 尺寸就什么都不做——那是对的，不该为它改实现）；
 *   2. **rAF 是异步的**：探测那一轮要能确定地跑完，于是把 `requestAnimationFrame`
 *      换成一个手动队列，`flushFrames()` 想跑几帧跑几帧；
 *   3. **`matchMedia`**：`prefers-reduced-motion` 那条要打桩才谈得上「降级成静态」。
 *
 * 量几何那一套（端点误差、坐标系换算）不在这里——那是 `mapping.test.ts` 的事，
 * 这一版动线**没有碰它一个数**：光的 `<path>` 与线共用同一个 `d`，下面有一条断言钉着。
 */
import { mount } from '@vue/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearRunningPlanPath, setRunningPlanPath } from '../../shell/device-run';
import { setSelectedDevice } from '../../shell/devices';
import { useStudioDocument } from '../../state/document';
import LinkOverlay from './LinkOverlay.vue';
import { BLOCK_SELECTOR, CARD_SELECTOR, CODE_LINE_SELECTOR } from './measure';
import { BRANCH_PLAN_JSON } from '../flow/__fixtures__/branch-plan';

const store = useStudioDocument();

/** 造一个假矩形（`DOMRect` 的样子，但不用 `new DOMRect`——happy-dom 没实现它的构造器）。 */
const rect = (left: number, top: number, width: number, height: number): DOMRect =>
	({
		x: left,
		y: top,
		left,
		top,
		right: left + width,
		bottom: top + height,
		width,
		height,
		toJSON: () => ({}),
	}) as DOMRect;

/** rAF 手动队列：想跑几帧就跑几帧，不靠真时间。 */
let frames: FrameRequestCallback[] = [];

const flushFrames = (count = 3): void => {
	for (let i = 0; i < count; i++) {
		const pending = frames;
		frames = [];
		for (const callback of pending) callback(0);
	}
};

/** `prefers-reduced-motion` 打桩：`matches` 只对那一条查询为真。 */
const stubMotion = (reduce: boolean): void => {
	const list = (query: string) => ({
		matches: reduce && query.includes('prefers-reduced-motion'),
		media: query,
		onchange: null,
		addEventListener: () => undefined,
		removeEventListener: () => undefined,
		addListener: () => undefined,
		removeListener: () => undefined,
		dispatchEvent: () => false,
	});
	// 打在 `window` 上而不是 `globalThis` 上：组件问的是 `window.matchMedia`。
	Object.defineProperty(window, 'matchMedia', { configurable: true, writable: true, value: list });
};

interface Harness {
	readonly wrapper: ReturnType<typeof mount>;
	/** overlay 的父元素——真实外壳里它是工作区，三栏与 overlay 是**兄弟**。 */
	readonly workspace: HTMLElement;
	/** 量过一轮之后的覆盖层（`links` 已经填上）。 */
	readonly overlay: Element;
}

/**
 * 搭一份最简工作区：三处锚点各来一遍（节点数与声明一致）。
 * 尺寸照 `mapping.test.ts` 那一套给，三处各占一行，于是每步两段线。
 */
const harness = async (reduce = false): Promise<Harness> => {
	stubMotion(reduce);
	const host = document.createElement('div');
	host.className = 'workspace';
	document.body.append(host);

	const wrapper = mount(LinkOverlay, { attachTo: host });
	const overlay = wrapper.get('[data-testid="mapping-overlay"]').element;
	// ⚠ 锚点必须挂在 **overlay 的父元素** 下：`measureLinks` 的查找范围是它
	// （`overlay.querySelectorAll` 找不到兄弟节点——真实外壳里三栏正是 overlay 的兄弟）。
	const workspace = overlay.parentElement;
	if (workspace === null) throw new Error('overlay 没有父元素，量不出锚点');

	const nodes = store.declaration.value?.nodes ?? [];
	nodes.forEach((node, index) => {
		const block = document.createElementNS('http://www.w3.org/2000/svg', 'g');
		block.setAttribute('class', 'blocklyDraggable');
		block.setAttribute('data-node-id', node.id);
		block.getBoundingClientRect = () => rect(180, 300 + index * 60, 240, 46);
		workspace.append(block);

		const card = document.createElement('article');
		card.setAttribute('data-testid', 'flow-node-card');
		card.setAttribute('data-node-id', node.id);
		card.getBoundingClientRect = () => rect(510, 280 + index * 80, 240, 120);
		workspace.append(card);

		const line = document.createElement('li');
		line.className = 'cp-line';
		line.setAttribute('data-node-id', node.id);
		line.getBoundingClientRect = () => rect(961, 300 + index * 40, 300, 22);
		workspace.append(line);
	});

	// overlay 的框必须显式给：`position: absolute` 在 happy-dom 里找不到 offsetParent，量出来是全 0。
	overlay.getBoundingClientRect = () => rect(0, 140, 1280, 620);
	flushFrames();
	// 量完只是把 `links` 换了，DOM 要等 Vue 这一轮渲染落定才看得到。
	await wrapper.vm.$nextTick();
	return { wrapper, workspace, overlay };
};

/** 某一步、某一段线（`block` = 积木→卡片，`card` = 卡片→代码行）。 */
const linkOf = (wrapper: ReturnType<typeof mount>, nodeId: string, kind: 'block' | 'card') => {
	const found = wrapper
		.findAll('.cc-link')
		.find((link) => link.attributes('data-node-id') === nodeId && link.attributes('data-link-kind') === kind);
	if (found === undefined) throw new Error(`没找到 ${nodeId} 的 ${kind} 段线`);
	return found;
};

const phasesOf = (wrapper: ReturnType<typeof mount>): string[] =>
	wrapper.findAll('.cc-link').map((link) => link.attributes('data-run-state') ?? '');

const nodeIdAt = (index: number): string => store.declaration.value?.nodes[index]?.id ?? '';

beforeEach(() => {
	// 这份素材说的是技能话；先站到那台设备上，格式与目录才是对的。
	setSelectedDevice('so101_robot');
	expect(store.loadTaskJson(BRANCH_PLAN_JSON)).toBe(true);
	clearRunningPlanPath();

	frames = [];
	vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
		frames.push(callback);
		return frames.length;
	});
	vi.stubGlobal('cancelAnimationFrame', () => undefined);
	document.body.replaceChildren();
});

afterEach(() => {
	// 这个 ref 是模块级的（跨用例活着的），用完必须清掉，否则下一个用例开局就带着标记。
	clearRunningPlanPath();
	vi.unstubAllGlobals();
	document.body.replaceChildren();
});

describe('动线 · 由 runningPlanPath 驱动', () => {
	it('没在跑的时候：一条线都不带「在跑」，全部是常态', async () => {
		const { wrapper } = await harness();

		// 五个节点、每步两段线（积木→卡片、卡片→代码行）
		expect(wrapper.findAll('.cc-link')).toHaveLength(10);
		expect(phasesOf(wrapper).every((phase) => phase === 'idle')).toBe(true);
		expect(wrapper.findAll('.cc-link.is-flowing')).toHaveLength(0);
	});

	it('给一条路径（臂里那一步）→ 只有那一步的两段线在跑，别的线一格都不动', async () => {
		const { wrapper } = await harness();

		setRunningPlanPath('1.then.0');
		await wrapper.vm.$nextTick();

		// 那一步就是声明里第三个节点（路径 `1.then.0` = 分支的 then 臂第一步）
		const armNode = nodeIdAt(2);
		expect(linkOf(wrapper, armNode, 'card').attributes('data-run-state')).toBe('flowing');
		expect(linkOf(wrapper, armNode, 'block').attributes('data-run-state')).toBe('flowing');
		// 十条里只有那两条在跑：其余八条连 class 都没有
		expect(wrapper.findAll('.cc-link.is-flowing')).toHaveLength(2);
		expect(phasesOf(wrapper).filter((phase) => phase === 'flowing')).toHaveLength(2);
		expect(wrapper.findAll('.cc-link.is-settled')).toHaveLength(0);
		// 其它步骤（含分支那一步自己）在跑的那一刻都还是常态
		expect(phasesOf(wrapper).filter((phase) => phase === 'idle')).toHaveLength(8);
		expect(linkOf(wrapper, nodeIdAt(1), 'card').attributes('data-run-state')).toBe('idle');
	});

	it('换到下一步 → 上一步收住（线还在、光停了），新的那一步接管；两边不同时在跑', async () => {
		const { wrapper } = await harness();

		setRunningPlanPath('1.then.0');
		await wrapper.vm.$nextTick();
		setRunningPlanPath('1.else.0');
		await wrapper.vm.$nextTick();

		const thenNode = nodeIdAt(2);
		const elseNode = nodeIdAt(3);
		expect(wrapper.findAll('.cc-link.is-flowing')).toHaveLength(2);
		expect(linkOf(wrapper, elseNode, 'card').attributes('data-run-state')).toBe('flowing');
		// 上一步**不是**啪一下回常态：它停在 is-settled 上（「这一步完了」）
		expect(linkOf(wrapper, thenNode, 'card').attributes('data-run-state')).toBe('settled');
		expect(linkOf(wrapper, thenNode, 'block').attributes('data-run-state')).toBe('settled');
		expect(linkOf(wrapper, thenNode, 'card').classes()).toContain('is-settled');
		expect(linkOf(wrapper, thenNode, 'card').classes()).not.toContain('is-flowing');
		// 更早的那一步（顶层第 0 步从没跑过）仍是常态
		expect(linkOf(wrapper, nodeIdAt(0), 'card').attributes('data-run-state')).toBe('idle');
	});

	it('清掉路径（跑完 / 复位）→ 没有一条线还在跑，最后那一步收住', async () => {
		const { wrapper } = await harness();

		setRunningPlanPath('1.then.0');
		await wrapper.vm.$nextTick();
		clearRunningPlanPath();
		await wrapper.vm.$nextTick();

		expect(wrapper.findAll('.cc-link.is-flowing')).toHaveLength(0);
		expect(phasesOf(wrapper).every((phase) => phase !== 'flowing')).toBe(true);
		// 「收住」不是「消失」：最后那一步的线还站在那儿，只是不再动
		expect(linkOf(wrapper, nodeIdAt(2), 'card').attributes('data-run-state')).toBe('settled');
	});

	it('下一趟开场：上一趟收住的尾巴不许跟过来', async () => {
		const { wrapper } = await harness();

		setRunningPlanPath('1.then.0');
		await wrapper.vm.$nextTick();
		clearRunningPlanPath();
		await wrapper.vm.$nextTick();
		setRunningPlanPath('0');
		await wrapper.vm.$nextTick();

		expect(linkOf(wrapper, nodeIdAt(0), 'card').attributes('data-run-state')).toBe('flowing');
		expect(wrapper.findAll('.cc-link.is-settled')).toHaveLength(0);
		expect(phasesOf(wrapper).filter((phase) => phase === 'flowing')).toHaveLength(2);
	});

	it('路径推不出节点（越界 / 悬空）→ 一条线都不动，不猜一条顶上', async () => {
		const { wrapper } = await harness();

		setRunningPlanPath('9.then.0');
		await wrapper.vm.$nextTick();

		expect(wrapper.findAll('.cc-link.is-flowing')).toHaveLength(0);
		expect(phasesOf(wrapper).every((phase) => phase === 'idle')).toBe(true);
	});
});

describe('动线 · 光画在同一条几何上，不改测量', () => {
	it('光的 `<path>` 与线共用同一个 `d`：动线是叠上去的一层，不是第二套几何', async () => {
		const { wrapper } = await harness();

		setRunningPlanPath('1.then.0');
		await wrapper.vm.$nextTick();

		for (const link of wrapper.findAll('.cc-link')) {
			const line = link.find('.cc-link__line');
			const pulse = link.find('.cc-link__pulse');
			expect(pulse.attributes('d')).toBe(line.attributes('d'));
			// 归一化长度：光跑一趟只认 0→1，不必按每条线的像素长度各算一份时长
			expect(pulse.attributes('pathLength')).toBe('1');
		}
	});

	it('光不带箭头、不吃指针事件（箭头仍归那条线）', async () => {
		const { wrapper } = await harness();

		for (const link of wrapper.findAll('.cc-link')) {
			const pulse = link.find('.cc-link__pulse');
			expect(pulse.attributes('marker-end')).toBeUndefined();
		}
	});
});

describe('动线 · prefers-reduced-motion 退化成静态', () => {
	it('reduce：光那一层根本不渲染，线的亮暗两档一个不少', async () => {
		const { wrapper } = await harness(true);

		expect(wrapper.get('[data-testid="mapping-overlay"]').attributes('data-motion')).toBe('static');
		setRunningPlanPath('1.then.0');
		await wrapper.vm.$nextTick();

		// 不动：一个 `<path class="cc-link__pulse">` 都没有
		expect(wrapper.findAll('.cc-link__pulse')).toHaveLength(0);
		// 信息一个不少：那一步的两段线照样进「在跑」，换步之后照样收住
		expect(linkOf(wrapper, nodeIdAt(2), 'card').attributes('data-run-state')).toBe('flowing');
		expect(linkOf(wrapper, nodeIdAt(2), 'card').classes()).toContain('is-flowing');

		setRunningPlanPath('1.else.0');
		await wrapper.vm.$nextTick();
		expect(linkOf(wrapper, nodeIdAt(2), 'card').attributes('data-run-state')).toBe('settled');
		expect(wrapper.findAll('.cc-link__pulse')).toHaveLength(0);
	});

	it('没关动效时：光那一层在（对照组，证明上面那条不是「本来就没有」）', async () => {
		const { wrapper } = await harness(false);

		expect(wrapper.get('[data-testid="mapping-overlay"]').attributes('data-motion')).toBe('animated');
		await wrapper.vm.$nextTick();

		expect(wrapper.findAll('.cc-link__pulse').length).toBe(wrapper.findAll('.cc-link').length);
	});
});

describe('动线 · 与选中各写各的', () => {
	it('用户选中别处时，在跑的那条线不跟着退到背景（机器的位置比人在看哪更要紧）', async () => {
		const { wrapper } = await harness();

		store.select(nodeIdAt(0));
		setRunningPlanPath('1.then.0');
		await wrapper.vm.$nextTick();

		const running = linkOf(wrapper, nodeIdAt(2), 'card');
		expect(running.attributes('data-run-state')).toBe('flowing');
		expect(running.classes()).not.toContain('is-dimmed');
		// 既不是选中的、也没在跑的线照旧退到背景
		expect(linkOf(wrapper, nodeIdAt(4), 'card').classes()).toContain('is-dimmed');
		// 选中的那一条照旧是 active
		expect(linkOf(wrapper, nodeIdAt(0), 'card').classes()).toContain('is-active');
	});
});
