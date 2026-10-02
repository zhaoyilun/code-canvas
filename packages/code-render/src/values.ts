/**
 * 取值格式：从校验器给的字段描述（`ProtocolFieldSummary`）推导，**不按参数名分支**（spec §4.1）。
 *
 * 规则只有三条，且对任何字段一视同仁：
 * - `kind: 'sensors'` → 字符串数组字面量（`["/scan0"]`）；
 * - `integer: true` → 整数文本；
 * - 其余数值字段 → 至少一位小数（`5` → `5.0`），但**不为好看丢精度**：
 *   小数位取到该值能被原样读回为止（`0.25` → `0.25`，而不是 `0.3`）。
 *
 * 缺省值也来自字段描述（`time` 的 1500 就是从 `defaultValue` 来的），这里不另写一份。
 */
import { jsonDetail, type DiagnosticCollector, type JsonValue, type ProtocolFieldSummary, type TaskAction } from '@codecanvas/contracts';

export interface FieldValueRender {
	/** 参数名，逐字来自字段描述。 */
	readonly name: string;
	/** 渲染出来的实参文本。 */
	readonly text: string;
	/** 值是否可信（缺失/类型不符/空数组时为 false，同时会给诊断）。 */
	readonly ok: boolean;
}

/**
 * 数字字面量文本。`integer` 由字段描述给出；超出 `toFixed` 能力的量级原样输出。
 * 后一条保证「渲染出来的字面量能被读回原值」——宁可难看，不可失真。
 */
export const formatNumberLiteral = (value: number, integer: boolean): string => {
	if (!Number.isFinite(value)) return String(value);
	if (Math.abs(value) >= 1e21) return String(value);
	if (integer) return String(value);
	if (Number.isInteger(value)) return `${value}.0`;
	for (let digits = 1; digits <= 15; digits += 1) {
		const text = value.toFixed(digits);
		if (Number(text) === value) return text;
	}
	return String(value);
};

export const formatSensorArrayLiteral = (sensors: readonly string[]): string =>
	`[${sensors.map((sensor) => JSON.stringify(sensor)).join(', ')}]`;

/** 传感器数组：非字符串元素、空数组都算不可信（协议要求 `ALLOWED_SENSORS` 的非空数组）。 */
const readSensors = (raw: JsonValue | undefined): readonly string[] | null => {
	if (!Array.isArray(raw)) return null;
	const sensors: string[] = [];
	for (const item of raw) {
		if (typeof item !== 'string') return null;
		sensors.push(item);
	}
	return sensors;
};

export const renderFieldValue = (
	field: ProtocolFieldSummary,
	raw: JsonValue | undefined,
	action: TaskAction,
	ref: string,
	collector: DiagnosticCollector,
): FieldValueRender => {
	const path = `nodes.${ref}.parameters.${field.name}`;
	const name = field.name;

	if (field.kind === 'sensors') {
		const sensors = readSensors(raw);
		if (sensors === null) {
			collector.warning({
				code: raw === undefined ? 'code_render.field.missing' : 'code_render.field.not_sensor_array',
				message: `${action}.${name} 不是传感器数组，渲染成空数组`,
				path,
				ref,
				details: { action, value: jsonDetail(raw) },
			});
			return { name, text: '[]', ok: false };
		}
		if (sensors.length === 0) {
			collector.warning({
				code: 'code_render.field.empty_sensor_array',
				message: `${action}.${name} 是空数组，协议要求至少一个传感器`,
				path,
				ref,
				details: { action },
			});
			return { name, text: '[]', ok: false };
		}
		return { name, text: formatSensorArrayLiteral(sensors), ok: true };
	}

	let value: number;
	if (typeof raw === 'number') {
		value = raw;
	} else if (raw === undefined && field.defaultValue !== undefined) {
		// 缺省：照字段描述补，不在这里另立一个默认值。
		value = field.defaultValue;
	} else {
		collector.warning({
			code: raw === undefined ? 'code_render.field.missing' : 'code_render.field.not_a_number',
			message: `${action}.${name} 取不到数值，渲染成 null`,
			path,
			ref,
			details: { action, value: jsonDetail(raw) },
		});
		return { name, text: 'null', ok: false };
	}

	const integer = field.integer === true;
	if (integer && !Number.isInteger(value)) {
		collector.warning({
			code: 'code_render.field.not_integer',
			message: `${action}.${name} 应为整数，实际是 ${value}`,
			path,
			ref,
			details: { action, value },
		});
		return { name, text: formatNumberLiteral(value, integer), ok: false };
	}
	return { name, text: formatNumberLiteral(value, integer), ok: true };
};
