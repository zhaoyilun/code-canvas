/**
 * 可挂载的入口：把「画布 + 机械臂 + 执行器 + 跑计划」这套从 `main.ts` 抽出来，
 * 交给任何一个宿主（studio 的右栏就是第一个宿主）。
 *
 * 为什么要有这一层：`main.ts` 那套三栏界面（目录 / 画面 / 日志）是这个应用**自己的**界面，
 * 搬进 studio 就变成栏中栏。studio 只要**画面与执行能力**，所以边界划在这里——
 * 这里不碰任何 `id="catalog" / id="run" / id="hud"` 的元素，只认传进来的 `host`：
 * 自己建 canvas、自己量尺寸、自己起渲染循环，`dispose()` 时全部收走。
 *
 * 复用而非重写：场景仍是 `scene/**`（`createKit` / `So101Rig` / `createStage`），
 * 执行仍是 `roboframe/**`（`RoboFrameExecutor` / `runPlan`）。这里只负责生命周期与接线。
 *
 * 关于尺寸：`host` 必须**有确定的宽高**（CSS 给出来）。挂载时按 `host` 量一次，
 * 之后由 `ResizeObserver` 跟着 `host` 的盒子走——canvas 自己设成 100%/100%，
 * 渲染缓冲的像素尺寸由 `stage.resize()` 从父元素量。所以宿主只要给块地方，
 * 不必知道 three 的存在。
 */
import { ROBOFRAME_SO101_CATALOG } from '@codecanvas/capabilities';
import { createStepGate, type CapabilityCatalog, type CapabilitySpec, type SkillPlan } from '@codecanvas/contracts';
import { RoboFrameExecutor, type RunOutcome, type StepEvent } from './roboframe/executor';
import { runPlan, type PlanRunner, type PlanStepGate, type PlanStepReport } from './roboframe/plan';
import { SerialQueue } from './roboframe/queue';
import { createKit } from './scene/kit';
import { So101Rig } from './scene/so101';
import { createStage, disposeStageResources } from './scene/stage';

/**
 * 门口把执行侧的类型一起转出去：宿主（studio 的面板）要写 `onStep` 的回调、
 * 要读 `run()` 的结局，就得拿得到 `StepEvent` / `RunOutcome` 这两个名字——
 * 让另一个应用去 deep import `roboframe/executor`，等于把内部路径写进它的 import 表。
 */
export type { RunOutcome, StepEvent, StepState } from './roboframe/executor';
export type { PlanRunOutcome, PlanStepReport, BranchArm, PlanStepGate } from './roboframe/plan';

/** 舞台的最小动作面（真身是 `scene/stage.ts` 的 `createStage`；测试注入假的，别让单测去跑真 WebGL） */
export interface StageHandle {
	render(dt: number): void;
	resize(): void;
	/** 释放渲染器与 GPU 资源。可选的：假舞台没有东西要放。 */
	dispose?(): void;
}

/** 一帧的节拍（秒）。渲染循环归 mount 独占，宿主订阅这个钩子刷自己的读数/HUD。 */
export type FrameListener = (dtSec: number) => void;

/**
 * 画面那一层。默认就是真的 three 舞台，所以默认参数下不用传；
 * 测试要跑在 happy-dom 里（没有 WebGL）就传一个假的进来。
 */
export type StageFactory = (canvas: HTMLCanvasElement, rig: So101Rig, kit: ReturnType<typeof createKit>) => StageHandle;

/**
 * 帧的排程方式。默认就是浏览器的 `requestAnimationFrame`。
 *
 * 为什么要留这个口子：机械臂的动画按**每帧的 dt** 推进，而测试环境里 rAF 的节奏不受控——
 * happy-dom 把 rAF 实现成 `setImmediate`（实测 120ms 里跑 2700 帧），于是每帧只有几十微秒，
 * `run()` 在测试的超时里永远等不到动作做完。测试传一个"手动泵"的排程器进来，
 * 就能像 `scene/so101.test.ts` 那样按固定步长把时间捏在手里。
 */
export type FrameScheduler = (onFrame: (nowMs: number) => void) => () => void;

/** 默认排程器：跟着浏览器的刷新走 */
const rafScheduler: FrameScheduler = (onFrame) => {
	const id = requestAnimationFrame(onFrame);
	return () => {
		cancelAnimationFrame(id);
	};
};

export interface VirtualDeviceMountOptions {
	/** 设备报上来的目录。默认 `ROBOFRAME_SO101_CATALOG`；测试塞小目录走这条路。 */
	readonly catalog?: CapabilityCatalog;
	/** 建舞台的方式。默认真的 three 舞台。 */
	readonly createStageImpl?: StageFactory;
	/** 帧的排程方式。默认浏览器的 rAF。 */
	readonly scheduleFrame?: FrameScheduler;
}

/** 一次排队的结局：一个能力，或一整份技能计划。 */
export interface RunResult {
	/** 这次跑的是计划还是单个能力（`main.ts` 的 JSON 入口两种都收）。 */
	readonly kind: 'capability' | 'plan';
	readonly outcome: RunOutcome;
	/** 只有 `kind === 'plan'` 时有：整份计划跑到第几步。 */
	readonly plan?: { readonly ok: boolean; readonly completed: number; readonly total: number; readonly reason?: string };
}

export interface VirtualDevice {
	/** 把一份技能计划跑一遍。失败即停，不自动重试（与 bridge 的纪律一致）。 */
	run(plan: SkillPlan): Promise<RunOutcome>;
	/**
	 * **单步**：一次走一个顶层步（界面上「第 N 步」那一格，与流程画布的一张卡同一件事）。
	 *
	 * 开始一趟：走完**第一步**就停住等放行；之后每按一次 `releaseStep()` 再走一步。
	 * 返回的 promise 是**整份计划跑完**时的结局（与 `run()` 同一套账）——调用方不必在每次放行时
	 * 重新取一次结局，也不必自己数走到了第几步（步骤行是 `onPlanStep` 推的）。
	 */
	beginStepRun(plan: SkillPlan): Promise<RunOutcome>;
	/**
	 * 放行下一步。停着的那一趟当场走；没停着就记一次**预放行**（按几次走几步，不丢按）。
	 * 没在单步跑时什么都不做（不是错：界面上那个按钮可能刚好在上一步跑完的那一刻被按下）。
	 */
	releaseStep(): void;
	/** 这一趟单步跑还在进行吗（跑完 / 没开始 = `false`）。界面靠它分辨「按下去是开始还是走下一步」。 */
	readonly stepping: boolean;
	/**
	 * 单步的停/续各推一次（`true` = 刚停住等放行）。
	 * 为什么要有这个通知：停在闸上的那一刻没有任何别的事件——不推，界面看不出它是停住了还是在动。
	 */
	onStepGate(listener: (waiting: boolean) => void): () => void;
	/** 回到初始姿态、清空步骤账本。 */
	reset(): void;
	/** 每走一步回调一次（state 为 'done'/'failed' 时才推，别把 'running' 也推）。 */
	onStep(listener: (event: StepEvent) => void): () => void;
	/**
	 * 计划自己的每一步：技能步与分支步各报一次，`running` 也推。
	 *
	 * 为什么和 `onStep` 的纪律不一样（那边只推终态）：分支步**没有原语事件**，
	 * 而「走了哪条臂」只有它的 `running` 说得清——界面要在这条臂开始跑的时候就把它写出来，
	 * 等臂跑完再写，那一行就会排在它自己的子步骤后面（读起来像是先有结果后有原因）。
	 */
	onPlanStep(listener: (event: PlanStepReport) => void): () => void;
	/** 卸载：停掉渲染循环、摘掉 DOM、释放 WebGL 资源。 */
	dispose(): void;
	/** 当前画面尺寸（面板要显示「多大」时用得上；测试与验收也读它）。 */
	readonly size: { readonly width: number; readonly height: number };
}

/** 界面（`main.ts` 自己那套、以及 studio 的面板）真正会用到的那几个东西，都在这里。 */
export interface MountedVirtualDevice extends VirtualDevice {
	readonly catalog: CapabilityCatalog;
	/** 这台设备的机械臂。读数（关节角 / 指尖）与复位都从它取。 */
	readonly rig: So101Rig;
	/** 排一个能力（点几次排几次，队列串行跑），返回它轮到自己跑完之后的结局 */
	runCapability(capabilityRef: string, params?: Record<string, string>): Promise<RunResult | null>;
	/** 排一条已经校验过的技能计划，返回跑完之后的结局。给了放行闸就是单步模式（见 `VirtualDevice.beginStepRun`）。 */
	enqueuePlan(plan: SkillPlan, options?: { readonly stepGate?: PlanStepGate }): Promise<RunResult>;
	/** 取消当前这次执行（与 `main.ts` 的取消同义） */
	cancel(): void;
	/** 清空还在排队的指令（正在跑的那条不动） */
	clearQueue(): void;
	/**
	 * 已经跑完的步骤账本：`done` / `failed` 两种终态。
	 * `skipped` / `refused` 不进这里——它们是**这次运行的完整经过**的一部分，
	 * 但既不算走通也不算失败，要完整经过就读 `run()` 回来的 `outcome.steps`。
	 */
	readonly stepEvents: readonly StepEvent[];
	/** 入队状态：正在跑的 + 排队的标签。界面拿它显示队列条。 */
	readonly queueState: { readonly running: string | null; readonly queued: readonly string[] };
	/** 每帧叫一次（渲染已经由 mount 做完）。宿主用它刷 HUD 那种要跟着画面走的东西。 */
	onFrame(listener: FrameListener): () => void;
	onQueue(listener: (state: { readonly running: string | null; readonly queued: readonly string[] }) => void): () => void;
	/** 队列里那条任务抛了没接住的异常时推一次（本该自己报错落到步骤账本里） */
	onQueueError(listener: (message: string) => void): () => void;
}

/**
 * 推给 `onStep` 的两种状态：`done` / `failed`。
 * 别的（`running` 是过程、`skipped` 与 `refused` 是"没做但也没坏"）都不推——
 * 听众拿到一条就代表「这一步有结论了」，不必自己去分辨状态。
 */
const PUSHED_STATES = new Set<StepEvent['state']>(['done', 'failed']);

/** canvas 自带的是 CSS 尺寸，渲染缓冲的像素尺寸由 stage 从父元素量——所以这里只给铺满 */
function styleCanvas(canvas: HTMLCanvasElement): void {
	canvas.style.display = 'block';
	canvas.style.width = '100%';
	canvas.style.height = '100%';
}

export function mountVirtualDevice(host: HTMLElement, options: VirtualDeviceMountOptions = {}): MountedVirtualDevice {
	const catalog = options.catalog ?? ROBOFRAME_SO101_CATALOG;
	// 标成 StageFactory：`createStage` 的返回类型少了可选的 `dispose`，
	// 不标的话两个分支会合成联合类型，`dispose?.()` 就过不了类型检查
	const buildStage: StageFactory = options.createStageImpl ?? createStage;

	// 宿主已经给了 canvas 就用它（这个应用自己的 `index.html` 里就有一张），
	// 没有才新建。`dispose()` 只摘掉**自己建的**那一张——宿主的东西还给宿主。
	const existing = host.querySelector('canvas');
	const canvas = existing ?? document.createElement('canvas');
	const ownsCanvas = existing === null;
	canvas.dataset['testid'] = 'virtual-device-canvas';
	styleCanvas(canvas);
	if (ownsCanvas) host.append(canvas);

	const kit = createKit();
	const rig = new So101Rig(kit);
	const stage = buildStage(canvas, rig, kit);

	/**
	 * 舞台没带 `dispose()` 时的兜底（测试里的假舞台就是这种）。
	 *
	 * 只放机械臂那棵树上的几何/材质/贴图——完整的拆法（连 renderer 与 GL 上下文一起丢）
	 * 在 `disposeStageResources` 里，真舞台走那条。这里不重复实现一份收集逻辑，两处同一个口径
	 * （共享的材质表由它内部 Set 去重，每份只 dispose 一次）。
	 */
	function disposeSceneFallback(): void {
		disposeStageResources({
			// 没有真舞台就没有渲染器要收；这两项是拆舞台接口的必填，给一对空实现
			renderer: { dispose: () => undefined, forceContextLoss: () => undefined },
			root: rig.group,
		});
	}

	// 先建步骤账本：执行器的 onStep 要往里记，监听者（面板/日志）照着它渲染
	const stepEvents: StepEvent[] = [];
	const stepListeners = new Set<(event: StepEvent) => void>();
	const planStepListeners = new Set<(event: PlanStepReport) => void>();
	/**
	 * 单步那一趟的放行闸（`null` = 没在单步跑）。**一次只有一趟**：单步是人在看着走的东西，
	 * 排队排两条「一步一步」的没有意义，而且「按一下」该放行哪一趟会变成猜。
	 */
	let activeGate: PlanStepGate | null = null;
	const stepGateListeners = new Set<(waiting: boolean) => void>();
	const queueListeners = new Set<(state: { running: string | null; queued: readonly string[] }) => void>();
	const queueErrorListeners = new Set<(message: string) => void>();
	const frameListeners = new Set<FrameListener>();

	const executor = new RoboFrameExecutor(rig, catalog.primitives, {
		onStep: (event) => {
			// 账本只收有结论的那两种（与 `onStep` 的契约同一条），也就是「第 N 步 · 结果」那几行的来源
			if (!PUSHED_STATES.has(event.state)) return;
			stepEvents.push(event);
			for (const listener of stepListeners) listener(event);
		},
	});

	/**
	 * 点几次排几次：队列串行跑。
	 * 之前「忙就忽略」会让人以为点了没反应，而这台设备本来就是连续的——排队才是它该有的样子。
	 */
	const queue = new SerialQueue({
		onChange: (state) => {
			for (const listener of queueListeners) listener(state);
		},
		onError: (task, error) => {
			const message = `队列里「${task.label}」抛错：${error instanceof Error ? error.message : String(error)}`;
			for (const listener of queueErrorListeners) listener(message);
		},
	});

	let last = performance.now();
	let disposed = false;
	const schedule = options.scheduleFrame ?? rafScheduler;
	let cancelFrame: () => void;

	/** 卸载之后这台设备已经不存在了：再跑就如实拒绝，别假装还能动 */
	function assertLive(): void {
		if (disposed) throw new Error('这台虚拟设备已卸载（dispose），不能再执行计划');
	}

	const syncSize = (): void => {
		const width = host.clientWidth;
		const height = host.clientHeight;
		// 隐藏（宽高为 0）时不写渲染缓冲：0 面积的后备缓冲在某些驱动上会让 WebGL 出警告
		if (width > 0 && height > 0) stage.resize();
	};

	// host 的盒子变了才量：不用 window.resize——宿主是个面板，跟着窗口动是偶然，跟着自己的盒子动才是必然
	const observer = new ResizeObserver(() => {
		syncSize();
	});
	observer.observe(host);
	syncSize();

	function tick(now: number): void {
		if (disposed) return;
		// 一帧最多推进 0.05s：标签页切回来时不至于让机械臂一次跳到位
		const dt = Math.min((now - last) / 1000, 0.05);
		last = now;
		stage.render(dt);
		for (const listener of frameListeners) listener(dt);
		if (!disposed) cancelFrame = schedule(tick);
	}
	cancelFrame = schedule(tick);

	/** 排一条任务；返回的是它**轮到自己跑完之后**的结局（清空队列会丢掉没跑的）。 */
	function enqueue(label: string, task: () => Promise<RunResult>): Promise<RunResult> {
		try {
			assertLive();
		} catch (error) {
			return Promise.reject(error instanceof Error ? error : new Error(String(error)));
		}
		return new Promise<RunResult>((resolve) => {
			queue.push({
				label,
				run: async () => {
					// 任务自报结局并调 resolve；抛出来的异常由队列的 onError 兜（不会变成 rejection，
					// 所以这里不必留一个 reject 分支——留了反而是一条永远不结的挂账）
					resolve(await task());
				},
			});
		});
	}

	const device: MountedVirtualDevice = {
		catalog,
		rig,
		stepEvents,
		get queueState() {
			return queue.state;
		},
		size: { width: 0, height: 0 },
		run: async (plan) => (await device.enqueuePlan(plan)).outcome,
		reset() {
			executor.reset();
			stepEvents.length = 0;
		},
		onStep(listener) {
			stepListeners.add(listener);
			return () => stepListeners.delete(listener);
		},
		onPlanStep(listener) {
			planStepListeners.add(listener);
			return () => planStepListeners.delete(listener);
		},
		onFrame(listener) {
			frameListeners.add(listener);
			return () => frameListeners.delete(listener);
		},
		onQueue(listener) {
			queueListeners.add(listener);
			return () => queueListeners.delete(listener);
		},
		onQueueError(listener) {
			queueErrorListeners.add(listener);
			return () => queueErrorListeners.delete(listener);
		},
		runCapability(capabilityRef, params = {}) {
			const capability: CapabilitySpec | undefined = catalog.capabilities.find(
				(item) => item.capabilityRef === capabilityRef,
			);
			if (capability === undefined) return Promise.resolve(null);
			return enqueue(capability.label, async () => {
				executor.beginRun(); // 接着当前姿态走，不回零
				return { kind: 'capability' as const, outcome: await executor.run(capability, params) };
			});
		},
		enqueuePlan(plan, options) {
			const gate = options?.stepGate;
			return enqueue(`计划 ${plan.description ?? '(未命名)'}${gate === undefined ? '' : '（单步）'}`, async () => {
				executor.beginRun(); // 同上：连续执行，不回零
				const runner: PlanRunner = executor;
				const outcome = await runPlan(plan, {
					catalog,
					runner,
					// 计划步事件照原样往外推（含 `running`）：界面靠它写「第 N 步 · 分支 · 走 then」那几行
					onPlanStep: (event) => {
						for (const listener of planStepListeners) listener(event);
					},
					// 不给闸就是一口气跑完（默认那条路一个字没变）
					...(gate === undefined ? {} : { stepGate: gate }),
				});
				return {
					kind: 'plan' as const,
					// 计划的结局就是「几步成了」：`run` 的门面按它判成败
					outcome: {
						ok: outcome.ok,
						steps: stepEvents.slice(),
						...(outcome.reason === undefined ? {} : { reason: outcome.reason }),
					},
					plan: outcome,
				};
			});
		},
		beginStepRun(plan) {
			const gate = createStepGate((waiting) => {
				for (const listener of stepGateListeners) listener(waiting);
			});
			activeGate = gate;
			/*
			 * `activeGate` 在这一趟**跑完**之前一直是它：界面据此知道「再按是走下一步」。
			 * 结束（跑完、失败停住、被取消）时清掉——那之后 `beginStepRun` 又是「开始新的一趟」。
			 */
			return device.enqueuePlan(plan, { stepGate: gate }).then(
				(result) => {
					if (activeGate === gate) activeGate = null;
					return result.outcome;
				},
				(error: unknown) => {
					if (activeGate === gate) activeGate = null;
					throw error instanceof Error ? error : new Error(String(error));
				},
			);
		},
		releaseStep() {
			activeGate?.release();
		},
		get stepping() {
			return activeGate !== null;
		},
		onStepGate(listener) {
			stepGateListeners.add(listener);
			return () => stepGateListeners.delete(listener);
		},
		cancel() {
			executor.cancel();
		},
		clearQueue() {
			queue.clear();
		},
		dispose() {
			if (disposed) return; // 幂等：重复卸载不该第二次动 DOM 与 GPU
			disposed = true;
			cancelFrame();
			observer.disconnect();
			/*
			 * 停在放行闸上的那一趟没有别的出路：卸载之后没人再按得到「单步运行」，
			 * 它就永远挂在闸上（那趟执行与它的 promise 都收不了摊）。取消它——那是执行侧唯一的打断手段。
			 * 只管单步那一趟：整趟跑着时卸载不改变原来的行为。
			 */
			if (activeGate !== null) {
				activeGate = null;
				executor.cancel();
			}
			stepListeners.clear();
			planStepListeners.clear();
			stepGateListeners.clear();
			queueListeners.clear();
			queueErrorListeners.clear();
			frameListeners.clear();
			// 先停循环、摘 canvas，再放 GPU 资源：顺序反了会在已释放的上下文上多画一帧
			if (ownsCanvas && canvas.parentElement === host) host.removeChild(canvas);
			// 舞台自己收（含 `renderer.dispose()` 与 `forceContextLoss()`，见 `disposeStageResources`）；
			// 它不收就退到兜底，至少把机械臂这棵树放掉——不留一份没人管的几何与材质
			if (stage.dispose) stage.dispose();
			else disposeSceneFallback();
		},
	};

	// size 是「当前画面多大」，读的是宿主量出来的实测值（每次 ResizeObserver 后重新读一遍）
	Object.defineProperty(device, 'size', {
		get: () => ({ width: host.clientWidth, height: host.clientHeight }),
		enumerable: true,
	});

	return device;
}
