/**
 * 实参取值：**规则从原语定义推导，不按参数名分支**（spec §4.1）。
 *
 * 一条实现步骤里的实参有两种形态，这是 `implementationStep.arguments` 的规定：
 * - 字面量（`0`、`true`、`["/scan0"]`）→ 照原样渲染；
 * - `$name` → 取**本节点**同名参数的值，渲染成实际数字（同一份实现被不同参数复用的唯一依据）。
 *
 * 渲染成什么形状由原语定义里那个参数的 `type` 决定（number → 至少一位小数；sensor → 字符串数组字面量；
 * string/pose → 引号字符串；boolean → true/false）。取值类型不符时给诊断并渲染占位符，
 * **不静默编一个数**——面板显示的是机器会执行的东西，编出来的数字比空着更坏。
 *
 * 数值保精度那条老的规矩继续有效：渲染出的字面量读回来必须还是原值（`0.0625` 不许写成 `0.1`）。
 */
import {
	jsonDetail,
	type ArgumentValue,
	type CatalogParameter,
	type DiagnosticCollector,
	type JsonObject,
	type JsonValue,
} from '@codecanvas/contracts';

/** `$name` 的前缀；契约里就是这么规定实参引用的（见 `capability.ts` 的 `argumentValueSchema`）。 */
export const REFERENCE_PREFIX = '$';

export interface RenderedArgument {
	/** 参数名，逐字来自原语定义。 */
	readonly name: string;
	/** 渲染出来的实参文本。 */
	readonly text: string;
	/** 值是否可信（取不到 / 类型不符时为 false，同时会给诊断）。 */
	readonly ok: boolean;
}

export interface ArgumentContext {
	/** 正在渲染的原语名（诊断里点得出来是哪一个调用出的问题）。 */
	readonly primitiveRef: string;
	/** 引用 `$name` 时去哪儿取值：节点的 `parameters`。 */
	readonly nodeParameters: JsonObject;
	/** 诊断的 `ref`：谁出错了。 */
	readonly nodeId: string;
}

/**
 * 数字字面量文本：整数也带一位小数（`0` → `0.0`），小数位取到能原样读回为止。
 * 超出 `toFixed` 能力的量级原样输出——宁可难看，不可失真。
 */
export const formatNumberLiteral = (value: number): string => {
	if (!Number.isFinite(value)) return String(value);
	if (Math.abs(value) >= 1e21) return String(value);
	if (Number.isInteger(value)) return `${value}.0`;
	for (let digits = 1; digits <= 15; digits += 1) {
		const text = value.toFixed(digits);
		if (Number(text) === value) return text;
	}
	return String(value);
};

export const formatSensorArrayLiteral = (sensors: readonly string[]): string =>
	`[${sensors.map((sensor) => JSON.stringify(sensor)).join(', ')}]`;

/**
 * 能直接渲染的取值：数字、字符串、布尔、字符串数组。
 *
 * `parameters` 是不透明载荷（spec §1.2），里面可能是任何 JSON——对象、null、混合数组都过不了这一关，
 * 于是它们走「类型不符」那条路给诊断，而不是被 `String()` 悄悄变成 `[object Object]`。
 */
type Renderable = number | string | boolean | readonly string[];

const asRenderable = (value: JsonValue | undefined): Renderable | undefined => {
	if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'string') return value;
	if (Array.isArray(value) && value.every((item) => typeof item === 'string')) return value;
	return undefined;
};

const isReference = (value: ArgumentValue): value is string =>
	typeof value === 'string' && value.startsWith(REFERENCE_PREFIX) && value.length > REFERENCE_PREFIX.length;

/** 按原语定义给的 `type` 渲染。返回 `code` 非 null 就是没渲染成合法字面量。 */
const renderByType = (
	type: CatalogParameter['type'],
	value: Renderable | undefined,
	integer = false,
): { text: string; code: string | null } => {
	switch (type) {
		case 'number':
			if (typeof value !== 'number' || !Number.isFinite(value)) {
				return { text: 'null', code: 'code_render.argument.not_a_number' };
			}
			// 目录里标了 `integer` 的参数（关节号、毫秒时长）不带小数：渲染成 `3` 而不是 `3.0`。
			return {
				text: integer && Number.isInteger(value) ? String(value) : formatNumberLiteral(value),
				code: null,
			};
		case 'boolean':
			return typeof value === 'boolean'
				? { text: value ? 'true' : 'false', code: null }
				: { text: 'null', code: 'code_render.argument.not_a_boolean' };
		case 'sensor':
			if (!Array.isArray(value)) return { text: '[]', code: 'code_render.argument.not_sensor_array' };
			if (value.length === 0) return { text: '[]', code: 'code_render.argument.empty_sensor_array' };
			return { text: formatSensorArrayLiteral(value), code: null };
		case 'string':
		case 'pose':
			if (typeof value === 'string') return { text: JSON.stringify(value), code: null };
			if (Array.isArray(value)) return { text: formatSensorArrayLiteral(value), code: null };
			return { text: 'null', code: 'code_render.argument.not_a_string' };
	}
};

const TYPE_MESSAGES: Readonly<Record<string, string>> = {
	'code_render.argument.not_a_number': '取不到数值，渲染成 null',
	'code_render.argument.not_a_boolean': '取不到布尔值，渲染成 null',
	'code_render.argument.not_sensor_array': '不是字符串数组，渲染成 []',
	'code_render.argument.empty_sensor_array': '是空数组，渲染成 []',
	'code_render.argument.not_a_string': '取不到字符串，渲染成 null',
};

/**
 * 渲染一个实参。实参缺省、`$name` 指不到节点参数、类型不符——三种情况都给诊断，
 * 并渲染一个明确的占位符（`null` / `[]`），绝不猜。
 */
export const renderArgument = (
	parameter: CatalogParameter,
	raw: ArgumentValue | undefined,
	context: ArgumentContext,
	collector: DiagnosticCollector,
): RenderedArgument => {
	const name = parameter.name;
	const where = `${context.primitiveRef}.${name}`;
	const path = `nodes.${context.nodeId}.parameters`;

	if (raw === undefined) {
		collector.warning({
			code: 'code_render.argument.missing',
			message: `${where} 没有实参，渲染成占位符`,
			path: `${path}.${name}`,
			ref: context.nodeId,
			details: { primitive: context.primitiveRef, parameter: name },
		});
		return { name, text: renderByType(parameter.type, undefined, parameter.integer === true).text, ok: false };
	}

	// `$name` 与字面量分岔：前者去节点参数里取值，后者就是它自己。
	let resolved: Renderable | undefined;
	let source: 'literal' | 'reference' = 'literal';
	if (isReference(raw)) {
		source = 'reference';
		const referenced = raw.slice(REFERENCE_PREFIX.length);
		const fromNode = context.nodeParameters[referenced];
		if (fromNode === undefined) {
			collector.warning({
				code: 'code_render.argument.missing',
				message: `${where} 引用了 $${referenced}，但本节点没有这个参数，渲染成占位符`,
				path: `${path}.${referenced}`,
				ref: context.nodeId,
				details: { primitive: context.primitiveRef, parameter: name, reference: referenced },
			});
			return { name, text: renderByType(parameter.type, undefined, parameter.integer === true).text, ok: false };
		}
		resolved = asRenderable(fromNode);
	} else {
		resolved = asRenderable(raw);
	}

	const rendered = renderByType(parameter.type, resolved, parameter.integer === true);
	if (rendered.code !== null) {
		collector.warning({
			code: rendered.code,
			message: `${where} ${TYPE_MESSAGES[rendered.code] ?? '取值不可用，渲染成占位符'}`,
			path,
			ref: context.nodeId,
			details: {
				primitive: context.primitiveRef,
				parameter: name,
				source,
				expected: parameter.type,
				value: jsonDetail(resolved === undefined ? (raw as JsonValue) : resolved),
			},
		});
		return { name, text: rendered.text, ok: false };
	}
	return { name, text: rendered.text, ok: true };
};
