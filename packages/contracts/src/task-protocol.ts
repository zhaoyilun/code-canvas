/**
 * 一期机器人任务协议（spec §1.1）。
 *
 * 约束逐条照 `docs/reference/task_protocol.py` 搬：`ALLOWED_ACTIONS`、`ALLOWED_SENSORS`、
 * `DEFAULT_LIMITS`，以及每个 action 分支的校验与**报错原文**。message 与参考实现逐字相同，
 * 是为了让「两边结论一致」可以被机械核对（见 test/parity.test.ts），不是美学选择。
 *
 * 参考实现是 fail-fast（第一处错就抛），这里是收集式（一次跑完给全部诊断）——
 * 结论（合法/非法）一致，报错集合是参考实现的超集。
 */
import { z } from 'zod';
import { DiagnosticCollector, type Diagnostic } from './diagnostic';
import { canonicalJsonString, jsonDetail } from './json';

export const TASK_SCHEMA_VERSION = '1.0';

/** 七种动作，这是全集。 */
export const ALLOWED_ACTIONS = [
	'move',
	'turn',
	'stop',
	'stop_if_obstacle',
	'get_status',
	'arm_joint',
	'arm6_joints',
] as const;
export type TaskAction = (typeof ALLOWED_ACTIONS)[number];

export const ALLOWED_SENSORS = ['/scan0', '/scan1'] as const;
export type TaskSensor = (typeof ALLOWED_SENSORS)[number];

/** 安全上限：任务只能收紧，不能放宽。 */
export const DEFAULT_LIMITS = {
	max_linear: 0.3,
	max_angular: 1.2,
	max_duration: 30.0,
	require_confirmation: true,
} as const;

export const DEFAULT_ARM_TIME_MS = 1500;
export const ARM_JOINT_IDS = [1, 2, 3, 4, 5, 6] as const;
export const ARM_JOINT_PARAMETER_NAMES = [
	'joint1',
	'joint2',
	'joint3',
	'joint4',
	'joint5',
	'joint6',
] as const;
export const MAX_OBSTACLE_DISTANCE_METERS = 2.0;

export const LIMIT_NAMES = ['max_linear', 'max_angular', 'max_duration'] as const;
export type NumericLimitName = (typeof LIMIT_NAMES)[number];

export interface TaskLimits {
	max_linear: number;
	max_angular: number;
	max_duration: number;
	require_confirmation: boolean;
}

const isSensor = (value: unknown): value is TaskSensor =>
	typeof value === 'string' && (ALLOWED_SENSORS as readonly string[]).includes(value);

const isTaskAction = (value: unknown): value is TaskAction =>
	typeof value === 'string' && (ALLOWED_ACTIONS as readonly string[]).includes(value);

export const isPlainObject = (value: unknown): value is Record<string, unknown> =>
	typeof value === 'object' && value !== null && !Array.isArray(value);

const hasOwn = (source: object, key: string): boolean => Object.prototype.hasOwnProperty.call(source, key);

/** 用于诊断 message 的值渲染：数字/布尔原样，结构走稳定键序 JSON。 */
const describeValue = (value: unknown): string => {
	if (typeof value === 'string') return value;
	if (typeof value === 'number' || typeof value === 'boolean') return String(value);
	if (value === null) return 'null';
	return canonicalJsonString(value);
};

// ---------------------------------------------------------------------------
// 协议描述表：校验器、zod schema、视图推导共用的唯一来源（spec §4.1）
// ---------------------------------------------------------------------------

export interface FieldMessages {
	readonly missing: string;
	readonly type: string;
	readonly range: string;
}

export interface NumericFieldSpec {
	readonly kind: 'number';
	readonly name: string;
	readonly code: string;
	readonly required: boolean;
	readonly defaultValue?: number;
	/** 含端点下界。 */
	readonly min?: number;
	/** 含端点上界。 */
	readonly max?: number;
	/** 开下界（`duration > 0` 这类）。 */
	readonly exclusiveMin?: number;
	/** 比较时取绝对值（方向由符号表达，限值只看量值）。 */
	readonly abs?: boolean;
	/** 与任务限值比较，而不是与固定上下界比较。 */
	readonly limit?: NumericLimitName;
	readonly integer?: boolean;
	/** 计入 `max_duration` 总时长。 */
	readonly countsTowardTotalDuration?: boolean;
	readonly unit?: string;
	readonly description: string;
	readonly messages: FieldMessages;
}

export interface SensorArrayFieldSpec {
	readonly kind: 'sensors';
	readonly name: string;
	readonly code: string;
	readonly required: true;
	readonly description: string;
	readonly messages: FieldMessages;
}

export type FieldSpec = NumericFieldSpec | SensorArrayFieldSpec;

export interface ActionSpec {
	readonly action: TaskAction;
	readonly summary: string;
	readonly fields: readonly FieldSpec[];
}

interface NumericFieldOptions {
	readonly required?: boolean;
	readonly defaultValue?: number;
	readonly min?: number;
	readonly max?: number;
	readonly exclusiveMin?: number;
	readonly abs?: boolean;
	readonly limit?: NumericLimitName;
	readonly integer?: boolean;
	readonly countsTowardTotalDuration?: boolean;
	readonly unit?: string;
	readonly rangeMessage: string;
	readonly description: string;
}

const numericField = (action: TaskAction, name: string, options: NumericFieldOptions): NumericFieldSpec => ({
	kind: 'number',
	name,
	code: `step.${action}.${name}`,
	required: options.required ?? true,
	defaultValue: options.defaultValue,
	min: options.min,
	max: options.max,
	exclusiveMin: options.exclusiveMin,
	abs: options.abs,
	limit: options.limit,
	integer: options.integer,
	countsTowardTotalDuration: options.countsTowardTotalDuration,
	unit: options.unit,
	description: options.description,
	messages: {
		missing: `missing ${name}`,
		type: `${name} must be a number`,
		range: options.rangeMessage,
	},
});

const sensorArrayField = (action: TaskAction, name: string, message: string, description: string): SensorArrayFieldSpec => ({
	kind: 'sensors',
	name,
	code: `step.${action}.${name}`,
	required: true,
	description,
	messages: { missing: `missing ${name}`, type: message, range: message },
});

const armTimeField = (action: TaskAction): NumericFieldSpec =>
	numericField(action, 'time', {
		required: false,
		defaultValue: DEFAULT_ARM_TIME_MS,
		min: 100,
		max: 10000,
		unit: 'ms',
		rangeMessage: 'time must be between 100 and 10000 ms',
		description: '运动耗时，缺省 1500ms',
	});

export const ACTION_SPECS: Readonly<Record<TaskAction, ActionSpec>> = {
	move: {
		action: 'move',
		summary: '以线速度 linear、角速度 angular 持续 duration 秒',
		fields: [
			numericField('move', 'linear', {
				abs: true,
				limit: 'max_linear',
				unit: 'm/s',
				rangeMessage: 'linear exceeds task limit',
				description: '线速度，符号表示前后方向',
			}),
			numericField('move', 'angular', {
				abs: true,
				limit: 'max_angular',
				unit: 'rad/s',
				rangeMessage: 'angular exceeds task limit',
				description: '角速度，符号表示转向',
			}),
			numericField('move', 'duration', {
				exclusiveMin: 0,
				countsTowardTotalDuration: true,
				unit: 's',
				rangeMessage: 'duration must be positive',
				description: '持续时间',
			}),
		],
	},
	turn: {
		action: 'turn',
		summary: '原地以角速度 angular 转 duration 秒',
		fields: [
			numericField('turn', 'angular', {
				abs: true,
				limit: 'max_angular',
				unit: 'rad/s',
				rangeMessage: 'angular exceeds task limit',
				description: '角速度，符号表示转向',
			}),
			numericField('turn', 'duration', {
				exclusiveMin: 0,
				countsTowardTotalDuration: true,
				unit: 's',
				rangeMessage: 'duration must be positive',
				description: '持续时间',
			}),
		],
	},
	stop: {
		action: 'stop',
		summary: '立即停止',
		fields: [],
	},
	get_status: {
		action: 'get_status',
		summary: '查询当前状态',
		fields: [],
	},
	stop_if_obstacle: {
		action: 'stop_if_obstacle',
		summary: '指定传感器在 distance 米内检测到障碍时停止',
		fields: [
			sensorArrayField(
				'stop_if_obstacle',
				'sensors',
				'sensors must be an array of /scan0 or /scan1',
				'参与避障的传感器，取值 /scan0 或 /scan1',
			),
			numericField('stop_if_obstacle', 'distance', {
				exclusiveMin: 0,
				max: MAX_OBSTACLE_DISTANCE_METERS,
				unit: 'm',
				rangeMessage: 'distance must be between 0 and 2 meters',
				description: '触发距离',
			}),
		],
	},
	arm_joint: {
		action: 'arm_joint',
		summary: '把单个关节转到 joint 度',
		fields: [
			numericField('arm_joint', 'joint_id', {
				min: 1,
				max: 6,
				integer: true,
				rangeMessage: 'joint_id must be between 1 and 6',
				description: '关节编号',
			}),
			numericField('arm_joint', 'joint', {
				min: 0,
				max: 180,
				unit: 'deg',
				rangeMessage: 'joint must be between 0 and 180 degrees',
				description: '目标角度',
			}),
			armTimeField('arm_joint'),
		],
	},
	arm6_joints: {
		action: 'arm6_joints',
		summary: '六轴同时转到各自目标角度',
		fields: [
			...ARM_JOINT_PARAMETER_NAMES.map((name) =>
				numericField('arm6_joints', name, {
					min: 0,
					max: 180,
					unit: 'deg',
					rangeMessage: `${name} must be between 0 and 180 degrees`,
					description: '目标角度',
				}),
			),
			armTimeField('arm6_joints'),
		],
	},
};

export interface ProtocolFieldSummary {
	readonly name: string;
	readonly kind: FieldSpec['kind'];
	readonly required: boolean;
	readonly defaultValue?: number;
	readonly min?: number;
	readonly max?: number;
	readonly exclusiveMin?: number;
	readonly abs?: boolean;
	readonly limit?: NumericLimitName;
	readonly integer?: boolean;
	readonly unit?: string;
	readonly description: string;
}

/**
 * 给下游视图/编译器用的字段描述（积木形状、代码面板渲染规则都从这里推导）。
 * 只暴露结构性约束；与任务限值相关的边界（`max_linear` 等）在 `validateTask` 里。
 */
export const describeActionFields = (action: TaskAction): readonly ProtocolFieldSummary[] =>
	ACTION_SPECS[action].fields.map((field) =>
		field.kind === 'number'
			? {
					name: field.name,
					kind: field.kind,
					required: field.required,
					defaultValue: field.defaultValue,
					min: field.min,
					max: field.max,
					exclusiveMin: field.exclusiveMin,
					abs: field.abs,
					limit: field.limit,
					integer: field.integer,
					unit: field.unit,
					description: field.description,
				}
			: {
					name: field.name,
					kind: field.kind,
					required: field.required,
					description: field.description,
				},
	);

// ---------------------------------------------------------------------------
// 由描述表生成的 zod schema
// ---------------------------------------------------------------------------

const zodFieldSchema = (field: FieldSpec): z.ZodType => {
	if (field.kind === 'sensors') return z.array(z.enum(ALLOWED_SENSORS)).min(1);
	let schema = z.number();
	if (field.integer === true) schema = schema.int();
	if (field.min !== undefined) schema = schema.min(field.min);
	if (field.max !== undefined) schema = schema.max(field.max);
	if (field.exclusiveMin !== undefined) schema = schema.gt(field.exclusiveMin);
	return field.required ? schema : schema.optional();
};

/**
 * 每个 action 的参数字段 schema（未知字段放行，与参考实现一致）。
 * 注意：与任务限值相关的上界（`max_linear` / `max_angular`）依赖具体任务，不在静态 schema 里，
 * 完整判定走 `validateTask`。
 */
const buildStepParameterSchema = (action: TaskAction): z.ZodType => {
	const shape: Record<string, z.ZodType> = {};
	for (const field of ACTION_SPECS[action].fields) shape[field.name] = zodFieldSchema(field);
	return z.object(shape).passthrough();
};

export const taskStepParameterSchemas: Readonly<Record<TaskAction, z.ZodType>> = {
	move: buildStepParameterSchema('move'),
	turn: buildStepParameterSchema('turn'),
	stop: buildStepParameterSchema('stop'),
	stop_if_obstacle: buildStepParameterSchema('stop_if_obstacle'),
	get_status: buildStepParameterSchema('get_status'),
	arm_joint: buildStepParameterSchema('arm_joint'),
	arm6_joints: buildStepParameterSchema('arm6_joints'),
};

// ---------------------------------------------------------------------------
// 校验后的规范化形状
// ---------------------------------------------------------------------------

export interface TaskStepBase {
	readonly id: string;
	/** 在 steps 里的下标（视图排版用；语义身份永远用 id）。 */
	readonly index: number;
}

export type TaskStep =
	| (TaskStepBase & { readonly action: 'move'; readonly linear: number; readonly angular: number; readonly duration: number })
	| (TaskStepBase & { readonly action: 'turn'; readonly angular: number; readonly duration: number })
	| (TaskStepBase & { readonly action: 'stop' })
	| (TaskStepBase & { readonly action: 'get_status' })
	| (TaskStepBase & { readonly action: 'stop_if_obstacle'; readonly sensors: readonly TaskSensor[]; readonly distance: number })
	| (TaskStepBase & { readonly action: 'arm_joint'; readonly joint_id: number; readonly joint: number; readonly time: number })
	| (TaskStepBase & {
			readonly action: 'arm6_joints';
			readonly joint1: number;
			readonly joint2: number;
			readonly joint3: number;
			readonly joint4: number;
			readonly joint5: number;
			readonly joint6: number;
			readonly time: number;
	  });

export interface ValidatedTask {
	readonly schema_version: typeof TASK_SCHEMA_VERSION;
	readonly task_id: string;
	readonly description?: string;
	readonly steps: readonly TaskStep[];
	/** 与 `DEFAULT_LIMITS` 合并后的有效限值。 */
	readonly limits: TaskLimits;
}

export interface ValidateTaskOptions {
	/** 执行端已接受的 task_id：重复即拒（参考实现的 `seen_task_ids`）。 */
	readonly seenTaskIds?: readonly string[];
}

export type TaskValidationResult =
	| { readonly ok: true; readonly task: ValidatedTask; readonly diagnostics: readonly Diagnostic[] }
	| { readonly ok: false; readonly diagnostics: readonly Diagnostic[] };

// ---------------------------------------------------------------------------
// 校验器
// ---------------------------------------------------------------------------

const withinFieldBounds = (
	field: NumericFieldSpec,
	value: number,
	limits: Record<NumericLimitName, number>,
	rejectedLimits: ReadonlySet<NumericLimitName>,
): boolean => {
	const comparable = field.abs === true ? Math.abs(value) : value;
	// 已被判非法的限值不再拿去卡字段：不拿一条刚被否掉的尺子去量东西。
	if (field.limit !== undefined && !rejectedLimits.has(field.limit) && comparable > limits[field.limit]) return false;
	if (field.integer === true && !Number.isInteger(comparable)) return false;
	if (field.exclusiveMin !== undefined && !(comparable > field.exclusiveMin)) return false;
	if (field.min !== undefined && comparable < field.min) return false;
	if (field.max !== undefined && comparable > field.max) return false;
	return true;
};

const validateStep = (
	rawStep: Record<string, unknown>,
	index: number,
	seenStepIds: Set<string>,
	limits: Record<NumericLimitName, number>,
	rejectedLimits: ReadonlySet<NumericLimitName>,
	collector: DiagnosticCollector,
): { step?: TaskStep; duration: number } => {
	const path = `steps[${index}]`;
	const errorCountBefore = collector.errorCount;

	let stepId: string | undefined;
	if (!hasOwn(rawStep, 'id')) {
		collector.error({ code: 'step.id.missing', message: 'missing step id', path: `${path}.id` });
	} else {
		const rawId = rawStep['id'];
		if (typeof rawId !== 'string' || rawId.trim() === '') {
			collector.error({
				code: 'step.id.invalid',
				message: 'step id must be a non-empty string',
				path: `${path}.id`,
				details: { value: jsonDetail(rawId) },
			});
		} else if (seenStepIds.has(rawId)) {
			collector.error({
				code: 'step.id.duplicate',
				message: `duplicate step id: ${rawId}`,
				path: `${path}.id`,
				ref: rawId,
			});
		} else {
			seenStepIds.add(rawId);
			stepId = rawId;
		}
	}

	let action: TaskAction | undefined;
	if (!hasOwn(rawStep, 'action')) {
		collector.error({ code: 'step.action.missing', message: 'missing action', path: `${path}.action`, ref: stepId });
	} else {
		const rawAction = rawStep['action'];
		if (isTaskAction(rawAction)) {
			action = rawAction;
		} else {
			collector.error({
				code: 'step.action.unknown',
				message: `unsupported action: ${describeValue(rawAction)}`,
				path: `${path}.action`,
				ref: stepId,
				details: { action: jsonDetail(rawAction), allowed: [...ALLOWED_ACTIONS] },
			});
		}
	}

	const values: Record<string, unknown> = {};
	if (action !== undefined) {
		for (const field of ACTION_SPECS[action].fields) {
			const fieldPath = `${path}.${field.name}`;
			if (!hasOwn(rawStep, field.name)) {
				if (field.required) {
					collector.error({
						code: `${field.code}.missing`,
						message: field.messages.missing,
						path: fieldPath,
						ref: stepId,
						details: { action, field: field.name },
					});
				} else {
					values[field.name] = field.defaultValue;
				}
				continue;
			}

			const rawValue = rawStep[field.name];
			if (field.kind === 'sensors') {
				const sensors = Array.isArray(rawValue) && rawValue.length > 0 && rawValue.every(isSensor) ? [...rawValue] : undefined;
				if (sensors === undefined) {
					collector.error({
						code: `${field.code}.invalid`,
						message: field.messages.range,
						path: fieldPath,
						ref: stepId,
						details: { value: jsonDetail(rawValue), allowed: [...ALLOWED_SENSORS] },
					});
				} else {
					values[field.name] = sensors;
				}
				continue;
			}

			if (typeof rawValue !== 'number') {
				collector.error({
					code: `${field.code}.type`,
					message: field.messages.type,
					path: fieldPath,
					ref: stepId,
					details: { action, value: jsonDetail(rawValue), expected: 'number' },
				});
				continue;
			}
			if (!withinFieldBounds(field, rawValue, limits, rejectedLimits)) {
				collector.error({
					code: `${field.code}.range`,
					message: field.messages.range,
					path: fieldPath,
					ref: stepId,
					details: {
						action,
						value: rawValue,
						min: field.min ?? null,
						max: field.max ?? null,
						exclusiveMin: field.exclusiveMin ?? null,
						limit: field.limit ?? null,
						limit_value: field.limit === undefined ? null : limits[field.limit],
					},
				});
				continue;
			}
			values[field.name] = rawValue;
		}
	}

	// 内部不变量：走到这里说明该字段已被校验，取不到就是校验器自身的 bug。
	const readNumber = (name: string): number => {
		const value = values[name];
		if (typeof value !== 'number') throw new Error(`contracts: field ${name} was not validated before use`);
		return value;
	};
	const readSensors = (): TaskSensor[] => {
		const value = values['sensors'];
		if (!Array.isArray(value)) throw new Error('contracts: sensors was not validated before use');
		const sensors: TaskSensor[] = [];
		for (const item of value) if (isSensor(item)) sensors.push(item);
		return sensors;
	};

	if (collector.errorCount !== errorCountBefore || stepId === undefined || action === undefined) {
		return { duration: 0 };
	}

	const base: TaskStepBase = { id: stepId, index };
	const step = ((): TaskStep => {
		switch (action) {
			case 'move':
				return { ...base, action: 'move', linear: readNumber('linear'), angular: readNumber('angular'), duration: readNumber('duration') };
			case 'turn':
				return { ...base, action: 'turn', angular: readNumber('angular'), duration: readNumber('duration') };
			case 'stop':
				return { ...base, action: 'stop' };
			case 'get_status':
				return { ...base, action: 'get_status' };
			case 'stop_if_obstacle':
				return { ...base, action: 'stop_if_obstacle', sensors: readSensors(), distance: readNumber('distance') };
			case 'arm_joint':
				return { ...base, action: 'arm_joint', joint_id: readNumber('joint_id'), joint: readNumber('joint'), time: readNumber('time') };
			case 'arm6_joints':
				return {
					...base,
					action: 'arm6_joints',
					joint1: readNumber('joint1'),
					joint2: readNumber('joint2'),
					joint3: readNumber('joint3'),
					joint4: readNumber('joint4'),
					joint5: readNumber('joint5'),
					joint6: readNumber('joint6'),
					time: readNumber('time'),
				};
		}
	})();

	let duration = 0;
	for (const field of ACTION_SPECS[action].fields) {
		if (field.kind === 'number' && field.countsTowardTotalDuration === true) duration += readNumber(field.name);
	}
	return { step, duration };
};

export const validateTask = (input: unknown, options: ValidateTaskOptions = {}): TaskValidationResult => {
	const collector = new DiagnosticCollector();
	const seenTaskIds = options.seenTaskIds ?? [];

	if (!isPlainObject(input)) {
		collector.error({ code: 'task.not_object', message: 'task must be an object' });
		return { ok: false, diagnostics: collector.diagnostics };
	}

	if (input['schema_version'] !== TASK_SCHEMA_VERSION) {
		collector.error({
			code: 'task.schema_version',
			message: 'schema_version must be 1.0',
			path: 'schema_version',
			details: { expected: TASK_SCHEMA_VERSION, actual: jsonDetail(input['schema_version']) },
		});
	}

	let taskId: string | undefined;
	if (!hasOwn(input, 'task_id')) {
		collector.error({ code: 'task.task_id.missing', message: 'missing task_id', path: 'task_id' });
	} else {
		const rawTaskId = input['task_id'];
		if (typeof rawTaskId !== 'string' || rawTaskId.trim() === '') {
			collector.error({
				code: 'task.task_id.invalid',
				message: 'task_id must be a non-empty string',
				path: 'task_id',
				details: { value: jsonDetail(rawTaskId) },
			});
		} else if (seenTaskIds.includes(rawTaskId)) {
			collector.error({
				code: 'task.task_id.duplicate',
				message: `duplicate task_id: ${rawTaskId}`,
				path: 'task_id',
				ref: rawTaskId,
			});
		} else {
			taskId = rawTaskId;
		}
	}

	let rawSteps: readonly unknown[] | undefined;
	if (!hasOwn(input, 'steps')) {
		collector.error({ code: 'task.steps.missing', message: 'missing steps', path: 'steps' });
	} else {
		const candidate = input['steps'];
		if (!Array.isArray(candidate) || candidate.length === 0) {
			collector.error({
				code: 'task.steps.invalid',
				message: 'steps must be a non-empty array',
				path: 'steps',
				details: { value: jsonDetail(candidate) },
			});
		} else {
			rawSteps = candidate;
		}
	}

	// 参考实现：limits 必填；缺省字段用 DEFAULT_LIMITS 补齐；越界（放宽）即拒。
	const numericLimits: Record<NumericLimitName, number> = {
		max_linear: DEFAULT_LIMITS.max_linear,
		max_angular: DEFAULT_LIMITS.max_angular,
		max_duration: DEFAULT_LIMITS.max_duration,
	};
	const rejectedLimits = new Set<NumericLimitName>();
	let requireConfirmation: boolean = DEFAULT_LIMITS.require_confirmation;
	if (!hasOwn(input, 'limits')) {
		collector.error({ code: 'task.limits.missing', message: 'missing limits', path: 'limits' });
	} else if (!isPlainObject(input['limits'])) {
		collector.error({ code: 'task.limits.invalid', message: 'limits must be an object', path: 'limits' });
	} else {
		const supplied = input['limits'];
		for (const name of LIMIT_NAMES) {
			const path = `limits.${name}`;
			const rawValue = hasOwn(supplied, name) ? supplied[name] : DEFAULT_LIMITS[name];
			if (typeof rawValue !== 'number') {
				collector.error({
					code: `${path}.type`,
					message: `${path} must be a number`,
					path,
					details: { value: jsonDetail(rawValue), expected: 'number' },
				});
				rejectedLimits.add(name);
				continue;
			}
			if (!(rawValue > 0 && rawValue <= DEFAULT_LIMITS[name])) {
				collector.error({
					code: `${path}.exceeds`,
					message: `${path} exceeds safety limit`,
					path,
					details: { value: rawValue, safety_limit: DEFAULT_LIMITS[name], rule: '0 < value <= safety limit' },
				});
				rejectedLimits.add(name);
				continue;
			}
			numericLimits[name] = rawValue;
		}

		const rawConfirmation = hasOwn(supplied, 'require_confirmation')
			? supplied['require_confirmation']
			: DEFAULT_LIMITS.require_confirmation;
		if (typeof rawConfirmation !== 'boolean') {
			collector.error({
				code: 'limits.require_confirmation.type',
				message: 'limits.require_confirmation must be boolean',
				path: 'limits.require_confirmation',
				details: { value: jsonDetail(rawConfirmation), expected: 'boolean' },
			});
		} else {
			requireConfirmation = rawConfirmation;
		}
	}

	const steps: TaskStep[] = [];
	const seenStepIds = new Set<string>();
	let totalDuration = 0;
	if (rawSteps !== undefined) {
		for (const [index, rawStep] of rawSteps.entries()) {
			if (!isPlainObject(rawStep)) {
				collector.error({ code: 'step.not_object', message: 'each step must be an object', path: `steps[${index}]` });
				continue;
			}
			const { step, duration } = validateStep(rawStep, index, seenStepIds, numericLimits, rejectedLimits, collector);
			if (step !== undefined) steps.push(step);
			totalDuration += duration;
		}
		if (totalDuration > numericLimits.max_duration) {
			collector.error({
				code: 'task.total_duration',
				message: 'total duration exceeds task limit',
				path: 'limits.max_duration',
				details: { total_duration: totalDuration, max_duration: numericLimits.max_duration },
			});
		}
	}

	// 参考实现不检查 description（plan §5 也点了这一条）。这里只给警告，不改判定。
	const rawDescription = input['description'];
	if (rawDescription !== undefined && typeof rawDescription !== 'string') {
		collector.warning({
			code: 'task.description.type',
			message: 'description should be a string when present',
			path: 'description',
			details: { value: jsonDetail(rawDescription) },
		});
	}

	if (collector.hasErrors || taskId === undefined || rawSteps === undefined) {
		return { ok: false, diagnostics: collector.diagnostics };
	}

	const description = typeof rawDescription === 'string' ? rawDescription : undefined;
	const task: ValidatedTask = {
		schema_version: TASK_SCHEMA_VERSION,
		task_id: taskId,
		...(description === undefined ? {} : { description }),
		steps,
		limits: {
			max_linear: numericLimits.max_linear,
			max_angular: numericLimits.max_angular,
			max_duration: numericLimits.max_duration,
			require_confirmation: requireConfirmation,
		},
	};
	return { ok: true, task, diagnostics: collector.diagnostics };
};

/** 便捷封装：拿诊断文本而不是结果对象。 */
export const explainTask = (input: unknown, options: ValidateTaskOptions = {}): string => {
	const result = validateTask(input, options);
	if (result.ok) return 'ok';
	return result.diagnostics
		.filter((diagnostic: Diagnostic) => diagnostic.severity === 'error')
		.map((diagnostic: Diagnostic) => `${diagnostic.code}: ${diagnostic.message}`)
		.join('; ');
};
