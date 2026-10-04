/**
 * **铺开的节奏器**：数据到了不等于画完了。
 *
 * 上游多快不由我们定。生成那条路上，flash 模型常在一两百毫秒里把一整份吐完，几十毫秒出完
 * 也不稀奇；第二次调用（教学规格 / 块规格）只会更快。若「数据一变就整批挂动画」，
 * 屏幕上是一瞬间全出来——看不出「这一块正在被放出来」这件事。
 *
 * 所以中间放一层**播放队列**：上层把**已经到手的整份序列**交给它（`aim`），它按拍子一格格往外放
 * （`revealed` 永远是那份序列的前缀）。来得比拍子慢就跟着数据走（绝不抢在数据前面放），
 * 来得比拍子快就按拍子把已经拿到的一格格铺完。
 *
 * ## 这一层刻意不认识任何业务类型
 *
 * 泛型参数 `T` 就是「待铺开的一格东西」——半成品步骤、教学规格里的块、代码行，
 * 都只是序列里的元素。这一层只管**第几格放出来了**，不知道那一格是什么、从哪来、是否校验过。
 * 谁拿到数据谁负责 `aim`；谁画谁负责读 `revealed` 只画前缀。几处读同一个数，
 * 于是积木铺到第 4 块、代码铺到第 4 行——屏幕上说的是同一件事。
 *
 * ## 一棵**嵌套**的树怎么喂进来
 *
 * 块树不是平铺的：C 形块（`if` / `repeat`）肚子里还嵌着一条语句链。喂进来的应当是
 * **深度优先遍历出来的序**（`flattenSteps` 就在下面，先父后子）——于是「一块块落进来」
 * 在嵌套的树上也成立：先摆外框，再往它肚子里填。
 *
 * ## 拍子怎么定（这三条就是全部规则）
 *
 * - **基准拍 130ms**：一格一块、一格一行的节奏。导演给的档是 120~150ms/格，取中间偏快——
 *   再慢就拖沓，再快就看不出是「一块块」。
 * - **总时长封顶 1600ms**：一批积压（队列从空变满的那一次）铺完的期限就是「这一刻 + 1600ms」，
 *   一拍 = **这一批剩下的时间 ÷ 队列里还剩几格**（夹在 40ms 与 130ms 之间）。积了 n 格时
 *   第一拍就是 `floor(1600/n)`，于是 9 格是 9×130 = 1.17s（没触到顶）、20 格约 80ms 一拍、
 *   40 格约 40ms 一拍，一批从开始铺到铺完都收在 1.6s 上下。
 *   40ms 是地板：再挤也要看得出是逐个，不是一起（积到 40 格以上时地板优先，总时长会超过 1.6s
 *   ——那是「看得出是逐个」压过「1.6 秒」的取舍，见 `beatFor`）。
 * - **两拍之间不重叠**：一格放出来之后，下一格最早也要等一拍。数据比拍子慢时这一条不生效
 *   （队列空着，来一格放一格），数据比拍子快时它就是那个「节奏」。
 *
 * 封顶封的是**一次积压**的铺开时长，不是整轮数据的时长：模型慢慢吐十分钟，画面就跟着吐十分钟
 * ——那是「跟着数据走」，不是要压的东西。
 *
 * ## 收尾那一步
 *
 * 数据到手不等于画完（`whenSettled()`）：要退场的东西（比如生成途中那份未校验的预览）
 * 得等铺完再退——不然「慢慢画出来」会在数据到手那一刻被整块换掉，一格都看不见。
 *
 * ## 画那一侧的两件事（这一层不管，但接口是给它们留的）
 *
 * - **每一格自己「动」起来**：放出一格就给它那一个新出现的元素挂入场动画。积木那边是
 *   「从工具箱方向拖进来 → 落位」（`views/blockly/blockly-canvas.ts` 的 `playBlockStepEntrance`：
 *   一棵树一块块落位用 `playBlockTreeEntrance`），**位移/缩放只在入场期间用、必须收在 identity、
 *   时长 ≤ 250ms**——`transform` 一族会挪 `blocklyBlockCanvas` 的坐标系，Blockly 按内部坐标
 *   算命中区与连线，收尾之后必须完全一致。
 * - **未校验的东西要有字**：这一层与真相无关，它铺的东西是不是真相由上层说清楚
 *   （流程画布那套是 `data-provisional="true"` + 一行「未校验」字样，照那个口径来）。
 */
import { computed, ref, shallowRef, type ComputedRef, type Ref } from 'vue';

/** 一套拍子。做成一组参数是为了这一层能原样复用在不同节奏的地方（默认那组就是定下来的那组）。 */
export interface PlaybackTiming {
	/** 基准拍：一格一块、一格一行。 */
	readonly beatMs: number;
	/** 一次积压的铺开总预算。 */
	readonly budgetMs: number;
	/** 拍子的地板：再挤也要看得出是逐个出场。 */
	readonly minBeatMs: number;
}

/** 基准拍 130ms / 封顶 1600ms / 地板 40ms（依据见文件头）。 */
export const DEFAULT_PLAYBACK_TIMING: PlaybackTiming = { beatMs: 130, budgetMs: 1600, minBeatMs: 40 };

/**
 * 三张画布的**错峰开场**（毫秒）：流程图 0、积木 200、代码 400。
 *
 * 为什么是这三个数：一拍 130ms，而"错峰"要看得出来、又不能让人等——1.5 拍与 3 拍
 * 跨在"看得出"和"不觉得慢"之间。三条一起铺是"数据到了"，依次落下来才像"在画"。
 *
 * 这个常量是**唯一的真相**：三条队列的开场延迟与三张画布的入场动画延迟都读它，
 * 两处各写一个数早晚会对不上（那时画布会先亮、后落，读起来像卡了一下）。
 */
export const PHASE_DELAY_MS = { flow: 0, blocks: 200, code: 400 } as const;

/**
 * 一拍多久：**这一批还剩的时间 ÷ 队列里还剩几格**，夹在 `[floor, beat]` 之间。
 *
 * `left` 默认给整份预算——于是 `beatFor(n)` 就是「n 格、时间还没花掉时的一拍」，
 * 「n 格要铺多久」直接拿它算：`n * beatFor(n) ≤ 预算`（除法**向下取整**，
 * 取整多出来的那一点正是让这条不等式成立的东西）。运行中它按剩下的时间逐拍重算
 * （`left` 越来越小、`pending` 也越来越小），所以**一批积压从开始铺到铺完**收在预算里。
 *
 * 地板优先于封顶：积到 `预算 / 地板` 格以上时拍子不再压（再快就不像逐格出场了），
 * 那时总时长会超过预算——那是「看得出是逐个」压过「1.6 秒」的取舍，写在这里免得下次有人当 bug 修。
 */
export const beatFor = (
	pending: number,
	left: number = DEFAULT_PLAYBACK_TIMING.budgetMs,
	timing: PlaybackTiming = DEFAULT_PLAYBACK_TIMING,
): number => {
	const steps = Math.max(1, Math.floor(pending));
	return Math.min(timing.beatMs, Math.max(timing.minBeatMs, Math.floor(left / steps)));
};

/**
 * 计时器：排一次 `tick`，返回取消它的函数。
 *
 * 做成参数是为了测试能给一个**手动时钟**——这一层的行为全是时间，
 * 拿 `setTimeout` 真等一秒来验「一拍一格」又慢又飘。
 */
export type PlaybackClock = (tick: () => void, ms: number) => () => void;

/** 造一个节奏器要的几样东西，全是可换的（默认就是真计时器 + `Date.now`）。 */
export interface PlaybackOptions {
	readonly timing?: PlaybackTiming;
	readonly clock?: PlaybackClock;
	readonly now?: () => number;
	/**
	 * 这一条队列的**开场延迟**（毫秒）。默认 0。
	 *
	 * 用途只有一个：让三张画布**错峰开场**——流程图先起、积木跟上、代码最后落。
	 * 一起涌出来是"数据到了"，依次落下来才是"在画"。
	 *
	 * 只推迟**每一轮的第一拍**（`reset` 之后、队列空着时来的那一批）：
	 * 中途陆续到的格子仍然跟着拍子走，不会被这条延迟拖慢。
	 */
	readonly delayMs?: number;
}

const defaultClock: PlaybackClock = (tick, ms) => {
	const handle = setTimeout(tick, ms);
	return () => {
		clearTimeout(handle);
	};
};

/**
 * 一棵**嵌套**的序列树 → 铺开的顺序：深度优先、**先父后子**。
 *
 * 块树不是平铺的：C 形块（`if` / `repeat`）肚子里还嵌着一条语句链，那条链上的块也得
 * 一块块落进来。所以喂给节奏器的不是「一层平铺的数组」，而是这份遍历出来的序——
 * 排在前面的先落位：**先摆外框，再往它肚子里填**。
 *
 * `children` 由调用方给（这一层不认识任何块规格的类型，只认「取孩子」这一件事）。
 */
export const flattenSteps = <T>(roots: readonly T[], children: (node: T) => readonly T[]): T[] => {
	const out: T[] = [];
	const visit = (node: T): void => {
		out.push(node);
		for (const child of children(node)) visit(child);
	};
	for (const root of roots) visit(root);
	return out;
};

export interface StepPlayback<T> {
	/** 已经放出来的那一段：**永远是上层给过的那份序列的前缀**。视图只画它。 */
	readonly revealed: ComputedRef<readonly T[]>;
	/** 已经放出来的格数（视图要拿自己那份数据切前缀时读它更顺手，两处说的必然同一个数）。 */
	readonly revealedCount: Ref<number>;
	/** 还有几格在排队没放出来。 */
	readonly pending: ComputedRef<number>;
	/** 还有东西没铺完。 */
	readonly playing: ComputedRef<boolean>;
	/**
	 * 上层把**此刻已经到手的整份序列**交给它。只增；
	 * 上游重写一版、序列反而短了就退回新的长度（宁可少画一格，也不画一格已经不存在的）。
	 */
	aim(sequence: readonly T[]): void;
	/** 这一轮结束（定稿 / 失败 / 中止）：队列与计数一起清掉，并把等着的收尾放行。 */
	reset(): void;
	/** 放完（或这一轮结束）时落定——收尾那一步要等它。 */
	whenSettled(): Promise<void>;
}

/**
 * 造一个节奏器。默认用真计时器；测试传手动时钟进来，时间就完全由测试说了算。
 *
 * `now` 也留了口子：判断「离上一拍够不够久」要读时间，而手动时钟下 `Date.now()` 不动。
 */
export const createStepPlayback = <T>(options: PlaybackOptions = {}): StepPlayback<T> => {
	const timing = options.timing ?? DEFAULT_PLAYBACK_TIMING;
	const clock = options.clock ?? defaultClock;
	const now = options.now ?? (() => Date.now());
	const delayMs = Math.max(0, options.delayMs ?? 0);
	/** 上层给的那份序列（整份，含还没放出来的）。 */
	const sequence = shallowRef<readonly T[]>([]);
	const revealedCount = ref(0);
	/** 排着的那一拍；`null` = 没有拍子在跑。 */
	let cancel: (() => void) | null = null;
	/** 上一次放出东西的时刻。数据慢慢来时靠它判「不必等这一拍」。 */
	let lastRevealAt = Number.NEGATIVE_INFINITY;
	/** 这一批铺完的期限（一批 = 队列从空变满的那一次）。没在铺时是 -∞。 */
	let deadline = Number.NEGATIVE_INFINITY;
	/**
	 * 这一轮**第一批**到手的时刻（`reset` 之后第一次 `aim`）。
	 *
	 * 开场延迟从这一刻起算——不能拿 `lastRevealAt` 算：它是 -∞，
	 * `delayMs - waited` 会算出 +∞ 再被拍子封顶，于是延迟整个失效（第一版就是这么错的，实测第一格仍在 0ms 落）。
	 */
	let batchStartedAt = Number.NEGATIVE_INFINITY;
	let waiting: (() => void)[] = [];

	const pending = computed(() => Math.max(0, sequence.value.length - revealedCount.value));
	const playing = computed(() => pending.value > 0);
	const revealed = computed<readonly T[]>(() => sequence.value.slice(0, revealedCount.value));

	/** 此刻这一拍照多久：这一批剩下的时间摊到队列里还剩下的格数上（见 `beatFor`）。 */
	const beatNow = (): number => beatFor(pending.value, deadline - now(), timing);

	/** 放完了（或这一轮结束了）：把等着的收尾放行。 */
	const settle = (): void => {
		for (const resolve of waiting.splice(0)) resolve();
	};

	const stopClock = (): void => {
		cancel?.();
		cancel = null;
	};

	/** 放一格。还有剩就按这一拍的时长排下一次。 */
	const step = (): void => {
		cancel = null;
		if (pending.value === 0) {
			settle();
			return;
		}
		revealedCount.value += 1;
		lastRevealAt = now();
		if (pending.value === 0) {
			deadline = Number.NEGATIVE_INFINITY;
			settle();
			return;
		}
		cancel = clock(step, beatNow());
	};

	const aim = (next: readonly T[]): void => {
		sequence.value = next;
		if (revealedCount.value > next.length) revealedCount.value = next.length;
		if (pending.value === 0) {
			stopClock();
			deadline = Number.NEGATIVE_INFINITY;
			settle();
			return;
		}
		// 已经有拍子在跑：让它按拍子来，别在这一刻抢着放（那就是「数据一到就整批」的老毛病）。
		if (cancel !== null) return;
		// 队列空着时来的这一批：期限从这一刻起算（这一批铺多久由它封顶）。
		deadline = now() + timing.budgetMs;
		batchStartedAt = now();
		// 离上一拍已经够久（数据比拍子慢）就立刻放——跟着数据走；还不够久（数据比拍子快）
		// 就把这一拍补上，节奏不被打乱。
		const waited = now() - lastRevealAt;
		const beat = beatNow();
		/*
		 * 开场延迟只作用于**本轮第一格**（`lastRevealAt` 还是 -∞ 的那一次）。
		 *
		 * 这里踩过两次坑，都记下来：
		 * ① 拿 `waited` 当判据不行——它是 +∞，任何延迟都被一步跨过去（第一格仍在 0ms 落）；
		 * ② 直接写成 `now() - batchStartedAt >= beat` 也不行——那会把**没有延迟时的正常行为**改掉
		 *    （原来的规矩是"数据一到就先放一格"，那一格不该等拍子）。
		 * 所以分两种情况：有开场延迟就等够延迟，没有就照旧立刻放第一格。
		 */
		const first = lastRevealAt === Number.NEGATIVE_INFINITY;
		if (first && delayMs > 0) {
			const left = delayMs - (now() - batchStartedAt);
			if (left <= 0) step();
			else cancel = clock(step, left);
			return;
		}
		if (waited >= beat) step();
		else cancel = clock(step, beat - waited);
	};

	const reset = (): void => {
		stopClock();
		sequence.value = [];
		revealedCount.value = 0;
		lastRevealAt = Number.NEGATIVE_INFINITY;
		deadline = Number.NEGATIVE_INFINITY;
		batchStartedAt = Number.NEGATIVE_INFINITY;
		settle();
	};

	const whenSettled = (): Promise<void> =>
		playing.value ? new Promise<void>((resolve) => waiting.push(resolve)) : Promise.resolve();

	return { revealed, revealedCount, pending, playing, aim, reset, whenSettled };
};
