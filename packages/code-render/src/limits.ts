/**
 * 安全限值的展示形态：名字来自 `LIMIT_NAMES`，安全上限来自 `DEFAULT_LIMITS`，
 * 单位从引用该限值的字段上取（`max_linear` 的单位就是 `move.linear` 的 `m/s`）——
 * 三样都不在这里另抄一份。限值是声明 `meta.limits` 里的真值（spec §1.1）。
 *
 * **`meta.limits` 缺省不是缺陷。** 它是一期协议那台设备的字段；别的任务格式（技能计划）
 * 本来就没有限值这一栏，缺了就是缺了。早先这里会为此报一条警告，于是换到 SO-101 之后，
 * 每一份完全合法的技能计划头上都挂着一条红字——那是拿一期的尺子量别人，不是它有问题。
 */
import {
	ACTION_SPECS,
	ALLOWED_ACTIONS,
	DEFAULT_LIMITS,
	LIMIT_NAMES,
	isJsonObject,
	jsonDetail,
	type DiagnosticCollector,
	type JsonObject,
	type NumericLimitName,
} from '@codecanvas/contracts';

export interface RenderedLimit {
	readonly name: NumericLimitName;
	readonly value: number;
	readonly unit: string | null;
	/** 协议安全上限（`DEFAULT_LIMITS`）；任务是这条线以内的收紧。 */
	readonly safetyCeiling: number;
	/** 比安全上限更紧。 */
	readonly tightened: boolean;
	/** 直接可显示的文本，如 `0.3 m/s`。 */
	readonly text: string;
}

export interface RenderedLimits {
	/** 声明里有没有 `meta.limits`；没有时退到安全上限（那不是缺陷，见文件头）。 */
	readonly present: boolean;
	readonly numeric: readonly RenderedLimit[];
	readonly requireConfirmation: boolean;
}

/**
 * 从协议描述表里找出每个限值的单位：谁引用它，就用谁的 `unit`；
 * `max_duration` 没有字段直接引用它，由「计入总时长」的字段（`duration`）给出。
 */
const limitUnits = (): Readonly<Record<NumericLimitName, string | null>> => {
	const units: Record<NumericLimitName, string | null> = { max_linear: null, max_angular: null, max_duration: null };
	for (const action of ALLOWED_ACTIONS) {
		for (const field of ACTION_SPECS[action].fields) {
			if (field.kind !== 'number' || field.unit === undefined) continue;
			if (field.limit !== undefined && units[field.limit] === null) units[field.limit] = field.unit;
			if (field.countsTowardTotalDuration === true && units.max_duration === null) units.max_duration = field.unit;
		}
	}
	return units;
};

const UNITS = limitUnits();

/** 没有声明时的限值展示：什么都没有，只有「运行前需确认」的协议缺省。 */
export const EMPTY_LIMITS: RenderedLimits = {
	present: false,
	numeric: [],
	requireConfirmation: DEFAULT_LIMITS.require_confirmation,
};

export const describeLimits = (
	meta: JsonObject,
	ref: string,
	collector: DiagnosticCollector,
): RenderedLimits => {
	const raw = meta['limits'];
	const present = isJsonObject(raw);
	// 缺了**不报**：限值是设备自己的事，没有这一栏的格式（技能计划）照样是合法声明。
	const source: JsonObject = present ? raw : {};

	const numeric = LIMIT_NAMES.map((name): RenderedLimit => {
		const safetyCeiling: number = DEFAULT_LIMITS[name];
		const supplied = source[name];
		let value: number = safetyCeiling;
		if (typeof supplied === 'number' && Number.isFinite(supplied)) {
			value = supplied;
		} else if (supplied !== undefined) {
			collector.warning({
				code: 'code_render.limit.not_a_number',
				message: `limits.${name} 不是数字，显示安全上限`,
				path: `meta.limits.${name}`,
				ref,
				details: { value: jsonDetail(supplied) },
			});
		}
		if (value > safetyCeiling) {
			// 限值只能收紧不能放宽（spec §1.1）；声明层面这里拦不到的是这份，面板必须点出来。
			collector.error({
				code: 'code_render.limit.exceeds_safety',
				message: `limits.${name} 超过了协议安全上限 ${safetyCeiling}`,
				path: `meta.limits.${name}`,
				ref,
				details: { value, safety_ceiling: safetyCeiling },
			});
		}
		const unit = UNITS[name];
		return {
			name,
			value,
			unit,
			safetyCeiling,
			tightened: value < safetyCeiling,
			text: unit === null ? String(value) : `${value} ${unit}`,
		};
	});

	const rawConfirmation = source['require_confirmation'];
	const requireConfirmation =
		typeof rawConfirmation === 'boolean' ? rawConfirmation : DEFAULT_LIMITS.require_confirmation;
	if (present && rawConfirmation !== undefined && typeof rawConfirmation !== 'boolean') {
		collector.warning({
			code: 'code_render.limit.not_a_boolean',
			message: 'limits.require_confirmation 不是布尔值，显示协议缺省',
			path: 'meta.limits.require_confirmation',
			ref,
			details: { value: jsonDetail(rawConfirmation) },
		});
	}

	return { present, numeric, requireConfirmation };
};
