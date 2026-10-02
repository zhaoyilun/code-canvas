/**
 * 积木上的序号徽标，以及给积木挂 `data-node-id`（spec §4.2 的 `blockId ↔ nodeId`）。
 *
 * **为什么是 SVG 而不是屏幕浮层**：徽标被塞进积木自己那个 `<g>` 里，和积木共用一套工作区坐标，
 * 于是「块被拖动」「画布缩放平移」都不用重算——变换是父元素给的，徽标天然跟得住。
 * 浮层就得在每次拖动/缩放/滚动后重新量一遍 `getBoundingClientRect()`，慢一步就飘。
 *
 * 这个文件只认 DOM 与调色板，不认识 Blockly 的渲染器：命中的元素仍是
 * `g.blocklyDraggable[data-id="<blockId>"]`，挂上去的 `data-node-id` 与徽标是同一次同步的产物。
 */
import type { WorkflowNode } from '@codecanvas/contracts';
import type { ThemePalette } from '@codecanvas/blockly-toolkit';

const SVG_NS = 'http://www.w3.org/2000/svg';

/** 挂 `nodeId` 的属性名：下一步的跨栏连线只靠 `[data-node-id]` 定位，三处共用这一个名字。 */
export const NODE_ID_ATTRIBUTE = 'data-node-id';
/** 徽标根节点的 class：同时是「这块积木的徽标挂好了」的判据。 */
export const BADGE_CLASS = 'cc-seq-badge';
/** 徽标被选中时的 class（形态由 `BlocklyView.vue` 的深选择器给，色值仍从 `--cc-seq-*` 来）。 */
export const BADGE_ACTIVE_CLASS = 'cc-seq-badge-active';

/** 徽标尺寸（工作区单位，与积木字号同一坐标系——缩放时跟积木一起缩，不会一大一小）。 */
export const BADGE_SIZE = 16;
/** 贴在积木右上角内侧留的边距。 */
export const BADGE_INSET = 3;
/** 圆角取右下角那块圆弧的半径：`rx/ry = 4` 是与渲染器形态最贴的一档。 */
export const BADGE_CORNER_RADIUS = 4;
/** 常态描边 1px / 选中 2px——与 theme.css 里那两个变量同一个口径（DOM 侧由 CSS 给）。 */
const STROKE_WIDTH = 1;
const STROKE_WIDTH_ACTIVE = 2;

export interface BadgePalette {
	readonly idleBackground: string;
	readonly idleBorder: string;
	readonly idleText: string;
	readonly activeBackground: string;
	readonly activeBorder: string;
	readonly activeText: string;
}

/**
 * 徽标的色值全部从调色板读（`--cc-*` 那一族，与积木主题同源；缺变量就在注入时已经抛过了）。
 *
 * 两个状态各给一个明确的观感，和流程卡片、代码行那枚 DOM 徽标对齐：
 *   常态：**压暗的底 + 强调色描边**，落在积木的亮色块面上像一枚凹进去的序号章；
 *   选中：**实心强调色 + 反白数字 + 描边加粗一档**，三处一起跳出来。
 * 亮色块面（`move` 是青、`stop_if_obstacle` 是琥珀）上，暗底比亮字更清楚——
 * 这也是不直接复用 `--cc-accent-veil`（半透明）的原因：压在七种动作色上会是七种观感。
 */
export const badgePalette = (palette: ThemePalette): BadgePalette => {
	const accent = palette['--cc-accent'];
	const accentStrong = palette['--cc-accent-strong'] ?? accent;
	const accentDim = palette['--cc-accent-dim'] ?? accent;
	const sunken = palette['--cc-surface-sunken'];
	return {
		idleBackground: sunken,
		idleBorder: accentDim,
		idleText: accentStrong,
		activeBackground: accent,
		activeBorder: accentStrong,
		activeText: sunken,
	};
};

const svgElement = <K extends keyof SVGElementTagNameMap>(name: K): SVGElementTagNameMap[K] =>
	document.createElementNS(SVG_NS, name);

/** 一个 rect：徽标底色或描边，尺寸与圆角都在工作区单位里。 */
const rect = (size: number): SVGRectElement => {
	const element = svgElement('rect');
	element.setAttribute('x', '0');
	element.setAttribute('y', '0');
	element.setAttribute('width', String(size));
	element.setAttribute('height', String(size));
	element.setAttribute('rx', String(BADGE_CORNER_RADIUS));
	element.setAttribute('ry', String(BADGE_CORNER_RADIUS));
	return element;
};

const innerRect = (strokeWidth: number): SVGRectElement => {
	const size = BADGE_SIZE - strokeWidth;
	const element = rect(size);
	element.setAttribute('x', String(strokeWidth / 2));
	element.setAttribute('y', String(strokeWidth / 2));
	return element;
};

/**
 * 建徽标：`<g class="cc-seq-badge"><rect 底色/><rect 描边/><text 数字/></g>`。
 *
 * 描边单独一个 rect 而不是给底色 rect 加 `stroke`：`stroke` 有一半画在矩形外面，
 * 会让徽标比它的格子宽一档，贴角后可能压出积木外沿。内缩半个描边宽度就贴住了。
 */
export const createBadgeElement = (palette: BadgePalette, index: number): SVGGElement => {
	const group = svgElement('g');
	group.setAttribute('class', BADGE_CLASS);
	// 徽标不挡指针：点它应当还是点中积木。
	group.setAttribute('pointer-events', 'none');

	const background = rect(BADGE_SIZE);
	background.setAttribute('fill', palette.idleBackground);
	background.setAttribute('stroke', 'none');

	const border = innerRect(STROKE_WIDTH);
	border.setAttribute('fill', 'none');
	border.setAttribute('stroke', palette.idleBorder);
	border.setAttribute('stroke-width', String(STROKE_WIDTH));

	const text = svgElement('text');
	text.setAttribute('x', String(BADGE_SIZE / 2));
	text.setAttribute('y', String(BADGE_SIZE / 2));
	text.setAttribute('text-anchor', 'middle');
	text.setAttribute('dominant-baseline', 'central');
	text.setAttribute('font-weight', '600');
	text.setAttribute('fill', palette.idleText);
	text.textContent = String(index);

	group.append(background, border, text);
	// 徽标摆在 `<g>` 的最后：同一个积木里它盖住别的子元素，不会被子元素压掉。
	return group;
};

/**
 * 徽标贴到积木右上角内侧。
 *
 * `box` 是**积木自己的**框，从 `block.getHeightWidth()` 来（见 blockly-canvas.ts 的说明）——
 * 不用 `getBBox()`：那个把阴影和子块一起算进去，贴右上的位置会偏。
 */
export const placeBadge = (badge: SVGGElement, box: { readonly width: number }): void => {
	const x = Math.max(BADGE_INSET, box.width - BADGE_SIZE - BADGE_INSET);
	badge.setAttribute('transform', `translate(${x}, ${BADGE_INSET})`);
};

/** 徽标显示第几步，以及它此刻是不是选中态。两个状态各改属性，形态始终一致。 */
export const updateBadge = (badge: SVGGElement, palette: BadgePalette, index: number, active: boolean): void => {
	const [background, border, text] = badge.children;
	if (
		!(background instanceof SVGRectElement) ||
		!(border instanceof SVGRectElement) ||
		!(text instanceof SVGTextElement)
	) {
		return;
	}

	const strokeWidth = active ? STROKE_WIDTH_ACTIVE : STROKE_WIDTH;
	const inner = BADGE_SIZE - strokeWidth;

	background.setAttribute('fill', active ? palette.activeBackground : palette.idleBackground);
	border.setAttribute('stroke', active ? palette.activeBorder : palette.idleBorder);
	border.setAttribute('stroke-width', String(strokeWidth));
	// 描边变粗时内缩量跟着变，徽标外沿才不会跟着长出去。
	border.setAttribute('x', String(strokeWidth / 2));
	border.setAttribute('y', String(strokeWidth / 2));
	border.setAttribute('width', String(inner));
	border.setAttribute('height', String(inner));

	text.setAttribute('fill', active ? palette.activeText : palette.idleText);
	text.textContent = String(index);

	badge.classList.toggle(BADGE_ACTIVE_CLASS, active);
};

/** 挂在积木 `<g>` 上的徽标；没有就是还没挂。 */
export const badgeOfBlockElement = (element: Element): SVGGElement | null => {
	const found = element.querySelector(`:scope > .${BADGE_CLASS}`);
	return found instanceof SVGGElement ? found : null;
};

/** 声明顺序 → 序数表：第 n 个节点是第 n 步。三个视图共用这一个口径。 */
export const stepNumbersOf = (nodes: readonly WorkflowNode[]): ReadonlyMap<string, number> => {
	const byNodeId = new Map<string, number>();
	nodes.forEach((node, position) => byNodeId.set(node.id, position + 1));
	return byNodeId;
};
