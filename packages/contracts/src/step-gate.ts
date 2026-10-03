/**
 * 单步放行闸：「每走一步等一次放行」这件事的**唯一一份**形状与语义。
 *
 * 为什么它在 contracts 而不是某一边的执行包里：单步有**两条执行路**——
 * 本机 3D（`apps/robot3d` 的 `runPlan`）与 bridge HTTP（`packages/robot-bridge` 的
 * `runCompiledPlan`）。放哪一边都会让另一边依赖它（3D 依赖 HTTP 客户端，或者反过来），
 * 而两处各写一份闸，早晚会有一处把「预放行」「取消要能叫醒等待」这些细节改松——
 * 于是界面上「按一次走一步」在两条路上会变成两件事。所以形状与语义写在这里一份。
 *
 * 它是**执行侧的**东西，不是协议：谁跑计划谁等它，界面只按它（`release()`）与看它（`waiting`）。
 */
export interface StepGate {
	/**
	 * 放行下一步。
	 *
	 * 没人等着就记一次**预放行**：下一次等待当场通过——按几次就走几步。
	 * 这不是「丢按」：用户在上一步还在动的时候连按三下，期望的正是再走三步。
	 */
	release(): void;
	/**
	 * 等下一次放行。`signal` 一 abort 就当场收摊。
	 *
	 * 为什么必须收信号：停在闸上的那一趟没有别的出路，而「取消」是执行侧唯一的打断手段——
	 * 不收信号，一趟执行会被一个没人再按的按钮永远挂着（界面也就永远回不到初始状态）。
	 */
	wait(signal: AbortSignal): Promise<void>;
	/** 现在正停着等放行吗（界面靠它说「停住了，按一下走下一步」）。 */
	readonly waiting: boolean;
}

/**
 * 造一个放行闸。
 *
 * `onWaiting` 在**停住**与**放开**的那一刻各叫一次（`true` = 刚停住）——界面据此换状态语：
 * 不通知的话，界面只能靠轮询去猜「它是在动，还是停住了」。
 */
export function createStepGate(onWaiting?: (waiting: boolean) => void): StepGate {
	/** 正等着放行的那一个等待（`null` = 没人等）。一次只有一个：计划是顺序走的。 */
	let wake: (() => void) | null = null;
	/** 预放行的次数：上一步还没走完时按下的那几下。 */
	let tokens = 0;

	const idle = (): void => {
		wake = null;
		onWaiting?.(false);
	};

	return {
		release() {
			const current = wake;
			if (current === null) {
				tokens += 1;
				return;
			}
			// 先摘再叫：`finish` 里那一步判断「还是不是我」靠的就是它，顺序反了会通知两次
			idle();
			current();
		},
		wait(signal) {
			// 已经取消 / 已经有预放行：不挂，当场过（判据只有这两条，不另立一套）
			if (signal.aborted) return Promise.resolve();
			if (tokens > 0) {
				tokens -= 1;
				return Promise.resolve();
			}
			return new Promise<void>((resolve) => {
				let done = false;
				const finish = (): void => {
					if (done) return;
					done = true;
					signal.removeEventListener('abort', onAbort);
					// 被 abort 叫醒时 `wake` 还指着我：这里收摊并通知「不等了」
					if (wake === finish) idle();
					resolve();
				};
				const onAbort = (): void => {
					finish();
				};
				wake = finish;
				onWaiting?.(true);
				signal.addEventListener('abort', onAbort, { once: true });
			});
		},
		get waiting() {
			return wake !== null;
		},
	};
}
