/**
 * 能力目录：一台设备会做什么，以及**它内部是怎么做的**。
 *
 * 两层结构：
 * - `primitives` 是这台设备支持的基础操作，是实现的**词汇表**——`set_velocity`、`read_scan`、
 *   `open_gripper` 这类原子动作，有的**有返回值**（读传感器），有的没有（下发速度）。
 * - `capabilities` 是对外可见的动作，每个带一棵 **`implementation` 语句树**：由原语组成的程序，
 *   或者一条 **`delegate`**——实现在执行侧，模板里只有一个接口引用（见下）。
 *
 * 为什么是树而不是一串步骤：函数体是**程序**，有赋值、有分支、有嵌套。
 * 扁平的调用清单既长不出「如果……那么」这样的积木，也渲染不出有结构的代码。
 * 形状借鉴前作的 `LogicStatementV1` / `LogicExpressionV1`（见 docs/inherited.md），
 * 但只保留这里够用的：调用、赋值、条件、委托；字面量、引用、比较/算术、取反。
 *
 * 教学上的意义：`capabilities` 是流程画布上的模块（函数调用点），`implementation` 是函数体
 * ——点开一个模块，看到的就是「机器为了执行它具体做了哪些事」。
 *
 * 谁的设备谁提供目录（插件产出，核心只认这个形状），所以底盘和机械臂能长在同一套结构下。
 *
 * 见 docs/spec.md §5。
 */
import { z } from 'zod';
import {
	executionFactsSchema,
	namedPoseTargetSchema,
	primitiveFactsSchema,
	trajectoryTemplateRuleSchema,
} from './device-facts';
import { jsonValueSchema, type JsonValue } from './json';
import { interfaceReferenceSchema, stableReferenceSchema } from './stable-ids';

/**
 * 参数与返回值的取值类型。
 *
 * `sensor` 与 `pose` 是给渲染层看的语义提示；`json` 是**结构化载荷**——
 * 关节位置映射（`{"1": 0.02, …}`）、轨迹模板这类原语实参不是标量，
 * 真实设备（RoboFrame 的技能库）里到处都是。声明成 `json` 才渲染得出来，
 * 也才不至于把一整个对象悄悄变成 `null`。
 */
export const catalogValueTypeSchema = z.enum(['number', 'string', 'boolean', 'sensor', 'pose', 'json']);
export type CatalogValueType = z.infer<typeof catalogValueTypeSchema>;

/** 只有这些类型能出现在表达式里（sensor / pose 是参数侧的概念，不是值）。 */
export const expressionValueTypeSchema = z.enum(['number', 'string', 'boolean']);
export type ExpressionValueType = z.infer<typeof expressionValueTypeSchema>;

export const catalogParameterSchema = z
	.object({
		name: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/, 'parameter name must be an identifier'),
		label: z.string().trim().min(1).max(64),
		type: catalogValueTypeSchema,
		/**
		 * 这个参数只取整数（关节号、毫秒时长这类）。缺省表示可以是小数。
		 * 渲染层据此决定写 `3` 还是 `3.0`。
		 */
		integer: z.boolean().optional(),
		/** 单位（上游 YAML 里写着，例如 `meters` / `degrees`）。有就显示，没有不编。 */
		unit: z.string().trim().min(1).max(24).optional(),
		/**
		 * 开区间下界（上游 YAML 里写着的 `exclusiveMinimum`，`gateway_policy.py` 真的按它校验）。
		 * 名字与上游逐字相同——换个说法就等于我们重新解释了一遍上游的约束。
		 */
		exclusiveMinimum: z.number().optional(),
		/**
		 * 这个参数**必须给**。
		 *
		 * 判据来自上游：技能的 `capability.parameters.required` 数组。缺了它就是缺陷，
		 * 不再是「执行侧会用默认值」——上游说必填就是必填。
		 */
		required: z.boolean().optional(),
	})
	.strict();
export type CatalogParameter = z.infer<typeof catalogParameterSchema>;

/**
 * 这台设备的一条**运行时能力**（上游 `gateway_policy.SkillRequirements` 的字段 + 它自己的说法）。
 *
 * 两个字段都是上游的：`name` 是那个 dataclass 的字段名，`unavailableMessage` 是上游
 * `_CAPABILITY_UNAVAILABLE_MESSAGES` 里那句话（「这条能力不满足时网关就是这么说的」）。
 * 不自己翻一遍：那句话是上游面向用户的原文，我们重写一遍就等于替它解释。
 */
export const runtimeCapabilitySchema = z
	.object({
		name: z.string().trim().min(1).max(64),
		/** 上游那句话（`_CAPABILITY_UNAVAILABLE_MESSAGES[name]`）。 */
		unavailableMessage: z.string().trim().min(1).max(120),
	})
	.strict();
export type RuntimeCapability = z.infer<typeof runtimeCapabilitySchema>;

/**
 * 一个基础操作。
 * `returns` 缺省表示它不返回值（只能当语句用）；给了就说明它能出现在表达式里。
 */
export const primitiveSpecSchema = z
	.object({
		primitiveRef: stableReferenceSchema,
		label: z.string().trim().min(1).max(64),
		/** 这个原子动作做什么，一句话（上游文档里那句）。 */
		summary: z.string().trim().min(1).max(200).optional(),
		/**
		 * 跑这条原语**设备上要先具备哪些运行时能力**（上游 `gateway_policy` 的
		 * `_PRIMITIVE_CAPABILITY_MAP` + `_CAPABILITY_UNAVAILABLE_MESSAGES`，顺序照上游
		 * `_CAPABILITY_ORDER`）。
		 *
		 * 与 `deviceFacts` 的区别：那是「这一次调用落到哪个坐标 / 哪个到位值」，这是
		 * 「这台设备得先有什么才有得谈」——`move_relative_ee` 要 `fresh_ee_pose`（末端位姿得是新的），
		 * `move_to_joint_positions` 要 `arm_trajectory`（轨迹通道）。
		 * 上游那张表只登记了 8 条，剩下的两条（`move_to_pose` / `move_to_configuration`）
		 * 上游没说，这里就**不写**——空数组与「上游没登记」是两件事，不许用一个空数组糊过去。
		 */
		runtimeCapabilities: z.array(runtimeCapabilitySchema).optional(),
		parameters: z.array(catalogParameterSchema),
		returns: expressionValueTypeSchema.optional(),
		/**
		 * 这条原语的一次调用**落到设备的哪几条事实上**（见 `device-facts.ts`）。
		 *
		 * 为什么挂在原语上而不是能力上：这些事实是**设备属性**（一张位姿表、一套方向映射、
		 * 一个夹爪到位值），一次调用落到哪几条由上游 `resolver.py` 决定——它把模板字段翻成
		 * 原语实参时就定下了（`pose_name` 查 `named_poses`、`motion_direction` 查方向映射）。
		 * 没登记就是「这条路我们不认识」：渲染层什么都不写，不猜。
		 */
		deviceFacts: primitiveFactsSchema.optional(),
	})
	.strict();
export type PrimitiveSpec = z.infer<typeof primitiveSpecSchema>;

// ---------------------------------------------------------------------------
// 实现：语句树
// ---------------------------------------------------------------------------

/**
 * 实参的取值：字面量，或者一个表达式（引用某参数/局部变量、嵌套调用、算术……）。
 * 字面量允许匿名数组，是为了 `sensors: ["/scan0"]` 这种写法读起来干净。
 */
export const implArgumentSchema: z.ZodType<ImplArgument> = z.union([
	z.number(),
	z.string(),
	z.boolean(),
	z.array(z.string()),
	z.lazy(() => implExpressionSchema),
]);
export type ImplArgument = number | string | boolean | string[] | ImplExpression;

/** 表达式：有值的东西。 */
export const implExpressionSchema: z.ZodType<ImplExpression> = z.lazy(() =>
	z.discriminatedUnion('kind', [
		/**
		 * 写死的取值。除了标量，也可以是**任意 JSON**——真实原语的实参常常是一整个结构
		 * （`joint_positions={"1": 0.02, …}`、轨迹模板）。它们是实现的一部分，
		 * 因此与结构一样只读，不给编辑入口。
		 */
		z.object({ kind: z.literal('literal'), value: jsonValueSchema }).strict(),
		/** 按名字取：先找本能力实现里 `set` 过的局部变量，再找本能力的参数。 */
		z.object({ kind: z.literal('param'), name: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/) }).strict(),
		/** 有返回值的原语调用，例如 `read_scan("/scan0")`。 */
		z
			.object({
				kind: z.literal('call'),
				primitiveRef: stableReferenceSchema,
				arguments: z.record(z.string(), implArgumentSchema),
			})
			.strict(),
		z
			.object({
				kind: z.literal('binary'),
				operator: z.enum([
					'lt',
					'lte',
					'gt',
					'gte',
					'eq',
					'neq',
					'add',
					'subtract',
					'multiply',
					'divide',
					'and',
					'or',
				]),
				left: z.lazy(() => implExpressionSchema),
				right: z.lazy(() => implExpressionSchema),
			})
			.strict(),
		z
			.object({
				kind: z.literal('unary'),
				operator: z.enum(['not', 'negate']),
				value: z.lazy(() => implExpressionSchema),
			})
			.strict(),
	]),
);
export type ImplExpression =
	| { kind: 'literal'; value: JsonValue }
	| { kind: 'param'; name: string }
	| { kind: 'call'; primitiveRef: string; arguments: Record<string, ImplArgument> }
	| { kind: 'binary'; operator: BinaryOperator; left: ImplExpression; right: ImplExpression }
	| { kind: 'unary'; operator: 'not' | 'negate'; value: ImplExpression };

export type BinaryOperator =
	| 'lt'
	| 'lte'
	| 'gt'
	| 'gte'
	| 'eq'
	| 'neq'
	| 'add'
	| 'subtract'
	| 'multiply'
	| 'divide'
	| 'and'
	| 'or';

/** 语句：做事的东西。 */
export const implStatementSchema: z.ZodType<ImplStatement> = z.lazy(() =>
	z.discriminatedUnion('kind', [
		/** 调一个不返回值的原语。 */
		z
			.object({
				kind: z.literal('call'),
				primitiveRef: stableReferenceSchema,
				arguments: z.record(z.string(), implArgumentSchema),
			})
			.strict(),
		/** 给一个局部变量赋值。 */
		z
			.object({
				kind: z.literal('set'),
				target: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/),
				value: z.lazy(() => implExpressionSchema),
			})
			.strict(),
		/** 条件分支；`else` 缺省表示没有否则那半边。 */
		z
			.object({
				kind: z.literal('if'),
				condition: z.lazy(() => implExpressionSchema),
				then: z.array(z.lazy(() => implStatementSchema)).min(1),
				else: z.array(z.lazy(() => implStatementSchema)).min(1).optional(),
			})
			.strict(),
		/**
		 * **委托**：这一步的实现在执行侧，不在模板里。
		 *
		 * 为什么需要它：上游有「实现不在模板里」的技能。`pick_object` 的 `primitive_sequence`
		 * 是空的——它把能力委托给 `/manipulation/execute_pick`，GraspGen 在运行时才生成
		 * 6-DOF 候选，模板给不出步骤（上游 `skill_library/README.md` §4 末尾就是这么写的）。
		 * 没有这一种语句，那种技能只能被拒之门外，或者被编一条假的实现——两条都是错。
		 *
		 * `interfaceRef` 是那个**执行侧接口**的稳定引用（ROS action / service 名），
		 * **不是原语名**：它不进 `catalog.primitives`——那 10 个是上游 `skill_library` 的白名单，
		 * 往里塞一个设备上并不存在的原语，就把它污染了。
		 *
		 * `arguments` 与 `call` 同一套（`ImplArgument`），于是 `{kind:'param', name}` 能表达
		 * 「这一步的取值来自这个技能的参数」——同一份技能被不同参数复用，这条链不断。
		 *
		 * 本机仿真演不了它；bridge 那边能不能执行，由技能自己决定。
		 */
		z
			.object({
				kind: z.literal('delegate'),
				interfaceRef: interfaceReferenceSchema,
				arguments: z.record(z.string(), implArgumentSchema),
			})
			.strict(),
	]),
);
export type ImplStatement =
	| { kind: 'call'; primitiveRef: string; arguments: Record<string, ImplArgument> }
	| { kind: 'set'; target: string; value: ImplExpression }
	| { kind: 'if'; condition: ImplExpression; then: ImplStatement[]; else?: ImplStatement[] }
	/** 实现在执行侧：`interfaceRef` 是那边的接口名，不是本目录里的原语。 */
	| { kind: 'delegate'; interfaceRef: string; arguments: Record<string, ImplArgument> };

/** 一个对外可见的动作：流程画布上的一个模块。 */
export const capabilitySpecSchema = z
	.object({
		capabilityRef: stableReferenceSchema,
		label: z.string().trim().min(1).max(64),
		/** 这个动作是干什么的，一句话。目录有就显示，没有也不编。 */
		summary: z.string().trim().min(1).max(200).optional(),
		kind: z.enum(['skill', 'primitive']),
		/** 这个能力接收的参数；实现里用 `{kind:'param', name}` 引用它们。 */
		parameters: z.array(catalogParameterSchema),
		/** **函数体**：这个动作内部做了什么。至少一条语句。 */
		implementation: z.array(implStatementSchema).min(1),
	})
	.strict();
export type CapabilitySpec = z.infer<typeof capabilitySpecSchema>;

export const capabilityCatalogSchema = z
	.object({
		catalogRef: stableReferenceSchema,
		/** 面向人的一句话说明，例如「差速底盘」或「SO-101 单臂」。 */
		displayName: z.string().trim().min(1).max(64),
		/**
		 * 设备自己认的名字（上游 `robot_config` 里的 `robot.name`，如 `so101_single_arm`）。
		 * 设备自己的任务格式要写这个名字，校验时拿它对照——对不上就说明计划编给了别的机器。
		 */
		robotName: z.string().trim().min(1).max(64).optional(),
		revisionRef: stableReferenceSchema,
		/**
		 * **执行侧的接口名表**（上游机器人配置里写着、`skill_executor_node.py` 认的那些名字）。
		 *
		 * 键是上游 YAML 里的字段名，**逐字照抄**（`skill_action_name` / `primitive_action_name` /
		 * `validate_skill_service` / `task_command_topic` / `status_topic` /
		 * `task_executor_action_name` / `move_configuration_service`），值是它的取值。
		 * 为什么键不翻成 camelCase：这些名字是**这一层唯一的存在理由**——
		 * 「这一步最后发到哪个 topic / action」要能对着上游原文核，翻一遍就多一层可能翻错的东西。
		 *
		 * 为什么放在目录级而不是每条原语上：它们是**配置级的**（一台设备一份），
		 * 原语与技能共用同一对 action（`execute_primitive` / `execute_skill`）。
		 * 上游自己也把它们放在两处：`embodied.*` 与 `embodied.execution.*`——
		 * 导入脚本按各自的真实位置取，`task_executor_action_name` /
		 * `move_configuration_service` 因此来自 `embodied.execution`（见 `import.mjs` 的
		 * `INTERFACE_FIELDS`，那里逐条写着路径，并有对着 launch builder 的对账）。
		 */
		interfaces: z.record(z.string().trim().min(1).max(64), z.string().trim().min(1).max(128)).optional(),
		primitives: z.array(primitiveSpecSchema).min(1),
		capabilities: z.array(capabilitySpecSchema).min(1),
		/** 命名位姿之类设备自带的枚举，可选。 */
		namedPoses: z.array(z.string().trim().min(1)).optional(),
		/**
		 * 命名位姿**落在哪个坐标上**：`namedPoses` 只给名字，这里给那六个量。
		 *
		 * 与 `namedPoses` 同一个键集（导入脚本按同一份 YAML 一起产出，测试对账）。
		 * 为什么另开一个字段而不是把 `namedPoses` 改成对象数组：那份 name 列表已经被
		 * 别处读着（任务格式校验拿它对名字），改形状等于把一条在用的链子拆掉。
		 */
		namedPoseTargets: z.array(namedPoseTargetSchema).optional(),
		/** 执行侧的量：一步多远、方向映射、夹爪开合位（上游 `robot.embodied.execution`）。 */
		execution: executionFactsSchema.optional(),
		/** 轨迹模板的展开规则（上游 `expand_trajectory_template` 那一侧）。 */
		trajectoryTemplates: z.array(trajectoryTemplateRuleSchema).optional(),
	})
	.strict();
export type CapabilityCatalog = z.infer<typeof capabilityCatalogSchema>;

/** 查一个能力。 */
export const findCapability = (
	catalog: CapabilityCatalog,
	capabilityRef: string,
): CapabilitySpec | undefined =>
	catalog.capabilities.find((capability) => capability.capabilityRef === capabilityRef);

/** 查一个原语。 */
export const findPrimitive = (
	catalog: CapabilityCatalog,
	primitiveRef: string,
): PrimitiveSpec | undefined =>
	catalog.primitives.find((primitive) => primitive.primitiveRef === primitiveRef);
