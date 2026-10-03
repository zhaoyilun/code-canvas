// @vitest-environment happy-dom
/**
 * `mountVirtualDevice` 的验收：挂载 / 跑一步 / 卸载这三件事的契约。
 *
 * **测得到什么**：canvas 真的进了 host、`onStep` 只推有结论的那两种状态、失败即停、
 * `reset()` 清账本、`dispose()` 之后 DOM 里不留 canvas、连续挂卸 10 次不报错、尺寸读实测值、
 * **本机布景的位置真的传到舞台上**（`setTargetBlock`）。
 * 执行器的动作（原语 → 关节角）与机械臂的动画在这个仓库里另有测试（`roboframe/**`、`scene/so101.test.ts`），
 * 这里不重复。
 *
 * **测不到什么（如实记）**：
 * - 真的 WebGL：happy-dom 没有 GL 上下文，`three` 的 `WebGLRenderer` 在这儿建不起来。
 *   所以测试**显式注入假舞台**（`createStageImpl`），只钉「mount 会建舞台、dispose 会通知它」，
 *   钉不到渲染器/几何/材质的真实释放。`mount.ts` 里那段 three 资源释放（`disposeScene`）
 *   因此**没有单测覆盖**——它靠的是「反复 mount/dispose 不泄漏、不报错」那条在浏览器里的行为。
 * - 渲染循环：机械臂要靠帧推进才会动完、`run()` 才会 resolve，而 happy-dom 的
 *   `requestAnimationFrame` 是 `setImmediate` 模拟的（会一直跑，实测 120ms 里约 2700 帧），
 *   所以这里直接 await——不额外泵时钟。代价是这几条用例的耗时取决于测试环境的计时器快慢
 *   （本机每条 < 1s），不像 `scene/so101.test.ts` 那样把时间捏在自己手里。
 * - `size` 的真实像素：happy-dom 不做布局，`clientWidth/clientHeight` 读的是测试自己设的那两个数，
 *   真实视口下的尺寸在浏览器里量（见交付报告）。
 */
import * as THREE from 'three';
import { describe, expect, it, vi } from 'vitest';
import { ROBOFRAME_SO101_CATALOG } from '@codecanvas/capabilities';
import type { CapabilityCatalog, SkillPlan } from '@codecanvas/contracts';
import { DEFAULT_TARGET_BLOCK, mountVirtualDevice, type FrameScheduler, type StageHandle, type StepEvent } from './mount';
import { disposeStageResources } from './scene/stage';

/** 测试要用的小目录：两个原语、三条能力。别让单测去跑整份 SO-101 目录（几十步动画太慢）。 */
const SMALL_CATALOG: CapabilityCatalog = {
	catalogRef: 'test.catalog',
	displayName: '测试臂',
	robotName: 'test_arm',
	revisionRef: 'test.rev.1',
	primitives: [
		{ primitiveRef: 'open_gripper', label: '张开夹爪', parameters: [] },
		{
			primitiveRef: 'move_relative_ee',
			label: '相对移动',
			parameters: [
				{ name: 'motion_direction', label: '方向', type: 'string' },
				{ name: 'motion_distance', label: '距离', type: 'number' },
			],
		},
	],
	capabilities: [
		{
			capabilityRef: 'greet',
			label: '打招呼',
			kind: 'skill',
			parameters: [],
			implementation: [{ kind: 'call', primitiveRef: 'open_gripper', arguments: {} }],
		},
		{
			// 参数故意给成字符串：执行器当场判 failed（"motion_distance 不是数字"），用来钉「失败即停」
			capabilityRef: 'bad_move',
			label: '参数坏掉的移动',
			kind: 'skill',
			parameters: [],
			implementation: [
				{ kind: 'call', primitiveRef: 'move_relative_ee', arguments: { motion_direction: 'up', motion_distance: 'abc' } },
			],
		},
		{
			capabilityRef: 'never_reached',
			label: '不该被跑到',
			kind: 'skill',
			parameters: [],
			implementation: [{ kind: 'call', primitiveRef: 'open_gripper', arguments: {} }],
		},
	],
};

/**
 * 假舞台：记下 resize / render / dispose 各被叫了几次，并且真的收走（不碰 GL）。
 *
 * 它**和真舞台做同一件事**：`render(dt)` 里推进机械臂（真身见 `scene/stage.ts` 里的
 * `rig.update(dt)`）。少了这一步，动作永远做不完、`run()` 永远不 resolve——
 * 那不是被测对象的问题，是替身没按契约干活。所以 `attach` 上机械臂之后每帧推它一次。
 */
function fakeStage(): StageHandle & {
	resizes: number;
	renders: number;
	disposals: number;
	attach(rig: { update(dt: number): void }): void;
	/** 舞台收到的每一次方块位置（真舞台拿它去挪那块 mesh） */
	targetBlocks: { x: number; y: number; z: number }[];
} {
	let rig: { update(dt: number): void } | null = null;
	const rigTree = new THREE.Group();
	const stage = {
		resizes: 0,
		renders: 0,
		disposals: 0,
		targetBlocks: [] as { x: number; y: number; z: number }[],
		attach(target: { update(dt: number): void }) {
			rig = target;
			if (target instanceof THREE.Object3D) rigTree.add(target);
		},
		resize() {
			stage.resizes += 1;
		},
		render(dt: number) {
			stage.renders += 1;
			rig?.update(dt);
		},
		setTargetBlock(position: { x: number; y: number; z: number }) {
			// 与真舞台同一件事：把三个数收下（真身是 `placeTargetBlock` 写那块 mesh 的 position）。
			// 存一份**拷贝**：真舞台写的是自己的 Vector3，不是调用方那个对象的引用
			stage.targetBlocks.push({ ...position });
		},
		dispose() {
			stage.disposals += 1;
			// 真舞台的 dispose 走的就是这一句（见 scene/stage.ts）；替身照做，
			// 「舞台收到 dispose」这条断言才不是空转
			disposeStageResources({ renderer: { dispose: () => undefined, forceContextLoss: () => undefined }, root: rigTree });
		},
	};
	return stage;
}

function hostOf(width = 420, height = 340): HTMLElement {
	const host = document.createElement('div');
	// happy-dom 不做布局：宽高得自己给，`size` 读的就是这两个数
	Object.defineProperty(host, 'clientWidth', { value: width, configurable: true });
	Object.defineProperty(host, 'clientHeight', { value: height, configurable: true });
	document.body.append(host);
	return host;
}

/** 一帧的步长：手动泵时钟时固定推进这么多秒，机械臂的动画时长才在测试手里 */
const FRAME_SEC = 0.02;

/**
 * 手动帧排程器：不接 rAF，而是把回调攒起来，由 `pump()` 一帧一帧喂。
 *
 * 为什么要它：机械臂按每帧 dt 推进，而 happy-dom 的 rAF 是 setImmediate 模拟的，
 * 每帧只有几十微秒——真的等下去，测试超时了动作还没做完。这里把时间捏在手里，
 * 跟 `scene/so101.test.ts` 同一套口径（固定 dt 推进）。
 *
 * `pump` 还可以一边喂帧一边等一个 promise（`until`）：执行侧的链条是
 * 「帧推进 → 动作完成 → 下一步」这样一环扣一环的，只在帧之间让一个微任务是不够的，
 * 得让整条链走到头（或者帧数用完）。
 */
function manualFrames(): {
	schedule: FrameScheduler;
	pump: (frames: number, until?: Promise<unknown>) => Promise<void>;
} {
	let pending: ((now: number) => void) | null = null;
	// 假时钟从此刻的真实时间起步：mount 记下的 `last` 就是这个量级的数，
	// 从 0 开始喂会让第一帧的 dt 变成一个绝对值巨大的负数，动作永远推不动
	let clock = performance.now();
	const schedule: FrameScheduler = (onFrame) => {
		pending = onFrame;
		return () => {
			pending = null;
		};
	};
	const pump = async (frames: number, until?: Promise<unknown>): Promise<void> => {
		let settled = false;
		if (until !== undefined) {
			void until.then(
				() => {
					settled = true;
				},
				() => {
					settled = true;
				},
			);
		}
		for (let i = 0; i < frames; i++) {
			if (settled) return;
			const next = pending;
			if (next === null) return;
			pending = null;
			clock += FRAME_SEC * 1000;
			next(clock);
			// 让执行侧的 await 链整条往下走（它会自己排一个新的帧回调回来）
			await Promise.resolve();
			await Promise.resolve();
		}
	};
	return { schedule, pump };
}

const plan = (...skills: string[]): SkillPlan => ({
	schemaVersion: 1,
	robot: 'test_arm',
	plan: skills.map((skill) => ({ step: 'skill' as const, skill })),
});

/**
 * 挂一台测试设备：小目录 + 假舞台 + 手动帧。
 * 舞台从工厂拿到 `rig` 并在每帧推进它——跟真舞台同一份契约，只是不碰 GL。
 */
function mountOn(host: HTMLElement, catalog: CapabilityCatalog = SMALL_CATALOG) {
	const frames = manualFrames();
	const stage = fakeStage();
	const device = mountVirtualDevice(host, {
		catalog,
		createStageImpl: (_canvas, rig) => {
			stage.attach(rig);
			return stage;
		},
		scheduleFrame: frames.schedule,
	});
	return { device, stage, frames };
}

describe('mountVirtualDevice · 挂载', () => {
	it('host 里有 canvas，尺寸读的是宿主的实测值', () => {
		const host = hostOf(420, 340);
		const { device, stage } = mountOn(host);

		expect(host.querySelector('canvas')).not.toBeNull();
		expect(device.size).toEqual({ width: 420, height: 340 });
		// 挂载时按宿主量过一次（真的 WebGL 尺寸就是这一步定下来的）
		expect(stage.resizes).toBeGreaterThan(0);

		device.dispose();
	});

	it('宿主里已经有 canvas 就用它（这个应用自己的 index.html 就带一张），卸载时不摘走宿主的 canvas', () => {
		const host = hostOf();
		const given = document.createElement('canvas');
		host.append(given);
		const { device } = mountOn(host);

		// 没有多出第二张：重挂入口不该在宿主里再插一张 canvas（那会让 #stage 里两张抢同一块地方）
		expect(host.querySelectorAll('canvas')).toHaveLength(1);
		expect(host.querySelector('canvas')).toBe(given);

		device.dispose();
		// 宿主给的 canvas 归宿主：卸载只收走自己建的那些
		expect(host.querySelectorAll('canvas')).toHaveLength(1);
		expect(host.querySelector('canvas')).toBe(given);
	});

	it('不传 catalog 时用的就是 ROBOFRAME_SO101_CATALOG（真舞台在 happy-dom 里建不起来，这里只钉目录）', () => {
		const device = mountVirtualDevice(hostOf(), { createStageImpl: () => fakeStage() });

		expect(device.catalog).toBe(ROBOFRAME_SO101_CATALOG);
		// 目录里确实有技能可跑，而不是一份空壳
		expect(device.catalog.capabilities.length).toBeGreaterThan(0);
		expect(device.catalog.primitives.length).toBeGreaterThan(0);

		device.dispose();
	});
});

describe('mountVirtualDevice · 跑一步', () => {
	it('跑完一个能力 → onStep 收到事件，且事件里没有 running', async () => {
		const { device, frames } = mountOn(hostOf());
		const seen: string[] = [];
		device.onStep((event) => seen.push(event.state));

		const pending = device.run(plan('greet'));
		await frames.pump(80, pending);
		const outcome = await pending;

		expect(outcome.ok).toBe(true);
		expect(outcome.steps).toHaveLength(1);
		expect(outcome.steps[0]?.state).toBe('done');
		expect(seen).toEqual(['done']);
		expect(seen).not.toContain('running');
		// 账本与推到听众的是同一批（只收有结论的那两种）
		expect(device.stepEvents.map((event) => event.state)).toEqual(['done']);

		device.dispose();
	});

	it('失败即停：第二步没做成就不再往下跑，如实报原因', async () => {
		const { device, frames } = mountOn(hostOf());
		const seen: string[] = [];
		device.onStep((event) => seen.push(`${event.capabilityRef}:${event.state}`));

		const pending = device.run(plan('greet', 'bad_move', 'never_reached'));
		await frames.pump(120, pending);
		const outcome = await pending;

		expect(outcome.ok).toBe(false);
		expect(outcome.reason).toContain('motion_distance');
		// 推到听众的只有真正跑过的那两步：失败那一步是终态，第三步一步没动
		expect(seen).toEqual(['greet:done', 'bad_move:failed']);
		expect(seen.some((item) => item.startsWith('never_reached'))).toBe(false);

		device.dispose();
	});

	it('跑计划时每一步的事件都带「计划第几步」；单独跑一个能力时如实没有', async () => {
		const { device, frames } = mountOn(hostOf());
		const seen: StepEvent[] = [];
		device.onStep((event) => seen.push(event));

		const pending = device.run(plan('greet', 'greet', 'greet'));
		await frames.pump(120, pending);
		await pending;

		// 三个技能各含一条原语：能力内的原语序号都是 1，计划序号才是 1/2/3
		expect(seen.map((event) => event.index)).toEqual([1, 1, 1]);
		expect(seen.map((event) => event.planIndex)).toEqual([1, 2, 3]);
		// task_id 由 runPlan 生成，逐条透传（bridge 的口径）
		expect(seen.every((event) => typeof event.taskId === 'string' && event.taskId.length > 0)).toBe(true);

		// 单独跑一个能力：没有"计划"这回事，就不编一个序号出来
		device.reset();
		const single = device.runCapability('greet');
		await frames.pump(80, single);
		const outcome = await single;
		expect(outcome?.outcome.steps[0]?.planIndex).toBeUndefined();
		expect(outcome?.outcome.steps[0]?.taskId).toBeUndefined();

		device.dispose();
	});

	it('计划里出现目录没有的技能：停在那一步，如实报出来', async () => {
		const { device, frames } = mountOn(hostOf());

		const pending = device.run(plan('greet', 'not_in_catalog', 'greet'));
		await frames.pump(120, pending);
		const outcome = await pending;

		expect(outcome.ok).toBe(false);
		expect(outcome.reason).toContain('not_in_catalog');
		expect(device.stepEvents.map((event) => event.capabilityRef)).toEqual(['greet']);

		device.dispose();
	});

	it('分支步真的跑：臂里的技能照常下发，计划步事件说清走了哪条臂', async () => {
		const { device, frames } = mountOn(hostOf());
		const reported: string[] = [];
		device.onPlanStep((event) => reported.push(`${event.path} ${event.arm ?? '-'} ${event.state}`));

		const pending = device.run({
			schemaVersion: 1,
			robot: 'test_arm',
			plan: [
				{ step: 'skill', skill: 'greet' },
				{
					step: 'if',
					condition: { field: 'last.success', op: '==', value: true },
					then: [{ step: 'skill', skill: 'never_reached' }],
					else: [{ step: 'skill', skill: 'bad_move' }],
				},
			],
		});
		await frames.pump(200, pending);
		const outcome = await pending;

		expect(outcome.ok).toBe(true);
		// 真执行器那边跑到的是 then 臂里的技能，else 臂一步没动
		expect(device.stepEvents.map((event) => event.capabilityRef)).toEqual(['greet', 'never_reached']);
		// 计划步事件：分支那一步（`1`）与它臂里的那一步（`1.then.0`）都在，臂写在事件上
		expect(reported).toEqual([
			'0 - running',
			'0 - done',
			'1 then running',
			'1.then.0 - running',
			'1.then.0 - done',
			'1 then done',
		]);

		device.dispose();
	});

	it('等待步真的等，且 device.cancel() 能打断它（真执行器 + 真取消订阅）', async () => {
		const { device, frames } = mountOn(hostOf());
		const reported: string[] = [];
		device.onPlanStep((event) => reported.push(`${event.path} ${event.arm ?? '-'} ${event.state} ${event.step.step}`));

		const pending = device.run({
			schemaVersion: 1,
			robot: 'test_arm',
			// 30 秒：要是 `cancel()` 打不断这次等待，下面那个 await 会一直挂着（测试超时就是红）
			plan: [
				{ step: 'skill', skill: 'greet' },
				{ step: 'wait', seconds: 30 },
				{ step: 'skill', skill: 'never_reached' },
			],
		});
		await frames.pump(60, pending);
		// 走到等待步了：它照报一步，`arm` 是 null（等待没有臂）
		expect(reported.at(-1)).toBe('1 - running wait');

		device.cancel();
		// 不再泵帧：等待是被信号打断的，不是等满 30 秒
		const outcome = await pending;
		expect(outcome.ok).toBe(false);
		expect(outcome.reason).toContain('已取消');
		expect(reported.at(-1)).toBe('1 - failed wait');
		// 后面那一步一步没动：设备那边只收到第一条技能
		expect(device.stepEvents.map((event) => event.capabilityRef)).toEqual(['greet']);

		device.dispose();
	});

	it('取消订阅之后不再收到事件', async () => {
		const { device, frames } = mountOn(hostOf());
		const listener = vi.fn();
		const off = device.onStep(listener);

		const first = device.run(plan('greet'));
		await frames.pump(80, first);
		await first;
		expect(listener).toHaveBeenCalledTimes(1);

		off();
		const second = device.run(plan('greet'));
		await frames.pump(80, second);
		await second;
		expect(listener).toHaveBeenCalledTimes(1);

		device.dispose();
	});

	it('reset() 清空步骤账本', async () => {
		const { device, frames } = mountOn(hostOf());

		const pending = device.run(plan('greet'));
		await frames.pump(80, pending);
		await pending;
		expect(device.stepEvents).toHaveLength(1);

		device.reset();
		expect(device.stepEvents).toHaveLength(0);

		device.dispose();
	});
});

describe('mountVirtualDevice · 本机布景（待抓的方块摆在哪）', () => {
	it('改名入口真的把位置传到舞台：三个数一个不少，而且是照收下的那份走', () => {
		const { device, stage } = mountOn(hostOf());

		device.setTargetBlock({ x: -0.05, y: 0.015, z: 0.22 });

		expect(stage.targetBlocks).toEqual([{ x: -0.05, y: 0.015, z: 0.22 }]);
		// 账也记下了（界面读它显示当前值）
		expect(device.targetBlock).toEqual({ x: -0.05, y: 0.015, z: 0.22 });

		device.dispose();
	});

	it('挂载时方块就是缺省那一处（0.12, 0.015, 0.16）——不摆一次也已经是它', () => {
		const { device, stage } = mountOn(hostOf());

		expect(device.targetBlock).toEqual({ x: 0.12, y: 0.015, z: 0.16 });
		expect(device.targetBlock).toEqual(DEFAULT_TARGET_BLOCK);
		// 舞台不需要在挂载时被摆一次：真舞台建出来就在缺省处（createStage 里那句 setTargetBlock）
		expect(stage.targetBlocks).toEqual([]);

		device.dispose();
	});

	it('摆到远处也照摆（本机布景没有范围限制），挪两次就是两次', () => {
		const { device, stage } = mountOn(hostOf());

		device.setTargetBlock({ x: 0.4, y: 0.3, z: -0.2 });
		device.setTargetBlock({ x: 0.12, y: 0.015, z: 0.16 });

		expect(stage.targetBlocks).toEqual([
			{ x: 0.4, y: 0.3, z: -0.2 },
			{ x: 0.12, y: 0.015, z: 0.16 },
		]);
		expect(device.targetBlock).toEqual({ x: 0.12, y: 0.015, z: 0.16 });

		device.dispose();
	});

	it('非有限数一律拒，且不动上一次的位置（NaN 进了场景，画面上没有一句话说得清是谁干的）', () => {
		const { device, stage } = mountOn(hostOf());
		device.setTargetBlock({ x: 0.2, y: 0.015, z: 0.16 });

		expect(() => device.setTargetBlock({ x: Number.NaN, y: 0.015, z: 0.16 })).toThrow(RangeError);
		expect(() => device.setTargetBlock({ x: 0.2, y: Number.POSITIVE_INFINITY, z: 0.16 })).toThrow(/y/);

		// 拒了就是拒了：舞台一次都没收到坏值，账本还是上一个好值
		expect(stage.targetBlocks).toEqual([{ x: 0.2, y: 0.015, z: 0.16 }]);
		expect(device.targetBlock).toEqual({ x: 0.2, y: 0.015, z: 0.16 });

		device.dispose();
	});

	it('卸载之后再摆：如实拒绝，不假装摆过了', () => {
		const { device, stage } = mountOn(hostOf());
		device.dispose();

		expect(() => device.setTargetBlock({ x: 0.1, y: 0.015, z: 0.1 })).toThrow(/卸载/);
		expect(stage.targetBlocks).toEqual([]);
	});

	it('读到的那份账改不动：外面拿到手写它，设备里的值不跟着变（读到≠能改）', () => {
		const { device } = mountOn(hostOf());

		device.setTargetBlock({ x: 0.1, y: 0.02, z: 0.3 });
		// 运行时的一次乱写（类型上这份账是只读的，所以这里绕一道）：冻结让它在严格模式下当场抛，
		// 而不是把设备里的账悄悄改掉——「读到的值」与「真摆在哪」从此不会分家
		const read = device.targetBlock as { x: number; y: number; z: number };

		expect(() => {
			read.x = 9;
		}).toThrow(TypeError);
		expect(device.targetBlock).toEqual({ x: 0.1, y: 0.02, z: 0.3 });

		device.dispose();
	});
});

describe('mountVirtualDevice · 卸载', () => {
	it('dispose() 之后 host 里没有 canvas 了，舞台收到 dispose', () => {
		const host = hostOf();
		const { device, stage } = mountOn(host);
		expect(host.querySelectorAll('canvas')).toHaveLength(1);

		device.dispose();

		expect(host.querySelector('canvas')).toBeNull();
		expect(host.childElementCount).toBe(0);
		expect(stage.disposals).toBe(1);
	});

	it('dispose() 之后渲染器真的被收：renderer.dispose 与 forceContextLoss 都被调到', () => {
		const host = hostOf();
		const frames = manualFrames();
		// 假舞台的 dispose 走**真的收尾代码**（`disposeStageResources`），
		// 所以这里断的不是替身自己的心情：真舞台的 dispose 也就是这一句。
		const renderer = { dispose: vi.fn(), forceContextLoss: vi.fn() };
		const controls = { dispose: vi.fn() };
		const scene = new THREE.Scene();
		const stage: StageHandle = {
			resize: vi.fn(),
			render: vi.fn(),
			dispose: () => disposeStageResources({ renderer, controls, root: scene }),
		};
		const device = mountVirtualDevice(host, {
			catalog: SMALL_CATALOG,
			createStageImpl: () => stage,
			scheduleFrame: frames.schedule,
		});
		expect(renderer.dispose).not.toHaveBeenCalled();

		device.dispose();

		// 不 `forceContextLoss()` 就等于每 mount 一次漏一个 GL 上下文（浏览器上限 ~16 个）
		expect(renderer.dispose).toHaveBeenCalledTimes(1);
		expect(renderer.forceContextLoss).toHaveBeenCalledTimes(1);
		expect(controls.dispose).toHaveBeenCalledTimes(1);
	});

	it('连续 mount / dispose 时每次都收一次（10 个上下文，一个都不留在外面）', () => {
		const host = hostOf();
		for (let i = 0; i < 10; i++) {
			const renderer = { dispose: vi.fn(), forceContextLoss: vi.fn() };
			const frames = manualFrames();
			const device = mountVirtualDevice(host, {
				catalog: SMALL_CATALOG,
				createStageImpl: () => ({
					resize: vi.fn(),
					render: vi.fn(),
					dispose: () => disposeStageResources({ renderer, root: new THREE.Scene() }),
				}),
				scheduleFrame: frames.schedule,
			});
			device.dispose();
			expect(renderer.dispose).toHaveBeenCalledTimes(1);
			expect(renderer.forceContextLoss).toHaveBeenCalledTimes(1);
		}
	});

	it('重复 dispose 是幂等的（第二次不再动 DOM 与 GPU）', () => {
		const { device, stage } = mountOn(hostOf());

		device.dispose();
		device.dispose();

		expect(stage.disposals).toBe(1);
	});

	it('连续 mount / dispose 10 次：不报错，也不留下 canvas', () => {
		const host = hostOf();
		for (let i = 0; i < 10; i++) {
			const { device, stage } = mountOn(host);
			expect(host.querySelectorAll('canvas')).toHaveLength(1);
			device.dispose();
			expect(host.querySelectorAll('canvas')).toHaveLength(0);
			expect(stage.disposals).toBe(1);
		}
		// 10 次之后宿主回到挂载前的样子
		expect(host.childElementCount).toBe(0);
	});

	it('卸载之后再跑：如实拒绝，不假装跑过', async () => {
		const { device } = mountOn(hostOf());
		device.dispose();

		await expect(device.run(plan('greet'))).rejects.toThrow(/卸载/);
	});
});
