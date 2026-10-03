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
 * 4. **不挡任何交互。** overlay 与里面的每一段线都是 `pointer-events: none`。
 *    线上**不写字**：跟着线走的小字既盖住栏里的内容，又得随滚动重排，
 *    而「这一段连的是哪两处」箭头已经说完（从哪出来、落到哪，看端点就知道）。
 *
 * 重算的触发面：声明变化、选中变化（这两条走 watch）、窗口尺寸与栏宽（ResizeObserver）、
 * 任意容器滚动（document 捕获阶段，滚动不冒泡）、积木画布缩放平移——
 * 最后这条没有事件可听（Blockly 的视口变化不改 DOM 的 scroll 事件），
 * 所以留一个 rAF 探针**比几何摘要**：摘要连续若干帧不变就降频到几百毫秒一次，
 * 一旦有变化（缩放、拖动、外部布局抖动）立刻回到逐帧。空闲时几乎不花 CPU。
 *
 * 5. **动线是叠在连线上的第二层画，不是第二套几何。**（M4）
 *    连线只说明「这三处对得上」，看不出「这句话正怎么流到机械臂上」。动线补的就是那一段：
 *    设备跑到某一步时，属于那一步的线上跑一道光。它**不改几何一个数**——
 *    光的 `<path>` 复用同一条 `d`（`pathLength="1"`，见 `theme.css` 的 `--cc-flow-dash`），
 *    量出来的端点仍由 `measure.ts` 一个来源给，`0.000px` 那条测试钉住的东西一动没动。
 *
 *    **它只由真实事件驱动**：唯一输入是 `shell/device-run.ts` 的 `runningPlanPath`，
 *    由右栏面板在设备每一步的 `running` 事件里写。这个文件里没有 `setInterval`、
 *    没有「照计划演一遍」的定时器，也没有每帧的 `getBoundingClientRect`——
 *    光跑在 `stroke-dashoffset` 上（不触发布局），重排只发生在几何真的变了的时候。
 *
 *    `prefers-reduced-motion: reduce` 时不跑光：那些 `<path>` 连渲染都不渲染，
 *    线本身照样进 `is-flowing` / `is-settled`（观感差别一点不少，只是不动）。
 */
import { computed, onBeforeUnmount, onMounted, ref, shallowRef, useId, watch } from 'vue';
import { useStudioDocument } from '../../state/document';
import { runningPlanPath } from '../../shell/device-run';
import { nodeAtPlanPath } from '../shared/plan-structure';
import { measureLinks, type LinkRow } from './measure';
import { EMPTY_RUN_TRACE, phaseOf, traceAfter, type RunTrace } from './run-trace';

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

/** 选中那一步有几段线（落在 `data-active-link-count` 上，量页面时看得见）。 */
const activeLinkCount = computed(() => {
	const active = activeNodeId.value;
	return active === null ? 0 : links.value.filter((link) => link.nodeId === active).length;
});

const isActive = (link: LinkRow): boolean => activeNodeId.value !== null && link.nodeId === activeNodeId.value;

// ---------------------------------------------------------------------------
// 动线：光跑到哪一步（判据只有 `runningPlanPath` 一个）
// ---------------------------------------------------------------------------

/**
 * 两步记忆（在跑的那一步、刚下来的那一步）——转移表在 `run-trace.ts`。
 *
 * 路径 → 节点仍走 `nodeAtPlanPath`（与流程卡、右栏面板同一份判据）：路径说的是
 * 「在计划的哪一格」，而线是按 `data-node-id` 挂的，中间那一步换算只有这一份实现。
 */
const trace = ref<RunTrace>(EMPTY_RUN_TRACE);

/** 这一处此刻的动线档位。`data-run-state` 就是它——浏览器里逐字读得出来的那个值。 */
const runStateOf = (link: LinkRow): 'idle' | 'flowing' | 'settled' => phaseOf(trace.value, link.nodeId);

/**
 * 有选中时，其余的线退到背景——高亮要对比出来的，不然只亮一条看不出来。
 *
 * 正在跑/刚跑过的那两处**不跟着退**：退是为了让选中的跳出来，而机器在哪比人在看哪更要紧
 * （跟随关掉时两者会分开）。把它压暗等于「设备正在这一步」被用户的选中盖掉。
 */
const isDimmed = (link: LinkRow): boolean =>
	activeNodeId.value !== null && link.nodeId !== activeNodeId.value && runStateOf(link) === 'idle';

/**
 * 这一段的两个端点里，哪个是**从卡片出去**的那一头。
 *
 * 一步两段线，方向都是左→右（见 `geometry.ts`）：`block` 段是积木→卡片，`card` 段是卡片→代码行。
 * 所以要「从卡片流向另一栏」的是 `card` 那一段——它先走；`block` 那一段是同一路的回响，
 * 慢半拍跟上来（`--cc-flow-echo-delay-ms`）。两段都属于这一步，于是两段都进 `is-flowing`。
 */
const echoDelayOf = (link: LinkRow): string => (link.kind === 'card' ? '0ms' : 'var(--cc-flow-echo-delay-ms)');

/**
 * 系统设置里关掉了动效。
 *
 * 这里读一次、听变化：`reduce` 时**光的 `<path>` 根本不渲染**（不是靠 CSS 盖住），
 * 于是那一趟同步 / 合成的工作一点都不发生。线本身的亮暗两档照旧——
 * 信息一个不少，少的是「动」。
 */
const reducedMotion = ref(false);

let motionQuery: MediaQueryList | null = null;
const onMotionChange = (event: MediaQueryListEvent): void => {
	reducedMotion.value = event.matches;
};

/**
 * 这一步跑到哪了 → 两格记忆。**唯一的写入口就是这里**，源只有 `runningPlanPath`。
 * `immediate` 是需要的：外壳挂载时可能已经有一趟在跑了（面板先挂上、overlay 后挂上）。
 */
watch(
	runningPlanPath,
	(path) => {
		const node = path === null ? null : (nodeAtPlanPath(store.declaration.value, path)?.id ?? null);
		trace.value = traceAfter(trace.value, node);
	},
	{ immediate: true },
);

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
	// 动效偏好：读一次 + 听着（用户在系统设置里改了就跟着变，不必刷新页面）。
	if (typeof window !== 'undefined' && typeof window.matchMedia === 'function') {
		motionQuery = window.matchMedia('(prefers-reduced-motion: reduce)');
		reducedMotion.value = motionQuery.matches;
		motionQuery.addEventListener('change', onMotionChange);
	}
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
	motionQuery?.removeEventListener('change', onMotionChange);
	motionQuery = null;
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

// 换了一份声明 = 换了一趟活：两格记忆里的节点 id 属于上一份声明，留着只会指向不存在的线。
// （跑着的时候声明不会换——右栏那份面板也不允许边跑边导入。）
watch(
	() => store.declaration.value?.digest ?? null,
	() => {
		trace.value = EMPTY_RUN_TRACE;
	},
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
		:data-motion="reducedMotion ? 'static' : 'animated'"
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
				'is-flowing': runStateOf(link) === 'flowing',
				'is-settled': runStateOf(link) === 'settled',
			}"
			:data-node-id="link.nodeId"
			:data-step="link.step"
			:data-link-kind="link.kind"
			:data-run-state="runStateOf(link)"
			:data-from="`${link.geometry.start.x},${link.geometry.start.y}`"
			:data-to="`${link.geometry.end.x},${link.geometry.end.y}`"
			:data-straight="link.geometry.straight ? 'true' : 'false'"
		>
			<path
				class="cc-link__line"
				:d="link.geometry.path"
				:marker-end="`url(#${isActive(link) ? arrowActiveId : arrowIdleId})`"
				:filter="isActive(link) ? `url(#${glowId})` : undefined"
			/>

			<!--
				动线：**同一条 `d`**（几何一个数没改），只是多画一遍、让描边的虚线跑起来。
				`pathLength="1"` 把长度归一化：下面的关键帧只认 0→1，不必按每条线的实际长度算数
				（三条线长短差得远，按像素算就得为每条线写一份时长）。

				`reduce` 时**不渲染**这一层——不是靠 CSS 藏起来，是这一趟同步与合成根本不发生。
				线的 `is-flowing` / `is-settled` 照旧，所以「哪一步在跑、哪一步刚过去」一个字没少。
			-->
			<path
				v-if="!reducedMotion"
				class="cc-link__pulse"
				:d="link.geometry.path"
				pathLength="1"
				:style="{ animationDelay: echoDelayOf(link) }"
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

/* ---------------------------------------------------------------------------
 * 动线：光跑去哪了
 *
 * 三档与连线那三档同一套信号，只多「动不动」这一维：
 *
 *   常态    细虚线（不动）
 *   在跑    实心亮线 + 一道光从卡片那侧跑到另一栏（`is-flowing`）
 *   刚跑完  线停在压暗的强调色上，光淡出去（`is-settled`）——「这一步完了」
 *
 * ⚠ 光跑在 `stroke-dashoffset` 上，**不触发布局**：它只让 renderer 重画这一条 path，
 * 不会让任何一栏重排，所以这里不会出现每帧 `getBoundingClientRect` 那种事
 * （那份测量仍旧只在 rAF 探针里、几何真的变了的时候做一次）。
 * ------------------------------------------------------------------------- */

.cc-link__pulse {
	fill: none;
	stroke: var(--cc-link-active);
	stroke-width: var(--cc-link-width-active);
	stroke-linecap: round;
	stroke-linejoin: round;
	stroke-dasharray: var(--cc-flow-dash);
	/* 常态没有光：它在，但一个像素都不画（下面两档才让它出现） */
	opacity: 0;
	pointer-events: none;
}

/* 在跑：线身点着，光从卡片那侧跑向另一栏，跑完停在那儿等下一步（不循环——循环会变成加载动画） */
.cc-link.is-flowing .cc-link__line {
	stroke: var(--cc-link-active);
	stroke-width: var(--cc-link-width-active);
	stroke-dasharray: none;
	opacity: 1;
}

.cc-link.is-flowing .cc-link__arrow--active {
	fill: var(--cc-link-active);
}

.cc-link.is-flowing .cc-link__pulse {
	animation: cc-flow-run var(--cc-flow-ms) cubic-bezier(0.35, 0, 0.65, 1) 1 forwards;
}

/*
 * 光跑一趟：`stroke-dashoffset` 0 → 1 就是「沿着路径方向走完一个周期」。
 * 两头用 opacity 淡进淡出，于是光看着是**从起点那一头钻进来、从终点那一头出去**，
 * 而不是在线的两端凭空出现与凭空消失。
 */
@keyframes cc-flow-run {
	0% {
		stroke-dashoffset: 0;
		opacity: 0;
	}

	12% {
		opacity: 1;
	}

	82% {
		opacity: 1;
	}

	100% {
		stroke-dashoffset: 1;
		opacity: 0;
	}
}

/* 刚跑完：线停在安静的亮色上（停住），光从远端收掉（淡出）——不是啪一下回到虚线 */
.cc-link.is-settled .cc-link__line {
	stroke: var(--cc-flow-settled);
	stroke-width: var(--cc-link-width-active);
	stroke-dasharray: none;
	opacity: var(--cc-flow-settled-opacity);
}

.cc-link.is-settled .cc-link__pulse {
	animation: cc-flow-settle var(--cc-flow-settle-ms) ease-out 1 forwards;
}

@keyframes cc-flow-settle {
	0% {
		stroke-dashoffset: 0.86;
		stroke-dasharray: var(--cc-flow-dash);
		opacity: 0.9;
	}

	100% {
		stroke-dashoffset: 1;
		stroke-dasharray: 0.02 0.98;
		opacity: 0;
	}
}

/*
 * 兜底网：JS 那侧读 `matchMedia` 决定渲不渲染这一层（`data-motion="static"` 时根本不渲染）。
 * 万一 `matchMedia` 不在（老浏览器），这条媒体查询仍然把光按住——两道闸都关才算数。
 * 注意只关「动」，不关 `is-flowing` / `is-settled` 这两档的颜色：信息一个不少。
 */
@media (prefers-reduced-motion: reduce) {
	.cc-link__pulse {
		display: none;
	}
}
</style>
