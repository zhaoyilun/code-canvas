<script setup lang="ts">
/**
 * 跨栏连线层（spec §4.2）：把「积木 ↔ 流程卡片 ↔ 代码行」三者的对应关系**画出来**，
 * 而不是只靠三处高亮让用户自己猜。
 *
 * 四条设计决定，都写在代码里免得下次又被问一遍：
 *
 * 1. **坐标系只有 overlay 局部像素一套。** 积木活在 Blockly 的 SVG 工作区里
 *    （`.blocklyBlockCanvas` 上有 `translate(scrollX, scrollY) scale(s)`），卡片与代码行是普通
 *    DOM 像素。所以一律 `getBoundingClientRect()`（视口像素）再一起减掉 overlay 自己的框——
 *    滚动、栏宽、整页缩放都被这个减法抵消掉。**不解 Blockly 的 transform**（见 `geometry.ts`）。
 *
 * 2. **每步两段线，箭头都指向右、都落在元素边缘上**：积木右边缘 → 卡片左边缘、
 *    卡片右边缘 → 代码行左边缘。箭头落在**哪一栏**，就说明这一段在说「这一栏对应过去的那个」；
 *    两段都朝右、端点都贴在边缘上，方向就不用再靠文字解释。
 *
 * 3. **常态克制、选中跳出。** 常态是细虚线（`--cc-link-*`，压在内容上像参考线），
 *    选中那一步换成实心强调色 + 辉光，**同时把其余的线再压暗一档**
 *    （`.is-dimmed`）——不然只是「亮了一条」，看不出「其余的不是我要看的」。
 *
 * 4. **不挡任何交互。** overlay 与里面的每一段线都是 `pointer-events: none`，
 *    悬停提示也只挂在线上（`pointer-events: stroke` 会挡住卡片点击，所以不用）。
 *
 * 重算的触发面：声明变化、选中变化（这两条走 watch）、窗口尺寸与栏宽（ResizeObserver）、
 * 任意容器滚动（document 捕获阶段，滚动不冒泡）、积木画布缩放平移——
 * 最后这条没有事件可听（Blockly 的视口变化不改 DOM 的 scroll 事件），
 * 所以留一个 rAF 探针**比几何摘要**：摘要连续若干帧不变就降频到几百毫秒一次，
 * 一旦有变化（缩放、拖动、外部布局抖动）立刻回到逐帧。空闲时几乎不花 CPU。
 */
import { computed, onBeforeUnmount, onMounted, ref, shallowRef, useId, watch } from 'vue';
import { useStudioDocument } from '../../state/document';
import { measureLinks, type LinkRow } from './measure';

const store = useStudioDocument();

/** 连续多少帧几何摘要不变就算「画布静下来了」，探针降频。 */
const IDLE_FRAMES = 8;
/** 降频之后的探测间隔（毫秒）。缩放/拖动一旦发生，最多这么久就被抓回来。 */
const IDLE_PROBE_MS = 350;

const uid = useId();
const glowId = `cc-link-glow-${uid}`;
const arrowIdleId = `cc-link-arrow-idle-${uid}`;
const arrowActiveId = `cc-link-arrow-active-${uid}`;

const overlayRef = ref<SVGSVGElement | null>(null);
const links = shallowRef<readonly LinkRow[]>([]);
const activeNodeId = computed(() => store.selectedNodeId.value);

/** 悬停提示要显示「第几步 → 哪一栏」，所以每段线带一个 `title`（SVG 里 `title` 就是 tooltip）。 */
const activeLinkCount = computed(() => {
	const active = activeNodeId.value;
	return active === null ? 0 : links.value.filter((link) => link.nodeId === active).length;
});

const isActive = (link: LinkRow): boolean => activeNodeId.value !== null && link.nodeId === activeNodeId.value;
/** 有选中时，其余的线退到背景——高亮要对比出来的，不然只亮一条看不出来。 */
const isDimmed = (link: LinkRow): boolean => activeNodeId.value !== null && link.nodeId !== activeNodeId.value;

let frame: number | null = null;
let idleScheduled = false;
let lastMeasure = 0;
let idleRuns = 0;
let signature: string | null = null;
let observer: ResizeObserver | null = null;

/**
 * 量一轮，几何真的变了才换 `links`（所以 rAF 探测不会每帧都触发 Vue 重新渲染）。
 */
function measure(): void {
	const overlay = overlayRef.value;
	if (overlay === null) return;
	lastMeasure = typeof performance === 'undefined' ? Date.now() : performance.now();

	// overlay 没尺寸（栏被折叠、还在首次排版）时什么都不用做。
	const box = overlay.getBoundingClientRect();
	if (box.width <= 0 || box.height <= 0) {
		idleRuns = IDLE_FRAMES;
		return;
	}

	const result = measureLinks({
		overlay,
		// 锚点的查找范围是工作区（overlay 的父元素）——三栏是 overlay 的兄弟，不是子孙。
		root: overlay.parentElement ?? overlay,
		declaration: store.declaration.value,
	});
	if (result.signature === signature) {
		idleRuns += 1;
		return;
	}
	signature = result.signature;
	idleRuns = 0;
	links.value = result.links;
}

function tick(): void {
	frame = null;
	const now = typeof performance === 'undefined' ? Date.now() : performance.now();
	if (idleRuns >= IDLE_FRAMES && now - lastMeasure < IDLE_PROBE_MS) {
		scheduleIdle();
		return;
	}
	measure();
	schedule();
}

/** 排在下一帧（逐帧模式）。 */
function schedule(): void {
	if (frame !== null) return;
	if (typeof requestAnimationFrame !== 'function') return;
	frame = requestAnimationFrame(tick);
}

/** 排在几百毫秒后（降频模式）。 */
function scheduleIdle(): void {
	if (idleScheduled || frame !== null) return;
	if (typeof setTimeout !== 'function') return;
	idleScheduled = true;
	setTimeout(() => {
		idleScheduled = false;
		schedule();
	}, IDLE_PROBE_MS);
}

function stop(): void {
	if (frame !== null) {
		cancelAnimationFrame(frame);
		frame = null;
	}
}

onMounted(() => {
	window.addEventListener('resize', schedule);
	// 滚动不冒泡，但**捕获阶段**会经过 document——于是这一条就够覆盖
	// 中栏流程列表、右栏代码面板、以及任何将来加进来的滚动容器，
	// 不必去猜哪个 class 名是可滚动的（那是别人视图的内部实现）。
	document.addEventListener('scroll', schedule, true);
	if (typeof ResizeObserver === 'function') {
		observer = new ResizeObserver(schedule);
		if (overlayRef.value !== null) observer.observe(overlayRef.value);
	}
	schedule();
});

onBeforeUnmount(() => {
	window.removeEventListener('resize', schedule);
	document.removeEventListener('scroll', schedule, true);
	observer?.disconnect();
	observer = null;
	stop();
	links.value = [];
	signature = null;
});

// 声明换了（导入新任务、积木写回）、选中换了：都先量一轮。
// 量在下一帧做——DOM 可能还没落定（Vue 的重渲染 + Blockly 的 queueRender 都在这一帧之后）。
watch(
	() => [store.declaration.value?.digest ?? null, store.selectedNodeId.value] as const,
	() => {
		idleRuns = 0;
		schedule();
	},
	{ flush: 'post' },
);
</script>

<template>
	<!--
		overlay 本身不吃指针事件：它是盖在三栏之上的，绝不能挡住卡片、代码行、积木的交互。
		线也一样——`pointer-events: none` 一直挂着，连 tooltip 也只是 `<title>`（浏览器自己给）。
	-->
	<svg
		ref="overlayRef"
		class="mapping-overlay"
		data-testid="mapping-overlay"
		:data-link-count="links.length"
		:data-active-link-count="activeLinkCount"
		aria-hidden="true"
	>
		<!--
			线宽在 CSS 里给，箭头尺寸跟线宽走（`markerUnits="strokeWidth"`）；
			常态与选中各一枚箭头（虚线细箭头 / 实心亮箭头），色值全从 --cc-link-* 来。
			refX = 4 与 viewBox 的右缘重合，箭头尖正好落在线端（也就是元素边缘）上。
		-->
		<defs>
			<marker
				:id="arrowIdleId"
				viewBox="0 0 4 4"
				refX="4"
				refY="2"
				markerWidth="4"
				markerHeight="4"
				markerUnits="strokeWidth"
				orient="auto-start-reverse"
				overflow="visible"
			>
				<path d="M 0 0 L 4 2 L 0 4 z" class="cc-link__arrow cc-link__arrow--idle" />
			</marker>
			<marker
				:id="arrowActiveId"
				viewBox="0 0 4 4"
				refX="4"
				refY="2"
				markerWidth="4.5"
				markerHeight="4.5"
				markerUnits="strokeWidth"
				orient="auto-start-reverse"
				overflow="visible"
			>
				<path d="M 0 0 L 4 2 L 0 4 z" class="cc-link__arrow cc-link__arrow--active" />
			</marker>
			<!-- 选中那一步的辉光：feDropShadow 比 CSS filter 便宜，也不会给整块 SVG 开合成层。 -->
			<filter :id="glowId" x="-20%" y="-40%" width="140%" height="180%">
				<feDropShadow dx="0" dy="0" stdDeviation="3" :flood-color="`var(--cc-link-glow)`" />
			</filter>
		</defs>

		<g
			v-for="link in links"
			:key="`${link.nodeId}:${link.kind}`"
			class="cc-link"
			:class="{
				'is-active': isActive(link),
				'is-dimmed': isDimmed(link),
			}"
			:data-node-id="link.nodeId"
			:data-step="link.step"
			:data-link-kind="link.kind"
			:data-from="`${link.geometry.start.x},${link.geometry.start.y}`"
			:data-to="`${link.geometry.end.x},${link.geometry.end.y}`"
			:data-straight="link.geometry.straight ? 'true' : 'false'"
		>
			<title>{{ link.title }}</title>
			<path
				class="cc-link__line"
				:d="link.geometry.path"
				:marker-end="`url(#${isActive(link) ? arrowActiveId : arrowIdleId})`"
				:filter="isActive(link) ? `url(#${glowId})` : undefined"
			/>
		</g>
	</svg>
</template>

<style scoped>
/*
 * 覆盖层：绝对定位铺满工作区，不吃指针事件。三栏本身仍是 grid 的正常流，
 * 这一层只是在它们之上画线——不参与排版，也不影响任何一栏的宽度与滚动。
 */
.mapping-overlay {
	position: absolute;
	inset: 0;
	width: 100%;
	height: 100%;
	overflow: visible;
	pointer-events: none;
	z-index: 5;
}

.cc-link,
.cc-link__line,
.cc-link__arrow {
	pointer-events: none;
}

/* 常态：细虚线，像一条参考线，压在内容上不抢注意力 */
.cc-link__line {
	fill: none;
	stroke: var(--cc-link-idle);
	stroke-width: var(--cc-link-width-idle);
	stroke-dasharray: var(--cc-link-dash-idle);
	transition:
		stroke 0.15s ease,
		stroke-width 0.15s ease,
		opacity 0.15s ease;
}

.cc-link__arrow--idle {
	fill: var(--cc-link-idle);
	stroke: none;
}

/*
 * 选中：换实心强调色、加粗一档、虚线收起来、配上辉光——和另外三处高亮同一套信号
 * （同样的 `--cc-highlight` 强调色，见 theme.css 的「联动」一段）。
 */
.cc-link.is-active .cc-link__line {
	stroke: var(--cc-link-active);
	stroke-width: var(--cc-link-width-active);
	stroke-dasharray: none;
}

.cc-link.is-active .cc-link__arrow--active {
	fill: var(--cc-link-active);
}

/* 有选中时，其余的线再压暗一档——「跳出来的那条」要靠周围的退让才看得出来 */
.cc-link.is-dimmed .cc-link__line {
	opacity: var(--cc-link-opacity-dimmed);
}

.cc-link.is-dimmed .cc-link__arrow--idle {
	opacity: var(--cc-link-opacity-dimmed);
}
</style>
