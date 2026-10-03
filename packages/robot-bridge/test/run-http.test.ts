/**
 * 集成：**起真服务**（spawn `tools/fake-bridge`）、拿**真目录**编计划、用真 HTTP 跑一遍。
 *
 * 为什么这一条是重点：`model-parity.test.ts` 证明的是形状对得上 pydantic，`run.test.ts` 证明的是
 * 执行器读结论读得对——两者都没有一行真的网络请求。这一条把「下发 → 轮询 → 终态 → 据此选臂」
 * 放在真 HTTP 上跑，而且判据尽量取**对面的日志**而不是我们自己的事件：
 * 「轮询真的发生过」看 `GET /v1/tasks/...` 的行数，「另一条臂一条都没发」看日志里有没有它的 task_id。
 *
 * 端口由假服务自己挑（`FAKE_BRIDGE_PORT=0`），从它打在 stdout 的 `listening ...` 那一行读回来
 * ——不许硬编码一个可能被占用的端口。
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SKILL_PLAN_SCHEMA_VERSION, type SkillPlan, type SkillPlanStep } from '@codecanvas/contracts';
import { ROBOFRAME_SO101_CATALOG } from '@codecanvas/capabilities';
import {
	catalogSchema,
	compilePlanToCalls,
	healthSchema,
	runCompiledPlan,
	type CompiledPlan,
	type PlanRunResult,
	type RunOverHttpOptions,
} from '../src/index';

const REPO_ROOT = fileURLToPath(new URL('../../..', import.meta.url));
const START_SCRIPT = fileURLToPath(new URL('../../../tools/fake-bridge/start.mjs', import.meta.url));
const DEVICE = 'so101_single_arm';

/**
 * 假服务的配置。三个名单都是**给这一整个测试文件用的**，所以每个测试挑的技能不许撞车：
 * - 失败的：`open_gripper_skill`（分支与「失败即停」两个测试都拿它当第一步）
 * - 目录里摘掉的：`celebrate`（演「计划里有、这台 bridge 不认识」→ 真 404）
 */
const FAKE_ENV = {
	FAKE_BRIDGE_PORT: '0',
	FAKE_BRIDGE_STEP_MS: '800',
	FAKE_BRIDGE_FAIL_SKILLS: 'open_gripper_skill,wave_hello',
	FAKE_BRIDGE_UNKNOWN_SKILLS: 'celebrate',
};

/** 假服务的 stdout（对照物）、stderr（它自己崩了的时候要看）与它挑中的地址。 */
const bridgeLog: string[] = [];
const bridgeErrors: string[] = [];
let bridge: ChildProcess | undefined;
let baseUrl = '';

const logLines = (needle: string): string[] => bridgeLog.filter((line) => line.includes(needle));
const pollsOf = (taskId: string): string[] => logLines(`GET /v1/tasks/${taskId} `);

/**
 * 日志是**整个文件共用**的（假服务只起一次）。要断言「某样东西一次都没出现」时，先记一笔游标，
 * 只在这之后追加的那些行里找——否则会撞上别的测试留下的同名字样（这是耦合，不是证据）。
 */
const logCursor = (): number => bridgeLog.length;
const linesSince = (from: number, needle: string): string[] =>
	bridgeLog.slice(from).filter((line) => line.includes(needle));

/** 等一件事在日志里出现（日志经管道异步到达，断言不能抢在它前面）。 */
const waitFor = async (predicate: () => boolean, what: string, timeoutMs = 5000): Promise<void> => {
	const deadline = Date.now() + timeoutMs;
	while (!predicate()) {
		if (Date.now() > deadline) {
			throw new Error(`等到超时：${what}\n假服务的日志：\n${bridgeLog.join('\n')}\n假服务的 stderr：\n${bridgeErrors.join('')}`);
		}
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
};

const startFakeBridge = async (): Promise<{ url: string; proc: ChildProcess }> => {
	const proc = spawn(process.execPath, [START_SCRIPT], {
		cwd: REPO_ROOT,
		env: { ...process.env, ...FAKE_ENV },
		stdio: ['ignore', 'pipe', 'pipe'],
	});
	proc.stdout?.setEncoding('utf8');
	proc.stdout?.on('data', (chunk: string) => {
		for (const line of chunk.split('\n')) if (line.trim() !== '') bridgeLog.push(line);
	});
	proc.stderr?.setEncoding('utf8');
	proc.stderr?.on('data', (chunk: string) => {
		bridgeErrors.push(chunk);
	});

	const deadline = Date.now() + 20_000;
	for (;;) {
		const line = bridgeLog.find((item) => item.includes('listening http://127.0.0.1:'));
		const match = line === undefined ? null : /listening http:\/\/127\.0\.0\.1:(\d+)/.exec(line);
		if (match?.[1] !== undefined) return { url: `http://127.0.0.1:${match[1]}`, proc };
		if (proc.exitCode !== null) {
			throw new Error(`假服务提前退出了（exit ${String(proc.exitCode)}）：\n${bridgeErrors.join('')}`);
		}
		if (Date.now() > deadline) throw new Error(`等假服务起来超时：\n${bridgeLog.join('\n')}\n${bridgeErrors.join('')}`);
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
};

beforeAll(async () => {
	const started = await startFakeBridge();
	bridge = started.proc;
	baseUrl = started.url;
	// health 通过再开跑：那一行日志说明它已经在听，但真连一次才算数
	const health = healthSchema.parse(await (await fetch(`${baseUrl}/v1/health`)).json());
	expect(health.status).toBe('ok');
});

afterAll(async () => {
	const proc = bridge;
	if (proc === undefined) return;
	// 把假服务这一趟说过的话打在测试输出里：验收要看的正是这些行（谁在什么时候发了什么）
	console.log(`[run-http] 假服务的日志（${String(bridgeLog.length)} 行）：\n${bridgeLog.join('\n')}`);
	const exited = new Promise<void>((resolve) => {
		proc.once('exit', () => {
			resolve();
		});
	});
	proc.kill('SIGTERM');
	await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 3000))]);
	if (proc.exitCode === null) proc.kill('SIGKILL');
});

// ---------------------------------------------------------------------------

const planOf = (steps: readonly SkillPlanStep[]): SkillPlan => ({
	schemaVersion: SKILL_PLAN_SCHEMA_VERSION,
	robot: DEVICE,
	plan: steps,
});

/**
 * 编一份计划。`taskIdPrefix` 每个测试都不同：bridge 靠 task_id 认任务，重号就是把两次执行记成一次
 * ——而日志断言正是按 task_id 找行的。
 */
const compile = (steps: readonly SkillPlanStep[], taskIdPrefix: string): CompiledPlan =>
	compilePlanToCalls(planOf(steps), { catalog: ROBOFRAME_SO101_CATALOG, deviceRef: DEVICE, taskIdPrefix });

const executeCallAt = (compiled: CompiledPlan, stepPath: string) => {
	const call = compiled.calls.find((item) => item.stepPath === stepPath);
	if (call?.kind !== 'execute') throw new Error(`预期 ${stepPath} 上是一条 execute`);
	return call;
};

const run = (compiled: CompiledPlan, extra: Partial<RunOverHttpOptions> = {}): Promise<PlanRunResult> =>
	runCompiledPlan(compiled, { baseUrl, ...extra });

const statesOf = (result: PlanRunResult): string[] => result.events.map((event) => `${event.stepPath}:${event.state}`);

const ONE_MINUTE = 60_000;

// ---------------------------------------------------------------------------

describe('一条全成功的计划：真的发出去、真的轮询、每一步都有事件', () => {
	it(
		'两条技能步：POST 各一条，每步轮询至少两次，事件与任务对得上',
		async () => {
			const compiled = compile(
				[
					{ step: 'skill', skill: 'inspect_scene' },
					{ step: 'skill', skill: 'nod_yes' },
				],
				'int-ok',
			);
			const first = executeCallAt(compiled, '0');
			const second = executeCallAt(compiled, '1');

			const result = await run(compiled);

			expect(result.ok).toBe(true);
			expect(result.reason).toBeUndefined();
			expect(statesOf(result)).toEqual(['0:running', '0:completed', '1:running', '1:completed']);
			expect(result.events.map((event) => event.taskId)).toEqual([
				first.request.task_id,
				first.request.task_id,
				second.request.task_id,
				second.request.task_id,
			]);

			// 对面的日志：两条 execute 各一条 202，且**每个任务都轮询了至少两次**
			await waitFor(() => pollsOf(second.request.task_id).length >= 2, '第二个任务被轮询两次');
			for (const call of [first, second]) {
				expect(
					logLines(`POST /v1/skills/execute skill=${call.request.skill} task=${call.request.task_id} status=202`),
				).toHaveLength(1);
				expect(pollsOf(call.request.task_id).length).toBeGreaterThanOrEqual(2);
				expect(logLines(`task ${call.request.task_id} -> completed success=true`)).toHaveLength(1);
			}

			// executed_primitives 是假服务从**真目录**的 implementation 里读出来的（不是编的）
			expect(result.events[1]?.detail).toContain('move_to_named_pose');
		},
		ONE_MINUTE,
	);
});

describe('分支按**真实成败**选臂', () => {
	it(
		'第一步按配置失败且 onFailure: continue → 走 then 臂，另一臂一条请求都没发（看对面日志）',
		async () => {
			const compiled = compile(
				[
					{ step: 'skill', skill: 'open_gripper_skill', onFailure: 'continue' },
					{
						step: 'if',
						condition: { field: 'last.success', op: '==', value: false },
						then: [{ step: 'skill', skill: 'recover_safe_pose' }],
						else: [{ step: 'skill', skill: 'happy_spin_upright' }],
					},
				],
				'int-branch',
			);
			const failing = executeCallAt(compiled, '0');
			const thenCall = executeCallAt(compiled, '1.then.0');
			const elseCall = executeCallAt(compiled, '1.else.0');

			const cursor = logCursor();
			const result = await run(compiled);

			expect(result.ok).toBe(true); // 被容忍的失败不拦
			expect(statesOf(result)).toEqual([
				'0:running',
				'0:failed',
				'1:completed',
				'1.then.0:running',
				'1.then.0:completed',
			]);
			expect(result.events[2]?.detail).toContain('走 then 臂');

			// 对面的证据：失败那一步真的落了 failed，被选中的臂真的跑了
			await waitFor(() => logLines(`task ${thenCall.request.task_id} -> completed success=true`).length === 1, 'then 臂跑完');
			expect(logLines(`task ${failing.request.task_id} -> failed success=false`)).toHaveLength(1);
			expect(logLines(`POST /v1/skills/execute skill=recover_safe_pose task=${thenCall.request.task_id} status=202`)).toHaveLength(1);

			// **另一条臂一条请求都没发**（不是「事件里没提」，是日志里根本没有它的 task_id / 技能名）
			expect(linesSince(cursor, elseCall.request.task_id)).toEqual([]);
			expect(linesSince(cursor, 'happy_spin_upright')).toEqual([]);
		},
		ONE_MINUTE,
	);
});

describe('缺省 onFailure ＝ 失败即停', () => {
	it(
		'失败那一步之后的计划一条请求都没发',
		async () => {
			const compiled = compile(
				[
					{ step: 'skill', skill: 'open_gripper_skill' },
					{ step: 'skill', skill: 'nod_yes' },
				],
				'int-stop',
			);
			const failing = executeCallAt(compiled, '0');
			const next = executeCallAt(compiled, '1');

			const cursor = logCursor();
			const result = await run(compiled);

			expect(result.ok).toBe(false);
			expect(statesOf(result)).toEqual(['0:running', '0:failed']);
			expect(result.reason).toContain('没写 onFailure');

			await waitFor(() => logLines(`task ${failing.request.task_id} -> failed success=false`).length === 1, '失败落终态');
			// 第二步的 task_id 与技能名在这一段日志里一次都不该出现（连 POST 都没有）
			expect(linesSince(cursor, next.request.task_id)).toEqual([]);
			expect(linesSince(cursor, 'skill=nod_yes')).toEqual([]);
		},
		ONE_MINUTE,
	);
});

describe('技能不在 bridge 的目录里 → unreachable（**不是** failed）', () => {
	it(
		'真 404：计划里有（拿真目录编的）、这台 bridge 不认识',
		async () => {
			// 先证明「不认识」这件事在对面是真的：celebrate 在真目录里，但没进这台 bridge 的技能表
			const catalog = catalogSchema.parse(await (await fetch(`${baseUrl}/v1/catalog`)).json());
			const names = catalog.skills.map((skill) => skill.name);
			expect(names).not.toContain('celebrate');
			expect(names).toContain('inspect_scene');
			expect(ROBOFRAME_SO101_CATALOG.capabilities.map((item) => item.capabilityRef)).toContain('celebrate');
			expect(catalog.robot_name).toBe(ROBOFRAME_SO101_CATALOG.robotName);
			expect(catalog.config_digest).toBe(ROBOFRAME_SO101_CATALOG.revisionRef);

			const compiled = compile([{ step: 'skill', skill: 'celebrate' }], 'int-404');
			const call = executeCallAt(compiled, '0');
			const result = await run(compiled);

			// 404 是「发都发不出去」：它单独一个状态，不许混进「这一步失败了」
			expect(statesOf(result)).toEqual(['0:running', '0:unreachable']);
			expect(result.events.some((event) => event.state === 'failed')).toBe(false);
			expect(result.events[1]?.detail).toContain('404');
			expect(result.events[1]?.detail).toContain('unknown skill');
			expect(result.ok).toBe(false);
			expect(result.reason).toContain('不是一回事');

			// 对面的日志：那条 404 真的发生过，而且**一次轮询都没有**（没有 task 可以问）
			await waitFor(
				() => logLines(`POST /v1/skills/execute skill=celebrate task=${call.request.task_id} status=404`).length === 1,
				'404 出现在日志里',
			);
			expect(pollsOf(call.request.task_id)).toEqual([]);
		},
		ONE_MINUTE,
	);
});

describe('wait 真的等了', () => {
	it(
		'注入的 sleep 被调用，时长正好是那一步的秒数（而且真的过去这么久）',
		async () => {
			const compiled = compile(
				[
					{ step: 'skill', skill: 'inspect_scene' },
					{ step: 'wait', seconds: 1.2 },
				],
				'int-wait',
			);
			const slept: number[] = [];
			const started = Date.now();
			const result = await run(compiled, {
				// 真的等（只是顺便记一笔）：这一条要证明的就是「它没有偷懒跳过」
				sleep: async (ms: number): Promise<void> => {
					slept.push(ms);
					await new Promise((resolve) => setTimeout(resolve, ms));
				},
			});
			const elapsed = Date.now() - started;

			expect(result.ok).toBe(true);
			expect(slept).toContain(1200);
			expect(Math.max(...slept)).toBe(1200);
			expect(elapsed).toBeGreaterThanOrEqual(1200);
			expect(result.events.find((event) => event.stepPath === '1')?.detail).toContain('等了 1.2 秒');
		},
		ONE_MINUTE,
	);
});

describe('假服务自己校验请求形状（所以它不是随便一个假服务）', () => {
	it(
		'形状不对 → 400 并说明错在哪个字段',
		async () => {
			// 少了 `skill`（ExecuteRequest 的必填栏）：判据是 `@codecanvas/robot-bridge` 的 zod 镜像
			const response = await fetch(`${baseUrl}/v1/skills/execute`, {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ task_id: 'int-shape-0', params: {} }),
			});
			const payload: unknown = await response.json();

			expect(response.status).toBe(400);
			expect(JSON.stringify(payload)).toContain('ExecuteRequest');
			expect(JSON.stringify(payload)).toContain('skill');
		},
		ONE_MINUTE,
	);
});

describe('取消（AbortSignal）能中断轮询', () => {
	it(
		'按了取消就不再轮询，且不替设备下结论',
		async () => {
			const compiled = compile([{ step: 'skill', skill: 'inspect_scene' }], 'int-abort');
			const call = executeCallAt(compiled, '0');

			const controller = new AbortController();
			let polls = 0;
			const result = await run(compiled, {
				signal: controller.signal,
				sleep: async (ms: number): Promise<void> => {
					polls += 1;
					// 就在第一次轮询的间隔里按下取消（那一步的 task 还在设备那边「跑」着）
					if (polls === 1) controller.abort();
					await new Promise((resolve) => setTimeout(resolve, ms));
				},
			});

			expect(result.ok).toBe(false);
			expect(result.reason).toContain('取消');
			expect(result.events.map((event) => event.state)).toEqual(['running']);

			// 对面只收到一次轮询（取消之后就没人问了）——而任务在 800ms 之后照样自己到了终态
			expect(pollsOf(call.request.task_id)).toHaveLength(1);
			await waitFor(() => logLines(`task ${call.request.task_id} -> completed success=true`).length === 1, '任务照常落终态');
			expect(polls).toBe(1);
		},
		ONE_MINUTE,
	);
});
