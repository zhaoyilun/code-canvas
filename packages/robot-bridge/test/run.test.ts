/**
 * 执行器的边界：超时、形状不对、404、网络错、分支没得判、编译期不该产出的调用、取消。
 *
 * 这里**注入** `fetchImpl` 与 `sleep`：要考的是「执行器怎么读结论」，不是 HTTP 本身
 * （真发请求那条路在 `run-http.test.ts`，那里起的是真服务）。
 *
 * 一条纪律在这里被反复钉：**「发不出去」不是「跑失败了」**。两者的事件状态不同
 * （`unreachable` / `failed`），后续行为也不同——前者就地停（机器可能一步没动，后面的
 * 成败无从谈起），后者才轮到 `onFailure` 说话。
 */
import { describe, expect, it, vi } from 'vitest';
import { SKILL_PLAN_SCHEMA_VERSION, createStepGate, type SkillPlan, type SkillPlanStep } from '@codecanvas/contracts';
import { ROBOFRAME_SO101_CATALOG } from '@codecanvas/capabilities';
import {
	BRIDGE_HEALTH_PATH,
	compilePlanToCalls,
	probeBridge,
	runCompiledPlan,
	type CompiledPlan,
	type PlanRunResult,
} from '../src/index';

const DEVICE = 'so101_single_arm';

const planOf = (steps: readonly SkillPlanStep[]): SkillPlan => ({
	schemaVersion: SKILL_PLAN_SCHEMA_VERSION,
	robot: DEVICE,
	plan: steps,
});

const compile = (steps: readonly SkillPlanStep[], taskIdPrefix?: string): CompiledPlan =>
	compilePlanToCalls(planOf(steps), {
		catalog: ROBOFRAME_SO101_CATALOG,
		deviceRef: DEVICE,
		...(taskIdPrefix === undefined ? {} : { taskIdPrefix }),
	});

interface StubCall {
	readonly url: string;
	readonly method: string;
	readonly body: string | undefined;
}

/** 一次假请求的台账：测得的不只是「回了什么」，还有「发了什么、发了几次」。 */
interface FetchStub {
	readonly fetchImpl: typeof fetch;
	readonly calls: StubCall[];
}

const stubFetch = (route: (call: StubCall) => Response | Promise<Response>): FetchStub => {
	const calls: StubCall[] = [];
	const fetchImpl: typeof fetch = async (input, init) => {
		const url = input instanceof Request ? input.url : String(input);
		const call: StubCall = {
			url,
			method: init?.method ?? 'GET',
			body: typeof init?.body === 'string' ? init.body : undefined,
		};
		calls.push(call);
		return await route(call);
	};
	return { fetchImpl, calls };
};

const jsonResponse = (status: number, payload: unknown): Response =>
	new Response(JSON.stringify(payload), { status, headers: { 'content-type': 'application/json' } });

const accepted = (taskId: string, skill: string): Response => jsonResponse(202, { accepted: true, task_id: taskId, skill });

const running = (taskId: string, skill: string): Response =>
	jsonResponse(200, { task_id: taskId, skill, state: 'executing', success: null });

const withSkill = (result: PlanRunResult, stepPath: string) => result.events.filter((event) => event.stepPath === stepPath);

/** 记录注入的 sleep（缺省立刻返回：这一层不考时间，只考「有没有按这个时长去等」）。 */
const recordingSleep = (): { sleep: (ms: number) => Promise<void>; slept: number[] } => {
	const slept: number[] = [];
	return {
		slept,
		sleep: async (ms: number): Promise<void> => {
			slept.push(ms);
		},
	};
};

const run = (compiled: CompiledPlan, stub: FetchStub, extra: Partial<Parameters<typeof runCompiledPlan>[1]> = {}) =>
	runCompiledPlan(compiled, { baseUrl: 'http://bridge.test', fetchImpl: stub.fetchImpl, sleep: async () => {}, ...extra });

// ---------------------------------------------------------------------------

describe('成功那一条路走通了', () => {
	it('下发 → 轮询到终态 → completed，事件与请求都对得上', async () => {
		const compiled = compile([{ step: 'skill', skill: 'inspect_scene' }]);
		const call = compiled.calls[0];
		if (call?.kind !== 'execute') throw new Error('预期一条 execute');
		const taskId = call.request.task_id;

		let polls = 0;
		const stub = stubFetch(({ method, url }) => {
			if (method === 'POST') return accepted(taskId, 'inspect_scene');
			if (!url.endsWith(`/v1/tasks/${taskId}`)) throw new Error(`轮询到了别的路径：${url}`);
			polls += 1;
			return polls === 1
				? running(taskId, 'inspect_scene')
				: jsonResponse(200, {
						task_id: taskId,
						skill: 'inspect_scene',
						state: 'completed',
						success: true,
						executed_primitives: ['move_to_named_pose'],
					});
		});

		const slept = recordingSleep();
		const result = await run(compiled, stub, { sleep: slept.sleep });

		expect(result.ok).toBe(true);
		expect(result.reason).toBeUndefined();
		expect(result.events.map((event) => `${event.stepPath}:${event.state}`)).toEqual(['0:running', '0:completed']);
		expect(result.events[1]?.taskId).toBe(taskId);
		expect(result.events[1]?.detail).toContain('completed');
		// 第一次读到 executing，所以中间真的等过一次（默认间隔就写在编译产物的 pollSpec 里）
		expect(polls).toBe(2);
		expect(slept.slept).toEqual([call.poll.intervalMs]);
		expect(stub.calls.map((item) => item.method)).toEqual(['POST', 'GET', 'GET']);
	});
});

describe('轮询：超时与读不懂', () => {
	it('预算用完仍是 executing → failed + reason，且不是 unreachable', async () => {
		const compiled = compile([{ step: 'skill', skill: 'wave_hello', timeoutSec: 1 }]);
		const call = compiled.calls[0];
		if (call?.kind !== 'execute') throw new Error('预期一条 execute');

		const stub = stubFetch(({ method }) =>
			method === 'POST' ? accepted(call.request.task_id, 'wave_hello') : running(call.request.task_id, 'wave_hello'),
		);
		const slept = recordingSleep();
		// interval 4000 + 余量 0：预算 = (1 + 0) * 1000 = 1000ms，于是问两次就到头
		const result = await run(compiled, stub, { sleep: slept.sleep, pollIntervalMs: 4000, pollMarginSec: 0 });

		expect(result.ok).toBe(false);
		expect(result.reason).toContain('没到终态');
		expect(result.reason).toContain('第 0 步');
		expect(result.events.map((event) => event.state)).toEqual(['running', 'failed']);
		expect(result.events[1]?.detail).toContain('预算');
		expect(stub.calls.filter((item) => item.method === 'GET')).toHaveLength(2);
		expect(slept.slept).toEqual([4000]);
	});

	it('轮询的响应形状不对 → 明确报出来（不说成「这一步失败了」）', async () => {
		const compiled = compile([{ step: 'skill', skill: 'wave_hello' }]);
		const call = compiled.calls[0];
		if (call?.kind !== 'execute') throw new Error('预期一条 execute');

		const stub = stubFetch(({ method }) =>
			method === 'POST' ? accepted(call.request.task_id, 'wave_hello') : jsonResponse(200, { 不是: 'TaskResult' }),
		);
		const result = await run(compiled, stub);

		expect(result.ok).toBe(false);
		expect(result.events[1]?.state).toBe('unreachable');
		expect(result.events[1]?.detail).toContain('轮询响应的形状不对');
		expect(result.events[1]?.detail).toContain('task_id');
		expect(result.reason).toContain('不是一回事');
	});

	it('202 的响应形状不对 → 同样报出来', async () => {
		const compiled = compile([{ step: 'skill', skill: 'wave_hello' }]);
		const stub = stubFetch(() => jsonResponse(202, { accepted: true, task_id: 42, skill: 'wave_hello' }));
		const result = await run(compiled, stub);

		expect(result.events[1]?.state).toBe('unreachable');
		expect(result.events[1]?.detail).toContain('202 的响应形状不对');
		// 轮询一次都没有：拿到的东西不可信，就不往下走
		expect(stub.calls).toHaveLength(1);
	});
});

describe('「发不出去」与「跑失败」是两回事', () => {
	it('execute 回 404（技能不在 bridge 的目录里）→ unreachable，不是 failed', async () => {
		const compiled = compile([{ step: 'skill', skill: 'wave_hello' }]);
		const stub = stubFetch(() => jsonResponse(404, { detail: 'unknown skill: wave_hello' }));
		const result = await run(compiled, stub);

		expect(result.events.map((event) => event.state)).toEqual(['running', 'unreachable']);
		expect(result.events.some((event) => event.state === 'failed')).toBe(false);
		expect(result.events[1]?.detail).toContain('404');
		expect(result.events[1]?.detail).toContain('unknown skill');
		expect(result.reason).toContain('发不出去');
		// 它是「发不出去」：一条轮询都不该有（没有 task 可以问）
		expect(stub.calls.map((item) => item.method)).toEqual(['POST']);
	});

	it('网络错（fetch 抛）→ unreachable，并停下', async () => {
		const compiled = compile([
			{ step: 'skill', skill: 'wave_hello' },
			{ step: 'skill', skill: 'nod_yes' },
		]);
		const stub = stubFetch(() => {
			throw new TypeError('fetch failed');
		});
		const result = await run(compiled, stub);

		expect(result.events.map((event) => event.state)).toEqual(['running', 'unreachable']);
		expect(result.reason).toContain('连不上 bridge');
		// 第二步一条请求都没发（发都发不出去，后面的成败无从谈起）
		expect(stub.calls).toHaveLength(1);
	});

	it('202 说收下了、轮询却 404 → unreachable（这条链断了）', async () => {
		const compiled = compile([{ step: 'skill', skill: 'wave_hello' }]);
		const call = compiled.calls[0];
		if (call?.kind !== 'execute') throw new Error('预期一条 execute');
		const stub = stubFetch(({ method }) =>
			method === 'POST' ? accepted(call.request.task_id, 'wave_hello') : jsonResponse(404, { detail: 'unknown task' }),
		);
		const result = await run(compiled, stub);

		expect(result.events[1]?.state).toBe('unreachable');
		expect(result.events[1]?.detail).toContain('unknown task');
	});
});

describe('失败之后停不停：读的是编译产物里的 onFailure', () => {
	it('缺省（没写 onFailure）＝ 失败即停，后面的请求一条都不发', async () => {
		const compiled = compile([
			{ step: 'skill', skill: 'wave_hello' },
			{ step: 'skill', skill: 'nod_yes' },
		]);
		const first = compiled.calls[0];
		if (first?.kind !== 'execute') throw new Error('预期一条 execute');

		const stub = stubFetch(({ method }) =>
			method === 'POST'
				? accepted(first.request.task_id, 'wave_hello')
				: jsonResponse(200, {
						task_id: first.request.task_id,
						skill: 'wave_hello',
						state: 'failed',
						success: false,
						error_code: 'skill_failed',
						message: '设备说没成',
					}),
		);
		const result = await run(compiled, stub);

		expect(result.ok).toBe(false);
		expect(result.events.map((event) => `${event.stepPath}:${event.state}`)).toEqual(['0:running', '0:failed']);
		expect(result.events[1]?.detail).toContain('skill_failed');
		expect(result.reason).toContain('没写 onFailure');
		expect(stub.calls).toHaveLength(2);
		// 第二步的 task_id 一个都没出现过
		expect(stub.calls.some((item) => item.body?.includes('nod_yes') ?? false)).toBe(false);
	});

	it('编译产物把 onFailure 带过来了（请求体里没有这一栏）', () => {
		const compiled = compile([
			{ step: 'skill', skill: 'open_gripper_skill', onFailure: 'continue' },
			{ step: 'skill', skill: 'nod_yes' },
		]);
		const [withContinue, withoutPolicy] = compiled.calls;
		if (withContinue?.kind !== 'execute' || withoutPolicy?.kind !== 'execute') throw new Error('预期两条 execute');

		expect(withContinue.onFailure).toBe('continue');
		// 没写的那些不带这个键（缺省＝stop，别在产物里摆一个假的显式值）
		expect(withoutPolicy.onFailure).toBeUndefined();
		// 它是给执行器读的，不是发给 bridge 的：ExecuteRequest 里不许出现这一栏
		expect(Object.keys(withContinue.request)).not.toContain('onFailure');
	});

	it('onFailure: continue → 记 failed、把 last.success 记成 false，然后接着走', async () => {
		const compiled = compile([
			{ step: 'skill', skill: 'open_gripper_skill', onFailure: 'continue' },
			{
				step: 'if',
				condition: { field: 'last.success', op: '==', value: false },
				then: [{ step: 'skill', skill: 'recover_safe_pose' }],
				else: [{ step: 'skill', skill: 'wave_hello' }],
			},
		]);
		const [first] = compiled.calls;
		if (first?.kind !== 'execute') throw new Error('预期一条 execute');
		const thenCall = compiled.calls.find((call) => call.stepPath === '1.then.0');
		if (thenCall?.kind !== 'execute') throw new Error('预期 then 臂的一条 execute');

		const stub = stubFetch(({ method, url }) => {
			if (method === 'POST') {
				return url.includes(thenCall.request.task_id)
					? accepted(thenCall.request.task_id, 'recover_safe_pose')
					: accepted(first.request.task_id, 'open_gripper_skill');
			}
			const skill = url.includes(thenCall.request.task_id) ? 'recover_safe_pose' : 'open_gripper_skill';
			const ok = skill === 'recover_safe_pose';
			return jsonResponse(200, {
				task_id: url.split('/').pop(),
				skill,
				state: ok ? 'completed' : 'failed',
				success: ok,
			});
		});

		const result = await run(compiled, stub);

		expect(result.ok).toBe(true); // 被容忍的失败不拦
		expect(result.events.map((event) => `${event.stepPath}:${event.state}`)).toEqual([
			'0:running',
			'0:failed',
			'1:completed',
			'1.then.0:running',
			'1.then.0:completed',
		]);
		// 条件读的是上一步的 reportedSuccess=false，所以走 then；else 那条臂一条请求都没发
		expect(result.events[2]?.detail).toContain('走 then 臂');
		expect(stub.calls.some((item) => item.body?.includes('wave_hello') ?? false)).toBe(false);
	});

	it('步内失败但 state 是 canceled：设备说成了也不算走完（stepCompleted 那一条）', async () => {
		const compiled = compile([{ step: 'skill', skill: 'wave_hello' }]);
		const call = compiled.calls[0];
		if (call?.kind !== 'execute') throw new Error('预期一条 execute');
		const stub = stubFetch(({ method }) =>
			method === 'POST'
				? accepted(call.request.task_id, 'wave_hello')
				: jsonResponse(200, { task_id: call.request.task_id, skill: 'wave_hello', state: 'canceled', success: true }),
		);
		const result = await run(compiled, stub);

		expect(result.events[1]?.state).toBe('failed');
		expect(result.events[1]?.detail).toContain('state=canceled');
	});
});

describe('wait 与 branch：没有请求，但它们是计划里的步', () => {
	it('wait 真的等（按秒 → 毫秒交给注入的 sleep）', async () => {
		const compiled = compile([
			{ step: 'skill', skill: 'inspect_scene' },
			{ step: 'wait', seconds: 1.5 },
		]);
		const call = compiled.calls[0];
		if (call?.kind !== 'execute') throw new Error('预期一条 execute');
		const stub = stubFetch(({ method }) =>
			method === 'POST'
				? accepted(call.request.task_id, 'inspect_scene')
				: jsonResponse(200, { task_id: call.request.task_id, skill: 'inspect_scene', state: 'completed', success: true }),
		);
		const slept = recordingSleep();
		const result = await run(compiled, stub, { sleep: slept.sleep });

		expect(result.ok).toBe(true);
		expect(slept.slept).toEqual([1500]);
		expect(withSkill(result, '1')).toEqual([
			{ stepPath: '1', state: 'completed', detail: expect.stringContaining('等了 1.5 秒') },
		]);
	});

	it('前面没有可读的 last.success（分支是第一步）→ skipped，不猜一条臂走', async () => {
		const compiled = compile([
			{
				step: 'if',
				condition: { field: 'last.success', op: '==', value: true },
				then: [{ step: 'skill', skill: 'wave_hello' }],
				else: [{ step: 'skill', skill: 'nod_yes' }],
			},
		]);
		// 一条请求都不该发：判不出来就不动
		const stub = stubFetch(() => {
			throw new Error('分支判不出来时不该发任何请求');
		});
		const result = await run(compiled, stub);

		expect(stub.calls).toEqual([]);
		expect(result.ok).toBe(true);
		expect(result.events).toHaveLength(1);
		expect(result.events[0]?.state).toBe('skipped');
		expect(result.events[0]?.stepPath).toBe('0');
		expect(result.events[0]?.detail).toContain('不猜');
	});

	it('wait 不该改 last.success：它后面那个 if 看到的还是等待之前那一步的结果', async () => {
		const compiled = compile([
			{ step: 'skill', skill: 'wave_hello' },
			{ step: 'wait', seconds: 0.1 },
			{
				step: 'if',
				condition: { field: 'last.success', op: '==', value: true },
				then: [{ step: 'skill', skill: 'nod_yes' }],
				else: [{ step: 'skill', skill: 'celebrate' }],
			},
		]);
		const first = compiled.calls[0];
		if (first?.kind !== 'execute') throw new Error('预期一条 execute');
		const thenCall = compiled.calls.find((call) => call.stepPath === '2.then.0');
		if (thenCall?.kind !== 'execute') throw new Error('预期 then 臂的一条 execute');

		const stub = stubFetch(({ method, url }) =>
			method === 'POST'
				? accepted(url.includes(thenCall.request.task_id) ? thenCall.request.task_id : first.request.task_id, 'x')
				: jsonResponse(200, {
						task_id: url.split('/').pop(),
						skill: 'x',
						state: 'completed',
						success: true,
					}),
		);
		const result = await run(compiled, stub, { sleep: async () => {} });

		expect(result.events.find((event) => event.stepPath === '2')?.detail).toContain('走 then 臂');
		expect(stub.calls.some((item) => item.body?.includes('celebrate') ?? false)).toBe(false);
	});
});

describe('编译期不该产出的调用（真看见了就是 bug）', () => {
	it('报一条明确的 failed 并停下，不静默跳过', async () => {
		// 类型系统挡住了这种编译产物（`PlanCall` 里没有 primitive），所以只能从解析结果进来——
		// 模拟的是「别的版本/别处编出来的东西进了这个执行器」
		const bogus: CompiledPlan = JSON.parse(
			JSON.stringify({
				calls: [{ kind: 'primitive', stepPath: '0', primitive: 'open_gripper' }],
				diagnostics: [],
			}),
		);
		const stub = stubFetch(() => {
			throw new Error('不该发任何请求');
		});
		const result = await run(bogus, stub);

		expect(stub.calls).toEqual([]);
		expect(result.ok).toBe(false);
		expect(result.events[0]?.state).toBe('failed');
		expect(result.events[0]?.stepPath).toBe('0');
		expect(result.events[0]?.detail).toContain('不该产出');
		expect(result.events[0]?.detail).toContain('open_gripper');
		expect(result.reason).toContain('不认的调用');
	});
});

describe('取消（AbortSignal）', () => {
	it('打断轮询：停下并给 reason，事件停在 running（不替设备下结论）', async () => {
		const compiled = compile([{ step: 'skill', skill: 'wave_hello' }]);
		const call = compiled.calls[0];
		if (call?.kind !== 'execute') throw new Error('预期一条 execute');

		const controller = new AbortController();
		const stub = stubFetch(({ method }) =>
			method === 'POST' ? accepted(call.request.task_id, 'wave_hello') : running(call.request.task_id, 'wave_hello'),
		);
		let polls = 0;
		const result = await run(compiled, stub, {
			signal: controller.signal,
			sleep: async () => {
				polls += 1;
				// 第一次轮询的间隔里按下取消（就是「轮询被中断」那一刻）
				if (polls === 1) controller.abort();
			},
		});

		expect(result.ok).toBe(false);
		expect(result.reason).toContain('取消');
		expect(result.reason).toContain('不替它下结论');
		// 只发了 POST + 一次 GET：取消之后不再轮询
		expect(stub.calls.map((item) => item.method)).toEqual(['POST', 'GET']);
		// 没有终态事件：这一步在设备那边可能还在跑
		expect(result.events.map((event) => event.state)).toEqual(['running']);
	});

	it('打断 wait', async () => {
		const compiled = compile([{ step: 'wait', seconds: 30 }]);
		const controller = new AbortController();
		const stub = stubFetch(() => {
			throw new Error('wait 不发请求');
		});
		const result = await run(compiled, stub, {
			signal: controller.signal,
			sleep: async () => {
				controller.abort();
			},
		});

		expect(result.ok).toBe(false);
		expect(result.reason).toContain('等待被打断');
		expect(result.events).toEqual([]);
	});
});

describe('缺省值：轮询的间隔与余量来自编译产物那一份（旧引擎的口径）', () => {
	it('不给 pollIntervalMs / pollMarginSec 时，睡的是 call.poll 里的 500、预算按 60 秒算', async () => {
		const compiled = compile([{ step: 'skill', skill: 'wave_hello' }]);
		const call = compiled.calls[0];
		if (call?.kind !== 'execute') throw new Error('预期一条 execute');
		expect(call.poll).toEqual({ intervalMs: 500, marginSec: 30, defaultTimeoutSec: 30 });

		// 永远 executing：让它把预算走满（120 次 × 500ms = 60000ms = (30 + 30) * 1000）
		const stub = stubFetch(({ method }) =>
			method === 'POST' ? accepted(call.request.task_id, 'wave_hello') : running(call.request.task_id, 'wave_hello'),
		);
		const slept = recordingSleep();
		const result = await run(compiled, stub, { sleep: slept.sleep });

		expect(slept.slept).toHaveLength(120);
		expect(slept.slept.every((ms) => ms === 500)).toBe(true);
		expect(result.ok).toBe(false);
		expect(result.reason).toContain('预算 60000ms');
		expect(stub.calls.filter((item) => item.method === 'GET')).toHaveLength(121);
	});

	it('onStep 每出一条事件就调一次（界面靠它看着计划走）', async () => {
		const compiled = compile([{ step: 'skill', skill: 'wave_hello' }]);
		const call = compiled.calls[0];
		if (call?.kind !== 'execute') throw new Error('预期一条 execute');
		const stub = stubFetch(({ method }) =>
			method === 'POST'
				? accepted(call.request.task_id, 'wave_hello')
				: jsonResponse(200, { task_id: call.request.task_id, skill: 'wave_hello', state: 'completed', success: true }),
		);
		const onStep = vi.fn();
		const result = await run(compiled, stub, { onStep });

		expect(onStep).toHaveBeenCalledTimes(result.events.length);
		expect(onStep.mock.calls.map(([event]) => event.state)).toEqual(['running', 'completed']);
	});
});

/*
 * 对面是谁：`GET /v1/health`。
 *
 * 这一条存在的理由很具体：`202` 与终态只说明**有人接了这件活**。开发替身
 * （`tools/fake-bridge`）没有机器人也没有夹爪，收到什么都会按时回 `success=true`——
 * 那份「走完了」是真 HTTP 换回来的，却不是一次真的动作。把对面**自报的**服务名与版本
 * 摆到屏幕上，看的人自己就能判断那边是替身还是真身。
 */
describe('probeBridge', () => {
	const respond = (body: string, status = 200): typeof fetch =>
		(async () => new Response(body, { status })) as unknown as typeof fetch;

	it('对面自报什么就报什么：服务名与版本一个字都不改', async () => {
		const probe = await probeBridge({
			baseUrl: 'http://127.0.0.1:8788/',
			fetchImpl: respond(JSON.stringify({ status: 'ok', service: 'roboframe-bridge', version: 'fake-bridge-0' })),
		});
		expect(probe).toEqual({ ok: true, health: { status: 'ok', service: 'roboframe-bridge', version: 'fake-bridge-0' } });
	});

	it('打的是 /v1/health，尾部斜杠不影响', async () => {
		const seen: string[] = [];
		const spy = (async (url: string) => {
			seen.push(String(url));
			return new Response(JSON.stringify({ version: 'v1' }), { status: 200 });
		}) as unknown as typeof fetch;
		await probeBridge({ baseUrl: 'http://127.0.0.1:8788///', fetchImpl: spy });
		expect(seen).toEqual([`http://127.0.0.1:8788${BRIDGE_HEALTH_PATH}`]);
	});

	it('探不到不是失败：连不上 / 非 200 / 不是 JSON / 不是一份 Health，各给一句实话', async () => {
		const dead = (async () => {
			throw new Error('ECONNREFUSED');
		}) as unknown as typeof fetch;
		const refused = await probeBridge({ baseUrl: 'http://127.0.0.1:9', fetchImpl: dead });
		expect(refused.ok).toBe(false);
		expect(refused.ok ? '' : refused.detail).toContain('连不上');

		const notFound = await probeBridge({ baseUrl: 'http://x', fetchImpl: respond('nope', 404) });
		expect(notFound.ok ? '' : notFound.detail).toContain('404');

		const notJson = await probeBridge({ baseUrl: 'http://x', fetchImpl: respond('<html>') });
		expect(notJson.ok ? '' : notJson.detail).toContain('读不懂');

		// `version` 是必填：缺了就不是一份 Health（不编一个版本号出来）。
		const notHealth = await probeBridge({ baseUrl: 'http://x', fetchImpl: respond('{"hello":1}') });
		expect(notHealth.ok).toBe(false);
	});

	it('地址空着时不去发请求，直说还没填', async () => {
		let called = 0;
		const spy = (async () => {
			called += 1;
			return new Response('{}', { status: 200 });
		}) as unknown as typeof fetch;
		const probe = await probeBridge({ baseUrl: '   ', fetchImpl: spy });
		expect(probe.ok).toBe(false);
		expect(called).toBe(0);
	});
});

// ---------------------------------------------------------------------------
// 单步（`stepGate`）：下一个顶层步的请求在放行之前**一个字节都不发**
// ---------------------------------------------------------------------------

/**
 * 这一组钉的是「单步在 HTTP 这条路上真的停住」：
 * ① 走完一个顶层步就停——下一个顶层步的 `POST` 一次都没发出去（判据是**请求台账**，不是界面）；
 * ② 放行一次走一步，走到尾收摊（结局与整趟跑同一套账）；
 * ③ 一步 = 一个**顶层步**：分支臂里的调用不各停一次；
 * ④ 停在闸上取消能把它叫醒（闸收信号）——那时那一步的请求也一个都没发。
 *
 * 闸本身（预放行、waiting、abort）在 `@codecanvas/contracts` 那边有专门的用例，
 * 这里钉的是**执行器怎么用它**。
 */
describe('单步（stepGate）：停住时下一步的请求还没发出去', () => {
	/** 让微任务跑完：这一组测的是「谁先谁后」，不真等时间。 */
	const flush = async (): Promise<void> => {
		for (let i = 0; i < 30; i += 1) await Promise.resolve();
	};

	/** 一个「发出去就收下、轮询立刻给终态」的替身：考的是发了几条，不是成败怎么读。 */
	const happyStub = (): FetchStub =>
		stubFetch(({ method, url }) => {
			if (method === 'POST') return accepted('t', 'x');
			const taskId = /\/v1\/tasks\/([^/]+)$/.exec(url)?.[1] ?? 't';
			return jsonResponse(200, {
				task_id: taskId,
				skill: 'x',
				state: 'completed',
				success: true,
				executed_primitives: [],
			});
		});

	/** POST 出去了几条（＝真的下发了几步）。 */
	const posts = (stub: FetchStub): number => stub.calls.filter((call) => call.method === 'POST').length;

	it('走完第一步就停住：第二个 POST 没发出去，放行之后才发', async () => {
		const compiled = compile([
			{ step: 'skill', skill: 'inspect_scene' },
			{ step: 'skill', skill: 'wave_hello' },
		]);
		const stub = happyStub();
		const gate = createStepGate();
		let settled = false;
		const running = run(compiled, stub, { stepGate: gate }).then((result) => {
			settled = true;
			return result;
		});

		await flush();
		expect(posts(stub)).toBe(1);
		expect(gate.waiting).toBe(true);
		expect(settled).toBe(false);
		// 停住 = 再等也不会自己往下走
		await flush();
		expect(posts(stub)).toBe(1);

		gate.release();
		const result = await running;
		expect(posts(stub)).toBe(2);
		expect(result.ok).toBe(true);
		expect(gate.waiting).toBe(false);
	});

	it('一步 = 一个顶层步：分支臂里的调用不各停一次', async () => {
		const compiled = compile([
			{ step: 'skill', skill: 'inspect_scene' },
			{
				step: 'if',
				condition: { field: 'last.success', op: '==', value: true },
				then: [
					{ step: 'skill', skill: 'wave_hello' },
					{ step: 'skill', skill: 'nod_yes' },
				],
			},
		]);
		const stub = happyStub();
		/** 数闸被等了几次：一次 = 一个顶层步的边界。 */
		let waits = 0;
		const gate = createStepGate((waiting) => {
			if (waiting) waits += 1;
		});

		const running = run(compiled, stub, { stepGate: gate });
		await flush();
		expect(posts(stub)).toBe(1);
		expect(waits).toBe(1);

		// 放行一次：顶层第二步（那个分支）连同它 then 臂里的两步一次走完——闸没有再停
		gate.release();
		const result = await running;
		expect(result.ok).toBe(true);
		expect(posts(stub)).toBe(3);
		expect(waits).toBe(1);
		expect(gate.waiting).toBe(false);
	});

	it('停在闸上取消：当场收摊，那一步的请求一个字节都没发出去', async () => {
		const compiled = compile([
			{ step: 'skill', skill: 'inspect_scene' },
			{ step: 'skill', skill: 'wave_hello' },
		]);
		const stub = happyStub();
		const gate = createStepGate();
		const controller = new AbortController();

		const running = run(compiled, stub, { stepGate: gate, signal: controller.signal });
		await flush();
		expect(gate.waiting).toBe(true);
		expect(posts(stub)).toBe(1);

		controller.abort();
		const result = await running;
		expect(result.ok).toBe(false);
		expect(result.reason).toContain('放行闸');
		// 取消叫醒的是闸，不是「发出去了再取消」：第二个 POST 根本没有出现过
		expect(posts(stub)).toBe(1);
		expect(gate.waiting).toBe(false);
	});

	it('不给闸就一口气发完：单步是加的一个模式，默认行为一个字没变', async () => {
		const compiled = compile([
			{ step: 'skill', skill: 'inspect_scene' },
			{ step: 'skill', skill: 'wave_hello' },
		]);
		const stub = happyStub();
		const result = await run(compiled, stub);
		expect(result.ok).toBe(true);
		expect(posts(stub)).toBe(2);
	});
});
