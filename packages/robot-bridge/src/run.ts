/**
 * HTTP 侧的**计划执行器**：把一份编译产物真的发出去、真的轮询、按上一步的成败选臂。
 *
 * 为什么要有这一层：`compile.ts` 产出的是**声明**（一列调用），一行网络代码都没有——
 * 那一版能证明的只有「形状对得上 pydantic」。这一层才把链走完：`POST /v1/skills/execute`
 * 换回 202，然后**在客户端**轮询 `GET /v1/tasks/{task_id}` 到终态，再据那个终态决定走哪条臂。
 * 于是「下发 → 轮询 → 终态 → 选臂」是在真 HTTP 上跑通的，不是形状对账。
 *
 * 四种事件各说各的一件事，**不许混**（这是这一层最要紧的纪律）：
 * - `unreachable`：请求**发不出去**（连不上、404 技能不在 bridge 的目录里、回了个读不懂的东西）。
 *   与「这一步跑失败了」是两回事——机器可能一步都没动，把它记成失败会让后面的计划照着
 *   「这一步试过了、没成」往下走（那是编造）。所以它单独一个状态，并且**就地停**：
 *   发都发不出去，后面几步的成败无从谈起。
 * - `failed`：请求发出去了、轮询到了终态，而那个终态**不算走完**（`stepCompleted` 为假，
 *   口径在 `compile.ts`：设备说成但 state 是被取消，仍是没走完）。
 * - `completed`：轮询到终态且走完。
 * - `skipped`：这一步没做，且**不是**因为失败（现在只有一种：分支前面没有可读的 `last.success`）。
 *
 * 分支读的量是 `reportedSuccess`（不是 `stepCompleted`），因为 `if` 的条件写的是
 * `last.success`——「设备对这一次执行怎么说」与「这一步算不算走完」是两个问题，
 * 两个函数在 `compile.ts` 里分开写着，这里不合并。
 *
 * 轮询预算是 `pollDeadlineMs` 给的（计划的 `timeoutSec` ?? 30 秒，再加 30 秒余量），
 * 但**按间隔累加来记**而不是读墙上时钟：`sleep` 是可以注入的（测试注入的那一个不推进真实时间），
 * 读时钟会让「等够没有」在注入下失去意义——两边各算一套迟早分叉。累加的正是这个量：
 * 每隔 `intervalMs` 问一次，问够了预算就不再等。默认（真 sleep）下它与墙上时钟是一回事。
 */
import type { ZodError } from 'zod';
import type { StepGate } from '@codecanvas/contracts';
import {
	BRIDGE_EXECUTE_PATH,
	isTerminalTaskState,
	pollDeadlineMs,
	reportedSuccess,
	stepCompleted,
	type CompiledPlan,
	type PlanCall,
	type PollSpec,
} from './compile';
import { executeAcceptedSchema, healthSchema, taskResultSchema, type Health, type TaskResult } from './models';

export interface RunOverHttpOptions {
	/** bridge 的地址，例如 `http://127.0.0.1:8788`（尾部斜杠会被去掉）。 */
	readonly baseUrl: string;
	/** 测试注入：换掉全局 `fetch`（真的发请求是缺省行为）。 */
	readonly fetchImpl?: typeof fetch;
	/** 测试注入：换掉 `setTimeout` 那种等法。缺省是会**被 signal 打断**的真等。 */
	readonly sleep?: (ms: number) => Promise<void>;
	/** 两次轮询之间等多久。缺省 500（与旧引擎一致，见 `DEFAULT_POLL_SPEC`）。 */
	readonly pollIntervalMs?: number;
	/** 轮询截止时间的余量（秒）。缺省 30（同上）。 */
	readonly pollMarginSec?: number;
	/** 每个请求都带上的头（鉴权 token 走这里，bridge 那边要 Bearer）。 */
	readonly headers?: Record<string, string>;
	/** 取消：打断等待与轮询。它**不是**失败——见文件头那条纪律。 */
	readonly signal?: AbortSignal;
	/**
	 * **单步放行闸**：给了就是单步模式——每个**顶层步**之间等一次 `release()`。
	 *
	 * 「一个顶层步」= 编译产物里 `stepPath` 没有 `.` 的那一批调用（`'1'` / `'2'`）；臂里的调用
	 * （`'1.then.0'`）不各停一次——一次放行 = 流程画布上的一张卡，两条执行路同一个口径。
	 * 第一个顶层步**不等**：按下「单步运行」那一刻就该走完第一步。
	 *
	 * 判据是「下一步的请求真的没发出去」：等放行是在这一段的**请求之前**，所以停着的时候
	 * 设备那边一个新请求都收不到。取消（`signal`）能叫醒它——闸收信号，理由与形状见
	 * `@codecanvas/contracts` 的 `StepGate`。
	 */
	readonly stepGate?: StepGate;
	/** 每出一条事件就调一次（界面上「看着计划走」用的就是它）。 */
	readonly onStep?: (event: PlanRunEvent) => void;
}

/**
 * 计划里的一个步发生的事。`stepPath` 与编译产物、执行侧、studio 是同一份口径
 * （`'1'` / `'1.then.0'` 这种），所以界面能把它对回计划里的那一格。
 *
 * 一个 `execute` 出两条（`running` 说「请求已经在设备那边了」、随后是它的一条终态）；
 * `wait` 与 `branch` 没有请求，各出一条——它们也是计划里的步，不能因为「没发东西」就不出声。
 */
export type PlanRunEvent = {
	readonly stepPath: string;
	readonly state: 'running' | 'completed' | 'failed' | 'unreachable' | 'skipped';
	readonly taskId?: string;
	readonly detail?: string;
};

export interface PlanRunResult {
	/** 整份计划走完了吗。**被容忍的失败不拦**（`onFailure: 'continue'` 的那一步照报 failed，但计划继续）。 */
	readonly ok: boolean;
	readonly events: readonly PlanRunEvent[];
	/** 没走完的原因（`ok` 为真时没有这一栏）。 */
	readonly reason?: string;
}

/** 一次 `POST /v1/skills/execute` 的结论。 */
type SubmitOutcome =
	| { readonly kind: 'accepted' }
	| { readonly kind: 'unreachable'; readonly detail: string }
	| { readonly kind: 'aborted' };

/** 一轮轮询的结论：读到终态 / 预算用完 / 读不到。 */
type PollOutcome =
	| { readonly kind: 'result'; readonly result: TaskResult }
	| { readonly kind: 'timeout'; readonly detail: string }
	| { readonly kind: 'unreachable'; readonly detail: string }
	| { readonly kind: 'aborted' };

/** 一条 `execute` 调用（联合里那一种）。 */
type ExecuteCall = Extract<PlanCall, { kind: 'execute' }>;
type WaitCall = Extract<PlanCall, { kind: 'wait' }>;
type BranchCall = Extract<PlanCall, { kind: 'branch' }>;

/** 一段连续的调用（一条臂在编译产物里就是一段连续区间，见 `runCompiledPlan` 里的 `armEnd`）。 */
interface CallRange {
	readonly start: number;
	readonly end: number;
}

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/**
 * 这一步是不是**顶层步**：路径里没有 `.`（`'1'` 是顶层，`'1.then.0'` 在臂里）。
 * 单步的「一步」就是这个口径——与执行侧、studio 的步骤行说的是同一件事。
 */
const isTopLevelPath = (stepPath: string): boolean => !stepPath.includes('.');

/** 报文本截短：错误信息进事件与 reason，太长会把界面撑坏（原样仍然在对方那边）。 */
const shorten = (text: string, limit = 200): string => (text.length <= limit ? text : `${text.slice(0, limit)}…`);

/**
 * 读一栏不认识的形状（联合之外的调用只能这么看，不用 `any`）——只读自有的一栏，不猜、不递归。
 * 走属性描述符是因为索引一个 `object` 会被 TS 拒（没有索引签名），而 `in` 在这里不缩窄。
 */
const readField = (value: unknown, key: string): unknown => {
	if (typeof value !== 'object' || value === null) return undefined;
	const found: unknown = Object.getOwnPropertyDescriptor(value, key)?.value;
	return found;
};

const parseJson = (text: string): unknown => {
	try {
		const parsed: unknown = JSON.parse(text);
		return parsed;
	} catch {
		// 解析不出来也是一种「形状不对」：交给 zod 报（它的话比这里编的准）
		return undefined;
	}
};

/** zod 的问题清单压成一行：字段名 + 那句话，前三条够了。 */
const describeZodError = (error: ZodError): string =>
	error.issues
		.slice(0, 3)
		.map((issue) => `${issue.path.map(String).join('.') || '<根>'}: ${issue.message}`)
		.join('；');

/**
 * 缺省的等：**被打断就立刻返回**（等一半被取消却还在睡，会让「取消」要等到这一步睡完才生效）。
 * 它不抛异常——取消由调用方在醒来之后看 `signal.aborted` 判，只有一处判据。
 */
const sleepUntil = (ms: number, signal: AbortSignal | undefined): Promise<void> =>
	new Promise((resolve) => {
		if (signal === undefined) {
			setTimeout(resolve, ms);
			return;
		}
		let timer: ReturnType<typeof setTimeout> | undefined;
		const done = (): void => {
			if (timer !== undefined) clearTimeout(timer);
			signal.removeEventListener('abort', done);
			resolve();
		};
		timer = setTimeout(done, ms);
		if (signal.aborted) {
			done();
			return;
		}
		signal.addEventListener('abort', done, { once: true });
	});

/**
 * 走完一份编译产物。
 *
 * 顺序**照 `compiled.calls`**（编译产物是计划的深度优先展开，顺序稳定）；分支那一步只走被选中
 * 的那条臂的调用，另一条臂的调用**一条都不发**（它们还在 `calls` 里，被 `runRange` 的区间跳过）。
 */
export const runCompiledPlan = async (
	compiled: CompiledPlan,
	options: RunOverHttpOptions,
): Promise<PlanRunResult> => {
	const events: PlanRunEvent[] = [];
	const emit = (event: PlanRunEvent): void => {
		events.push(event);
		options.onStep?.(event);
	};

	const fetchImpl: typeof fetch = options.fetchImpl ?? fetch;
	const signal = options.signal;
	const aborted = (): boolean => signal?.aborted === true;
	const sleep = options.sleep ?? ((ms: number): Promise<void> => sleepUntil(ms, signal));
	const base = options.baseUrl.replace(/\/+$/, '');
	const calls = compiled.calls;
	const stepGate = options.stepGate;
	/**
	 * 闸等的那条信号。`options.signal` 缺席时自己起一个**永远不会 abort** 的：
	 * 闸的 `wait()` 收 `AbortSignal`（形状在 contracts 里只有一份），这里不给它第二种形状。
	 */
	const gateSignal = signal ?? new AbortController().signal;

	/** 停下来的原因；`undefined` ＝ 还在走。计划是顺序执行的，所以一个标志就够。 */
	let stop: string | undefined;
	/** 上一步轮询回来的 `reportedSuccess`——**分支读的就是这个量**（`wait` 不改它）。 */
	let lastSuccess: boolean | undefined;

	const headersFor = (withBody: boolean): Record<string, string> => ({
		...(withBody ? { 'content-type': 'application/json' } : {}),
		...options.headers,
	});

	const request = (path: string, init: RequestInit): Promise<Response> =>
		fetchImpl(`${base}${path}`, signal === undefined ? init : { ...init, signal });

	// -------------------------------------------------------------------------
	// 下发 + 轮询
	// -------------------------------------------------------------------------

	/** 发一条 execute。**成败不进这个响应**（bridge 立刻回 202），所以这里只回答「发出去没有」。 */
	const submit = async (call: ExecuteCall): Promise<SubmitOutcome> => {
		let response: Response;
		try {
			response = await request(BRIDGE_EXECUTE_PATH, {
				method: 'POST',
				headers: headersFor(true),
				body: JSON.stringify(call.request),
			});
		} catch (error) {
			if (aborted()) return { kind: 'aborted' };
			return { kind: 'unreachable', detail: `连不上 bridge：${messageOf(error)}` };
		}

		const text = await response.text();
		if (!response.ok) {
			// 404 是这里最要紧的一种：技能不在 bridge 的目录里。**它不是「这一步失败了」**
			// ——请求被挡在门外，机器一步都没动，记成失败会让后面的分支照着编造的成败走。
			const hint =
				response.status === 404
					? '（404 ＝ bridge 不认识这个技能：它的目录里没有它；这一步的请求被挡在门外，机器一步都没动）'
					: '';
			return {
				kind: 'unreachable',
				detail: `POST ${BRIDGE_EXECUTE_PATH} 回了 ${String(response.status)}：${shorten(text.trim())}${hint}`,
			};
		}

		const accepted = executeAcceptedSchema.safeParse(parseJson(text));
		if (!accepted.success) {
			return {
				kind: 'unreachable',
				detail: `202 的响应形状不对（${describeZodError(accepted.error)}）：${shorten(text.trim())}`,
			};
		}
		return { kind: 'accepted' };
	};

	/** 轮询到终态。终态判据是 `isTerminalTaskState`（与 bridge 的 `app.py` 同一份口径）。 */
	const poll = async (call: ExecuteCall, spec: PollSpec): Promise<PollOutcome> => {
		const deadlineMs = pollDeadlineMs(call.request.timeout_sec ?? undefined, spec);
		let waitedMs = 0;

		for (;;) {
			if (aborted()) return { kind: 'aborted' };

			let response: Response;
			try {
				response = await request(call.pollPath, { method: 'GET', headers: headersFor(false) });
			} catch (error) {
				if (aborted()) return { kind: 'aborted' };
				return { kind: 'unreachable', detail: `轮询发不出去：${messageOf(error)}` };
			}

			const text = await response.text();
			if (!response.ok) {
				// 202 说收下了、轮询却说不认识这个 task_id：这条链断了，不是这一步失败了
				return {
					kind: 'unreachable',
					detail: `GET ${call.pollPath} 回了 ${String(response.status)}：${shorten(text.trim())}`,
				};
			}

			const parsed = taskResultSchema.safeParse(parseJson(text));
			if (!parsed.success) {
				return {
					kind: 'unreachable',
					detail: `轮询响应的形状不对（${describeZodError(parsed.error)}）：${shorten(text.trim())}`,
				};
			}

			const result = parsed.data;
			if (isTerminalTaskState(result.state)) return { kind: 'result', result };
			if (waitedMs >= deadlineMs) {
				return {
					kind: 'timeout',
					detail: `等了 ${String(waitedMs)}ms（预算 ${String(deadlineMs)}ms）仍是 ${result.state}，没到终态`,
				};
			}
			await sleep(spec.intervalMs);
			waitedMs += spec.intervalMs;
		}
	};

	/** 一条 execute 走完：下发 → 轮询 → 报终态 →（按 `onFailure`）决定停不停。 */
	const runExecute = async (call: ExecuteCall): Promise<void> => {
		const taskId = call.request.task_id;
		// 轮询的间隔与余量：带 plan 那一份缺省，允许调用方整体覆写（旧引擎也是这么给的）
		const spec: PollSpec = {
			intervalMs: options.pollIntervalMs ?? call.poll.intervalMs,
			marginSec: options.pollMarginSec ?? call.poll.marginSec,
			defaultTimeoutSec: call.poll.defaultTimeoutSec,
		};

		emit({
			stepPath: call.stepPath,
			state: 'running',
			taskId,
			detail: `POST ${BRIDGE_EXECUTE_PATH} skill=${call.request.skill}`,
		});

		const submitted = await submit(call);
		if (submitted.kind === 'aborted') {
			stop = `运行被取消（AbortSignal）：第 ${call.stepPath} 步的请求已经发出去了，设备那边可能还在跑——我们不替它下结论`;
			return;
		}
		if (submitted.kind === 'unreachable') {
			emit({ stepPath: call.stepPath, state: 'unreachable', taskId, detail: submitted.detail });
			stop = `第 ${call.stepPath} 步发不出去（这与「这一步跑失败了」不是一回事）：${submitted.detail}`;
			return;
		}

		const outcome = await poll(call, spec);
		if (outcome.kind === 'aborted') {
			stop = `运行被取消（AbortSignal）：第 ${call.stepPath} 步轮询到一半（task_id=${taskId}），设备那边可能还在跑——我们不替它下结论`;
			return;
		}
		if (outcome.kind === 'unreachable') {
			emit({ stepPath: call.stepPath, state: 'unreachable', taskId, detail: outcome.detail });
			stop = `第 ${call.stepPath} 步读不到结论（这与「这一步跑失败了」不是一回事）：${outcome.detail}`;
			return;
		}
		if (outcome.kind === 'timeout') {
			// 超时**是**失败：请求发出去了、机器可能动了，只是没在预算里给结论
			lastSuccess = false;
			emit({ stepPath: call.stepPath, state: 'failed', taskId, detail: outcome.detail });
			if (call.onFailure !== 'continue') {
				stop = `第 ${call.stepPath} 步在预算里没到终态：${outcome.detail}（这一步没写 onFailure: 'continue'，计划停在这里）`;
			}
			return;
		}

		const result = outcome.result;
		const done = stepCompleted(result);
		// 分支读 reportedSuccess（设备对这一次执行的说法）；「算不算走完」是另一个问题（stepCompleted）
		lastSuccess = reportedSuccess(result);
		emit({
			stepPath: call.stepPath,
			state: done ? 'completed' : 'failed',
			taskId,
			detail:
				`终态 state=${result.state} success=${String(result.success)}` +
				(result.error_code === '' ? '' : ` error_code=${result.error_code}`) +
				(result.message === '' ? '' : ` message=${result.message}`) +
				// 下发了哪些原语也带上：它是「设备真的报了什么」的证据，不是我们编的措辞
				(result.executed_primitives.length === 0 ? '' : ` primitives=[${result.executed_primitives.join(', ')}]`),
		});

		if (!done && call.onFailure !== 'continue') {
			stop = `第 ${call.stepPath} 步失败（state=${result.state}）：这一步没写 onFailure: 'continue'，计划停在这里（缺省就是停）`;
		}
	};

	/** 一条 wait：客户端真的等，bridge 不参与；它**不改** `lastSuccess`。 */
	const runWait = async (call: WaitCall): Promise<void> => {
		await sleep(call.seconds * 1000);
		if (aborted()) {
			stop = `运行被取消（AbortSignal）：第 ${call.stepPath} 步的等待被打断`;
			return;
		}
		emit({
			stepPath: call.stepPath,
			state: 'completed',
			detail: `等了 ${String(call.seconds)} 秒（bridge 不参与，这一步不产生成败）`,
		});
	};

	/** 一条 branch：条件读的是**上一步**的 `reportedSuccess`。只走被选中那条臂的调用。 */
	const runBranch = async (call: BranchCall, thenRange: CallRange, elseRange: CallRange): Promise<void> => {
		if (lastSuccess === undefined) {
			// 前面还没有走过会产生成败的步（这是计划开头，或前面只有 wait）：条件判不出来。
			// 保守＝跳过这一步，**不猜**一条臂走（猜错就是让机器按一个编造的条件动）。
			emit({
				stepPath: call.stepPath,
				state: 'skipped',
				detail: '条件读的是上一步的 last.success，而前面还没有走过会产生成败的步——判不出来就不猜一条臂走（保守）',
			});
			return;
		}

		const { op, value } = call.condition;
		const matches = op === '==' ? lastSuccess === value : lastSuccess !== value;
		const taken = matches ? thenRange : elseRange;
		const takenName = matches ? 'then' : 'else';
		const steps = taken.end - taken.start;

		emit({
			stepPath: call.stepPath,
			state: 'completed',
			detail:
				`条件 last.success ${op} ${String(value)} ${matches ? '成立' : '不成立'} → 走 ${takenName} 臂` +
				(steps === 0 ? '（这一臂没有步：计划没写 else，什么也不做）' : `（${String(steps)} 条调用）`),
		});

		if (steps > 0) await runRange(taken.start, taken.end);
	};

	/**
	 * 编译产物里一条臂到哪儿结束。
	 *
	 * 编译是深度优先的（分支自己 → then 臂 → else 臂），所以**属于某条臂的调用永远是一段连续区间**
	 * ——不需要在这里重建计划树，扫一遍前缀就够了。`then` 臂后面紧跟着 `else` 臂，
	 * 没有 `else` 时那一段是空的，于是「分支之后的步」自然接在后面。
	 */
	const armEnd = (from: number, path: string): number => {
		let end = from;
		while (end < calls.length) {
			const call = calls[end];
			if (call === undefined || (call.stepPath !== path && !call.stepPath.startsWith(`${path}.`))) break;
			end += 1;
		}
		return end;
	};

	/**
	 * `primitive` 步**编不出调用**（`limits.ts` 里 `where: 'nowhere'`），所以执行器不该看见它
	 * ——真看见了就是编译产物有 bug。报一条明确的 `failed` 并停下，**不静默跳过**：
	 * 静默跳过等于假装这一步不存在，而它明明在计划里。
	 */
	const reportUnknownCall = (call: unknown): void => {
		const stepPath = readField(call, 'stepPath');
		const kind = readField(call, 'kind');
		emit({
			stepPath: typeof stepPath === 'string' ? stepPath : '<未知>',
			state: 'failed',
			detail: `执行器看到一个编译期不该产出的调用（kind=${typeof kind === 'string' ? kind : '没有 kind'}；原样=${shorten(JSON.stringify(call) ?? '')}）——这是 bug，不静默跳过`,
		});
		stop = '编译产物里出现了执行器不认的调用（见那条 failed 事件）';
	};

	/** 走 `[from, to)` 这一段调用。分支在这里决定往哪条臂递归。 */
	const runRange = async (from: number, to: number): Promise<void> => {
		let index = from;
		while (index < to && stop === undefined) {
			const call = calls[index];
			if (call === undefined) return; // 到这儿就是这一段走完了

			/*
			 * 单步：进一个**顶层步**之前先等一次放行。两件事在这儿说清：
			 * ① 臂里的调用（`'1.then.0'`）不等——一次放行 = 一个顶层步，与流程画布的一张卡同口径；
			 * ② `index > 0`：整套调用的第一个**不等**（按下「单步运行」那一刻就该走完第一步）。
			 */
			if (stepGate !== undefined && index > 0 && isTopLevelPath(call.stepPath)) {
				await stepGate.wait(gateSignal);
				if (aborted()) {
					stop = `运行被取消（AbortSignal）：停在放行闸上，第 ${call.stepPath} 步的请求一个字节都没发出去`;
					return;
				}
			}

			index += 1;

			if (call.kind === 'execute') {
				await runExecute(call);
				continue;
			}
			if (call.kind === 'wait') {
				await runWait(call);
				continue;
			}
			if (call.kind === 'branch') {
				const thenRange: CallRange = { start: index, end: armEnd(index, `${call.stepPath}.then`) };
				const elseRange: CallRange = { start: thenRange.end, end: armEnd(thenRange.end, `${call.stepPath}.else`) };
				index = elseRange.end;
				await runBranch(call, thenRange, elseRange);
				continue;
			}
			reportUnknownCall(call);
		}
	};

	await runRange(0, calls.length);

	const reason = stop;
	return reason === undefined ? { ok: true, events } : { ok: false, events, reason };
};

// ---------------------------------------------------------------------------
// 对面是谁
// ---------------------------------------------------------------------------

/** `GET /v1/health` 的路径。它**不要 token**（bridge 那边唯一没挂守卫的端点）。 */
export const BRIDGE_HEALTH_PATH = '/v1/health';

export interface BridgeProbeOptions {
	/** bridge 的地址，例如 `http://127.0.0.1:8788`（尾部斜杠会被去掉）。 */
	readonly baseUrl: string;
	/** 测试注入：换掉全局 `fetch`。 */
	readonly fetchImpl?: typeof fetch;
	/** 与下发同一批头（真身那边也认，见 `RunOverHttpOptions.headers`）。 */
	readonly headers?: Record<string, string>;
	readonly signal?: AbortSignal;
}

/** 探到的那句话：`service` 与 `version` 都是**它自己报的**，这里一个字都不改。 */
export type BridgeProbe =
	| { readonly ok: true; readonly health: Health }
	| { readonly ok: false; readonly detail: string };

/**
 * 对面是谁：问一句 `GET /v1/health`。
 *
 * 为什么要有这个探针：`POST /v1/skills/execute` 的 202 与随后的终态只说明**有人接了这件活**，
 * 不说明接活的是谁。开发替身（`tools/fake-bridge`）没有机器人、没有夹爪——它收到什么都会
 * 按时回一个 `success=true`。那份「走完了」是真 HTTP 换回来的，可它不是一次真的抓取。
 * 把对面**自己报的**服务名与版本摆到屏幕上，看的人自己就能判断那边是替身还是真身，
 * 不必由我们替他下结论（也就不会有「界面说这是真机」这种我们自己编的话）。
 *
 * 探不到**不是失败**：有些部署不给 health，或者跨网段。所以它返回一句如实的话，不抛。
 */
export const probeBridge = async (options: BridgeProbeOptions): Promise<BridgeProbe> => {
	const fetchImpl = options.fetchImpl ?? fetch;
	// 先把两头空白去掉再判空：地址框里只剩空格与判空是同一件事（「还没填」）。
	const base = options.baseUrl.trim().replace(/\/+$/, '');
	if (base === '') return { ok: false, detail: '还没填 bridge 地址' };

	let response: Response;
	try {
		response = await fetchImpl(
			`${base}${BRIDGE_HEALTH_PATH}`,
			options.signal === undefined
				? { method: 'GET', headers: options.headers }
				: { method: 'GET', headers: options.headers, signal: options.signal },
		);
	} catch (error) {
		return { ok: false, detail: `连不上：${messageOf(error)}` };
	}

	const text = await response.text();
	if (!response.ok) {
		return { ok: false, detail: `${BRIDGE_HEALTH_PATH} 回了 ${String(response.status)}：${shorten(text.trim())}` };
	}

	let raw: unknown;
	try {
		raw = JSON.parse(text);
	} catch {
		return { ok: false, detail: `回的读不懂（不是 JSON）：${shorten(text.trim())}` };
	}
	const parsed = healthSchema.safeParse(raw);
	if (!parsed.success) return { ok: false, detail: `回的不是一份 Health：${shorten(text.trim())}` };
	return { ok: true, health: parsed.data };
};
