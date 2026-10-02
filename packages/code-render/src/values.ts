/**
 * 取值 → 文本：**规则从原语定义推导，不按参数名分支**（spec §4.1）。
 *
 * 语句树里有两种「值」要落成文本，走的是同一个 `renderByType`：
 * - **实参**（`call` 语句/表达式里的 `arguments`）：先按名字查原语定义里那个参数，
 *   再按它的 `type` 与 `integer` 渲染。名字与顺序由定义决定，这里一个参数名都不手写。
 * - **字面量表达式**（`{kind:'literal', value}`）与**解析出来的 `param`**
 *   （能力参数取节点的值、局部变量取上一条 `set` 的值）：值本身就是全部依据，
 *   类型提示来自表达式所在的语境（写数字 → `number`，写字符串数组 → `sensor`）。
 *
 * 渲染成什么形状由类型决定（number → 至少一位小数；sensor → 字符串数组字面量；
 * string/pose → 引号字符串；boolean → true/false）。取值不可用时给诊断并渲染占位符，
 * **不静默编一个值**——面板显示的是机器会执行的东西，编出来的数字比空着更坏。
 *
 * 数值保精度那条老的规矩继续有效：渲染出的字面量读回来必须还是原值（`0.0625` 不许写成 `0.1`）。
 */
import {
	jsonDetail,
	type CatalogParameter,
	type DiagnosticCollector,
	type JsonObject,
	type JsonValue,
} from '@codecanvas/contracts';

/** 历史遗留：老形状的实参引用前缀（`$name`）。语句树里由 `{kind:'param'}` 取代。 */
export const REFERENCE_PREFIX = '$';

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

/** 目录里标了 `integer` 的参数（关节号、毫秒时长）不带小数：`3` 而不是 `3.0`。 */
export const formatIntegerLiteral = (value: number): string =>
	Number.isInteger(value) ? String(value) : formatNumberLiteral(value);

export const formatSensorArrayLiteral = (sensors: readonly string[]): string =>
	`[${sensors.map((sensor) => JSON.stringify(sensor)).join(', ')}]`;

/** 数组字面量，元素是任意 JSON——`["/scan0"]` 这种写法读起来比紧凑 JSON 松快一点。 */
const formatJsonArrayLiteral = (items: readonly JsonValue[]): string =>
	`[${items.map((item) => JSON.stringify(item) ?? 'null').join(', ')}]`;

/**
 * 结构化载荷（`json` 类型的实参）的文本。
 *
 * 紧凑 JSON 是**默认**——一条语句一行，行号与步骤的映射才是准的。
 * 只有在调用方明确允许换行（顶层语句的实参）且紧凑形态长到读不下去时，才摊成缩进 JSON；
 * 摊开后的续行由渲染器按语句缩进推，所以这里从 0 缩进开始写。
 */
export const COMPACT_JSON_LIMIT = 72;

export const compactJsonText = (value: JsonValue): string => JSON.stringify(value) ?? 'null';

export const formatJsonLiteral = (value: JsonValue, multiline: boolean): string => {
	const compact = compactJsonText(value);
	if (!multiline || compact.length <= COMPACT_JSON_LIMIT) return compact;
	return JSON.stringify(value, null, 4) ?? compact;
};

/**
 * 能直接渲染的取值。
 *
 * 现在是整个 JSON 值域：`json` 类型的参数收对象与嵌套数组，那是真实原语（关节位置映射、
 * 轨迹模板）的常态，不收就等于把一整个结构悄悄变成 `null`。
 */
export type Renderable = JsonValue;

export interface RenderedArgument {
	/** 参数名，逐字来自原语定义。 */
	readonly name: string;
	/** 渲染出来的实参文本。 */
	readonly text: string;
	/** 值是否可信（取不到 / 类型不符时为 false，同时会给诊断）。 */
	readonly ok: boolean;
}

/** `renderByType` 的产物：文本 + 失败码（`code` 非 null 就是没渲染成合法字面量）。 */
export interface RenderedValue {
	readonly text: string;
	readonly code: string | null;
}

/**
 * 能直接渲染的取值：数字、字符串、布尔、字符串数组。
 *
 * `parameters` 是不透明载荷（spec §1.2），里面可能是任何 JSON——对象、null、混合数组都过不了这一关，
 * 于是它们走「类型不符」那条路给诊断，而不是被 `String()` 悄悄变成 `[object Object]`。
 */
export const asRenderable = (value: JsonValue | undefined): Renderable | undefined => {
	if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'string') return value;
	if (Array.isArray(value) && value.every((item) => typeof item === 'string')) return value;
	return undefined;
};

/** 按类型渲染。`code` 非 null 就是没渲染成合法字面量（调用方负责出诊断）。 */
export const renderByType = (
	type: CatalogParameter['type'],
	value: Renderable | undefined,
	integer = false,
): RenderedValue => {
	switch (type) {
		case 'number':
			if (typeof value !== 'number' || !Number.isFinite(value)) {
				return { text: 'null', code: 'code_render.argument.not_a_number' };
			}
			return { text: integer ? formatIntegerLiteral(value) : formatNumberLiteral(value), code: null };
		case 'boolean':
			return typeof value === 'boolean'
				? { text: value ? 'true' : 'false', code: null }
				: { text: 'null', code: 'code_render.argument.not_a_boolean' };
		case 'sensor':
			if (!Array.isArray(value)) return { text: '[]', code: 'code_render.argument.not_sensor_array' };
			if (value.length === 0) return { text: '[]', code: 'code_render.argument.empty_sensor_array' };
			return { text: formatJsonArrayLiteral(value), code: null };
		case 'string':
		case 'pose':
			if (typeof value === 'string') return { text: JSON.stringify(value), code: null };
			if (Array.isArray(value)) return { text: formatJsonArrayLiteral(value), code: null };
			return { text: 'null', code: 'code_render.argument.not_a_string' };
		case 'json':
			// 结构化载荷：只要有值就照原样写出来（对象、嵌套数组、标量都算数），
			// 这里恒为紧凑形态——多行那条路只在顶层语句的实参上开。
			return value === undefined
				? { text: 'null', code: 'code_render.argument.missing_json' }
				: { text: formatJsonLiteral(value, false), code: null };
	}
};

const TYPE_MESSAGES: Readonly<Record<string, string>> = {
	'code_render.argument.not_a_number': '取不到数值，渲染成 null',
	'code_render.argument.not_a_boolean': '取不到布尔值，渲染成 null',
	'code_render.argument.not_sensor_array': '不是字符串数组，渲染成 []',
	'code_render.argument.empty_sensor_array': '是空数组，渲染成 []',
	'code_render.argument.not_a_string': '取不到字符串，渲染成 null',
	'code_render.argument.missing_json': '没有取值，渲染成 null',
};

export const valueMessage = (code: string): string =>
	TYPE_MESSAGES[code] ?? '取值不可用，渲染成占位符';

/**
 * 一个原始值 → 代码文本，**没有类型提示**时用（字面量表达式、解析出来的能力参数与局部变量）。
 *
 * 对象与 null 不是能写出来的值：给诊断 + 占位符，绝不 `String()` 糊过去。
 */
export const renderConstant = (
	value: JsonValue | undefined,
	integer: boolean,
	collector: DiagnosticCollector,
	where: {
		/** 诊断前缀：`能力 的 1.then.0`——点得出来是哪个调用出的问题。 */
		readonly code: string;
		readonly message: string;
		readonly path: string;
		readonly ref: string;
		readonly details?: JsonObject;
	},
): RenderedValue => {
	let rendered: RenderedValue;
	if (value === undefined) {
		rendered = { text: 'null', code: 'code_render.argument.not_a_number' };
	} else if (typeof value === 'number') {
		rendered = Number.isFinite(value)
			? { text: integer ? formatIntegerLiteral(value) : formatNumberLiteral(value), code: null }
			: { text: 'null', code: 'code_render.argument.not_a_number' };
	} else if (typeof value === 'boolean') {
		rendered = { text: value ? 'true' : 'false', code: null };
	} else if (typeof value === 'string') {
		rendered = { text: JSON.stringify(value), code: null };
	} else if (Array.isArray(value)) {
		// 字符串数组仍是老样子（`["/scan0"]` 比 JSON 好看）；其余数组按结构化载荷写出来。
		const sensors = value.filter((item): item is string => typeof item === 'string');
		rendered =
			sensors.length === value.length
				? { text: formatSensorArrayLiteral(sensors), code: null }
				: { text: compactJsonText(value), code: null };
	} else {
		// 剩下的是 null 与对象。契约放开了 JSON 字面量，两者都是**能写出来的取值**——
		// 早先它们走「类型不符」给诊断，现在真原语的实参就长这样，拒收等于把结构吃掉。
		rendered = { text: compactJsonText(value), code: null };
	}

	if (rendered.code === null) return rendered;

	collector.warning({
		code: rendered.code,
		message: where.message,
		path: where.path,
		ref: where.ref,
		details: { ...(where.details ?? {}), value: jsonDetail(value) },
	});
	return rendered;
};
