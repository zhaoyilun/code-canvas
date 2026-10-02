/**
 * 轨迹模板展开：把上游 `move_through_joint_positions` 的 trajectory_template
 * 合成成一串关节角路点。
 *
 * 两种模板（目录里出现的全部）：
 *
 * - `single_joint_wave_v1`：单关节正弦摆动
 *   `j(t) = base_j + amplitude · sin(2π·t)`，其余关节保持 base。
 * - `wave_dance_v1`：多关节傅里叶级数
 *   `j(t) = base_j + Σ A_k · sin(2π·h_k·t + φ_k)`。
 *
 * 归一化口径（**这是本仓库的解释，不是上游代码**）：`t = i / active_waypoint_count`，
 * 即 `harmonic` = 「整段序列里摆几个周期」。上游由执行器展开模板，我们看不到它的
 * 归一化方式；选这个口径是因为 h=1,2 出来的动作幅度和节奏与技能描述相符。
 * 换口径只需改这一处，路点数量与每拍时长都照抄模板。
 */

export interface FourierTerm {
	readonly amplitude: number;
	readonly harmonic: number;
	readonly phase: number;
}

export interface WaveDanceTemplate {
	readonly type: 'wave_dance_v1';
	readonly waypoint_duration_sec: number;
	readonly active_waypoint_count: number;
	readonly repeat_count: number;
	readonly zero_hold_count?: number;
	readonly base_pose: Record<string, number>;
	readonly joints: Record<string, { readonly terms: readonly FourierTerm[] }>;
	readonly workspace_limits?: WorkspaceLimits;
}

export interface SingleJointWaveTemplate {
	readonly type: 'single_joint_wave_v1';
	readonly waypoint_duration_sec: number;
	readonly active_waypoint_count: number;
	readonly repeat_count: number;
	readonly base_pose: Record<string, number>;
	readonly joint: string;
	readonly amplitude: number;
	readonly workspace_limits?: WorkspaceLimits;
}

export type TrajectoryTemplate = WaveDanceTemplate | SingleJointWaveTemplate;

/** 上游给的安全边界：末端（ee）在中点坐标系里的允许范围 */
export interface WorkspaceLimits {
	readonly model?: string;
	readonly points?: Record<string, Record<string, readonly [number, number]>>;
}

export interface Waypoint {
	/** 关节 1~5 的角度（弧度） */
	readonly joints: Record<string, number>;
	/** 到达这一拍用的时间（秒） */
	readonly dt: number;
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** 契约里 trajectory_template 声明成 json，形状得自己认；认不出来就返回 null，别硬猜。 */
export function asTemplate(value: unknown): TrajectoryTemplate | null {
	if (!isRecord(value)) return null;
	const type = value['type'];
	if (type !== 'wave_dance_v1' && type !== 'single_joint_wave_v1') return null;
	const dt = value['waypoint_duration_sec'];
	const count = value['active_waypoint_count'];
	const base = value['base_pose'];
	if (typeof dt !== 'number' || dt <= 0) return null;
	if (typeof count !== 'number' || count <= 0) return null;
	if (!isRecord(base)) return null;
	return value as unknown as TrajectoryTemplate;
}

function baseJoints(base: Record<string, number>): Record<string, number> {
	const out: Record<string, number> = {};
	for (const key of Object.keys(base)) out[key] = base[key] ?? 0;
	return out;
}

/** 合成一段轨迹：先按模板生成 active 段，再按 repeat_count 重复，首尾各补 zero_hold 拍 */
export function synthesize(template: TrajectoryTemplate): Waypoint[] {
	const dt = template.waypoint_duration_sec;
	const count = template.active_waypoint_count;
	const repeats = Math.max(1, Math.floor(template.repeat_count ?? 1));
	const base = baseJoints(template.base_pose);
	const hold = template.type === 'wave_dance_v1' ? Math.max(0, Math.floor(template.zero_hold_count ?? 0)) : 0;

	const active: Record<string, number>[] = [];
	for (let i = 0; i < count; i++) {
		const t = i / count;
		const pose: Record<string, number> = { ...base };
		if (template.type === 'single_joint_wave_v1') {
			pose[template.joint] = (base[template.joint] ?? 0) + template.amplitude * Math.sin(2 * Math.PI * t);
		} else {
			for (const [joint, track] of Object.entries(template.joints)) {
				let value = base[joint] ?? 0;
				for (const term of track.terms) {
					value += term.amplitude * Math.sin(2 * Math.PI * term.harmonic * t + term.phase);
				}
				pose[joint] = value;
			}
		}
		active.push(pose);
	}

	const out: Waypoint[] = [];
	for (let h = 0; h < hold; h++) out.push({ joints: { ...base }, dt });
	for (let r = 0; r < repeats; r++) {
		for (const pose of active) out.push({ joints: pose, dt });
	}
	for (let h = 0; h < hold; h++) out.push({ joints: { ...base }, dt });
	return out;
}

export function trajectorySeconds(waypoints: readonly Waypoint[]): number {
	return waypoints.reduce((n, w) => n + w.dt, 0);
}

/** 关节角路点是否落在给定安全边界内（只检查能算的部分：越界就拒绝执行，不静默截断） */
export function checkLimits(
	limits: WorkspaceLimits | undefined,
	point: string,
	sample: Record<string, number>,
): string | null {
	const range = limits?.points?.[point];
	if (!range) return null;
	for (const [axis, bounds] of Object.entries(range)) {
		const value = sample[axis];
		if (typeof value !== 'number') continue;
		const lo = bounds[0];
		const hi = bounds[1];
		if (value < lo || value > hi) {
			return `${point}.${axis}=${value.toFixed(3)} 越界 [${lo}, ${hi}]`;
		}
	}
	return null;
}
