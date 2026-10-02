/**
 * 串行队列：点几次就排几次，一条跑完接着下一条。
 *
 * 为什么要有它：界面上的「执行」如果只是"忙就忽略"，用户连点两次就以为坏了；
 * 而指令之间本来是连续的（设备停在哪儿就从哪儿接着走），排队执行才是它该有的样子。
 *
 * 队列不管怎么执行——只管**顺序**。每个任务自带 `run()`，串行调用，不并行，
 * 一条抛错也继续下一条（错误由任务自己往界面上报，队列不吞也不重试）。
 */
export interface QueuedTask {
	/** 界面上显示的名字 */
	readonly label: string;
	run(): Promise<void>;
}

export interface QueueState {
	readonly running: string | null;
	readonly queued: readonly string[];
}

export interface QueueHooks {
	readonly onChange?: (state: QueueState) => void;
	/**
	 * 任务自己抛错时叫一声。队列只管顺序：一条炸了不挡后面的，
	 * 但也**不替它吞掉**——错误该由任务自己往界面上报，这里是最后一道兜底。
	 */
	readonly onError?: (task: QueuedTask, error: unknown) => void;
}

export class SerialQueue {
	#items: QueuedTask[] = [];
	#current: QueuedTask | null = null;
	#draining = false;

	constructor(private readonly hooks: QueueHooks = {}) {}

	push(task: QueuedTask): void {
		this.#items.push(task);
		this.#notify();
		void this.#drain();
	}

	/** 清空**等待中**的；正在跑的那条不动（要停它得用它自己的取消） */
	clear(): void {
		this.#items = [];
		this.#notify();
	}

	get state(): QueueState {
		return { running: this.#current?.label ?? null, queued: this.#items.map((item) => item.label) };
	}

	#notify(): void {
		this.hooks.onChange?.(this.state);
	}

	async #drain(): Promise<void> {
		if (this.#draining) return;
		this.#draining = true;
		while (this.#items.length > 0) {
			const task = this.#items.shift();
			if (!task) break;
			this.#current = task;
			this.#notify();
			try {
				await task.run();
			} catch (error) {
				// 关键：不能让异常把 drain 循环带走——否则后面排队的永远不跑
				this.hooks.onError?.(task, error);
			} finally {
				this.#current = null;
				this.#notify();
			}
		}
		this.#draining = false;
	}
}
