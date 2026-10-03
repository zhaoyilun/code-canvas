/**
 * 铺开的节奏器（`step-playback.ts`）的验收：拍子、封顶、跟着数据走、收尾。
 *
 * 这里量的是**时间**，所以时间由测试自己给：一个手动时钟（`manualClock`）把 `setTimeout` 换成
 * 「谁排在什么时候」的表，`advance` 一格一格推到点。这样「一拍一格」是真的被量出来的，
 * 而不是靠真等一秒、再去猜它有没有动。
 *
 * 四条钉住的东西（它们就是这个机制的全部规则，见那个文件的文件头）：
 *   1. **一拍一格**：一格放出来之后，下一格最早也要等一拍（基准 130ms）；
 *   2. **封顶**：一次积压的铺开总时长不超过 1600ms（40 格以内严格成立，超过 40 格时拍子的地板 40ms 优先）；
 *   3. **跟着数据走**：数据来得比拍子慢时，来一格放一格，不多等（也绝不抢在数据前面放）；
 *   4. **收尾**：`whenSettled()` 在铺完那一刻落定，`reset()` 也把等着的放行。
 */
import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_PLAYBACK_TIMING, beatFor, createStepPlayback, flattenSteps, type PlaybackClock } from './step-playback';

/* ───────────────────────── 手动时钟 ───────────────────────── */

interface ManualClock {
	readonly now: () => number;
	/** 手动时钟本体：交给 `createStepPlayback({ clock })` 的那个 `clock`。 */
	readonly schedule: PlaybackClock;
	/** 把所有到点的拍子按时间顺序推完，最后停在 `+ms`。 */
	advance(ms: number): void;
	/** 排着还没到点的拍子数。 */
	readonly armed: number;
}

const manualClock = (): ManualClock => {
	let current = 0;
	const timers: { due: number; tick: () => void }[] = [];
	return {
		now: () => current,
		schedule: (tick, ms) => {
			const entry = { due: current + ms, tick };
			timers.push(entry);
			return () => {
				const index = timers.indexOf(entry);
				if (index >= 0) timers.splice(index, 1);
			};
		},
		advance: (ms) => {
			const target = current + ms;
			for (;;) {
				const next = timers.filter((entry) => entry.due <= target).sort((left, right) => left.due - right.due)[0];
				if (next === undefined) break;
				timers.splice(timers.indexOf(next), 1);
				current = next.due;
				next.tick();
			}
			current = target;
		},
		get armed() {
			return timers.length;
		},
	};
};

/**
 * 一毫秒一毫秒地推到 `until`，把「第几毫秒放出了第几格」记成一盘磁带。
 *
 * 节奏长什么样，看这一盘就够了：起点那一格是 `aim` 当场放的，所以要先把初始状态记下来，
 * 否则会漏掉「第一格是立刻的」这件事。
 */
const tapeOf = (
	clock: ManualClock,
	player: { revealedCount: { value: number } },
	until: number,
): { at: number; revealed: number }[] => {
	const tape: { at: number; revealed: number }[] = [{ at: clock.now(), revealed: player.revealedCount.value }];
	for (let elapsed = 0; elapsed < until; elapsed += 1) {
		clock.advance(1);
		const revealed = player.revealedCount.value;
		const last = tape[tape.length - 1];
		if (last !== undefined && revealed !== last.revealed) tape.push({ at: clock.now(), revealed });
	}
	return tape;
};

const items = (count: number): readonly number[] => Array.from({ length: count }, (_, index) => index + 1);

/* ───────────────────────── 拍子本身 ───────────────────────── */

describe('拍子 · beatFor', () => {
	it('基准拍 130ms：队列不长时就是它（9 格 9×130 = 1.17s，没触到顶）', () => {
		expect(beatFor(1)).toBe(130);
		expect(beatFor(9)).toBe(130);
		expect(beatFor(12)).toBe(130); // 1600/12 = 133，仍被基准拍压住
	});

	it('积压越多拍子越紧：按预算除（13 格 123ms、20 格 80ms、40 格 40ms）', () => {
		expect(beatFor(13)).toBe(123);
		expect(beatFor(20)).toBe(80);
		expect(beatFor(40)).toBe(40);
	});

	it('地板 40ms：再积也不会压到看不出是逐个', () => {
		expect(beatFor(41)).toBe(40);
		expect(beatFor(200)).toBe(40);
	});

	it('封顶：40 格以内，一次积压的总铺开时长不超过 1600ms', () => {
		for (let pending = 1; pending <= 40; pending += 1) {
			expect(pending * beatFor(pending), `${String(pending)} 格`).toBeLessThanOrEqual(1600);
		}
	});

	it('参数的默认值就是定下来的那组（改了这里会红，改的时候要一起说清依据）', () => {
		expect(DEFAULT_PLAYBACK_TIMING).toEqual({ beatMs: 130, budgetMs: 1600, minBeatMs: 40 });
	});
});

/* ───────────────────────── 队列行为 ───────────────────────── */

describe('播放队列 · 一拍一格', () => {
	it('一次到手一整份 9 格：立刻放第一格，其余每 130ms 一格，一共 1.04s', () => {
		const clock = manualClock();
		const player = createStepPlayback<number>({ clock: clock.schedule, now: clock.now });
		// 数据「一刻」到手：9 格同时进来。
		player.aim(items(9));
		const tape = tapeOf(clock, player, 1500);

		expect(tape).toEqual([
			{ at: 0, revealed: 1 },
			{ at: 130, revealed: 2 },
			{ at: 260, revealed: 3 },
			{ at: 390, revealed: 4 },
			{ at: 520, revealed: 5 },
			{ at: 650, revealed: 6 },
			{ at: 780, revealed: 7 },
			{ at: 910, revealed: 8 },
			{ at: 1040, revealed: 9 },
		]);
		expect(player.pending.value, '铺完之后队列该是空的').toBe(0);
	});

	it('一次到手 40 格：压到 40ms 上下，一批的总时长收在 1.6s 上下', () => {
		const clock = manualClock();
		const player = createStepPlayback<number>({ clock: clock.schedule, now: clock.now });
		player.aim(items(40));
		const tape = tapeOf(clock, player, 2000);
		const last = tape[tape.length - 1];

		expect(player.revealedCount.value).toBe(40);
		expect(player.pending.value).toBe(0);
		expect(tape).toHaveLength(40);
		// 第一格是立刻放的（t=0），剩下 39 格按「这一批剩下的时间 ÷ 队列里剩下的格数」走完；
		// 取整的余量摊在最后一拍上，所以这里量的是「最后一格不晚于预算 + 一拍」。
		expect(last?.at ?? -1).toBeLessThanOrEqual(1600 + 130);
		// 每一拍都在 40~130ms 之间：既压得住时长，也没有压到看不出是逐个。
		for (let index = 1; index < tape.length; index += 1) {
			const gap = (tape[index]?.at ?? 0) - (tape[index - 1]?.at ?? 0);
			expect(gap, `第 ${String(index + 1)} 格的间隔`).toBeGreaterThanOrEqual(40);
			expect(gap, `第 ${String(index + 1)} 格的间隔`).toBeLessThanOrEqual(130);
		}
	});

	it('放出来的永远是「上层给过的那份序列」的前缀（不多不少）', () => {
		const clock = manualClock();
		const player = createStepPlayback<string>({ clock: clock.schedule, now: clock.now });
		player.aim(['a', 'b', 'c']);
		clock.advance(130);
		expect(player.revealed.value).toEqual(['a', 'b']);
		expect(player.revealed.value).toEqual(['a', 'b', 'c'].slice(0, player.revealedCount.value));
	});
});

describe('播放队列 · 跟着数据走（不许抢在数据前面放）', () => {
	it('数据比拍子慢：来一格放一格，中间不多等', () => {
		const clock = manualClock();
		const player = createStepPlayback<number>({ clock: clock.schedule, now: clock.now });

		player.aim(items(1));
		expect(player.revealedCount.value).toBe(1);

		clock.advance(5000); // 模型想了 5 秒
		expect(player.revealedCount.value).toBe(1);

		player.aim(items(2)); // 第二格到了：离上一拍早过了，立刻放
		expect(player.revealedCount.value).toBe(2);
	});

	it('数据比拍子快、但也是一格格到的：仍然按 130ms 的拍子放', () => {
		const clock = manualClock();
		const player = createStepPlayback<number>({ clock: clock.schedule, now: clock.now });

		player.aim(items(1)); // t=0 第一格
		expect(player.revealedCount.value).toBe(1);

		clock.advance(20); // 20ms 后第二格到了——离上一拍还差 110ms
		player.aim(items(2));
		expect(player.revealedCount.value, '第二格抢在拍子前面出来了').toBe(1);

		clock.advance(109);
		expect(player.revealedCount.value).toBe(1);
		clock.advance(1);
		expect(player.revealedCount.value).toBe(2);
	});

	it('数据一刻不到就不放：aim 之前队列是空的，也不排拍子', () => {
		const clock = manualClock();
		const player = createStepPlayback<number>({ clock: clock.schedule, now: clock.now });
		clock.advance(1000);
		expect(player.revealedCount.value).toBe(0);
		expect(player.playing.value).toBe(false);
		expect(clock.armed).toBe(0);
	});

	it('上游重写一版、序列反而短了：退回新的长度，不画一格已经不存在的', () => {
		const clock = manualClock();
		const player = createStepPlayback<number>({ clock: clock.schedule, now: clock.now });
		player.aim(items(3));
		expect(player.revealedCount.value).toBe(1);
		player.aim(items(1));
		expect(player.revealedCount.value).toBe(1);
		expect(player.revealed.value).toEqual([1]);
		expect(player.pending.value).toBe(0);
	});
});

describe('播放队列 · 收尾', () => {
	it('whenSettled 在最后一格放出来那一刻落定', async () => {
		const clock = manualClock();
		const player = createStepPlayback<number>({ clock: clock.schedule, now: clock.now });
		player.aim(items(3));

		const settled = vi.fn();
		const waiting = player.whenSettled().then(settled);
		clock.advance(129);
		await Promise.resolve();
		expect(settled, '还没铺完就落定了').not.toHaveBeenCalled();

		clock.advance(131); // 第 3 格在 260ms
		await waiting;
		expect(settled).toHaveBeenCalledTimes(1);
		expect(player.revealedCount.value).toBe(3);
	});

	it('已经铺完时 whenSettled 立刻落定（不吊着收尾那一步）', async () => {
		const clock = manualClock();
		const player = createStepPlayback<number>({ clock: clock.schedule, now: clock.now });
		player.aim(items(1));
		await expect(player.whenSettled()).resolves.toBeUndefined();
	});

	it('reset 把队列清空、把等着的放行（这一轮被中止时不能把收尾吊死）', async () => {
		const clock = manualClock();
		const player = createStepPlayback<number>({ clock: clock.schedule, now: clock.now });
		player.aim(items(9));
		const waiting = player.whenSettled();
		clock.advance(130);

		player.reset();
		await waiting;
		expect(player.revealedCount.value).toBe(0);
		expect(player.revealed.value).toEqual([]);
		expect(player.pending.value).toBe(0);
		expect(clock.armed, 'reset 之后还有拍子在排——它会往一个已经结束的队列里放东西').toBe(0);
	});
});

/* ───────────────────────── 嵌套的序列树 ───────────────────────── */

describe('嵌套的序列树 · flattenSteps', () => {
	interface Node {
		readonly id: string;
		readonly kids: readonly Node[];
	}

	const kids = (node: Node): readonly Node[] => node.kids;
	const leaf = (id: string): Node => ({ id, kids: [] });
	const box = (id: string, children: readonly Node[]): Node => ({ id, kids: children });

	it('深度优先、先父后子：C 形块先落，它肚子里的语句紧跟着落', () => {
		// 一棵 `if`，肚子里是「一句 + 一个嵌套的 if（肚子里还有一句）」
		const tree = box('if', [leaf('a'), box('if2', [leaf('b')])]);
		expect(flattenSteps([tree], kids).map((node) => node.id)).toEqual(['if', 'a', 'if2', 'b']);
	});

	it('多棵顶层块按自上而下的顺序接在后面（不是按层平铺）', () => {
		const first = box('top1', [leaf('x'), leaf('y')]);
		const second = box('top2', [leaf('z')]);
		expect(flattenSteps([first, second], kids).map((node) => node.id)).toEqual(['top1', 'x', 'y', 'top2', 'z']);
	});

	it('不丢块：遍历出来的个数与树上的一模一样（深嵌套也一样）', () => {
		const deep = box('l1', [box('l2', [box('l3', [box('l4', [leaf('l5')])])])]);
		const flat = flattenSteps([deep, leaf('other')], kids);
		expect(flat.map((node) => node.id)).toEqual(['l1', 'l2', 'l3', 'l4', 'l5', 'other']);
	});

	it('空树给空数组（没有块要铺，节奏器就没什么可放）', () => {
		expect(flattenSteps([], kids)).toEqual([]);
	});

	it('铺出来的顺序就是这一份序：前 2 格永远是树的前 2 块', () => {
		const clock = manualClock();
		const player = createStepPlayback<Node>({ clock: clock.schedule, now: clock.now });
		const flat = flattenSteps([box('if', [leaf('a'), box('if2', [leaf('b')])])], kids);
		player.aim(flat);

		expect(player.revealed.value.map((node) => node.id)).toEqual(['if']);
		clock.advance(130);
		expect(player.revealed.value.map((node) => node.id)).toEqual(['if', 'a']);
	});
});
