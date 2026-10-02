/**
 * 初始视口：让整条链落在可视区里（spec §4.1）。
 *
 * Blockly 自带的 `zoomToFit()` 不管字看不看得清——一条七块的链在窄栏里会被压到 0.3 左右，
 * 字就没了。这里自己做两件事：按内容算一个「装得下」的比例，再夹在**可读下限**之上；
 * 然后居中。夹到下限之后仍装不下的（内容实在太高），就如实回报 `fits: false`，
 * 由调用方决定要不要提示——不偷偷把字缩小了事。
 */
import type * as Blockly from 'blockly';

/** 初始比例的可读下限：13px 的字乘它是 7.8px，再小就不该拿来做初始视图了。 */
export const MIN_READABLE_SCALE = 0.6;
/** 内容小时不放大过头：放大会让积木显得笨重，也会把链推出视口。 */
export const MAX_FIT_SCALE = 1;
/** 内容四周留白（工作区单位）。 */
export const FIT_PADDING = 16;

export interface FitOptions {
	readonly padding?: number;
	readonly minScale?: number;
	readonly maxScale?: number;
}

export interface FitResult {
	/** 实际落定的比例。 */
	readonly scale: number;
	/** 按这个比例，整条链是否完整落在可视区里。 */
	readonly fits: boolean;
	/** 按内容算出来的理想比例（未被夹之前），便于核对。 */
	readonly fitScale: number;
}

const clamp = (value: number, low: number, high: number): number => Math.min(high, Math.max(low, value));

/**
 * 可视区尺寸（像素）。
 *
 * 直接用 Blockly 的 `viewWidth/viewHeight`：它们已经是「扣掉工具箱之后」的可见**像素**尺寸。
 * 两条都是踩过的坑：① 别自己去减 `toolboxWidth/toolboxHeight`——左侧工具箱的 `toolboxHeight`
 * 报的是工具箱整条的高度（跟画布一样高），减下去可视高度就是 0，自适应永远量不出比例；
 * ② 别再乘 scale——这两个值本来就是像素，乘了会小一圈。
 */
const usablePixels = (metrics: Blockly.utils.Metrics): ContentSize => ({
	width: metrics.viewWidth,
	height: metrics.viewHeight,
});

/** 内容框（只用到宽高，工作区单位）。 */
export interface ContentSize {
	readonly width: number;
	readonly height: number;
}

/**
 * 纯计算部分：内容尺寸 + 可视区像素 → 落定比例。与 Blockly 解耦，好在无头环境里核对。
 * 装不下时按可读下限给比例，并如实说 `fits: false`。
 */
export const planFit = (
	content: ContentSize,
	usable: ContentSize,
	options: FitOptions = {},
): FitResult | null => {
	if (!(content.width > 0) && !(content.height > 0)) return null;
	if (usable.width <= 0 || usable.height <= 0) return null;

	const padding = options.padding ?? FIT_PADDING;
	const minScale = options.minScale ?? MIN_READABLE_SCALE;
	const maxScale = options.maxScale ?? MAX_FIT_SCALE;

	const fitScale = Math.min(
		usable.width / Math.max(1, content.width + padding * 2),
		usable.height / Math.max(1, content.height + padding * 2),
	);
	return { scale: clamp(fitScale, minScale, maxScale), fits: fitScale >= minScale, fitScale };
};

/**
 * 声明 → 工作区之后调用：按内容定比例并居中。没有内容（或画布还没量到尺寸）返回 null，什么都不动。
 *
 * 调用前先 `Blockly.svgResize(workspace)`，否则量到的是上一次的尺寸。
 */
export const fitWorkspaceToContent = (
	workspace: Blockly.WorkspaceSvg,
	options: FitOptions = {},
): FitResult | null => {
	const box = workspace.getBlocksBoundingBox();
	const plan = planFit(
		{ width: box.getWidth(), height: box.getHeight() },
		usablePixels(workspace.getMetrics()),
		options,
	);
	if (plan === null) return null;

	workspace.setScale(plan.scale);

	// 居中：内容框中心对到可视区中心。
	// scrollX/scrollY 是像素偏移，且画布变换就是 `translate(scrollX, scrollY) scale(s)`，
	// 所以工作区坐标要乘上 scale 才能跟可视区的像素尺寸对齐（不乘就会整体偏移半个内容）。
	const settled = workspace.getMetrics();
	const centreX = box.left + box.getWidth() / 2;
	const centreY = box.top + box.getHeight() / 2;
	workspace.scroll(
		settled.viewWidth / 2 - centreX * plan.scale,
		settled.viewHeight / 2 - centreY * plan.scale,
	);

	return plan;
};
