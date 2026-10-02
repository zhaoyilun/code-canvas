/**
 * 能力目录：一台设备会做什么，以及**它内部是怎么做的**。
 *
 * 两层结构：`primitives` 是这台设备支持的基础操作（原子运动、读传感器、等待……），
 * `capabilities` 是对外可见的动作，每个都带一串 `implementation`——由原语组成的执行步骤。
 *
 * 教学上的意义：`capabilities` 是流程画布上的模块（函数调用点），
 * `implementation` 就是那个函数的体（点开模块看到的"机器到底做了什么"）。
 *
 * 谁的设备谁提供目录（插件产出，核心只认这个形状），所以底盘和机械臂能长在同一套结构下，
 * 各自的原语集不同而已。
 *
 * 见 docs/spec.md §5。
 */
import { z } from 'zod';
import { stableReferenceSchema } from './stable-ids';

/** 参数与实参的取值类型。`sensor` 与 `pose` 是给渲染层看的语义提示。 */
export const catalogValueTypeSchema = z.enum(['number', 'string', 'boolean', 'sensor', 'pose']);
export type CatalogValueType = z.infer<typeof catalogValueTypeSchema>;

export const catalogParameterSchema = z
	.object({
		name: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/, 'parameter name must be an identifier'),
		label: z.string().trim().min(1).max(64),
		type: catalogValueTypeSchema,
		/**
		 * 这个参数只取整数（关节号、毫秒时长这类）。缺省表示可以是小数。
		 * 渲染层据此决定 `3` 还是 `3.0`，积木那边也可以据此给整数输入。
		 */
		integer: z.boolean().optional(),
	})
	.strict();
export type CatalogParameter = z.infer<typeof catalogParameterSchema>;

/** 一个基础操作。它的参数就是积木上会长出来的那些字段。 */
export const primitiveSpecSchema = z
	.object({
		primitiveRef: stableReferenceSchema,
		label: z.string().trim().min(1).max(64),
		parameters: z.array(catalogParameterSchema),
	})
	.strict();
export type PrimitiveSpec = z.infer<typeof primitiveSpecSchema>;

/**
 * 实现里的一步：调用某个原语。
 *
 * 实参写成字符串时，`$name` 表示「取本能力的同名参数」——这样同一份实现能被不同参数复用，
 * 也是渲染层把 `linear=0.2` 填进代码行与积木字段的唯一依据。
 */
export const argumentValueSchema = z.union([
	z.string(),
	z.number(),
	z.boolean(),
	z.array(z.string()),
]);
export type ArgumentValue = z.infer<typeof argumentValueSchema>;

export const implementationStepSchema = z
	.object({
		step: stableReferenceSchema,
		arguments: z.record(z.string(), argumentValueSchema),
	})
	.strict();
export type ImplementationStep = z.infer<typeof implementationStepSchema>;

/** 一个对外可见的动作：流程画布上的一个模块。 */
export const capabilitySpecSchema = z
	.object({
		capabilityRef: stableReferenceSchema,
		label: z.string().trim().min(1).max(64),
		kind: z.enum(['skill', 'primitive']),
		/** 这个能力接收的参数；实现里的 `$name` 引用它们。 */
		parameters: z.array(catalogParameterSchema),
		/** **缺的那一层**：这个动作内部由哪些原语步骤组成。至少一步。 */
		implementation: z.array(implementationStepSchema).min(1),
	})
	.strict();
export type CapabilitySpec = z.infer<typeof capabilitySpecSchema>;

export const capabilityCatalogSchema = z
	.object({
		catalogRef: stableReferenceSchema,
		/** 面向人的一句话说明，例如「差速底盘」或「SO-101 单臂」。 */
		displayName: z.string().trim().min(1).max(64),
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
