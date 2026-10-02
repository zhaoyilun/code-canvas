/**
 * 实现积木：**一个模块 = 一个能力，一块积木 = 实现语句树里的一个节点**（spec §4.1）。
 *
 * 实现的形状是**语句树**（`@codecanvas/contracts` 的 `ImplStatement` / `ImplExpression`）：
 * 有赋值、有条件、有嵌套。所以这里做的事是**递归**的——从原语定义推导每一块积木的形状，
 * 并且把子节点（if 的条件、比较的左右两侧、赋值右边的值）当作同一件事继续往下推。
 *
 * 于是「判断阈值」长出来的不是一块带阈值的积木，而是三块咬在一起的积木：
 * C 形的 `如果`、嵌在条件位的 `比较`、再嵌进比较两侧的 `引用` 与 `数字`。
 *
 * 形状仍然**从能力目录推导**，一个字段名都不手写：
 *   - 字段来自 `catalog.primitives[].parameters`（名字、顺序、`integer` 标记）；
 *   - 字段的值来自这一步的实参：`{kind:'param'}` 指向本能力参数时**可写**（改它等于改节点的
 *     `parameters`），原始字面量（`0`、`"/scan0"`、`["/scan0"]`）只读——实现结构不归画布管；
 *   - 比较/算术的算符、`set` 的目标名也都是树里给的，不在这里另造一门语言。
 *
 * 块类型 = `cc_impl_<目录>#<能力>#<节点标签>#<下标路径>`。四样都要：字段长什么样由「这个节点
 * 怎么绑实参」决定，所以同一个原语在树里两处出现就是两块字段不同的积木；路径进类型则是为了
 * 让「树里第几处」这件事在类型名上就分得开（`1` 与 `1.then.0` 是两块不同的块）。
 */
import * as Blockly from 'blockly';
import {
	ALLOWED_ACTIONS,
	ALLOWED_SENSORS,
	describeActionFields,
	findPrimitive,
	type BinaryOperator,
	type CapabilityCatalog,
	type CapabilitySpec,
	type CatalogParameter,
	type CatalogValueType,
	type ImplArgument,
	type ImplExpression,
	type ImplStatement,
	type JsonValue,
	type PrimitiveSpec,
	type ProtocolFieldSummary,
	type TaskAction,
	type TaskSensor,
} from '@codecanvas/contracts';

/** 类型名前缀：`cc_impl_<catalogRef>#<capabilityRef>#<节点标签>#<下标路径>`。 */
export const IMPLEMENTATION_BLOCK_TYPE_PREFIX = 'cc_impl_';
/** 分隔符刻意选 `#`：它不在 `stableReferenceSchema` 的字符集里，也不在下标路径里，几段拼起来不会撞。 */
export const IMPLEMENTATION_TYPE_SEPARATOR = '#';

/**
 * 块类型 = **目录 + 能力 + 节点标签 + 下标路径**。
 *
 * 节点标签说的是「这块积木是树里的哪种节点、按哪种绑法长的」（`call_stmt` / `if` / `ref_num`…），
 * 下标路径说的是「它在树里的哪一处」。两者缺一不可：同一个原语在两条语句里各调一次，
 * 实参绑法可能不同（一处是能力参数、一处是写死的字面量），字段就不一样。
 */
export const implementationBlockType = (
	catalogRef: string,
	capabilityRef: string,
	nodeTag: string,
	stepPath: string,
): string =>
	[IMPLEMENTATION_BLOCK_TYPE_PREFIX + catalogRef, capabilityRef, nodeTag, stepPath].join(
		IMPLEMENTATION_TYPE_SEPARATOR,
	);

/** 主题里每个能力占一个 blockStyle（色值在主题里，不在这张表里）。 */
export const blockStyleName = (capabilityRef: string): string => `cc_cap_${capabilityRef}`;

/**
 * 一行只摆一个原语参数：标签在左、输入框在右，纵向排开。
 * 横着排会把输入框挤到看不清（`drive_joints` 有七个字段），换行规则就这一条。
 */
export const MAX_FIELDS_PER_ROW = 1;

/**
 * 单位不占主行宽度：它是紧跟输入框的一个小字号标签（`field_label` 的 class），
 * 由视图侧用 `--cc-fs-xs` 定字号。单位同时留在字段 tooltip 里，信息不丢。
 */
export const BLOCK_UNIT_CLASS = 'cc-block-unit';

/** 数值字段的单位标签字段名：与数值字段名同族但不会撞名。 */
export const unitFieldName = (fieldName: string): string => `unit_${fieldName}`;

/** 只读字段（字面量实参、没有可编辑控件的参数类型）的字段名。 */
export const literalFieldName = (parameter: string): string => `literal_${parameter}`;

/** `/scan0` → `sensor_scan0`：字段名由传感器名机械地推出来。 */
export const sensorFieldName = (sensor: TaskSensor): string => `sensor${sensor.replace(/[^a-zA-Z0-9]+/g, '_')}`;

/** 值块里承载「值 / 名字」的那个字段名：一块只装一个，固定就好。 */
export const VALUE_FIELD_NAME = 'value';
/** 只读引用块里承载名字的那个字段名。 */
export const REFERENCE_FIELD_NAME = 'name';
/** `设 <名字> 为 …` 里那个名字的字段名（只读：结构不归画布管）。 */
export const SET_TARGET_FIELD_NAME = 'target';
/** 「未知原语 <名字>」里那个名字的字段名。 */
export const UNKNOWN_PRIMITIVE_FIELD_NAME = 'primitive';

/** 值输入/语句口的 Blockly input 名（大写，与目录里的参数名天然分得开）。 */
export const VALUE_INPUT_NAME = 'VALUE';
export const CONDITION_INPUT_NAME = 'CONDITION';
export const THEN_INPUT_NAME = 'DO';
export const ELSE_INPUT_NAME = 'ELSE';
export const LEFT_INPUT_NAME = 'LEFT';
export const RIGHT_INPUT_NAME = 'RIGHT';

// ---------------------------------------------------------------------------
// 下标路径
// ---------------------------------------------------------------------------

/**
 * 下标路径：从实现语句树根往下走的一串段，段之间用 `.` 连。
 *
 * `"1"` 是顶层第二条语句，`"1.then.0"` 是它 then 分支的第一条，`"1.condition.right"`
 * 是它条件右边的那个表达式。**段名就是树里的键名**（`then` / `else` / `condition` /
 * `value` / `left` / `right` / `arguments.<参数名>`），所以路径是机械可解析的，不是另编的一套坐标。
 */
export const childPath = (path: string, segment: string | number): string => `${path}.${String(segment)}`;

/** 顶层语句下标：路径的第一段。**它就是 `selectedStepIndex` 用的那个数**（0 基）。 */
export const topLevelStepIndexOf = (path: string): number | null => {
	const head = path.split('.')[0];
	if (head === undefined || !/^\d+$/.test(head)) return null;
	return Number.parseInt(head, 10);
};

/** 顶层语句（路径只有一段）——徽标数它、选中高亮认它。 */
export const isTopLevelPath = (path: string): boolean => !path.includes('.');

// ---------------------------------------------------------------------------
// 节点角色
// ---------------------------------------------------------------------------

/** 树里的一个节点，落在积木上是什么角色。 */
export type ImplementationNodeRole =
	| 'call-statement'
	| 'call-value'
	| 'set'
	| 'if'
	| 'if-else'
	| 'literal-number'
	| 'literal-text'
	| 'literal-boolean'
	| 'param-read'
	| 'param-number'
	| 'param-text'
	| 'param-boolean'
	| 'binary'
	| 'unary'
	| 'unknown-statement'
	| 'unknown-value';

/** 角色 → 类型名里的那一段（短、稳、能一眼读出是什么节点）。 */
export const ROLE_TAG: Readonly<Record<ImplementationNodeRole, string>> = {
	'call-statement': 'call_stmt',
	'call-value': 'call_value',
	set: 'set',
	if: 'if',
	'if-else': 'if_else',
	'literal-number': 'lit_num',
	'literal-text': 'lit_text',
	'literal-boolean': 'lit_bool',
	'param-read': 'ref_read',
	'param-number': 'ref_num',
	'param-text': 'ref_text',
	'param-boolean': 'ref_bool',
	binary: 'bin',
	unary: 'un',
	'unknown-statement': 'unknown_stmt',
	'unknown-value': 'unknown_value',
};

const BINARY_SYMBOL: Readonly<Record<BinaryOperator, string>> = {
	lt: '<',
	lte: '≤',
	gt: '>',
	gte: '≥',
	eq: '=',
	neq: '≠',
	add: '+',
	subtract: '−',
	multiply: '×',
	divide: '÷',
	and: '且',
	or: '或',
};

const BINARY_LABEL: Readonly<Record<BinaryOperator, string>> = {
	lt: '小于',
	lte: '不大于',
	gt: '大于',
	gte: '不小于',
	eq: '等于',
	neq: '不等于',
	add: '加',
	subtract: '减',
	multiply: '乘',
	divide: '除以',
	and: '并且',
	or: '或者',
};

const UNARY_SYMBOL: Readonly<Record<'not' | 'negate', string>> = { not: '非', negate: '−' };
const UNARY_LABEL: Readonly<Record<'not' | 'negate', string>> = { not: '取反', negate: '取负' };

/** 目录里没有这个原语时画出来的占位块：如实说不知道，不猜一块顶上。 */
export const isUnknownShape = (shape: ImplementationBlockShape): boolean =>
	shape.role === 'unknown-statement' || shape.role === 'unknown-value';

// ---------------------------------------------------------------------------
// 形状
// ---------------------------------------------------------------------------

/**
 * 实参 → 绑定：
 *   - `parameter` 指向能力参数（**可写**：改它等于改节点的 parameters）；
 *   - `local` 指向实现里 `set` 过的局部变量（只读——它是算出来的，不是配置）；
 *   - `literal` 是目录里写死的值（只读）；
 *   - `dangling` 是既不是参数也不是局部变量的名字（目录缺陷，报诊断，不替它编一个值）；
 *   - `unbound` 是目录漏给了这一步的实参（缺陷，同上）。
 */
export type ArgumentBinding =
	| { readonly kind: 'parameter'; readonly parameter: string }
	| { readonly kind: 'local'; readonly name: string }
	| { readonly kind: 'literal'; readonly value: JsonValue }
	| { readonly kind: 'not-a-value'; readonly name: string }
	| { readonly kind: 'dangling'; readonly name: string }
	| { readonly kind: 'unbound' };

interface BaseWidget {
	/** Blockly 字段名。 */
	readonly fieldName: string;
	/** 原语参数名（目录里那个）；表达式位置的参数块上就是能力参数名。 */
	readonly parameter: string;
	/** 这个字段的值从哪来。 */
	readonly binding: ArgumentBinding;
	readonly tooltip: string;
}

export type ImplementationWidget =
	| (BaseWidget & {
			readonly kind: 'number';
			/** 声明里缺这个值时积木上显示什么（协议默认值，见 `numericDefault`）。 */
			readonly value: number;
			readonly unit?: string;
			readonly unitFieldName?: string;
	  })
	| (BaseWidget & {
			readonly kind: 'text';
			/** 声明里缺这个值时输入框里放什么。 */
			readonly value: string;
	  })
	| (BaseWidget & {
			readonly kind: 'sensor';
			readonly sensor: TaskSensor;
			/** 勾选框自己的文字（传感器路径，协议取值，照抄不译）。 */
			readonly label: string;
			/** 声明里没有这个字段时勾不勾。 */
			readonly checked: boolean;
	  })
	| (BaseWidget & { readonly kind: 'boolean'; readonly checked: boolean })
	| (BaseWidget & {
			/**
			 * 只读字段：目录写死的字面量（`turn` 的 `linear: 0`），
			 * 或者类型上没有可编辑控件的参数（`pose`）。写回时一律跳过。
			 */
			readonly kind: 'literal';
			readonly text: string;
	  });

/** 一行 = 一个原语参数：`label` 是这一行的字段标签。 */
export interface ImplementationBlockRow {
	readonly parameter: string;
	readonly label: string;
	/** 字段型的一行：控件在这里。 */
	readonly widgets: readonly ImplementationWidget[];
	/** 值输入型的一行：这一行的 Blockly input 名（实参是一个表达式时走这条）。 */
	readonly input?: string;
}

/** 值输入：条件、比较的操作数、赋值的右边——都是一棵子表达式。 */
export interface ImplementationValueInput {
	readonly name: string;
	readonly child: ImplementationBlockShape;
	/** 字面量当 shadow：它是目录里写死的值，不是可换的零件。 */
	readonly asShadow: boolean;
}

/** 语句口：if 的 then / else 里的语句链。 */
export interface ImplementationStatementInput {
	readonly name: string;
	readonly blocks: readonly ImplementationBlockShape[];
}

export interface ImplementationBlockShape {
	readonly role: ImplementationNodeRole;
	readonly tag: string;
	readonly type: string;
	readonly style: string;
	/** 一句话说明这个节点是什么（tooltip 里给眼睛看的那半句）。 */
	readonly detail: string;
	/** 这个节点自带的那一个记号（赋值的名字、字面量的值、参数名、未知原语名）。 */
	readonly atom: string;
	readonly tooltip: string;

	readonly capabilityRef: string;
	readonly capabilityLabel: string;
	/** 这个节点在实现语句树里的下标路径。 */
	readonly stepPath: string;
	/** 顶层语句下标（0 基）；嵌套节点也记着它所属的那条顶层语句。 */
	readonly stepIndex: number;
	/** 是不是顶层语句——徽标数它、选中高亮认它、代码行按它对齐。 */
	readonly topLevel: boolean;

	readonly primitiveRef: string | null;
	readonly primitiveLabel: string | null;
	/** 原语参数名，顺序就是目录顺序（读回参数时按它取）。 */
	readonly parameters: readonly string[];
	readonly widgets: readonly ImplementationWidget[];
	readonly rows: readonly ImplementationBlockRow[];
	readonly valueInputs: readonly ImplementationValueInput[];
	readonly statementInputs: readonly ImplementationStatementInput[];
}

// ---------------------------------------------------------------------------
// 路径解析
// ---------------------------------------------------------------------------

/** 路径指向的那个节点：语句或表达式。查不到就是 null（目录与路径对不上）。 */
export type ImplementationNodeAtPath =
	| { readonly kind: 'statement'; readonly statement: ImplStatement }
	| { readonly kind: 'expression'; readonly expression: ImplExpression };

const isExpressionArgument = (argument: ImplArgument | undefined): argument is ImplExpression =>
	typeof argument === 'object' && argument !== null && !Array.isArray(argument) && 'kind' in argument;

/**
 * 按下标路径从实现语句树里取出节点。
 *
 * 段名与树里的键名一一对应，所以这函数没有自己的语法：`then.0`、`condition.right`、
 * `arguments.sensors` 都是树里真实存在的键。取不到就返回 null——路径是画布自己写进
 * `block.data` 的，对不上说明积木与目录已经不是同一版，那要如实报错，不能猜。
 */
export const resolveImplementationPath = (
	capability: CapabilitySpec,
	path: string,
): ImplementationNodeAtPath | null => {
	const segments = path.split('.');
	const head = segments[0];
	if (head === undefined || !/^\d+$/.test(head)) return null;
	let statement: ImplStatement | undefined = capability.implementation[Number.parseInt(head, 10)];
	if (statement === undefined) return null;
	let expression: ImplExpression | undefined;

	for (let index = 1; index < segments.length; index += 1) {
		const segment = segments[index];
		if (segment === undefined) return null;

		if (expression !== undefined) {
			// 表达式往下走：比较/算术的左右、取反的值、有返回值调用的实参。
			if (expression.kind === 'binary') {
				if (segment === 'left') expression = expression.left;
				else if (segment === 'right') expression = expression.right;
				else return null;
				continue;
			}
			if (expression.kind === 'unary' && segment === 'value') {
				expression = expression.value;
				continue;
			}
			if (expression.kind === 'call' && segment === 'arguments') {
				const name = segments[index + 1];
				const argument = name === undefined ? undefined : expression.arguments[name];
				if (!isExpressionArgument(argument)) return null;
				expression = argument;
				index += 1;
				continue;
			}
			return null;
		}

		if (statement === undefined) return null;
		if (statement.kind === 'if' && segment === 'condition') {
			expression = statement.condition;
			continue;
		}
		if (statement.kind === 'set' && segment === 'value') {
			expression = statement.value;
			continue;
		}
		if (statement.kind === 'call' && segment === 'arguments') {
			const name = segments[index + 1];
			const argument = name === undefined ? undefined : statement.arguments[name];
			if (!isExpressionArgument(argument)) return null;
			expression = argument;
			index += 1;
			continue;
		}
		if (statement.kind === 'if' && (segment === 'then' || segment === 'else')) {
			const branch: readonly ImplStatement[] | undefined = segment === 'then' ? statement.then : statement.else;
			const position = segments[index + 1];
			const picked: ImplStatement | undefined =
				branch === undefined || position === undefined ? undefined : branch[Number.parseInt(position, 10)];
			if (picked === undefined) return null;
			statement = picked;
			expression = undefined;
			index += 1;
			continue;
		}
		return null;
	}

	if (expression !== undefined) return { kind: 'expression', expression };
	if (statement !== undefined) return { kind: 'statement', statement };
	return null;
};

/** 实现里被 `set` 过的局部变量名（`{kind:'param'}` 先在这里找，再找能力参数）。 */
export const localVariablesOf = (capability: CapabilitySpec): ReadonlySet<string> => {
	const names = new Set<string>();
	const walk = (statements: readonly ImplStatement[]): void => {
		for (const statement of statements) {
			if (statement.kind === 'set') names.add(statement.target);
			if (statement.kind === 'if') {
				walk(statement.then);
				if (statement.else !== undefined) walk(statement.else);
			}
		}
	};
	walk(capability.implementation);
	return names;
};

// ---------------------------------------------------------------------------
// 从目录推导形状
// ---------------------------------------------------------------------------

/** 能力引用恰好是任务协议里的动作名时，协议字段描述可用（单位、限值、缺省）。 */
const isTaskAction = (value: string): value is TaskAction =>
	(ALLOWED_ACTIONS as readonly string[]).includes(value);

const protocolFieldOf = (capabilityRef: string, parameter: string): ProtocolFieldSummary | null => {
	if (!isTaskAction(capabilityRef)) return null;
	return describeActionFields(capabilityRef).find((field) => field.name === parameter) ?? null;
};

const capabilityParameterOf = (capability: CapabilitySpec, name: string): CatalogParameter | null =>
	capability.parameters.find((candidate) => candidate.name === name) ?? null;

/**
 * 新积木的默认值：优先协议给的 `defaultValue`，其次区间下界，
 * 再次「开区间下界向上取整」（`duration > 0` → 1、`0 < distance ≤ 2` → 1）。
 * 全是从描述里算出来的，没有协议之外的数字。
 */
const numericDefault = (field: ProtocolFieldSummary | null): number => {
	if (field === null) return 0;
	if (field.defaultValue !== undefined) return field.defaultValue;
	if (field.min !== undefined) return field.min;
	if (field.exclusiveMin !== undefined) return Math.floor(field.exclusiveMin) + 1;
	return 0;
};

/** 取值范围提示也从描述里拼，界面上说的和校验器判的是同一件事。 */
const rangeHint = (field: ProtocolFieldSummary): string => {
	const parts: string[] = [];
	if (field.exclusiveMin !== undefined) parts.push(`> ${field.exclusiveMin}`);
	if (field.min !== undefined) parts.push(`≥ ${field.min}`);
	if (field.max !== undefined) parts.push(`≤ ${field.max}`);
	if (field.limit !== undefined) parts.push(`且不超过任务的 ${field.limit}`);
	if (field.integer === true) parts.push('取整数');
	if (field.abs === true) parts.push('比较时看绝对值，符号只表示方向');
	if (!field.required && field.defaultValue !== undefined) parts.push(`可省略，缺省 ${field.defaultValue}`);
	return parts.join('，');
};

const describeBinding = (binding: ArgumentBinding): string => {
	switch (binding.kind) {
		case 'parameter':
			return `← $${binding.parameter}`;
		case 'local':
			return `← 局部变量 ${binding.name}`;
		case 'literal':
			return `= ${literalText(binding.value)}`;
		case 'not-a-value':
			return `← $${binding.name}（$这一类型的参数进不了表达式）`;
		case 'dangling':
			return `← ${binding.name}（既不是能力参数，也不是实现里 set 过的局部变量）`;
		case 'unbound':
			return '← 目录没给这一处的实参（缺陷，不是可编辑的值）';
	}
};

/**
 * 字面量的显示文本。
 *
 * 标量与字符串数组照旧（`["/scan0"]` 读成 `/scan0`）；**结构化载荷摊成紧凑 JSON**——
 * 真原语的实参就是关节位置映射、轨迹模板这种一整个对象，
 * 老写法会把它变成 `[object Object]`，那是把程序说错。
 */
export const literalText = (value: JsonValue): string => {
	if (Array.isArray(value) && value.every((item) => typeof item === 'string')) return value.join(' ');
	if (value !== null && typeof value === 'object') return JSON.stringify(value) ?? 'null';
	return String(value);
};

/**
 * 积木上字面量字段的显示上限。
 *
 * 代码面板不截断（那是不许的），但积木是画出来的东西：一个字面量四千字符会把整块画布撑爆。
 * 这里截断**明说**——尾巴上写着总共多少字，全文在 tooltip 里，一个字都没丢。
 */
export const LITERAL_FIELD_LIMIT = 48;

export const truncateLiteralText = (text: string): string =>
	text.length <= LITERAL_FIELD_LIMIT ? text : `${text.slice(0, LITERAL_FIELD_LIMIT)}…（共 ${text.length} 字）`;

/**
 * tooltip：参数名、它绑到哪、显示名、单位与取值范围（协议有的话）都留着——
 * 主行只写显示名，信息不能跟着一起省掉。
 */
const tooltipFor = (
	parameter: string,
	binding: ArgumentBinding,
	label: string,
	field: ProtocolFieldSummary | null,
): string =>
	[
		`${parameter} ${describeBinding(binding)}（${label}）`,
		field === null || field.unit === undefined ? '' : `单位 ${field.unit}`,
		field?.description ?? '',
		field === null ? '' : rangeHint(field),
	]
		.filter((part) => part.length > 0)
		.join('；');

/** 一个原语参数 / 一个能力参数 → 它的控件（可能不止一个：传感器白名单每项一个勾选框）。 */
interface WidgetOptions {
	readonly parameter: string;
	/** Blockly 字段名（数值字段还带单位标签时，单位标签在它名字上派生）。 */
	readonly fieldName: string;
	readonly label: string;
	readonly type: CatalogValueType;
	readonly field: ProtocolFieldSummary | null;
	readonly tooltip: string;
	/** 表达式位置上的参数块不挂单位标签（`0.5 m` 在运算里是噪音）；调用行挂。 */
	readonly withUnit: boolean;
}

const writableWidgets = (binding: ArgumentBinding, options: WidgetOptions): readonly ImplementationWidget[] => {
	const base = { parameter: options.parameter, binding, tooltip: options.tooltip };
	const { fieldName } = options;
	/** 勾选框的 tooltip 说清「勾上的集合进的是哪个能力参数」。 */
	const target = binding.kind === 'parameter' ? binding.parameter : options.parameter;

	if (options.type === 'number') {
		const unit = options.withUnit ? options.field?.unit : undefined;
		return [
			{
				...base,
				kind: 'number',
				fieldName,
				value: numericDefault(options.field),
				...(unit === undefined ? {} : { unit, unitFieldName: unitFieldName(fieldName) }),
			},
		];
	}

	if (options.type === 'sensor') {
		// 数组字段没有原生控件：白名单里每一项一个勾选框，勾上的就是数组内容。
		return ALLOWED_SENSORS.map((sensor, index) => ({
			...base,
			kind: 'sensor' as const,
			fieldName: sensorFieldName(sensor),
			sensor,
			label: sensor,
			// 声明里缺这个字段时勾第一个，否则积木一落地就是非法状态。
			checked: index === 0,
			tooltip: `${options.tooltip}（勾选即进 ${target} 数组）`,
		}));
	}

	if (options.type === 'boolean') {
		return [{ ...base, kind: 'boolean', fieldName, checked: false }];
	}

	if (options.type === 'string') {
		return [{ ...base, kind: 'text', fieldName, value: '' }];
	}

	// `pose`：没有对应的可编辑控件，只读显示标签（不回写）。
	return [
		{
			...base,
			kind: 'literal',
			fieldName,
			text: options.label,
			tooltip: `${options.tooltip}；这一类型只读显示，画布不回写它`,
		},
	];
};

/** 只读显示一个值（漏给的实参、目录里写死的字面量、悬空的名字）。 */
const readOnlyWidget = (parameter: string, binding: ArgumentBinding, text: string, tooltip: string): ImplementationWidget => ({
	kind: 'literal',
	fieldName: literalFieldName(parameter),
	parameter,
	binding,
	text,
	tooltip,
});

/** 描述一个节点时的公共上下文。 */
interface DescribeContext {
	readonly catalog: CapabilityCatalog;
	readonly capability: CapabilitySpec;
	readonly locals: ReadonlySet<string>;
}

const shapeBase = (
	context: DescribeContext,
	path: string,
	role: ImplementationNodeRole,
	tag: string,
	detail: string,
	atom: string,
): Omit<
	ImplementationBlockShape,
	| 'primitiveRef'
	| 'primitiveLabel'
	| 'parameters'
	| 'widgets'
	| 'rows'
	| 'valueInputs'
	| 'statementInputs'
	| 'tooltip'
> => {
	const stepIndex = topLevelStepIndexOf(path) ?? 0;
	const topLevel = isTopLevelPath(path);
	return {
		role,
		tag,
		type: implementationBlockType(context.catalog.catalogRef, context.capability.capabilityRef, tag, path),
		style: blockStyleName(context.capability.capabilityRef),
		detail,
		atom,
		capabilityRef: context.capability.capabilityRef,
		capabilityLabel: context.capability.label,
		stepPath: path,
		stepIndex,
		topLevel,
	};
};

const emptyParts = {
	primitiveRef: null,
	primitiveLabel: null,
	parameters: [] as readonly string[],
	widgets: [] as readonly ImplementationWidget[],
	rows: [] as readonly ImplementationBlockRow[],
	valueInputs: [] as readonly ImplementationValueInput[],
	statementInputs: [] as readonly ImplementationStatementInput[],
};

/** 目录查不到原语：如实画一块「未知原语」占位，报错由调用方给（不猜一块顶上）。 */
const unknownShape = (
	context: DescribeContext,
	path: string,
	primitiveRef: string,
	position: 'statement' | 'value',
): ImplementationBlockShape => {
	const role: ImplementationNodeRole = position === 'statement' ? 'unknown-statement' : 'unknown-value';
	const detail = `未知原语 ${primitiveRef}`;
	return {
		...shapeBase(context, path, role, ROLE_TAG[role], detail, primitiveRef),
		...emptyParts,
		primitiveRef,
		primitiveLabel: null,
		tooltip: `${context.capability.label} 的实现里有目录里查不到的原语 ${primitiveRef}（路径 ${path}）`,
	};
};

/**
 * 一个原语调用 → 一块积木的行。
 *
 * 每个参数一行：实参是「能力参数」或目录里写死的字面量时给字段控件；
 * 实参是一棵表达式（嵌套调用、比较、算术、引用局部变量）时给一个**值输入**，
 * 子块由 `describeExpression` 递归长出来。
 */
const describeCall = (
	context: DescribeContext,
	path: string,
	primitiveRef: string,
	args: Readonly<Record<string, ImplArgument>>,
	position: 'statement' | 'value',
): ImplementationBlockShape => {
	const primitive = findPrimitive(context.catalog, primitiveRef);
	if (primitive === undefined) return unknownShape(context, path, primitiveRef, position);

	const rows: ImplementationBlockRow[] = [];
	const widgets: ImplementationWidget[] = [];
	const valueInputs: ImplementationValueInput[] = [];

	for (const parameter of primitive.parameters) {
		const argument = args[parameter.name];
		const argumentPath = childPath(childPath(path, 'arguments'), parameter.name);
		// 协议描述按**供值的那个名字**取：`wait(seconds ← $duration)` 的单位/范围/缺省
		// 是 `duration` 那一条，不是原语槽位 `seconds` 的（协议里根本没有后者）。
		const referencedName = isExpressionArgument(argument) && argument.kind === 'param' ? argument.name : null;
		const capabilityParameter = referencedName === null ? null : capabilityParameterOf(context.capability, referencedName);
		const field = protocolFieldOf(context.capability.capabilityRef, referencedName ?? parameter.name);
		const label = field?.label ?? capabilityParameter?.label ?? parameter.label;

		if (referencedName !== null) {
			if (capabilityParameter !== null) {
				// `{kind:'param'}` 指向本能力的参数：这一行是**可写**的字段，绑到节点的 parameters。
				const binding: ArgumentBinding = { kind: 'parameter', parameter: referencedName };
				const built = writableWidgets(binding, {
					parameter: parameter.name,
					fieldName: parameter.name,
					label,
					type: parameter.type,
					field,
					tooltip: tooltipFor(parameter.name, binding, label, field),
					withUnit: true,
				});
				widgets.push(...built);
				rows.push({ parameter: parameter.name, label, widgets: built });
				continue;
			}
			// 局部变量 / 悬空引用：长成一块只读引用块，嵌进这一行的值输入。
			const child = describeExpression(context, argument as ImplExpression, argumentPath);
			valueInputs.push({ name: parameter.name, child, asShadow: false });
			rows.push({ parameter: parameter.name, label, widgets: [], input: parameter.name });
			continue;
		}

		if (isExpressionArgument(argument)) {
			// 实参是一棵表达式：值块长在值输入里（字面量当 shadow）。
			const child = describeExpression(context, argument, argumentPath);
			valueInputs.push({
				name: parameter.name,
				child,
				asShadow: child.role.startsWith('literal-'),
			});
			rows.push({ parameter: parameter.name, label, widgets: [], input: parameter.name });
			continue;
		}

		// 目录里写死的字面量（`0`、`"/scan0"`），或者目录漏给了这一处的实参。
		const binding: ArgumentBinding = argument === undefined ? { kind: 'unbound' } : { kind: 'literal', value: argument };
		const text = argument === undefined ? '—' : literalText(argument);
		const widget = readOnlyWidget(parameter.name, binding, text, tooltipFor(parameter.name, binding, label, field));
		widgets.push(widget);
		rows.push({ parameter: parameter.name, label, widgets: [widget] });
	}

	const detail = `${primitive.label}（${primitive.primitiveRef}）`;
	const base = shapeBase(
		context,
		path,
		position === 'statement' ? 'call-statement' : 'call-value',
		position === 'statement' ? ROLE_TAG['call-statement'] : ROLE_TAG['call-value'],
		detail,
		'',
	);
	return {
		...base,
		primitiveRef: primitive.primitiveRef,
		primitiveLabel: primitive.label,
		parameters: primitive.parameters.map((parameter) => parameter.name),
		widgets,
		rows,
		valueInputs,
		statementInputs: [],
		tooltip: blockTooltipFor(base, primitive, widgets),
	};
};

/** 表达式 → 一块值积木（递归；子表达式各自长成自己的块，嵌在值输入里）。 */
const describeExpression = (
	context: DescribeContext,
	expression: ImplExpression,
	path: string,
): ImplementationBlockShape => {
	if (expression.kind === 'literal') {
		const full = literalText(expression.value);
		const text =
			typeof expression.value === 'boolean' ? (expression.value ? '真' : '假') : truncateLiteralText(full);
		const role: ImplementationNodeRole =
			typeof expression.value === 'number'
				? 'literal-number'
				: typeof expression.value === 'boolean'
					? 'literal-boolean'
					: 'literal-text';
		const detail = `字面量 ${text}`;
		return {
			...shapeBase(context, path, role, ROLE_TAG[role], detail, text),
			...emptyParts,
			widgets: [
				{
					kind: 'literal',
					fieldName: VALUE_FIELD_NAME,
					parameter: VALUE_FIELD_NAME,
					binding: { kind: 'literal', value: expression.value },
					text,
					tooltip: `实现里写死的值 ${full}（画布不回写它）`,
				},
			],
			rows: [],
			tooltip: `${context.capability.label} 的实现里有写死的字面量 ${text}（路径 ${path}）`,
		};
	}

	if (expression.kind === 'param') {
		return describeParamReference(context, expression.name, path);
	}

	if (expression.kind === 'call') {
		return describeCall(context, path, expression.primitiveRef, expression.arguments, 'value');
	}

	if (expression.kind === 'binary') {
		const left = describeExpression(context, expression.left, childPath(path, 'left'));
		const right = describeExpression(context, expression.right, childPath(path, 'right'));
		const detail = `运算 ${BINARY_LABEL[expression.operator]}`;
		return {
			...shapeBase(context, path, 'binary', `${ROLE_TAG.binary}_${expression.operator}`, detail, ''),
			...emptyParts,
			valueInputs: [
				{ name: LEFT_INPUT_NAME, child: left, asShadow: left.role.startsWith('literal-') },
				{ name: RIGHT_INPUT_NAME, child: right, asShadow: right.role.startsWith('literal-') },
			],
			tooltip: `${context.capability.label} 的实现里有一次${BINARY_LABEL[expression.operator]}比较/运算（路径 ${path}）`,
		};
	}

	const value = describeExpression(context, expression.value, childPath(path, 'value'));
	const detail = `运算 ${UNARY_LABEL[expression.operator]}`;
	return {
		...shapeBase(context, path, 'unary', `${ROLE_TAG.unary}_${expression.operator}`, detail, ''),
		...emptyParts,
		valueInputs: [{ name: VALUE_INPUT_NAME, child: value, asShadow: value.role.startsWith('literal-') }],
		tooltip: `${context.capability.label} 的实现里有一次${UNARY_LABEL[expression.operator]}（路径 ${path}）`,
	};
};

/**
 * `{kind:'param', name}` 在**表达式位置**长什么：按解析结果走三条路。
 *   - 是本能力参数且类型可进表达式（number/string/boolean）→ **可写的值块**，绑到节点参数；
 *   - 是实现里 `set` 过的局部变量 → 只读引用块，显示名字；
 *   - 都不是 → 只读引用块 + 诊断（由渲染侧报 `dangling_argument`）。
 * 能力参数里 `sensor` / `pose` 这两类不能进表达式（契约只认三种值类型），也走只读引用，
 * 并另报一条诊断——那是目录写歪了，不是画布该猜的。
 */
const describeParamReference = (context: DescribeContext, name: string, path: string): ImplementationBlockShape => {
	const capabilityParameter = capabilityParameterOf(context.capability, name);
	const inExpression = isExpressionValueType(capabilityParameter?.type);

	if (capabilityParameter !== null && inExpression) {
		const field = protocolFieldOf(context.capability.capabilityRef, name);
		const binding: ArgumentBinding = { kind: 'parameter', parameter: name };
		const label = field?.label ?? capabilityParameter.label;
		const widgets = writableWidgets(binding, {
			parameter: name,
			fieldName: VALUE_FIELD_NAME,
			label,
			type: capabilityParameter.type,
			field,
			tooltip: tooltipFor(name, binding, label, field),
			withUnit: false,
		});
		const role: ImplementationNodeRole =
			capabilityParameter.type === 'number'
				? 'param-number'
				: capabilityParameter.type === 'boolean'
					? 'param-boolean'
					: 'param-text';
		const detail = `参数 ${name}（${label}）`;
		return {
			...shapeBase(context, path, role, ROLE_TAG[role], detail, name),
			...emptyParts,
			primitiveRef: null,
			parameters: [name],
			widgets,
			rows: [{ parameter: name, label, widgets }],
			tooltip: `${context.capability.label} 的参数 ${name}（${label}）：改它等于改这个节点的 parameters（路径 ${path}）`,
		};
	}

	const binding: ArgumentBinding =
		capabilityParameter !== null
			? { kind: 'not-a-value', name }
			: context.locals.has(name)
				? { kind: 'local', name }
				: { kind: 'dangling', name };
	const detail =
		binding.kind === 'not-a-value'
			? `引用 ${name}（这一类型的参数进不了表达式）`
			: binding.kind === 'local'
				? `引用局部变量 ${name}`
				: `引用 ${name}（目录里查不到它）`;
	return {
		...shapeBase(context, path, 'param-read', ROLE_TAG['param-read'], detail, name),
		...emptyParts,
		widgets: [
			{
				kind: 'literal',
				fieldName: REFERENCE_FIELD_NAME,
				parameter: name,
				binding,
				text: name,
				tooltip:
					binding.kind === 'local'
						? `局部变量 ${name}——它在实现里被 set 过，只读（它的值不是节点参数）`
						: `${name} 既不是本能力的参数，也不是实现里 set 过的局部变量（目录缺陷，只读显示原样）`,
			},
		],
		tooltip: `${context.capability.label} 的实现里引用了 ${name}（路径 ${path}）`,
	};
};

const isExpressionValueType = (type: CatalogValueType | undefined): boolean =>
	type === 'number' || type === 'string' || type === 'boolean';

/** 语句 → 一块积木（递归；if 的两个分支各自是一串语句）。 */
const describeStatement = (
	context: DescribeContext,
	statement: ImplStatement,
	path: string,
): ImplementationBlockShape => {
	if (statement.kind === 'call') {
		return describeCall(context, path, statement.primitiveRef, statement.arguments, 'statement');
	}

	if (statement.kind === 'set') {
		const value = describeExpression(context, statement.value, childPath(path, 'value'));
		const detail = `给 ${statement.target} 赋值`;
		return {
			...shapeBase(context, path, 'set', ROLE_TAG.set, detail, statement.target),
			...emptyParts,
			valueInputs: [{ name: VALUE_INPUT_NAME, child: value, asShadow: value.role.startsWith('literal-') }],
			tooltip: `${context.capability.label} 的实现里给 ${statement.target} 赋值（路径 ${path}）`,
		};
	}

	const condition = describeExpression(context, statement.condition, childPath(path, 'condition'));
	const thenBlocks = statement.then.map((child, index) =>
		describeStatement(context, child, childPath(childPath(path, 'then'), index)),
	);
	const elseBlocks =
		statement.else === undefined
			? []
			: statement.else.map((child, index) =>
					describeStatement(context, child, childPath(childPath(path, 'else'), index)),
				);
	const withElse = statement.else !== undefined;
	const role: ImplementationNodeRole = withElse ? 'if-else' : 'if';
	const detail = withElse ? '如果……那么……否则' : '如果……那么';
	return {
		...shapeBase(context, path, role, ROLE_TAG[role], detail, ''),
		...emptyParts,
		valueInputs: [{ name: CONDITION_INPUT_NAME, child: condition, asShadow: condition.role.startsWith('literal-') }],
		statementInputs: [
			{ name: THEN_INPUT_NAME, blocks: thenBlocks },
			...(withElse ? [{ name: ELSE_INPUT_NAME, blocks: elseBlocks }] : []),
		],
		tooltip: `${context.capability.label} 的实现里有${withElse ? '一条条件分支（带否则那半边）' : '一条条件分支'}（路径 ${path}）`,
	};
};

/** tooltip 的头部：顶层语句说「第几步」，嵌套节点说路径。 */
const blockTooltipFor = (
	base: { readonly capabilityLabel: string; readonly stepPath: string; readonly stepIndex: number; readonly topLevel: boolean },
	primitive: PrimitiveSpec,
	widgets: readonly ImplementationWidget[],
): string => {
	const units = widgets
		.flatMap((widget) => (widget.kind === 'number' && widget.unit !== undefined ? [`${widget.parameter} ${widget.unit}`] : []))
		.join('、');
	const head = base.topLevel
		? `${base.capabilityLabel} 的实现第 ${base.stepIndex + 1} 步：${primitive.label}（${primitive.primitiveRef}）`
		: `${base.capabilityLabel} 的实现 · ${primitive.label}（${primitive.primitiveRef}）（路径 ${base.stepPath}）`;
	return units.length === 0 ? head : `${head}（单位：${units}）`;
};

/**
 * 一个下标路径上的那个节点的形状（写回时按 `block.data` 里的路径把它找回来）。
 * 路径对不上目录就返回 null——积木与目录不是同一版了，那要如实报错，不猜。
 */
export const describeNodeAtPath = (
	catalog: CapabilityCatalog,
	capability: CapabilitySpec,
	path: string,
): ImplementationBlockShape | null => {
	const node = resolveImplementationPath(capability, path);
	if (node === null) return null;
	const context: DescribeContext = { catalog, capability, locals: localVariablesOf(capability) };
	return node.kind === 'statement'
		? describeStatement(context, node.statement, path)
		: describeExpression(context, node.expression, path);
};

/** 一个能力 → 它实现里顶端那几条语句的形状（画布按顺序把它们的 next 串起来）。 */
export const describeImplementation = (
	catalog: CapabilityCatalog,
	capability: CapabilitySpec,
): readonly ImplementationBlockShape[] => {
	const context: DescribeContext = { catalog, capability, locals: localVariablesOf(capability) };
	return capability.implementation.map((statement, index) => describeStatement(context, statement, String(index)));
};

/** 形状树里的每一个节点（深度优先，父在子前）：注册积木与报诊断都按它遍历。 */
export const flattenShape = (shape: ImplementationBlockShape): readonly ImplementationBlockShape[] => [
	shape,
	...shape.valueInputs.flatMap((input) => flattenShape(input.child)),
	...shape.statementInputs.flatMap((input) => input.blocks.flatMap((block) => flattenShape(block))),
];

/** 一个能力 → 它实现里每个节点的形状（含嵌套节点）。注册积木要的是这一份全量。 */
export const describeCapabilityImplementation = (
	catalog: CapabilityCatalog,
	capability: CapabilitySpec,
): readonly ImplementationBlockShape[] =>
	describeImplementation(catalog, capability).flatMap((shape) => flattenShape(shape));

/** 目录里每个能力的每个节点都有形状。 */
export const describeCatalogImplementations = (
	catalog: CapabilityCatalog,
): readonly ImplementationBlockShape[] =>
	catalog.capabilities.flatMap((capability) => describeCapabilityImplementation(catalog, capability));

/** 一个块在一行里要用的字段（只读标签也是字段，画布上一样要摆）。 */
const widgetArgs = (widget: ImplementationWidget): Record<string, unknown> => {
	switch (widget.kind) {
		case 'number':
			// 刻意不给 min/max：Blockly 的数值字段会**静默夹住**越界输入，
			// 那正是 spec §4.1 禁止的「静默修正」。越界一律由校验器给诊断。
			return { type: 'field_number', name: widget.fieldName, value: widget.value };
		case 'text':
			return { type: 'field_input', name: widget.fieldName, text: widget.value };
		case 'sensor':
		case 'boolean':
			return { type: 'field_checkbox', name: widget.fieldName, checked: widget.checked };
		case 'literal':
			return { type: 'field_label', name: widget.fieldName, text: widget.text };
	}
};

/** 单位标签：只读小字，字号由视图侧的 `.cc-block-unit` 定；不参与序列化，也不进参数。 */
const unitArg = (widget: ImplementationWidget): Record<string, unknown> | null =>
	widget.kind === 'number' && widget.unit !== undefined && widget.unitFieldName !== undefined
		? { type: 'field_label', name: widget.unitFieldName, text: widget.unit, class: BLOCK_UNIT_CLASS }
		: null;

/**
 * 形状 → Blockly 的积木 JSON。
 *
 * 子块不在这份定义里：定义只说「这个位置是个值输入 / 语句口」，具体嵌着什么由
 * `render.ts` 按同一棵形状树生成序列化状态。定义与取值分开，写回时也就能只碰取值那一半。
 */
export const buildBlockDefinition = (shape: ImplementationBlockShape): Record<string, unknown> => {
	const valueType = shape.role.endsWith('value') || shape.role.startsWith('literal-') || shape.role.startsWith('param-') || shape.role === 'binary' || shape.role === 'unary';
	const definition: Record<string, unknown> = {
		type: shape.type,
		tooltip: shape.tooltip,
		style: shape.style,
		// 表达式块（比较/取反/赋值）要把操作数摆在同一行；语句块一行一个字段，
		// `inputsInline: true` 会把 message1/message2… 并回同一行，一行一个字段就白排了。
		inputsInline: shape.role === 'binary' || shape.role === 'unary' || shape.role === 'set',
		helpUrl: '',
	};
	if (valueType) definition['output'] = null;
	else {
		definition['previousStatement'] = null;
		definition['nextStatement'] = null;
	}

	// 字段型的一行：`参数标签 %1 %2`（%2 可能是单位小标签）。
	let rowIndex = 0;
	for (const row of shape.rows) {
		const args: Record<string, unknown>[] = [];
		const parts: string[] = [];
		for (const widget of row.widgets) {
			// 勾选框的文字（传感器路径）跟在框后面；数值/文本字段的文字就是这一行的字段标签。
			const trailing = widget.kind === 'sensor' ? ` ${widget.label}` : '';
			parts.push(`%${args.length + 1}${trailing}`);
			args.push(widgetArgs(widget));
			const unit = unitArg(widget);
			if (unit !== null) {
				parts.push(`%${args.length + 1}`);
				args.push(unit);
			}
		}
		if (row.input !== undefined) {
			parts.push(`%${args.length + 1}`);
			args.push({ type: 'input_value', name: row.input });
		}
		// 第一行左边先写这一步的显示名，其余每行左边是这一行的参数标签。
		const head = rowIndex === 0 ? `${shape.primitiveLabel ?? ''} ` : '';
		definition[`message${rowIndex}`] = `${head}${row.label} ${parts.join(' ')}`.trim();
		definition[`args${rowIndex}`] = args;
		rowIndex += 1;
	}

	if (shape.rows.length === 0) {
		// 没有参数的原语（停止运动 / 紧急刹停），以及赋值与条件分支：整块只写一句人话。
		const parts: string[] = [];
		const args: Record<string, unknown>[] = [];
		const placeholder = (arg: Record<string, unknown>): string => {
			args.push(arg);
			return `%${args.length}`;
		};
		let message: string;
		switch (shape.role) {
			case 'set':
				message = `设 ${placeholder({ type: 'field_label', name: SET_TARGET_FIELD_NAME, text: shape.atom })} 为 ${placeholder({ type: 'input_value', name: VALUE_INPUT_NAME })}`;
				break;
			case 'if':
				message = `如果 ${placeholder({ type: 'input_value', name: CONDITION_INPUT_NAME })} 那么 ${placeholder({ type: 'input_statement', name: THEN_INPUT_NAME })}`;
				break;
			case 'if-else':
				message = `如果 ${placeholder({ type: 'input_value', name: CONDITION_INPUT_NAME })} 那么 ${placeholder({ type: 'input_statement', name: THEN_INPUT_NAME })} 否则 ${placeholder({ type: 'input_statement', name: ELSE_INPUT_NAME })}`;
				break;
			case 'binary':
				message = `${placeholder({ type: 'input_value', name: LEFT_INPUT_NAME })} ${binarySymbolOf(shape.tag)} ${placeholder({ type: 'input_value', name: RIGHT_INPUT_NAME })}`;
				break;
			case 'unary':
				message = `${unarySymbolOf(shape.tag)} ${placeholder({ type: 'input_value', name: VALUE_INPUT_NAME })}`;
				break;
			case 'unknown-statement':
			case 'unknown-value':
				message = `未知原语 ${placeholder({ type: 'field_label', name: UNKNOWN_PRIMITIVE_FIELD_NAME, text: shape.atom })}`;
				break;
			default: {
				// 字面量与引用：一块一个只读字段，值就在块面上。
				const widget = shape.widgets[0];
				message =
					widget === undefined
						? (shape.primitiveLabel ?? shape.detail)
						: placeholder(widgetArgs(widget));
			}
		}
		definition['message0'] = message;
		definition['args0'] = args;
	}

	return definition;
};

/** `bin_lt` → `<`；认不出的标签给 `?`（宁可看起来不对，也不静默换一个算符）。 */
const binarySymbolOf = (tag: string): string => {
	const operator = tag.slice('bin_'.length) as BinaryOperator;
	return BINARY_SYMBOL[operator] ?? '?';
};

const unarySymbolOf = (tag: string): string => {
	const operator = tag.slice('un_'.length) as 'not' | 'negate';
	return UNARY_SYMBOL[operator] ?? '?';
};

/**
 * 把目录里每一个「能力 × 节点」组合注册成一块积木。
 *
 * `blockly.Blocks[type] === undefined` 就是幂等判据：同一个 Blockly 实例上重复注册不会覆盖，
 * 也不用（跨测试实例会漂的）模块级开关。
 */
export const registerImplementationBlocks = (
	catalog: CapabilityCatalog,
	blockly: typeof Blockly = Blockly,
): readonly string[] => {
	const shapes = describeCatalogImplementations(catalog);
	const fresh = shapes.filter((shape) => blockly.Blocks[shape.type] === undefined);
	if (fresh.length > 0) blockly.defineBlocksWithJsonArray(fresh.map(buildBlockDefinition));
	return fresh.map((shape) => shape.type);
};

/** 画布上这一块是不是实现积木（给「认不出来的块」的判据用）。 */
export const isImplementationBlockType = (type: string): boolean =>
	type.startsWith(IMPLEMENTATION_BLOCK_TYPE_PREFIX);
