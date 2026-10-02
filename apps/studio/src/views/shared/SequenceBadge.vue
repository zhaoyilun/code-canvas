<script setup lang="ts">
/**
 * 序号徽标：**一个步骤在声明里的序数**（1 起），三个视图共用同一个组件。
 *
 * 为什么放在 `views/shared/`（原先临时搁在 `views/flow/` 下）：它是流程卡片与代码行唯一需要
 * 逐像素一致的东西，拆成两份就会慢慢长歪，而跨视图 import 又会让目录之间长出不该有的依赖。
 * 积木那侧的徽标是画在 SVG 里的（见 `views/shared/sequence-badge.ts`），
 * 用的是同一组 `--cc-seq-*` 变量、同一形态（`--cc-radius-sm` 圆角方块）——观感同源，见 theme.css 末尾。
 *
 * 常态与选中是同一枚徽标的两个状态：选了就「反白压在 accent 实心上」。
 * 这个状态变化是三处联动里最稳的那条线索——描边、底色、字色三者一起动，扫一眼就认得出来。
 */
const props = defineProps<{
	/** 步骤在声明里的序数，从 1 开始。 */
	readonly index: number;
	/** 它对应的步骤正被选中。 */
	readonly active?: boolean;
	/** 测试用的钩子（三处各一个，好分别核对）。 */
	readonly testid?: string;
}>();

const label = (): string => `第 ${props.index} 步`;
</script>

<template>
	<span
		class="cc-seq"
		:class="{ 'is-active': active === true }"
		:data-testid="testid"
		:data-seq="index"
		:data-active="active === true ? 'true' : 'false'"
		:title="label()"
		aria-hidden="true"
	>{{ index }}</span>
</template>

<style scoped>
/*
 * 圆角方块 + 数字。圆角用 `--cc-radius-sm`（与积木那侧同一个变量），
 * 色值一律走 `--cc-seq-*`——加上积木的 SVG 徽标，三处合计只有这一份定义。
 */
.cc-seq {
	display: inline-flex;
	align-items: center;
	justify-content: center;
	flex: 0 0 auto;
	min-width: 20px;
	height: 20px;
	padding: 0 var(--cc-space-1);
	font-family: var(--cc-font-mono);
	font-size: var(--cc-fs-xs);
	font-weight: 600;
	line-height: 1;
	color: var(--cc-seq-text);
	background: var(--cc-seq-bg);
	border: var(--cc-highlight-border-width-idle) solid var(--cc-seq-border);
	border-radius: var(--cc-radius-sm);
}

.cc-seq.is-active {
	color: var(--cc-seq-text-active);
	background: var(--cc-seq-bg-active);
	border-color: var(--cc-seq-border-active);
	border-width: var(--cc-highlight-border-width);
}
</style>
