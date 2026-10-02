/**
 * 跨栏连线的几何（spec §4.2 的 `blockId ↔ nodeId`、`blockId ↔ 生成代码行范围`）。
 *
 * 这个文件**只做算术，不碰 DOM 的选择器，也不认识 Vue**——于是它能在没有浏览器的环境里
 * 被逐条核对（`geometry.test.ts`）。哪三处当锚点、怎么把它们量出来，是 `measure.ts` 的事。
 *
 * 坐标系只有一套：**overlay 的局部像素**。三处的锚点各自活在什么坐标系里无所谓——
 * 积木在 Blockly 的 SVG 工作区里（`.blocklyBlockCanvas` 上有 `translate/scale`），
 * 卡片与代码行是普通 DOM 像素——量之前一律 `getBoundingClientRect()`（视口像素），
 * 再一起减掉 overlay 自己的 `getBoundingClientRect()`。差值就是 overlay 局部坐标。
 * 这条「先统一到视口、再统一到 overlay」是整层唯一需要记住的事。
 */

/** 只需要这几个读数：`DOMRect` 满足它，测试里的假矩形也满足它（不依赖 DOMRect 实例）。 */
export interface RectLike {
	readonly left: number;
	readonly top: number;
	readonly right: number;
	readonly bottom: number;
	readonly width: number;
	readonly height: number;
}

/** 一个端点在 overlay 局部坐标系里的位置。 */
export interface AnchorPoint {
	readonly x: number;
	readonly y: number;
}

/**
 * 一段连线的两端：`from` 是锚点元素那侧，`to` 是箭头指着的目标元素那侧。
 * 两段线的方向都是「从左往右」——因为三栏的固定顺序就是积木 | 流程 | 右栏。
 */
export interface LinkSpan {
	readonly from: AnchorPoint;
	readonly to: AnchorPoint;
	/** 箭头落在哪一栏：积木（第一段）还是流程卡片（第二段）。 */
	readonly arrowAt: 'block' | 'card';
}

export interface LinkGeometry {
	readonly start: AnchorPoint;
	readonly end: AnchorPoint;
	readonly control: readonly [AnchorPoint, AnchorPoint];
	/** 给 `<path d>` 用的实际字符串；两端同高时是一条直线，否则是三次贝塞尔。 */
	readonly path: string;
	/** 直线不值得用 bezier 语法，留个标记（便于测试与调试看清走的是哪条分支）。 */
	readonly straight: boolean;
}

/**
 * 折线的弯曲程度。
 *
 * 不按固定像素弯：一块积木可以很矮（`stop`）也可以很高（`arm6_joints`），
 * 用固定的控制点偏移会让矮块那侧「一出来就斜着走」。按两端纵向落差的四成取，
 * 再夹在 16–96px 之间——足够拉开弧度，又不至于在栏间空隙里绕一大圈。
 */
export const CURVE_BEND_MIN = 16;
export const CURVE_BEND_MAX = 96;
const CURVE_BEND_RATIO = 0.4;

/** 两端纵向落差为零（同高、水平相邻）时不画 bezier：直线更干净，也少一条无意义的控制点。 */
const STRAIGHT_EPSILON = 0.5;

/** 一条 span 的箭头端点：落在元素边缘上，而不是元素中心——线要「贴到边」，不能扎进卡片里。 */
export const anchorFrom = (rect: RectLike, side: 'right' | 'left'): AnchorPoint =>
	side === 'right' ? { x: rect.right, y: rect.top + rect.height / 2 } : { x: rect.left, y: rect.top + rect.height / 2 };

/**
 * 视口像素 → overlay 局部像素。
 *
 * 两个 `getBoundingClientRect()` 一减，滚动、栏宽变化、整页缩放就都被抵消了：
 * overlay 自己也在滚、也在变宽，差值里那部分自然消掉。**不读 `offsetLeft`、不读 `transform`**，
 * 更不去解 Blockly 的 `translate(scrollX, scrollY) scale(s)`——那条路上每一步都是一个坑。
 */
export const toLocal = (point: AnchorPoint, overlayRect: RectLike): AnchorPoint => ({
	x: point.x - overlayRect.left,
	y: point.y - overlayRect.top,
});

/**
 * 一段线：两端点 + 两个控制点 → 可写进 `<path d>` 的字符串。
 *
 * 控制点横着推开（`dx` 由两端水平间距与纵向落差共同决定），所以线一离开源元素就是水平的，
 * 到目标元素前也是水平的——箭头因此永远「平着指过去」，不会斜插进卡片。
 */
export const curveOf = (from: AnchorPoint, to: AnchorPoint): LinkGeometry => {
	const dx = Math.abs(to.x - from.x);
	const dy = to.y - from.y;
	if (Math.abs(dy) < STRAIGHT_EPSILON) {
		return {
			start: from,
			end: to,
			control: [from, to],
			path: `M ${round(from.x)} ${round(from.y)} L ${round(to.x)} ${round(to.y)}`,
			straight: true,
		};
	}
	const bend = Math.min(Math.max((dx + Math.abs(dy)) * CURVE_BEND_RATIO * 0.5, CURVE_BEND_MIN), CURVE_BEND_MAX);
	// 目标在右边（两段线都该如此）：c1 往右推、c2 往左推。
	const direction = to.x >= from.x ? 1 : -1;
	const c1: AnchorPoint = { x: from.x + bend * direction, y: from.y };
	const c2: AnchorPoint = { x: to.x - bend * direction, y: to.y };
	return {
		start: from,
		end: to,
		control: [c1, c2],
		path:
			`M ${round(from.x)} ${round(from.y)} ` +
			`C ${round(c1.x)} ${round(c1.y)}, ${round(c2.x)} ${round(c2.y)}, ${round(to.x)} ${round(to.y)}`,
		straight: false,
	};
};

/** 坐标保留两位小数就够（亚像素没有意义，属性值短一点 diff 也干净）。 */
const round = (value: number): number => Math.round(value * 100) / 100;
