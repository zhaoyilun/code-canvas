/**
 * 动线状态机的验收：**光跑到哪一格**，只由「设备现在跑哪一步」这一串真实变化推出来。
 *
 * 这里钉的是转移表本身（`run-trace.ts`）：换步、开场、收工各是什么结果。
 * 组件那一侧的 DOM 后果（哪条线进 `is-flowing`）在 `LinkOverlay.test.ts` 里量。
 */
import { describe, expect, it } from 'vitest';
import { EMPTY_RUN_TRACE, phaseOf, traceAfter } from './run-trace';

describe('动线 · 路径变化 → 两格记忆', () => {
	it('从没在跑到某一步：开场，上一趟的尾巴不留过来', () => {
		// 先跑一趟、收工（最后一步停在「收住」），再开新的一趟。
		const afterRun = traceAfter({ running: 'nd_b', settled: 'nd_a' }, null);
		expect(afterRun).toEqual({ running: null, settled: 'nd_b' });

		// 新的一趟第一步：`settled` 必须清掉——否则新任务第 1 步一亮，
		// 上一条已经跑完的线还停在那儿，读起来像这一步连了两处。
		expect(traceAfter(afterRun, 'nd_c')).toEqual({ running: 'nd_c', settled: null });
	});

	it('换到下一步：刚下来的那一步进「收住」，别的都不动', () => {
		expect(traceAfter({ running: 'nd_a', settled: null }, 'nd_b')).toEqual({ running: 'nd_b', settled: 'nd_a' });
		// 再换一步：只有两步记忆，更早的那一步回常态（留一屏历史会把当下的对比淹掉）
		expect(traceAfter({ running: 'nd_b', settled: 'nd_a' }, 'nd_c')).toEqual({ running: 'nd_c', settled: 'nd_b' });
	});

	it('收工（跑完 / 复位 / 换设备）：最后一步收住，不啪一下回到常态虚线', () => {
		expect(traceAfter({ running: 'nd_last', settled: 'nd_prev' }, null)).toEqual({
			running: null,
			settled: 'nd_last',
		});
	});

	it('同一步被报两次：原样返回（不重放一遍动线）', () => {
		const trace = { running: 'nd_a', settled: 'nd_b' };
		expect(traceAfter(trace, 'nd_a')).toBe(trace);
		expect(traceAfter(EMPTY_RUN_TRACE, null)).toBe(EMPTY_RUN_TRACE);
	});

	it('一步跑两遍（环）：第二次跑时亮的是「在跑」，不是「收住」', () => {
		const back = traceAfter({ running: 'nd_b', settled: 'nd_a' }, 'nd_a');
		expect(back).toEqual({ running: 'nd_a', settled: 'nd_b' });
		expect(phaseOf(back, 'nd_a')).toBe('flowing');
		expect(phaseOf(back, 'nd_b')).toBe('settled');
	});
});

describe('动线 · 某一格此刻的档位', () => {
	it('在跑 / 刚下来 / 与它无关，三档分得清', () => {
		const trace = { running: 'nd_run', settled: 'nd_prev' };
		expect(phaseOf(trace, 'nd_run')).toBe('flowing');
		expect(phaseOf(trace, 'nd_prev')).toBe('settled');
		expect(phaseOf(trace, 'nd_other')).toBe('idle');
	});

	it('什么都没在跑时，每一格都是常态', () => {
		expect(phaseOf(EMPTY_RUN_TRACE, 'nd_a')).toBe('idle');
		expect(phaseOf({ running: null, settled: 'nd_a' }, 'nd_a')).toBe('settled');
	});
});
