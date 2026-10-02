// @vitest-environment happy-dom
/**
 * 跨栏连线的**可核对部分**：坐标系换算、折线形状、以及「哪三处算锚点」。
 *
 * 真实浏览器里量出来的数字（端点误差 0px、缩放平移后仍然 0px）在交付报告里贴；
 * 这里钉住的是那些不该靠肉眼守的规则：
 *   1. 视口像素 → overlay 局部像素这一步没有别的地方再做一遍（滚动/栏宽/整页缩放全靠它抵消）；
 *   2. 端点落在元素**边缘**上（右边缘 / 左边缘 + 纵向居中），不是中心；
 *   3. 两端同高就画直线，有落差才画 bezier——省掉一条无意义的控制点；
 *   4. **没有 `data-node-id` 的积木不进连线**（从工具箱拖出来还没进声明的那种），
 *      而且锚点只从工作区里找——Blockly 工具箱里那七块样板不算数。
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { anchorFrom, curveOf, toLocal } from './geometry';
import { BLOCK_SELECTOR, CARD_SELECTOR, CODE_LINE_SELECTOR, measureLinks } from './measure';
import { setSelectedDevice } from '../../shell/devices';
import { loadSampleTask, useStudioDocument } from '../../state/document';

/**
 * 造一个假矩形（`DOMRect` 的样子，但不用 `new DOMRect`——happy-dom 没实现它的构造器）。
 * 顶替 `getBoundingClientRect` 时 `as` 一下：读出来的六个读数就是真的。
 */
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

/** 顶上元素的 `getBoundingClientRect`：happy-dom 不做排版，框得自己给。 */
const stubRect = (element: Element, box: () => DOMRect): void => {
	element.getBoundingClientRect = box;
};

describe('连线 · 坐标系', () => {
	it('视口像素减掉 overlay 自己的框就是 overlay 局部坐标', () => {
		const overlay = rect(40, 136, 1280, 620);
		expect(toLocal({ x: 100, y: 200 }, overlay)).toEqual({ x: 60, y: 64 });
	});

	it('overlay 自己滚动/变宽，局部坐标不受影响（差值把那部分抵消掉了）', () => {
		const before = toLocal({ x: 500, y: 300 }, rect(0, 136, 1280, 620));
		const after = toLocal({ x: 540, y: 300 }, rect(40, 136, 1240, 620));
		expect(before).toEqual({ x: 500, y: 164 });
		expect(after).toEqual({ x: 500, y: 164 });
	});
});

describe('连线 · span 落在边缘上', () => {
	it('源元素取右边缘、目标元素取左边缘，纵向都取中点', () => {
		const box = rect(10, 20, 200, 48);
		expect(anchorFrom(box, 'right')).toEqual({ x: 210, y: 44 });
		expect(anchorFrom(box, 'left')).toEqual({ x: 10, y: 44 });
	});
});

describe('连线 · 折线形状', () => {
	it('两端同高：画直线，不画 bezier', () => {
		const geometry = curveOf({ x: 10, y: 50 }, { x: 210, y: 50 });
		expect(geometry.straight).toBe(true);
		expect(geometry.path).toBe('M 10 50 L 210 50');
	});

	it('有落差：控制点横着推开，线一出来就是水平的（箭头不会斜插进卡片）', () => {
		const from = { x: 433, y: 301 };
		const to = { x: 510, y: 130.5 };
		const geometry = curveOf(from, to);
		expect(geometry.straight).toBe(false);
		expect(geometry.control[0].y).toBe(from.y);
		expect(geometry.control[1].y).toBe(to.y);
		// c1 在源点右边、c2 在目标点左边——两端切向都是水平的
		expect(geometry.control[0].x).toBeGreaterThan(from.x);
		expect(geometry.control[1].x).toBeLessThan(to.x);
		expect(geometry.path.startsWith('M 433 301 C ')).toBe(true);
		expect(geometry.path.endsWith(' 510 130.5')).toBe(true);
	});

	it('弯曲程度有上下限：极近与极远都不至于变成一条折角或一圈回环', () => {
		const near = curveOf({ x: 0, y: 0 }, { x: 4, y: 4 });
		const far = curveOf({ x: 0, y: 0 }, { x: 2000, y: 900 });
		// 近：控制点至少推开 16px
		expect(near.control[0].x - near.start.x).toBeGreaterThanOrEqual(16);
		// 远：控制点最多推开 96px（否则曲线会绕出去）
		expect(far.control[0].x - far.start.x).toBeLessThanOrEqual(96);
	});
});

describe('连线 · 锚点范围', () => {
	beforeEach(() => {
		// 样例跟着**设备格式**走（默认那台说的是技能计划），而这里量的是这份一期样例的连线，
		// 所以先站到一期那台设备上。
		setSelectedDevice('phase1_robot');
		expect(loadSampleTask()).toBe(true);
		// 每个用例一份干净的 DOM：上一轮挂的假锚点留着会互相干扰。
		document.body.replaceChildren();
	});

	/** 按真实 DOM 的形状搭一份最简结构：工作区里三处锚点，工具箱（工作区外）里放一块样板积木。 */
	const buildDom = (options: { blocks: number; cards: number; lines: number; toolboxBlocks?: number }): HTMLElement => {
		const workspace = document.createElement('div');
		workspace.className = 'workspace';
		const panes = document.createElement('div');
		panes.className = 'panes';
		workspace.append(panes);
		// overlay 与三栏是**兄弟**（真实外壳里就是这样）——所以找锚点必须从工作区找，
		// 从 overlay 自己往下找是一个都找不到的。
		const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
		svg.setAttribute('data-testid', 'mapping-overlay');
		workspace.append(svg);

		const nodes = useStudioDocument().declaration.value?.nodes ?? [];
		for (let i = 0; i < options.blocks; i++) {
			const block = document.createElementNS('http://www.w3.org/2000/svg', 'g');
			block.setAttribute('class', 'blocklyDraggable');
			block.setAttribute('data-node-id', nodes[i]?.id ?? `nope-${String(i)}`);
			panes.append(block);
		}
		for (let i = 0; i < options.cards; i++) {
			const card = document.createElement('article');
			card.setAttribute('data-testid', 'flow-node-card');
			card.setAttribute('data-node-id', nodes[i]?.id ?? `nope-${String(i)}`);
			panes.append(card);
		}
		for (let i = 0; i < options.lines; i++) {
			const line = document.createElement('li');
			line.className = 'cp-line';
			line.setAttribute('data-node-id', nodes[i]?.id ?? `nope-${String(i)}`);
			panes.append(line);
		}
		// 工具箱里的样板积木：同样带 `blocklyDraggable`，但**没有** `data-node-id`，
		// 而且不在工作区里——两个条件各自都足以让它不进连线。
		for (let i = 0; i < (options.toolboxBlocks ?? 0); i++) {
			const sample = document.createElementNS('http://www.w3.org/2000/svg', 'g');
			sample.setAttribute('class', 'blocklyDraggable');
			workspace.append(sample);
		}
		document.body.append(workspace);

		// happy-dom 不做排版，框得自己给：工作区左上角 (0,140)，三处锚点各摆一行。
		// ⚠ 这个 (0,140) 必须**显式**给 overlay：它的 `position: absolute` 在 happy-dom 里
		// 找不到 offsetParent，量出来会是全 0；真实浏览器里它贴着工作区，量出来才是 (0,140)。
		stubRect(svg, () => rect(0, 140, 1280, 620));
		panes.querySelectorAll(BLOCK_SELECTOR).forEach((el, i) => {
			stubRect(el, () => rect(180, 300 + i * 60, 240, 46));
		});
		panes.querySelectorAll(CARD_SELECTOR).forEach((el, i) => {
			stubRect(el, () => rect(510, 280 + i * 80, 240, 120));
		});
		panes.querySelectorAll(CODE_LINE_SELECTOR).forEach((el, i) => {
			stubRect(el, () => rect(961, 300 + i * 40, 300, 22));
		});
		return workspace;
	};

	const overlayOf = (workspace: HTMLElement): Element => {
		const svg = workspace.querySelector('[data-testid="mapping-overlay"]');
		if (svg === null) throw new Error('overlay 没挂上');
		return svg;
	};

	it('三处齐全 → 每步两段线，端点贴在三处锚点的边缘上', () => {
		const workspace = buildDom({ blocks: 4, cards: 4, lines: 4 });
		const { links, stepCount, linkedCount } = measureLinks({
			overlay: overlayOf(workspace),
			root: workspace,
			declaration: useStudioDocument().declaration.value,
		});

		expect(stepCount).toBe(4);
		expect(linkedCount).toBe(4);
		expect(links).toHaveLength(8);
		// 第 1 步第一段：积木右边缘 → 卡片左边缘
		const first = links.find((link) => link.step === 1 && link.kind === 'block');
		if (first === undefined) throw new Error('第 1 步的积木段没量出来');
		expect(first.kind).toBe('block');
		expect(first.step).toBe(1);
		// 积木框 (180,300,240,46) → 右边缘中点视口 (420,323)；overlay 顶边在视口 y=140，
		// 所以 overlay 局部坐标是 (420,183)。
		expect(first.geometry.start).toEqual({ x: 420, y: 183 });
		// 卡片框 (510,280,240,120) → 左边缘中点视口 (510,340) → 局部 (510,200)
		expect(first.geometry.end).toEqual({ x: 510, y: 200 });
		// 第 1 步第二段：卡片右边缘 (750,200) → 代码行左边缘 (961,171)（代码行框 (961,300,300,22)）
		const second = links.find((link) => link.step === 1 && link.kind === 'card');
		if (second === undefined) throw new Error('第 1 步的代码段没量出来');
		expect(second.kind).toBe('card');
		expect(second.geometry.start).toEqual({ x: 750, y: 200 });
		expect(second.geometry.end).toEqual({ x: 961, y: 171 });
	});

	it('从工具箱拖出来、还没进声明的积木：不画给它（同一批里其它线照画）', () => {
		const workspace = buildDom({ blocks: 3, cards: 4, lines: 4, toolboxBlocks: 7 });
		const { links, linkedCount } = measureLinks({
			overlay: overlayOf(workspace),
			root: workspace,
			declaration: useStudioDocument().declaration.value,
		});

		// 工具箱里那 7 块样板一块都没进来
		expect(workspace.querySelectorAll('g.blocklyDraggable')).toHaveLength(10);
		expect(workspace.querySelectorAll('.panes g.blocklyDraggable')).toHaveLength(3);
		// 缺锚点的那一步只有「卡片 → 代码行」一段，其余三步仍是两段
		expect(linkedCount).toBe(3);
		expect(links).toHaveLength(7);
		const lastStep = links.filter((link) => link.step === 4);
		expect(lastStep).toHaveLength(1);
		expect(lastStep[0]?.kind).toBe('card');
	});

	it('没进声明的块即使带上别的 nodeId 也不进线（线只认声明里那几步）', () => {
		const workspace = buildDom({ blocks: 4, cards: 4, lines: 4 });
		const stray = document.createElementNS('http://www.w3.org/2000/svg', 'g');
		stray.setAttribute('class', 'blocklyDraggable');
		stray.setAttribute('data-node-id', 'nd_stray_not_in_declaration');
		stubRect(stray, () => rect(180, 900, 240, 46));
		workspace.querySelector('.panes')?.append(stray);
		const { links } = measureLinks({
			overlay: overlayOf(workspace),
			root: workspace,
			declaration: useStudioDocument().declaration.value,
		});
		expect(links).toHaveLength(8);
		expect(links.some((link) => link.nodeId === 'nd_stray_not_in_declaration')).toBe(false);
	});

	it('没有声明（还没导入任务）→ 一条线都不画', () => {
		const workspace = buildDom({ blocks: 4, cards: 4, lines: 4 });
		expect(
			measureLinks({ overlay: overlayOf(workspace), root: workspace, declaration: null }).links,
		).toEqual([]);
	});
});
