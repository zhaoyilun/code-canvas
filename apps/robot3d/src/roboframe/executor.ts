/**
 * RoboFrame 能力执行器：把目录里的 `capability.implementation` 语句树跑成机械臂动作。
 *
 * 分工：
 * - **目录说做什么**（capability → primitive 序列、实参、轨迹模板），一句不改地照抄；
 * - **本执行器说怎么动**（原语 → 关节角/末端位姿），这是"实现"，因此每个原语的处理
 *   都在这里写清楚，映射有歧义的地方（基座系方向、模板归一化）明确标注。
 * - **安全边界照拦**：模板里带了 `workspace_limits`，越界就拒绝执行并如实报出来，
 *   不静默截断——上游的 `safety_guard` 也是这个态度。
 *
 * 对外两个入口：`run()` 跑一个**能力**（目录里的 `implementation` 整条链），
 * `runPrimitiveCommand()` 跑**一个原语**（上游 `/embodied/execute_primitive` 那条路，
 * 给目录里没有技能包装的原子动作用）。两者报同一套事件、同一套取消与失败口径。
 */
import type { CapabilitySpec, ImplArgument, ImplExpression, ImplStatement, PrimitiveSpec } from '@codecanvas/contracts';
import { asTemplate, checkLimits, synthesize, trajectorySeconds, type Waypoint } from './trajectory';
import { namedPose } from './poses';

/** 机械臂需要提供的最小动作面（真机由驱动实现，这里由 three.js 的 rig 实现） */
export interface ArmRigLike {
	moveJoints(joints: Record<string, number>, durationSec: number): Promise<void>;
	playWaypoints(waypoints: readonly Waypoint[]): Promise<void>;
	setGripper(value01: number, durationSec: number): Promise<void>;
	rotateTool(degrees: number, durationSec: number): Promise<void>;
	moveEE(direction: string, meters: number): Promise<void>;
	poseJoints(): Record<string, number>;
	toolPosition(): { x: number; y: number; z: number };
	/**
	 * 正解：给定关节角，算出上游 workspace_limits 里那几个检查点的位置（基座系，米）。
	 * 返回 null = 这台设备算不出来，安全检查只能跳过（并且要说出来）。
	 */
	linkPositions(joints: Record<string, number>): Record<string, { x: number; y: number; z: number }> | null;
	/**
	 * 这套运动学的可信度。`verified` = 标定过的真机（边界越界必须拒绝执行）；
	 * `approximate` = 连杆长度/零点还是估的（越界只能提示，不能拿估算去否决动作）。
	 */
	readonly calibration: 'verified' | 'approximate';
	reset(): void;
}

export type StepState = 'running' | 'done' | 'skipped' | 'refused' | 'failed';

export interface StepEvent {
	/**
	 * 这一步属于哪个能力。**直接跑一个原语时没有能力可指**（`/embodied/execute_primitive`
	 * 那条路压根不经过能力），这一栏就如实缺席——不拿原语名冒充它，
	 * 与 `planIndex` 「不在计划里就没有」同一个口径。
	 */
	readonly capabilityRef?: string;
	/**
	 * 这一步调的原语。**委托步没有原语**——它的实现在执行侧（`pick_object` →
	 * `/manipulation/execute_pick`），这一栏就是 `null`：拿接口名冒充原语，
	 * 下游会拿着一根目录里不存在的原语去查表。
	 */
	readonly primitiveRef: string | null;
	/** 委托步的执行侧接口名；不是委托步就没有这一栏。 */
	readonly interfaceRef?: string;
	/** 这一步在**这个能力内部**是第几个原语（1 基） */
	readonly index: number;
	readonly total: number;
	/**
	 * 这一步属于整份计划的第几步（1 基）。只有跑计划时有——直接跑一个能力时没有"计划"这回事，
	 * 缺席就是如实缺席，不拿能力内的原语序号冒充它（两者会重号，"第 1 步"出现三次）。
	 */
	readonly planIndex?: number;
	/** 计划号：跑计划时由 `runPlan` 生成并透传（bridge 的 task_id 口径） */
	readonly taskId?: string;
	readonly args: Record<string, unknown>;
	readonly state: StepState;
	readonly detail?: string;
	readonly durationSec?: number;
}

export interface RunOutcome {
	readonly ok: boolean;
	readonly steps: StepEvent[];
	readonly reason?: string;
	/**
	 * 这次跑**本机仿真演不了**的步骤（执行侧接口名）。它是「没演」，不是「没成」——
	 * 所以 `ok` 照旧是 `true`，调用方也不许把它记成失败。
	 *
	 * 为什么单独一栏而不是数 `steps` 里的 `skipped`：`skipped` 还有别的来路
	 * （目录里没有那个原语、命名位姿查不到），那些是**目录与设备对不上**；
	 * 这一栏说的是**边界**：这一步的实现在执行侧，本机压根没有那套东西。
	 */
	readonly unrunnable?: readonly string[];
}

export interface ExecutorHooks {
	onStep?(event: StepEvent): void;
}

type Scope = Map<string, unknown>;

/** 末端相对移动支持的方向（基座系；映射见 README） */
const KNOWN_DIRECTIONS = new Set(['up', 'down', 'left', 'right', 'forward', 'backward']);

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/** 关节映射：目录里是 1~5，rig 里同样按 1~5 用（第 6 轴只由 rotate_gripper_* 驱动） */
function normalizeJoints(value: unknown): Record<string, number> | null {
	if (!isRecord(value)) return null;
	const out: Record<string, number> = {};
	for (const [k, v] of Object.entries(value)) {
		const angle = num(v);
		// 冒号形式（"1": 0.02）与非零基（1）都收，键统一成字符串
		const key = String(Number(k));
		if (angle === null) return null;
		out[key] = angle;
	}
	return out;
}

export class RoboFrameExecutor {
	private cancelled = false;
	/**
	 * 取消的订阅者。计划层的 `wait` 要能被**真打断**（不是等完再检查），
	 * 而执行器对外只有 `cancel()` 一个动作——所以把「取消了」这件事做成一次订阅。
	 */
	private readonly cancelListeners = new Set<() => void>();
	/** 当前这次运行属于计划的第几步（`runPlan` 每一步前设一次）。0 = 不在跑计划。 */
	private planIndex = 0;
	private taskId: string | undefined;

	constructor(
		private readonly rig: ArmRigLike,
		private readonly primitives: readonly PrimitiveSpec[],
		private readonly hooks: ExecutorHooks = {},
	) {}

	cancel(): void {
		// 先记标记再通知：订阅者（等在 `wait` 上的那一步）收到通知就当场收摊，
		// 顺序反过来的话它可能先看一眼标记、看到的是「还没取消」。
		this.cancelled = true;
		for (const listener of this.cancelListeners) listener();
	}

	/** 订阅「这次执行被取消了」，返回退订函数（`runPlan` 跑完一趟就退订）。 */
	onCancel(listener: () => void): () => void {
		this.cancelListeners.add(listener);
		return () => {
			this.cancelListeners.delete(listener);
		};
	}

	/**
	 * 开始一次运行：只清取消标记，**不动机械臂**。
	 * 真机上换技能是从当前姿态接着走，不是先回零——回零是目录里的 `recover_zero_pose` 干的活。
	 */
	beginRun(): void {
		this.cancelled = false;
	}

	/**
	 * 换一步：给接下来这一步的事件盖上「计划第几步 + task_id」。
	 * 跑计划时由 `runPlan` 每一步叫一次；直接跑一个能力时不叫，于是那些事件如实没有计划序号。
	 */
	setPlanContext(context: { readonly planIndex: number; readonly taskId: string }): void {
		this.planIndex = context.planIndex;
		this.taskId = context.taskId;
	}

	/** 显式复位：关节归零、夹爪张开。只有用户按「复位」时才该发生。 */
	reset(): void {
		this.cancelled = false;
		this.planIndex = 0;
		this.taskId = undefined;
		this.rig.reset();
	}

	private primitiveSpec(ref: string): PrimitiveSpec | undefined {
		return this.primitives.find((p) => p.primitiveRef === ref);
	}

	// ---- 表达式求值 -------------------------------------------------------

	private evalExpression(expr: ImplExpression, scope: Scope): unknown {
		switch (expr.kind) {
			case 'literal':
				return expr.value;
			case 'param':
				return scope.get(expr.name);
			case 'unary': {
				const v = this.evalExpression(expr.value, scope);
				if (expr.operator === 'not') return !v;
				const n = num(v);
				return n === null ? null : -n;
			}
			case 'binary': {
				const l = this.evalExpression(expr.left, scope);
				const r = this.evalExpression(expr.right, scope);
				const ln = num(l);
				const rn = num(r);
				switch (expr.operator) {
					case 'add':
						return ln !== null && rn !== null ? ln + rn : null;
					case 'subtract':
						return ln !== null && rn !== null ? ln - rn : null;
					case 'multiply':
						return ln !== null && rn !== null ? ln * rn : null;
					case 'divide':
						return ln !== null && rn !== null && rn !== 0 ? ln / rn : null;
					case 'lt':
						return ln !== null && rn !== null ? ln < rn : null;
					case 'lte':
						return ln !== null && rn !== null ? ln <= rn : null;
					case 'gt':
						return ln !== null && rn !== null ? ln > rn : null;
					case 'gte':
						return ln !== null && rn !== null ? ln >= rn : null;
					case 'eq':
						return l === r;
					case 'neq':
						return l !== r;
					case 'and':
						return Boolean(l) && Boolean(r);
					case 'or':
						return Boolean(l) || Boolean(r);
					default:
						return null;
				}
			}
			case 'call':
				// 有返回值的原语（读传感器那类）本执行器不实现：目录里 SO-101 没有用到
				return null;
			default:
				return null;
		}
	}

	private evalArgument(arg: ImplArgument, scope: Scope): unknown {
		if (typeof arg === 'number' || typeof arg === 'string' || typeof arg === 'boolean') return arg;
		if (Array.isArray(arg)) return arg;
		return this.evalExpression(arg, scope);
	}

	// ---- 原语执行 ---------------------------------------------------------

	/** 单个原语：认不出来的原语不假装做过——报 skipped 并说明原因。 */
	private async applyPrimitive(
		primitiveRef: string,
		args: Record<string, unknown>,
	): Promise<{ state: StepState; detail?: string; durationSec?: number }> {
		const spec = this.primitiveSpec(primitiveRef);
		if (!spec) return { state: 'skipped', detail: '目录里没有这个原语' };

		switch (primitiveRef) {
			case 'move_to_named_pose': {
				const name = String(args['pose_name'] ?? '');
				const pose = namedPose(name);
				if (!pose) return { state: 'skipped', detail: `未知命名位姿 ${name}` };
				await this.rig.moveJoints(pose.joints, 1.6);
				return { state: 'done', detail: `${name}（${pose.source}）`, durationSec: 1.6 };
			}
			case 'move_to_joint_positions':
			case 'move_to_configuration': {
				const joints = normalizeJoints(args['joint_positions']);
				if (!joints) return { state: 'failed', detail: 'joint_positions 形状不认识' };
				const duration = num(args['duration_sec']) ?? 1.5;
				await this.rig.moveJoints(joints, duration);
				return { state: 'done', durationSec: duration };
			}
			case 'move_through_joint_positions': {
				const template = asTemplate(args['trajectory_template']);
				if (!template) return { state: 'skipped', detail: '轨迹模板类型不支持' };
				const waypoints = synthesize(template);
				// 安全边界：模板自带 workspace_limits，逐拍正解出检查点再比对。
				// 越界就拒绝执行（不静默截断），算不出来就如实说明跳过了检查。
				const guard = this.checkWorkspace(template.workspace_limits, waypoints);
				if (guard.violation) {
					// 标定可信才拦；拿估算的连杆长度去否决上游动作是假精确，改成带提示照跑
					if (this.rig.calibration === 'verified') return { state: 'refused', detail: guard.violation };
					await this.rig.playWaypoints(waypoints);
					return {
						state: 'done',
						durationSec: trajectorySeconds(waypoints),
						detail: `${waypoints.length} 拍 · 边界提示（本模型标定未验证，照跑）：${guard.violation}`,
					};
				}
				await this.rig.playWaypoints(waypoints);
				const detail = [`${waypoints.length} 拍`, guard.note].filter(Boolean).join(' · ');
				return { state: 'done', durationSec: trajectorySeconds(waypoints), detail };
			}
			case 'move_relative_ee': {
				const direction = String(args['motion_direction'] ?? '');
				const distance = num(args['motion_distance']);
				if (distance === null) return { state: 'failed', detail: 'motion_distance 不是数字' };
				if (!KNOWN_DIRECTIONS.has(direction.toLowerCase())) {
					return { state: 'skipped', detail: `不认识的方向 ${JSON.stringify(direction)}（可用：${[...KNOWN_DIRECTIONS].join(' / ')}）` };
				}
				const before = this.rig.toolPosition();
				await this.rig.moveEE(direction, distance);
				const after = this.rig.toolPosition();
				const achieved = Math.hypot(after.x - before.x, after.y - before.y, after.z - before.z);
				// 解析解会在行程边界处夹住，所以如实报"实际走了多远"，不照抄请求值
				const short = achieved < distance * 0.9;
				return {
					state: 'done',
					durationSec: 0.6,
					detail: short
						? `${direction} ${distance} m → 实际 ${achieved.toFixed(3)} m（到行程边界了）`
						: `${direction} ${distance} m`,
				};
			}
			case 'move_to_pose': {
				const target = args['target_pose'];
				if (!isRecord(target)) return { state: 'failed', detail: 'target_pose 形状不认识' };
				// 目录里的 target_pose 是 base 系位姿；SO-101 的 16 个技能没用它，
				// 这里只做「按方向分量平移」的保守解释，做不到就如实说。
				return { state: 'skipped', detail: 'target_pose 需要完整位姿解算，本执行器只支持相对移动' };
			}
			case 'open_gripper':
				await this.rig.setGripper(1, 0.4);
				return { state: 'done', durationSec: 0.4 };
			case 'close_gripper':
				await this.rig.setGripper(0, 0.4);
				return { state: 'done', durationSec: 0.4 };
			case 'rotate_gripper_cw':
			case 'rotate_gripper_ccw': {
				const deg = num(args['motion_distance']);
				if (deg === null) return { state: 'failed', detail: 'motion_distance 不是数字' };
				const signed = primitiveRef === 'rotate_gripper_cw' ? -deg : deg;
				await this.rig.rotateTool(signed, 0.5);
				return { state: 'done', durationSec: 0.5, detail: `${signed}°` };
			}
			default:
				return { state: 'skipped', detail: '本执行器没有实现这个原语' };
		}
	}

	/** 逐拍检查 workspace_limits；采样步长 4 拍，够密也不至于拖慢 */
	private checkWorkspace(
		limits: ReturnType<typeof asTemplate> extends null ? never : Parameters<typeof checkLimits>[0],
		waypoints: readonly Waypoint[],
	): { violation: string | null; note?: string } {
		if (!limits?.points) return { violation: null, note: '模板未附边界' };
		const first = this.rig.linkPositions(waypoints[0]?.joints ?? {});
		if (!first) return { violation: null, note: '本设备算不出检查点，未做边界校验' };
		for (let i = 0; i < waypoints.length; i += 4) {
			const links = this.rig.linkPositions(waypoints[i]?.joints ?? {});
			if (!links) return { violation: null, note: '本设备算不出检查点，未做边界校验' };
			for (const [point, sample] of Object.entries(links)) {
				const bad = checkLimits(limits, point, sample);
				if (bad) return { violation: `第 ${i} 拍越界：${bad}`, note: '边界校验未通过' };
			}
		}
		return { violation: null, note: '边界校验通过' };
	}

	// ---- 语句树执行 -------------------------------------------------------

	private async runStatements(
		statements: readonly ImplStatement[],
		scope: Scope,
		capabilityRef: string,
		counter: { index: number; total: number },
		events: StepEvent[],
		unrunnable: string[],
	): Promise<string | null> {
		for (const statement of statements) {
			if (this.cancelled) return '已取消';
			if (statement.kind === 'set') {
				scope.set(statement.target, this.evalExpression(statement.value, scope));
				continue;
			}
			if (statement.kind === 'if') {
				const branch = this.evalExpression(statement.condition, scope) ? statement.then : (statement.else ?? []);
				const nested = await this.runStatements(branch, scope, capabilityRef, counter, events, unrunnable);
				if (nested) return nested;
				continue;
			}
			if (statement.kind === 'delegate') {
				/*
				 * 委托步：实现在执行侧（`pick_object` → `/manipulation/execute_pick`），
				 * **本机这套仿真压根没有那套东西**。三件事在这儿说清：
				 *
				 * ① 照报一步（`skipped` + 接口名），不静默跳过——静默跳过会让 `pick_object`
				 *    跑出「计划完成：1 步都走通了」而屏幕上一条步骤行都没有，那是假账；
				 * ② 报**只有终态**，不先报 `running`：这一步没有时长、什么都没动，
				 *    报一个 running 出去只是闪一下；
				 * ③ 记进 `unrunnable`：它是「没演」不是「没成」，`ok` 与 `last.success` 都不许
				 *    因此变坏（见 `RunOutcome.unrunnable`）。
				 */
				counter.index += 1;
				const args: Record<string, unknown> = {};
				for (const [name, arg] of Object.entries(statement.arguments)) {
					args[name] = this.evalArgument(arg, scope);
				}
				const event: StepEvent = {
					capabilityRef,
					primitiveRef: null,
					interfaceRef: statement.interfaceRef,
					index: counter.index,
					total: counter.total,
					args,
					state: 'skipped',
					detail: `实现在执行侧（${statement.interfaceRef}），本机仿真不演这一步`,
					...(this.planIndex === 0 ? {} : { planIndex: this.planIndex }),
					...(this.taskId === undefined ? {} : { taskId: this.taskId }),
				};
				unrunnable.push(statement.interfaceRef);
				events.push(event);
				this.hooks.onStep?.(event);
				continue;
			}
			if (statement.kind !== 'call') continue;

			const args: Record<string, unknown> = {};
			for (const [name, arg] of Object.entries(statement.arguments)) {
				args[name] = this.evalArgument(arg, scope);
			}
			counter.index += 1;
			const base = {
				capabilityRef,
				primitiveRef: statement.primitiveRef,
				index: counter.index,
				total: counter.total,
				args,
				...(this.planIndex === 0 ? {} : { planIndex: this.planIndex }),
				...(this.taskId === undefined ? {} : { taskId: this.taskId }),
			};
			this.hooks.onStep?.({ ...base, state: 'running' });
			const result = await this.applyPrimitive(statement.primitiveRef, args);
			const event: StepEvent = {
				...base,
				state: result.state,
				...(result.detail === undefined ? {} : { detail: result.detail }),
				...(result.durationSec === undefined ? {} : { durationSec: result.durationSec }),
			};
			events.push(event);
			this.hooks.onStep?.(event);
			if (result.state === 'failed' || result.state === 'refused') {
				return result.detail ?? `${statement.primitiveRef} 未完成`;
			}
		}
		return null;
	}

	/** 跑一个能力：参数按目录声明校验，然后逐条执行 implementation。 */
	async run(capability: CapabilitySpec, params: Record<string, unknown>): Promise<RunOutcome> {
		this.cancelled = false;
		const scope: Scope = new Map();
		for (const param of capability.parameters) {
			const value = params[param.name];
			if (value === undefined || value === '') {
				return { ok: false, steps: [], reason: `缺少参数 ${param.name}` };
			}
			scope.set(param.name, param.type === 'number' ? Number(value) : value);
		}
		const total = countSteps(capability.implementation);
		const events: StepEvent[] = [];
		const unrunnable: string[] = [];
		const reason = await this.runStatements(
			capability.implementation,
			scope,
			capability.capabilityRef,
			{ index: 0, total },
			events,
			unrunnable,
		);
		const outcome = reason === null ? { ok: true, steps: events } : { ok: false, steps: events, reason };
		return unrunnable.length === 0 ? outcome : { ...outcome, unrunnable };
	}

	/**
	 * 跑**一个原语**：上游 `PrimitiveCommand.action` → `/embodied/execute_primitive` 那条路。
	 *
	 * 为什么要有这个公开入口：有些原子动作**没有**技能包装（`open_gripper` / `close_gripper` 这种），
	 * 计划里想直接叫它就得有地方接——`run()` 只接 `CapabilitySpec`，而原语不是能力
	 * （目录里没有它的 `implementation`）。这里就是那条直路，四件事说清：
	 *
	 * - **参数按目录声明校验**：名字必须是那个原语声明过的（多给的名字当场拒，
	 *   不悄悄咽下去送给设备），标了 `required: true` 的缺了是错误——判据来自目录；
	 *   没标必填的缺了**不是错**：执行侧对它们有默认值（与计划层那条「只提醒」同一条口径，
	 *   计划层放行的事，执行侧不许反过来拒）。
	 * - **事件照常报**：`running` 与终态各一条，走同一个 `onStep`。
	 *   跑计划时（`setPlanContext` 设过）它们带着计划序号与 task_id；
	 *   直接叫一个原语时那一栏如实缺席（跟 `capabilityRef` 同一个道理）。
	 * - **可取消**：取消标记由 `beginRun()` 清（与跑计划同一个口径），这里只看它——
	 *   取消之后不假装跑过。原语一旦下发就没法从中间叫停，这一点与技能步一样如实。
	 * - **失败如实返回**：原语认不出来、参数不对，都是 `ok: false` 带原因，不抛异常、不粉饰。
	 *
	 * 事件里的步骤号恒为 `1/1`：这是**一个**原语，不是一条实现。
	 */
	async runPrimitiveCommand(primitiveRef: string, params: Record<string, unknown> = {}): Promise<RunOutcome> {
		const spec = this.primitiveSpec(primitiveRef);
		if (spec === undefined) return { ok: false, steps: [], reason: `目录里没有原语 ${primitiveRef}` };

		const declared = new Set(spec.parameters.map((parameter) => parameter.name));
		for (const name of Object.keys(params)) {
			if (declared.has(name)) continue;
			return { ok: false, steps: [], reason: `原语 ${primitiveRef} 没有参数 ${name}` };
		}

		const args: Record<string, unknown> = {};
		for (const parameter of spec.parameters) {
			const value = params[parameter.name];
			if (value === undefined || value === '') {
				if (parameter.required === true) return { ok: false, steps: [], reason: `缺少参数 ${parameter.name}` };
				continue;
			}
			args[parameter.name] = parameter.type === 'number' ? Number(value) : value;
		}

		if (this.cancelled) return { ok: false, steps: [], reason: '已取消' };

		const base = {
			primitiveRef,
			index: 1,
			total: 1,
			args,
			...(this.planIndex === 0 ? {} : { planIndex: this.planIndex }),
			...(this.taskId === undefined ? {} : { taskId: this.taskId }),
		};
		this.hooks.onStep?.({ ...base, state: 'running' });
		const result = await this.applyPrimitive(primitiveRef, args);
		const event: StepEvent = {
			...base,
			state: result.state,
			...(result.detail === undefined ? {} : { detail: result.detail }),
			...(result.durationSec === undefined ? {} : { durationSec: result.durationSec }),
		};
		this.hooks.onStep?.(event);
		// `failed` 与 `refused` 是没做成（与 `run()` 同一口径）；`skipped` 是「没做，但也没坏」，
		// 它照旧不算失败——把它算成失败，会让「这一步没做成」这句话指向一次根本没下发的动作。
		if (result.state === 'failed' || result.state === 'refused') {
			return { ok: false, steps: [event], reason: result.detail ?? `${primitiveRef} 未完成` };
		}
		return { ok: true, steps: [event] };
	}
}

/**
 * 数一数这棵语句树里有多少**步**（进度显示用）：原语调用 + **委托**。
 *
 * 委托不是原语调用，但它是这一步真的报出来的一件事——进度里不数它，
 * 报出来的步号就会越过总数（`index` > `total`），那一栏就开始说瞎话。
 */
export function countSteps(statements: readonly ImplStatement[]): number {
	let n = 0;
	for (const s of statements) {
		if (s.kind === 'call' || s.kind === 'delegate') n += 1;
		else if (s.kind === 'if') n += countSteps(s.then) + countSteps(s.else ?? []);
	}
	return n;
}
