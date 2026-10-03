import { describe, expect, it } from 'vitest';
import { createStepGate } from '../src/step-gate';

/**
 * 放行闸这一层只钉三件事，多一件都不测：
 * ① 没人等时 `release()` 记一次预放行（按几次走几步）；
 * ② `wait()` 真的挂着，直到 `release()`；
 * ③ 取消（信号 abort）能把它叫醒——不收信号，一趟执行会被一个没人再按的按钮挂住。
 */
describe('单步放行闸', () => {
	/** 让微任务跑完：这一步不测时间，只测「谁先谁后」。 */
	const flush = async (): Promise<void> => {
		for (let i = 0; i < 10; i += 1) await Promise.resolve();
	};

	it('没人等的时候按一下记一次预放行：下一次等待当场通过（按几次走几步）', async () => {
		const gate = createStepGate();
		expect(gate.waiting).toBe(false);

		gate.release();
		gate.release();
		// 还没人等：闸上记着两次，`waiting` 仍是 false（它说的是「现在有人停着吗」）
		expect(gate.waiting).toBe(false);

		let passed = 0;
		const signal = new AbortController().signal;
		await gate.wait(signal).then(() => {
			passed += 1;
		});
		await gate.wait(signal).then(() => {
			passed += 1;
		});
		expect(passed).toBe(2);

		// 两次用完了：第三次真的挂住
		let third = false;
		void gate.wait(signal).then(() => {
			third = true;
		});
		await flush();
		expect(third).toBe(false);
		expect(gate.waiting).toBe(true);

		gate.release();
		await flush();
		expect(third).toBe(true);
		expect(gate.waiting).toBe(false);
	});

	it('waiting 说的是「现在有人停着吗」，停/放各通知一次', async () => {
		const seen: boolean[] = [];
		const gate = createStepGate((waiting) => seen.push(waiting));
		const signal = new AbortController().signal;

		const parked = gate.wait(signal);
		await flush();
		expect(gate.waiting).toBe(true);
		expect(seen).toEqual([true]);

		gate.release();
		await parked;
		expect(gate.waiting).toBe(false);
		expect(seen).toEqual([true, false]);
	});

	it('取消能叫醒停着的那一趟：abort 之后当场收摊，不是等下一次放行', async () => {
		const seen: boolean[] = [];
		const gate = createStepGate((waiting) => seen.push(waiting));
		const controller = new AbortController();

		let passed = false;
		const parked = gate.wait(controller.signal).then(() => {
			passed = true;
		});
		await flush();
		expect(passed).toBe(false);

		controller.abort();
		await parked;
		expect(passed).toBe(true);
		// 停→放各通知一次：界面因此能把「停住了」那句话收回去
		expect(seen).toEqual([true, false]);
		expect(gate.waiting).toBe(false);
	});

	it('已经取消的信号不等（当场过），取消之后 release 也不会把闸弄坏', async () => {
		const gate = createStepGate();
		const controller = new AbortController();
		controller.abort();

		await gate.wait(controller.signal);
		expect(gate.waiting).toBe(false);

		gate.release();
		let passed = false;
		void gate.wait(controller.signal).then(() => {
			passed = true;
		});
		await flush();
		expect(passed).toBe(true);
	});
});
