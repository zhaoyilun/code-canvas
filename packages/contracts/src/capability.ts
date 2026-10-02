/**
 * 能力目录：一台设备会做什么，以及**它内部是怎么做的**。
 *
 * 两层结构：
 * - `primitives` 是这台设备支持的基础操作，是实现的**词汇表**——`set_velocity`、`read_scan`、
 *   `open_gripper` 这类原子动作，有的**有返回值**（读传感器），有的没有（下发速度）。
 * - `capabilities` 是对外可见的动作，每个带一棵 **`implementation` 语句树**：由原语组成的程序。
 *
 * 为什么是树而不是一串步骤：函数体是**程序**，有赋值、有分支、有嵌套。
 * 扁平的调用清单既长不出「如果……那么」这样的积木，也渲染不出有结构的代码。
 * 形状借鉴前作的 `LogicStatementV1` / `LogicExpressionV1`（见 docs/inherited.md），
 * 但只保留这里够用的：调用、赋值、条件；字面量、引用、比较/算术、取反。
 *
 * 教学上的意义：`capabilities` 是流程画布上的模块（函数调用点），`implementation` 是函数体
 * ——点开一个模块，看到的就是「机器为了执行它具体做了哪些事」。
 *
 * 谁的设备谁提供目录（插件产出，核心只认这个形状），所以底盘和机械臂能长在同一套结构下。
 *
 * 见 docs/spec.md §5。
 */
import { z } from 'zod';
import { jsonValueSchema, type JsonValue } from './json';
import { stableReferenceSchema } from './stable-ids';

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
 * 一个基础操作。
 * `returns` 缺省表示它不返回值（只能当语句用）；给了就说明它能出现在表达式里。
 */
export const primitiveSpecSchema = z
	.object({
		primitiveRef: stableReferenceSchema,
		label: z.string().trim().min(1).max(64),
		/** 这个原子动作做什么，一句话（上游文档里那句）。 */
		summary: z.string().trim().min(1).max(200).optional(),
		parameters: z.array(catalogParameterSchema),
		returns: expressionValueTypeSchema.optional(),
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
	]),
);
export type ImplStatement =
	| { kind: 'call'; primitiveRef: string; arguments: Record<string, ImplArgument> }
	| { kind: 'set'; target: string; value: ImplExpression }
	| { kind: 'if'; condition: ImplExpression; then: ImplStatement[]; else?: ImplStatement[] };

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
		primitives: z.array(primitiveSpecSchema).min(1),
		capabilities: z.array(capabilitySpecSchema).min(1),
		/** 命名位姿之类设备自带的枚举，可选。 */
		namedPoses: z.array(z.string().trim().min(1)).optional(),
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
