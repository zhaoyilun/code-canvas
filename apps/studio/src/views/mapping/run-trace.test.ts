// @vitest-environment happy-dom
/**
 * 动线的**痕**（`runTrace.trail`）：这一趟走过哪条路。
 *
 * 这一份守的是三件事，每件都是"看起来一样、其实完全不同"的坑：
 *
 * 1. **走过的顺序**：一步跑两遍要走两次（流程画布上的痕是顺序敏感的）；
 * 2. **开场清路**：新的一趟（`null → 某一步`）必须把上一趟的痕清掉——
 *    否则新任务的第 1 步一亮，上一条已经跑完的路还停在那儿，读起来像"这一步连了两处"；
 * 3. **收工不清路**：跑完（`某一步 → null`）时最后那条路要留着——
 *    刚跑完就把人看的东西收走是最气人的一种"自动行为"。
 *
 * 另外还有一条**没走过的绝不亮**：痕只能由真实事件累积（设备每一步的 `running`），
 * 这里不许出现"按计划顺序猜"——猜会把没走的那条臂也点亮，那是假账。
 */
import { describe, expect, it } from 'vitest';
import { EMPTY_RUN_TRACE, phaseOf, traceAfter } from './run-trace';

describe('痕 · 走过的那条路', () => {
	it('开场：第一步既是在跑的，也是痕的第一格', () => {
		const trace = traceAfter(EMPTY_RUN_TRACE, 'n1');
		expect(trace.running).toBe('n1');
		expect(trace.settled).toBe(null);
		expect(trace.trail).toEqual(['n1']);
	});

	it('换步：新的一步进"在跑"，旧的进"收住"，两个都在痕里，顺序是走的顺序', () => {
		const trace = traceAfter(traceAfter(traceAfter(EMPTY_RUN_TRACE, 'n1'), 'n2'), 'n3');
		expect(trace.running).toBe('n3');
		expect(trace.settled).toBe('n2');
		expect(trace.trail).toEqual(['n1', 'n2', 'n3']);
	});

	it('同一步报两次：不重放、不重复记（设备把同一步报两遍是常事）', () => {
		const once = traceAfter(EMPTY_RUN_TRACE, 'n1');
		expect(traceAfter(once, 'n1')).toBe(once);
	});

	it('同一步跑两遍（走回头路）：痕里就该有两条', () => {
		const trace = traceAfter(traceAfter(traceAfter(EMPTY_RUN_TRACE, 'n1'), 'n2'), 'n1');
		expect(trace.trail).toEqual(['n1', 'n2', 'n1']);
	});

	it('收工（某一步 → null）：路留着，只有"在跑"那一格灭', () => {
		const running = traceAfter(traceAfter(EMPTY_RUN_TRACE, 'n1'), 'n2');
		const done = traceAfter(running, null);
		expect(done.running).toBe(null);
		expect(done.settled).toBe('n2');
		expect(done.trail).toEqual(['n1', 'n2']);
	});

	it('新的一趟开场：上一趟的路清干净，只剩新第一步', () => {
		const first = traceAfter(traceAfter(EMPTY_RUN_TRACE, 'n1'), 'n2');
		const done = traceAfter(first, null);
		const second = traceAfter(done, 'm1');
		expect(second.trail).toEqual(['m1']);
		expect(second.settled).toBe(null);
	});

	it('已经跑完再点一次生成（仍然是 null）：痕不许被清——那不是新的一趟', () => {
		const done = traceAfter(traceAfter(EMPTY_RUN_TRACE, 'n1'), null);
		const again = traceAfter(done, null);
		expect(again).toBe(done);
		expect(again.trail).toEqual(['n1']);
	});
});

describe('光 · 哪一步亮着', () => {
	it('在跑的赢过收住的（同一步跑两遍时亮的是"在跑"）', () => {
		// 同一个值报两次：状态没变——它仍然"在跑"（不是被清掉）。
		const repeat = traceAfter(traceAfter(EMPTY_RUN_TRACE, 'n1'), 'n1');
		expect(phaseOf(repeat, 'n1')).toBe('flowing');
		// 走回头路回到 n1：n1 又"在跑"，n2 变"收住"。
		const back = traceAfter(traceAfter(traceAfter(EMPTY_RUN_TRACE, 'n1'), 'n2'), 'n1');
		expect(phaseOf(back, 'n1')).toBe('flowing');
		expect(phaseOf(back, 'n2')).toBe('settled');
		expect(phaseOf(back, 'n3')).toBe('idle');
	});
});
