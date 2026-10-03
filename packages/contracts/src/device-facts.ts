/**
 * 设备事实：一次原语调用**落到哪儿**。
 *
 * 为什么要有这一层：模板里一半技能的实现只有一条原语
 * （`inspect_scene` = `move_to_named_pose(pose_name="observe_table")`）。
 * 光看这一行，「机器为了执行这个动作具体做了什么」就无从说起——**那条调用落到哪个坐标上，
 * 上游写着，我们得导进来**。
 *
 * 四类事实，全部来自上游 `robot_config` 与技能库（一个数字都不编）：
 *
 * 1. `named_poses.<名字>` 的 `position` / `orientation` —— 位姿名落在哪个坐标；
 * 2. `embodied.execution` 的相对运动量与夹爪开合位 —— 一步多远、方向映射、夹爪到位值；
 * 3. 轨迹模板（`trajectory_template`）的**展开规则** —— 抄上游 `expand_trajectory_template`
 *    那一侧（`embodied_common/trajectory_templates.py`），不是我们的发明；
 * 4. 原语参数的**单位与范围** —— 上游模板的 `capability.parameters` 里写着的 `unit` /
 *    `exclusiveMinimum`（`gateway_policy.py` 真的按它校验）。
 *
 * 谁读它：这些真值是**给模型的参考材料**——机器会什么、每个技能底下有哪些原语、
 * 命名位姿的真实坐标是什么、一步走多远。模型要照着一个真实坐标写教学规格，就不能靠猜；
 * 没有这一层，它只能编一个数字，而屏幕上每个字都得对得上事实。
 * 所以这个文件提供两件事：**按名字读**（下面那四个 `find*` / `*Of`）与
 * **把一次调用说成人话**（`describeDeviceFacts`，给提示词直接用）。
 *
 * 一条纪律贯穿全篇：**说不出来就什么都不说**。认不出的模板类型、查不到的位姿名、
 * 缺了取值的实参，一律给 `undefined` / 空数组——绝不返回一个默认值顶上。
 */
import { z } from 'zod';
import type { CapabilityCatalog, PrimitiveSpec } from './capability';
import { isJsonObject, type JsonValue } from './json';

// ---------------------------------------------------------------------------
// 形状
// ---------------------------------------------------------------------------

/** 一个 `position` / `orientation` 的三四个分量：缺一个都不补 0（补了就是编）。 */
const xyzSchema = z.object({ x: z.number(), y: z.number(), z: z.number() }).strict();
const quaternionSchema = z.object({ x: z.number(), y: z.number(), z: z.number(), w: z.number() }).strict();

/**
 * 一个命名位姿落到的坐标（上游 `robot.embodied.named_poses.<名字>`）。
 *
 * 上游 `skill_executor_node._pose_from_name` 读的就是这六个量：`position` 三个进
 * `Pose.position`，`orientation` 四个进 `Pose.orientation`。
 * 两半都可缺（上游某台设备可能只写位置），但**不能两半都空**——那样这条事实什么都没说。
 */
export const namedPoseTargetSchema = z
	.object({
		name: z.string().trim().min(1).max(64),
		position: xyzSchema.optional(),
		orientation: quaternionSchema.optional(),
	})
	.strict()
	.refine(
		(target) => target.position !== undefined || target.orientation !== undefined,
		'命名位姿的 position 与 orientation 不能都缺——这条事实要说出点什么才值得写进目录',
	);
export type NamedPoseTarget = z.infer<typeof namedPoseTargetSchema>;

/**
 * 执行侧的量（上游 `robot.embodied.execution`）。
 *
 * 逐项可缺：上游某个字段没有就是没有，我们**不补默认值**——上游 `loader.py` 里那套
 * 「缺了就取 1.0 / 0.0」的兜底是执行侧的运行时行为，不是这台设备声明过的事实。
 * 参考系与方向映射一起才说得清「forward 落到 (0, -1, 0)」；少一半时渲染层只说得到的那半。
 */
export const executionFactsSchema = z
	.object({
		/** 「一点」默认映射步长（米）。上游 `embodied.execution.relative_motion_step_m`。 */
		relativeMotionStepM: z.number().optional(),
		/** 方向映射所在的参考系（上游写着 `base`）。 */
		relativeMotionReferenceFrame: z.string().trim().min(1).max(64).optional(),
		/** 方向名 → 单位向量（`forward → [0, -1, 0]`）。 */
		relativeMotionDirectionMapping: z
			.record(z.string().trim().min(1).max(64), z.tuple([z.number(), z.number(), z.number()]))
			.optional(),
		/** 夹爪张开到位值（上游 `embodied.execution.gripper_open_position`）。 */
		gripperOpenPosition: z.number().optional(),
		/** 夹爪闭合到位值（上游 `embodied.execution.gripper_closed_position`）。 */
		gripperClosedPosition: z.number().optional(),
	})
	.strict();
export type ExecutionFacts = z.infer<typeof executionFactsSchema>;

/**
 * 一种轨迹模板的展开规则（上游 `expand_trajectory_template`）。
 *
 * 规则本身是**代码**（`generate_wave_dance_v1` / `generate_single_joint_wave_v1`），
 * 这里把它摊成「读哪几个字段、缺省是多少」——字段名与缺省值逐条照抄那个文件，
 * 渲染层不写死任何一个。两种规则的区别正是上游两个函数的区别：
 *
 * - `cycle_repeat`：一个循环 `cycleField` 拍，重复 `repeatField` 次（`single_joint_wave_v1`）；
 * - `cycle_repeat_hold`：再加 `holdField` 拍**静止**（`wave_dance_v1` 末尾把最后一拍复制若干份）。
 *
 * 总数 = 循环拍数 × 重复次数（+ 静止拍）；总时长 = 总数 × 每拍时长。
 * 上游那个文件里两个 `for` 循环是嵌套的（外层 repeat、内层 cycle），所以是乘法不是加法。
 */
export const trajectoryTemplateRuleSchema = z
	.object({
		/** 上游认的模板类型名（`trajectory_template.type`）。 */
		templateType: z.string().trim().min(1).max(64),
		rule: z.enum(['cycle_repeat', 'cycle_repeat_hold']),
		/** 一个循环多少拍。 */
		cycleField: z.string().trim().min(1).max(64),
		/** 上游给这个字段的缺省（`wave_dance_v1` 是 0 且必须为正，所以这里不填）。 */
		cycleDefault: z.number().int().positive().optional(),
		repeatField: z.string().trim().min(1).max(64),
		repeatDefault: z.number().int().positive(),
		/** 末尾静止拍；只有 `cycle_repeat_hold` 这一种规则读它。 */
		holdField: z.string().trim().min(1).max(64).optional(),
		holdDefault: z.number().int().nonnegative().optional(),
		/** 每拍时长（秒）。 */
		durationField: z.string().trim().min(1).max(64),
		/**
		 * 缺省每拍时长：上游 `DEFAULT_WAYPOINT_DURATION_SEC`（0.08）。
		 * 解析顺序照 `_expand_skill_templates`：模板字段 → 步骤字段 → 这个缺省。
		 */
		durationDefaultSec: z.number().positive(),
	})
	.strict()
	.refine(
		(rule) => (rule.rule === 'cycle_repeat_hold') === (rule.holdField !== undefined),
		'cycle_repeat_hold 必须有 holdField，cycle_repeat 必须没有——两种规则的区别就在这一个字段上',
	);
export type TrajectoryTemplateRule = z.infer<typeof trajectoryTemplateRuleSchema>;

/**
 * 一条原语的一次调用落到哪几条事实上，以及从**哪个实参**取值。
 *
 * 这是对上游 `skill_library/resolver.py` 的判读，逐条都能指回去：
 * - `move_to_named_pose`：`pose_name` → `_pose_from_name` 查 `named_poses`；
 * - `move_relative_ee`：`motion_direction` → `direction_to_delta` 查方向映射；
 * - `open_gripper` / `close_gripper`：没有实参，`gripper_position` 直接取开合位；
 * - `move_through_joint_positions`：`trajectory_template` → `expand_trajectory_template` 展开。
 *
 * 四个字段都可缺——缺的那条事实在这条原语上不成立，渲染层就不为它写说明行。
 */
export const primitiveFactsSchema = z
	.object({
		/** 哪个实参是命名位姿表里的名字。 */
		poseNameArgument: z.string().trim().min(1).max(64).optional(),
		/** 哪个实参是方向名（取值查 `execution.relativeMotionDirectionMapping`）。 */
		directionArgument: z.string().trim().min(1).max(64).optional(),
		/** 哪个实参是轨迹模板（按 `trajectoryTemplates` 里那条规则展开）。 */
		trajectoryArgument: z.string().trim().min(1).max(64).optional(),
		/** 这条原语落到哪个夹爪位上。 */
		gripperPosition: z.enum(['open', 'closed']).optional(),
	})
	.strict();
export type PrimitiveFacts = z.infer<typeof primitiveFactsSchema>;

// ---------------------------------------------------------------------------
// 按名字读
// ---------------------------------------------------------------------------

/** 浮点噪声（`0.05 × 48 = 2.4000000000000004`）不许上屏。 */
const trimFloat = (value: number): number => Number(value.toPrecision(12));

const numberOf = (value: JsonValue | undefined): number | undefined =>
	typeof value === 'number' && Number.isFinite(value) ? value : undefined;

/**
 * 一个命名位姿落在哪（`named_poses.observe_table` → 位置 + 姿态）。
 * 目录里没有这个名字、或这台设备根本没导坐标，就给 `undefined`——**不返回一个零点顶上**。
 */
export const findNamedPoseTarget = (
	catalog: CapabilityCatalog,
	name: string,
): NamedPoseTarget | undefined => catalog.namedPoseTargets?.find((target) => target.name === name);

/**
 * 一个方向落在哪：方向名、参考系、单位向量、设备默认一步多远。
 *
 * 四样一次给全：分开问会得到一个「有向量但不知道在哪个系里」的中间状态，
 * 而那个状态说出来的话是错的。方向名不在映射里、或这台设备没导执行量，就给 `undefined`——
 * **不拿 `resolver.py` 里那份兜底映射顶上**（那是上游的运行时缺省，不是这台设备声明过的事实）。
 *
 * `referenceFrame` / `stepM` 为 `null` 表示上游没写这一项：调用方照实说「没写」，
 * 不许替它写一个 `base` 或 `0.03`。
 */
export interface RelativeMotion {
	readonly direction: string;
	readonly referenceFrame: string | null;
	readonly vector: readonly [number, number, number];
	readonly stepM: number | null;
}

export const relativeMotionOf = (
	catalog: CapabilityCatalog,
	direction: string,
): RelativeMotion | undefined => {
	const vector = catalog.execution?.relativeMotionDirectionMapping?.[direction];
	if (vector === undefined) return undefined;
	return {
		direction,
		referenceFrame: catalog.execution?.relativeMotionReferenceFrame ?? null,
		vector,
		stepM: catalog.execution?.relativeMotionStepM ?? null,
	};
};

/** 夹爪到位值：`'open'` 是张开位、`'closed'` 是闭合位。上游没导就给 `undefined`。 */
export const gripperPositionOf = (
	catalog: CapabilityCatalog,
	position: 'open' | 'closed',
): number | undefined =>
	position === 'open' ? catalog.execution?.gripperOpenPosition : catalog.execution?.gripperClosedPosition;

/** 一种轨迹模板的展开规则。认不出的类型给 `undefined`——调用方什么都不说，不猜一个。 */
export const findTrajectoryTemplateRule = (
	catalog: CapabilityCatalog,
	templateType: unknown,
): TrajectoryTemplateRule | undefined =>
	typeof templateType === 'string'
		? catalog.trajectoryTemplates?.find((rule) => rule.templateType === templateType)
		: undefined;

/** 一个轨迹模板展开的结果：多少拍、每拍多久、一共多久。 */
export interface TrajectoryExpansion {
	readonly templateType: string;
	readonly rule: TrajectoryTemplateRule['rule'];
	/** 循环拍数 × 重复次数（+ 静止拍）。 */
	/** 一个循环多少拍、重复几次、末尾几拍静止（`cycle_repeat` 那条规则里恒为 0）。 */
	readonly cycle: number;
	readonly repeat: number;
	readonly hold: number;
	/** 循环拍数 × 重复次数（+ 静止拍）。 */
	readonly waypointCount: number;
	readonly waypointDurationSec: number;
	readonly totalSec: number;
}

/**
 * 一个轨迹模板**展开成多少拍、多长时间**——按目录里那条规则算。
 *
 * 算得出才返回：认不出的模板类型、缺了必给的字段（上游对非正数直接抛错，这里同样不认）
 * 都给 `undefined`。拍数是乘法不是加法——上游那两个生成器是嵌套的两层循环
 * （外层 `repeat_count`、内层 `active_waypoint_count`），末尾再补 `zero_hold_count` 拍静止。
 */
export const expandTrajectoryTemplateOf = (
	catalog: CapabilityCatalog,
	template: JsonValue | undefined,
): TrajectoryExpansion | undefined => {
	if (!isJsonObject(template)) return undefined;
	const rule = findTrajectoryTemplateRule(catalog, template['type']);
	if (rule === undefined) return undefined;

	const cycle = numberOf(template[rule.cycleField]) ?? rule.cycleDefault;
	const repeat = numberOf(template[rule.repeatField]) ?? rule.repeatDefault;
	// 静止拍只有 `cycle_repeat_hold` 这一种规则读；上游缺了它当 0。
	const hold = rule.holdField === undefined ? 0 : (numberOf(template[rule.holdField]) ?? rule.holdDefault ?? 0);
	const duration = numberOf(template[rule.durationField]) ?? rule.durationDefaultSec;
	if (cycle === undefined || cycle <= 0 || repeat <= 0 || hold < 0 || duration <= 0) return undefined;

	const waypointCount = cycle * repeat + hold;
	return {
		templateType: rule.templateType,
		rule: rule.rule,
		cycle,
		repeat,
		hold,
		waypointCount,
		waypointDurationSec: duration,
		totalSec: trimFloat(waypointCount * duration),
	};
};

// ---------------------------------------------------------------------------
// 说法：目录级的两层（执行侧接口名 / 原语的运行时能力）
// ---------------------------------------------------------------------------

/**
 * 这台设备的**执行侧接口名** → 说明行（给提示词与界面用）。
 *
 * 键是上游 YAML 里那个字段名（逐字），值是它的取值，所以这一行本身就是一句可核对的话：
 * 「`primitive_action_name` = `/embodied/execute_primitive`」。
 * 这台设备没导到接口名（上游没写）时给空数组——不编一个默认值，
 * 上游 `skill_executor_node.py` 里那几个默认值不是这台设备声明过的事实。
 */
export const describeInterfaces = (catalog: CapabilityCatalog): readonly string[] =>
	Object.entries(catalog.interfaces ?? {}).map(([name, ref]) => `${name} = ${ref}`);

/**
 * 一条原语**要设备先具备哪些运行时能力** → 说明行。
 *
 * 两个字符串都来自上游：能力名是 `SkillRequirements` 的字段名，括号里那句是
 * `_CAPABILITY_UNAVAILABLE_MESSAGES` 的原文（「这条能力不满足时网关就是这么说的」）。
 * 上游没登记这条原语时给空数组——「上游没说」不许写成「不需要任何能力」。
 */
export const describeRuntimeCapabilities = (primitive: PrimitiveSpec): readonly string[] =>
	(primitive.runtimeCapabilities ?? []).map(
		(capability) => `${capability.name}（缺了的话网关说：${capability.unavailableMessage}）`,
	);

// ---------------------------------------------------------------------------
// 说法
// ---------------------------------------------------------------------------

/** 物理量的写法：整数也带一位小数（`1` → `1.0`），与上游 YAML 里 `1.0` 的字面一致。 */
const quantity = (value: number): string => (Number.isInteger(value) ? `${value}.0` : String(value));

const vector = (values: readonly number[]): string => `(${values.map((item) => quantity(item)).join(', ')})`;

/**
 * 一次原语调用 → 「它落到哪儿」的说明行（不含 `#` 前缀与缩进——那是渲染层的事）。
 *
 * `argumentValues` 是**已经解析过**的实参取值：渲染层按 `{kind:'param'}` 去节点参数里取，
 * 积木那边给实现里写死的那些。取不到的实参就是 `undefined`，对应的说明行**不产出**。
 *
 * 认不出的模板类型、查不到的位姿名、缺了一般的量——一律跳过。说不出来就什么都不说。
 */
export const describeDeviceFacts = (
	catalog: CapabilityCatalog,
	primitive: PrimitiveSpec,
	argumentValues: Readonly<Record<string, JsonValue | undefined>>,
): readonly string[] => {
	const facts = primitive.deviceFacts;
	if (facts === undefined) return [];

	const lines: string[] = [];

	// 1. 命名位姿：这个名字落在哪个坐标上。
	if (facts.poseNameArgument !== undefined) {
		const name = argumentValues[facts.poseNameArgument];
		const target = typeof name === 'string' ? findNamedPoseTarget(catalog, name) : undefined;
		if (typeof name === 'string' && target !== undefined) {
			lines.push(`${facts.poseNameArgument}=${JSON.stringify(name)} → named_poses.${name}`);
			if (target.position !== undefined) {
				const { x, y, z } = target.position;
				lines.push(`  位置 x=${quantity(x)} y=${quantity(y)} z=${quantity(z)}`);
			}
			if (target.orientation !== undefined) {
				const { x, y, z, w } = target.orientation;
				lines.push(`  姿态 四元数 x=${quantity(x)} y=${quantity(y)} z=${quantity(z)} w=${quantity(w)}`);
			}
		}
	}

	// 2. 相对运动：这个方向在参考系里是哪个向量、设备默认一步多远。
	if (facts.directionArgument !== undefined) {
		const direction = argumentValues[facts.directionArgument];
		const motion = typeof direction === 'string' ? relativeMotionOf(catalog, direction) : undefined;
		if (motion !== undefined) {
			const where = motion.referenceFrame === null ? '' : `在 ${motion.referenceFrame} 系`;
			const parts = [`${motion.direction} ${where}是 ${vector(motion.vector)}`];
			const sources = ['execution.relative_motion_direction_mapping'];
			// 参考系没导到时那句「在 X 系」整个不写——不留一个「在 系」的空位。
			if (motion.stepM !== null) {
				parts.push(`设备默认一步 ${quantity(motion.stepM)} m`);
				sources.push('relative_motion_step_m');
			}
			lines.push(`${parts.join('；')}（${sources.join(' / ')}）`);
		}
	}

	// 3. 夹爪：这条原语落到哪个到位值上（顺带说另一个，读的人才看得出两个数的关系）。
	if (facts.gripperPosition !== undefined) {
		const own = gripperPositionOf(catalog, facts.gripperPosition);
		if (own !== undefined) {
			const other = gripperPositionOf(catalog, facts.gripperPosition === 'open' ? 'closed' : 'open');
			const ownLabel = facts.gripperPosition === 'open' ? '张开到位' : '闭合到位';
			const otherLabel = facts.gripperPosition === 'open' ? '闭合位' : '张开位';
			const parts = [`${ownLabel} ${quantity(own)}`];
			if (other !== undefined) parts.push(`${otherLabel} ${quantity(other)}`);
			lines.push(`${parts.join('；')}（execution.gripper_open_position / _closed_position）`);
		}
	}

	// 4. 轨迹模板：这个模板展开成多少拍、多长时间。展开不出来（认不出的类型、缺字段）就不说。
	if (facts.trajectoryArgument !== undefined) {
		const expansion = expandTrajectoryTemplateOf(catalog, argumentValues[facts.trajectoryArgument]);
		if (expansion !== undefined) {
			const formula =
				expansion.hold > 0
					? `${expansion.cycle} × ${expansion.repeat} + ${expansion.hold} = ${expansion.waypointCount}`
					: `${expansion.cycle} × ${expansion.repeat} = ${expansion.waypointCount}`;
			lines.push(
				`模板 ${expansion.templateType} 展开成 ${formula} 拍，每拍 ${quantity(
					expansion.waypointDurationSec,
				)} 秒，共 ${quantity(expansion.totalSec)} 秒`,
			);
		}
	}

	return lines;
};
