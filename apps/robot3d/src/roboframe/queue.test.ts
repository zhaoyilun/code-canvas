import { describe, expect, it } from 'vitest';
import { SerialQueue, type QueueState } from './queue';

const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

describe('SerialQueue', () => {
	it('按入队顺序串行执行，不并行', async () => {
		const order: string[] = [];
		const queue = new SerialQueue();
		const make = (name: string, ms: number) => ({
			label: name,
			run: async () => {
				order.push(`start:${name}`);
				await new Promise((r) => setTimeout(r, ms));
				order.push(`end:${name}`);
			},
		});
		// 先入队一条慢的，再入队两条快的：串行的话顺序必须是 a 完了才轮到 b
		queue.push(make('a', 5));
		queue.push(make('b', 0));
		queue.push(make('c', 0));
		await new Promise((r) => setTimeout(r, 20));
		expect(order).toEqual(['start:a', 'end:a', 'start:b', 'end:b', 'start:c', 'end:c']);
	});

	it('状态变化会报出来：running / queued', async () => {
		const states: QueueState[] = [];
		const queue = new SerialQueue({ onChange: (s) => states.push({ running: s.running, queued: [...s.queued] }) });
		queue.push({ label: 'one', run: async () => tick() });
		queue.push({ label: 'two', run: async () => tick() });
		await new Promise((r) => setTimeout(r, 10));
		// 入队当下就会报一次（还没开跑），所以断言"出现过"而不是"第一条"
		expect(states).toContainEqual({ running: null, queued: ['one'] });
		expect(states).toContainEqual({ running: 'one', queued: ['two'] });
		expect(states.at(-1)).toEqual({ running: null, queued: [] });
	});

	it('一条失败不挡住后面的，并且错误会被报出来', async () => {
		const done: string[] = [];
		const errors: string[] = [];
		const queue = new SerialQueue({ onError: (task) => errors.push(task.label) });
		queue.push({
			label: 'boom',
			run: async () => {
				throw new Error('这条炸了');
			},
		});
		queue.push({
			label: 'next',
			run: async () => {
				done.push('next');
			},
		});
		await new Promise((r) => setTimeout(r, 10));
		expect(done).toEqual(['next']);
		expect(errors).toEqual(['boom']);
		expect(queue.state).toEqual({ running: null, queued: [] });
	});

	it('clear 只清等待中的，正在跑的不受影响', async () => {
		const queue = new SerialQueue();
		let release = (): void => {};
		queue.push({
			label: 'running',
			run: () =>
				new Promise<void>((resolve) => {
					release = resolve;
				}),
		});
		queue.push({ label: 'waiting-1', run: async () => tick() });
		queue.push({ label: 'waiting-2', run: async () => tick() });
		await tick();
		expect(queue.state).toEqual({ running: 'running', queued: ['waiting-1', 'waiting-2'] });
		queue.clear();
		expect(queue.state).toEqual({ running: 'running', queued: [] });
		release();
		await tick();
		expect(queue.state).toEqual({ running: null, queued: [] });
	});
});
