/**
 * 初始视口：整条链要落在可视区里，字又不能小到看不见。
 * 比例计算与 Blockly 解耦（`planFit`），这里算的是同一个函数在真实画布尺寸下的结果。
 */
import { describe, expect, it } from 'vitest';
import { FIT_PADDING, MAX_FIT_SCALE, MIN_READABLE_SCALE, planFit } from '../src/viewport';

/** dev 左栏画布的量级：宽 ~420px（已扣工具箱），高 ~340px。 */
const LEFT_PANE = { width: 420, height: 340 };

describe('初始视口比例', () => {
	it('内容装不下时按可读下限给比例，并如实说装不下', () => {
		const content = { width: 300, height: 600 };
		const plan = planFit(content, LEFT_PANE);
		expect(plan?.fitScale).toBeCloseTo(340 / (600 + 2 * FIT_PADDING), 5);
		// 算出来是 0.54——比可读下限还小，就夹到 0.6，而不是把字缩没。
		expect(plan?.scale).toBe(MIN_READABLE_SCALE);
		expect(plan?.fits).toBe(false);
	});

	it('内容装得下时，落定比例乘内容确实装得进可视区', () => {
		const content = { width: 300, height: 500 };
		const usable = { width: 480, height: 520 };
		const plan = planFit(content, usable);
		expect(plan?.fits).toBe(true);
		expect((content.width + 2 * FIT_PADDING) * (plan?.scale ?? 1)).toBeLessThanOrEqual(usable.width);
		expect((content.height + 2 * FIT_PADDING) * (plan?.scale ?? 1)).toBeLessThanOrEqual(usable.height);
	});

	it('内容小时不放大过头：上限 1', () => {
		const plan = planFit({ width: 80, height: 60 }, { width: 900, height: 700 });
		expect(plan?.scale).toBe(MAX_FIT_SCALE);
		expect(plan?.fits).toBe(true);
	});

	it('宽是瓶颈时按宽算', () => {
		const plan = planFit({ width: 1000, height: 100 }, LEFT_PANE);
		expect(plan?.fitScale).toBeCloseTo(420 / (1000 + 2 * FIT_PADDING), 5);
	});

	it('空内容或零尺寸画布不算比例（不动视图，也不把字缩没）', () => {
		expect(planFit({ width: 0, height: 0 }, LEFT_PANE)).toBeNull();
		expect(planFit({ width: 300, height: 600 }, { width: 0, height: 0 })).toBeNull();
	});
});
