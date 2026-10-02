/**
 * 命名位姿：目录只给名字（`namedPoses: ["home","observe_table","zero"]`），
 * 关节值在上游 `robot_config` 的 YAML 里，本次导入没带过来。
 *
 * 所以这里对每个位姿**分别标注来源**——哪些是上游真值、哪些是本次近似。
 * 不标注就分不清「照抄」和「我编的」，那是拿演示冒充设备。
 */
export interface NamedPoseEntry {
	/** 五个关节的角度（弧度），键与上游 `joint_positions` 一致：1~5 */
	readonly joints: Record<string, number>;
	/** `upstream` = 目录里逐字出现的真值；`derived` = 从真值推出来；`placeholder` = 本次近似 */
	readonly source: 'upstream' | 'derived' | 'placeholder';
	readonly note: string;
}

/**
 * `observe_table` 是真值：wave / nod / shake / dance 这些技能都以它作为
 * `base_pose` 写死在轨迹模板里（`{"1":0.02,"2":0.54,"3":-0.82,"4":-0.18,"5":0.02}`），
 * 而它们的语义就是「在观察位姿做手势」。
 */
const OBSERVE_TABLE: Record<string, number> = { '1': 0.02, '2': 0.54, '3': -0.82, '4': -0.18, '5': 0.02 };

export const NAMED_POSES: Record<string, NamedPoseEntry> = {
	observe_table: {
		joints: OBSERVE_TABLE,
		source: 'upstream',
		note: '轨迹模板里的 base_pose 原值',
	},
	zero: {
		joints: { '1': 0, '2': 0, '3': 0, '4': 0, '5': 0 },
		source: 'derived',
		note: '零位按定义全零',
	},
	home: {
		joints: { '1': 0, '2': -0.6, '3': 0.9, '4': 0.35, '5': 0.02 },
		source: 'placeholder',
		note: '上游 YAML 才有真值，这里用收拢抬起的近似位姿',
	},
};

/** 目录里出现过的位姿名，取不到就返回 undefined——由调用方决定报错还是跳过 */
export function namedPose(name: string): NamedPoseEntry | undefined {
	return NAMED_POSES[name];
}
