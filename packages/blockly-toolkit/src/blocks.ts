/**
 * 实现积木：**一个模块 = 一个能力，一块积木 = 这个能力实现里的一步**（spec §4.1）。
 *
 * 积木的形状从**能力目录**推导，不是手写：字段来自 `catalog.primitives[].parameters`，
 * 字段的值来自这一步的实参 `implementation[].arguments`——
 *   - `"$name"` → 取本能力同名参数（**可写**：改它等于改节点的 parameters）；
 *   - 其它（`0`、`"/scan0"` 这种）→ 目录里写死的字面量（**只读**：实现结构不归画布管）。
 * 显示名/单位/取值范围仍从任务协议的字段描述里取（与能力参数同名的那个字段）——
 * 目录只说「有哪些参数」，协议说「这个参数的单位与限值」，两边各说各知道的。
 *
 * 所以同一块积木会出现两次而长相不同（`set_velocity` 在 `move` 下是青色、在 `turn` 下是蓝色），
 * 块类型因此带着能力名：类型 = `cc_impl_<能力>#<原语>`。
 */
import * as Blockly from 'blockly';
import {
	ALLOWED_ACTIONS,
	ALLOWED_SENSORS,
	describeActionFields,
	findPrimitive,
	type ArgumentValue,
	type CapabilityCatalog,
	type CapabilitySpec,
	type CatalogParameter,
	type ImplementationStep,
	type ProtocolFieldSummary,
	type TaskAction,
	type TaskSensor,
} from '@codecanvas/contracts';

/** 类型名前缀：`cc_impl_<catalogRef>#<capabilityRef>#<primitiveRef>#<stepIndex>`。 */
export const IMPLEMENTATION_BLOCK_TYPE_PREFIX = 'cc_impl_';
/** 分隔符刻意选 `#`：它不在 `stableReferenceSchema` 的字符集里，几段拼起来不会撞。 */
export const IMPLEMENTATION_TYPE_SEPARATOR = '#';

/**
 * 块类型 = **目录 + 能力 + 原语 + 这一步在实现里的序号**。
 *
 * 四样都要：字段长什么样由「这一步的实参怎么绑」决定（`$name` 是可写输入框、字面量是只读标签），
 * 所以同一条实现里两次调用同一个原语、绑定不同，就是**两块字段不同的积木**；
 * 目录名与能力名进类型则是为了换一台设备的目录（能力名与原语名撞车）时不互相顶掉。
 */
export const implementationBlockType = (
	catalogRef: string,
	capabilityRef: string,
	primitiveRef: string,
	stepIndex: number,
): string =>
	[IMPLEMENTATION_BLOCK_TYPE_PREFIX + catalogRef, capabilityRef, primitiveRef, String(stepIndex)].join(
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

/**
 * 实参 → 绑定：`$name` 指向能力参数（**可写**），其余是目录里的字面量（只读），
 * `unbound` 是目录漏给了这一步的实参（缺陷，渲染时报诊断，不替它编一个值）。
 */
export type ArgumentBinding =
	| { readonly kind: 'parameter'; readonly parameter: string }
	| { readonly kind: 'literal'; readonly value: ArgumentValue }
	| { readonly kind: 'unbound' };

/** `$linear` → `linear`；不是 `$` 开头或空名返回 null。 */
export const capabilityParameterOf = (argument: ArgumentValue): string | null => {
	if (typeof argument !== 'string' || !argument.startsWith('$')) return null;
	const name = argument.slice(1);
	return name.length === 0 ? null : name;
};

interface BaseWidget {
	/** Blockly 字段名。 */
	readonly fieldName: string;
	/** 原语参数名（目录里那个）。 */
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
			 * 或者类型上没有可编辑控件的参数（`pose` / `string`）。写回时一律跳过。
			 */
			readonly kind: 'literal';
			readonly text: string;
	  });

/** 一行 = 一个原语参数：`label` 是这一行的字段标签。 */
export interface ImplementationBlockRow {
	readonly parameter: string;
	readonly label: string;
	readonly widgets: readonly ImplementationWidget[];
}

export interface ImplementationBlockShape {
	readonly capabilityRef: string;
	readonly capabilityLabel: string;
	readonly primitiveRef: string;
	readonly primitiveLabel: string;
	/** 这一步在实现里的位置（0 基）与序号（1 基，画在徽标上）。 */
	readonly stepIndex: number;
	readonly type: string;
	readonly style: string;
	/** 原语参数名，顺序就是目录顺序（读回参数时按它取）。 */
	readonly parameters: readonly string[];
	readonly widgets: readonly ImplementationWidget[];
	readonly rows: readonly ImplementationBlockRow[];
}

/** 能力引用恰好是任务协议里的动作名时，协议字段描述可用（单位、限值、缺省）。 */
const isTaskAction = (value: string): value is TaskAction =>
	(ALLOWED_ACTIONS as readonly string[]).includes(value);

const protocolFieldOf = (capabilityRef: string, parameter: string): ProtocolFieldSummary | null => {
	if (!isTaskAction(capabilityRef)) return null;
	return describeActionFields(capabilityRef).find((field) => field.name === parameter) ?? null;
};

const capabilityParameterOfSpec = (
	capability: CapabilitySpec,
	parameter: string,
): CatalogParameter | null => capability.parameters.find((candidate) => candidate.name === parameter) ?? null;

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

/** 字面量的显示文本：数字/布尔照原样，字符串照抄（含 `$` 悬空引用），数组按协议写法列出来。 */
export const literalText = (value: ArgumentValue): string => {
	if (Array.isArray(value)) return value.join(' ');
	return String(value);
};

/**
 * tooltip：原语参数名、它绑到哪（`$name` 还是字面量）、显示名、
 * 单位与取值范围（协议有的话）都留着——主行只写显示名，信息不能跟着一起省掉。
 */
const tooltipFor = (
	primitiveParameter: string,
	binding: ArgumentBinding,
	label: string,
	field: ProtocolFieldSummary | null,
): string => {
	const head =
		binding.kind === 'parameter'
			? `${primitiveParameter} ← $${binding.parameter}（${label}）`
			: binding.kind === 'literal'
				? `${primitiveParameter} = ${literalText(binding.value)}（实现里写死的值，改不了）`
				: `${primitiveParameter} ← 目录没给这一步的实参（缺陷，不是可编辑的值）`;
	return [
		head,
		field === null || field.unit === undefined ? '' : `单位 ${field.unit}`,
		field?.description ?? '',
		field === null ? '' : rangeHint(field),
	]
		.filter((part) => part.length > 0)
		.join('；');
};

/** 一个原语参数 → 它的控件（可能不止一个：传感器白名单每项一个勾选框）。 */
const widgetsForParameter = (
	capability: CapabilitySpec,
	argument: ArgumentValue | undefined,
	parameter: CatalogParameter,
): readonly ImplementationWidget[] => {
	const referenced = argument === undefined ? null : capabilityParameterOf(argument);
	const capabilityParameter = referenced === null ? null : capabilityParameterOfSpec(capability, referenced);
	// 三种「画不出可编辑控件」的情形，一律只读显示：目录没给实参、实参是字面量、
	// `$name` 指向一个能力里不存在的参数（悬空引用）。都不猜，也都在渲染时报诊断。
	const binding: ArgumentBinding =
		argument === undefined
			? { kind: 'unbound' }
			: referenced !== null && capabilityParameter !== null
				? { kind: 'parameter', parameter: referenced }
				: { kind: 'literal', value: argument };
	const field = referenced === null ? null : protocolFieldOf(capability.capabilityRef, referenced);
	const label = field?.label ?? capabilityParameter?.label ?? parameter.label;

	if (binding.kind !== 'parameter') {
		return [
			{
				kind: 'literal',
				fieldName: literalFieldName(parameter.name),
				parameter: parameter.name,
				binding,
				text: binding.kind === 'literal' ? literalText(binding.value) : '—',
				tooltip: tooltipFor(parameter.name, binding, label, field),
			},
		];
	}

	if (parameter.type === 'number') {
		const unit = field?.unit;
		return [
			{
				kind: 'number',
				fieldName: parameter.name,
				parameter: parameter.name,
				binding,
				value: numericDefault(field),
				...(unit === undefined ? {} : { unit, unitFieldName: unitFieldName(parameter.name) }),
				tooltip: tooltipFor(parameter.name, binding, label, field),
			},
		];
	}

	if (parameter.type === 'sensor') {
		// 数组字段没有原生控件：白名单里每一项一个勾选框，勾上的就是数组内容。
		return ALLOWED_SENSORS.map((sensor, index) => ({
			kind: 'sensor' as const,
			fieldName: sensorFieldName(sensor),
			parameter: parameter.name,
			binding,
			sensor,
			label: sensor,
			// 声明里缺这个字段时勾第一个，否则积木一落地就是非法状态。
			checked: index === 0,
			tooltip: `${tooltipFor(parameter.name, binding, label, field)}（勾选即进 ${referenced ?? parameter.name} 数组）`,
		}));
	}

	if (parameter.type === 'boolean') {
		return [
			{
				kind: 'boolean',
				fieldName: parameter.name,
				parameter: parameter.name,
				binding,
				checked: false,
				tooltip: tooltipFor(parameter.name, binding, label, field),
			},
		];
	}

	// `pose` / `string`：目录里没有对应的可编辑控件，read-only 显示声明里的值（不回写）。
	return [
		{
			kind: 'literal',
			fieldName: literalFieldName(parameter.name),
			parameter: parameter.name,
			binding,
			text: label,
			tooltip: `${tooltipFor(parameter.name, binding, label, field)}；这一类型只读显示，画布不回写它`,
		},
	];
};

/**
 * 实现里的一步 → 一块积木的形状。行是边遍历目录参数边长出来的，没有任何手写的字段表。
 *
 * 注意：这里**只描述形状**，字段的实际取值由 `render.ts` 从节点参数里填——
 * 形状（目录决定）与取值（声明决定）分开，写回时也就能只碰取值那一半。
 */
export const describeImplementationStep = (
	catalog: CapabilityCatalog,
	capability: CapabilitySpec,
	step: ImplementationStep,
	stepIndex: number,
): ImplementationBlockShape | null => {
	const primitive = findPrimitive(catalog, step.step);
	if (primitive === undefined) return null; // 目录缺这一步的原语：画不出来，由调用方报诊断
	const widgets: ImplementationWidget[] = [];
	const rows: ImplementationBlockRow[] = [];

	for (const parameter of primitive.parameters) {
		const argument = step.arguments[parameter.name];
		const rowWidgets = widgetsForParameter(capability, argument, parameter);
		widgets.push(...rowWidgets);
		rows.push({ parameter: parameter.name, label: parameter.label, widgets: rowWidgets });
	}

	return {
		capabilityRef: capability.capabilityRef,
		capabilityLabel: capability.label,
		primitiveRef: primitive.primitiveRef,
		primitiveLabel: primitive.label,
		stepIndex,
		type: implementationBlockType(
			catalog.catalogRef,
			capability.capabilityRef,
			primitive.primitiveRef,
			stepIndex,
		),
		style: blockStyleName(capability.capabilityRef),
		parameters: primitive.parameters.map((parameter) => parameter.name),
		widgets,
		rows,
	};
};

/** 一个能力 → 它实现里每一步的形状。画布只显示其中一个能力，但要按目录全量注册积木定义。 */
export const describeCapabilityImplementation = (
	catalog: CapabilityCatalog,
	capability: CapabilitySpec,
): readonly ImplementationBlockShape[] =>
	capability.implementation.flatMap((step, stepIndex) => {
		const shape = describeImplementationStep(catalog, capability, step, stepIndex);
		return shape === null ? [] : [shape];
	});

/** 目录里每个能力的每一步都有形状；缺原语的那一步不出形状（由渲染侧报诊断）。 */
export const describeCatalogImplementations = (
	catalog: CapabilityCatalog,
): readonly ImplementationBlockShape[] =>
	catalog.capabilities.flatMap((capability) => describeCapabilityImplementation(catalog, capability));

const widgetArgs = (widget: ImplementationWidget): Record<string, unknown> => {
	switch (widget.kind) {
		case 'number':
			// 刻意不给 min/max：Blockly 的数值字段会**静默夹住**越界输入，
			// 那正是 spec §4.1 禁止的「静默修正」。越界一律由校验器给诊断。
			return { type: 'field_number', name: widget.fieldName, value: widget.value };
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
 * 积木上的单位一览（tooltip 用）：主行只有显示名，单位在这里按参数名列一份，
 * 好跟节点参数里的 `linear=...` 对上号。
 */
const unitsHint = (shape: ImplementationBlockShape): string =>
	shape.rows
		.flatMap((row) =>
			row.widgets.flatMap((widget) =>
				widget.kind === 'number' && widget.unit !== undefined ? [`${widget.parameter} ${widget.unit}`] : [],
			),
		)
		.join('、');

/** 显示名给眼睛，目录名（能力/原语）给对账，序号说明这是实现里的第几步。 */
export const blockTooltip = (shape: ImplementationBlockShape): string => {
	const units = unitsHint(shape);
	const head = `${shape.capabilityLabel} 的实现第 ${String(shape.stepIndex + 1)} 步：${shape.primitiveLabel}（${shape.primitiveRef}）`;
	return units.length === 0 ? head : `${head}（单位：${units}）`;
};

/** 形状 → Blockly 的积木 JSON（行内参数编号跨行连续，这是 Blockly 的规矩）。 */
export const buildBlockDefinition = (shape: ImplementationBlockShape): Record<string, unknown> => {
	const definition: Record<string, unknown> = {
		type: shape.type,
		tooltip: blockTooltip(shape),
		style: shape.style,
		// 必须是 false：`inputsInline: true` 会把 message1/message2… 这些行**并回同一行**，
		// 一行一个字段就白排了（Blockly 把后续行标成 inline，渲染器就把它们摆到一条线上）。
		inputsInline: false,
		previousStatement: null,
		nextStatement: null,
		helpUrl: '',
	};

	let rowIndex = 0;
	for (const row of shape.rows) {
		// 参数编号在每行内从 1 起（Blockly 的规矩：messageN 的 %k 对应 argsN[k-1]）。
		// 数值字段后面可能再跟一个单位标签、勾选框后面跟着自己的路径文字，
		// 都占一个编号，所以编号与 args 同步长。
		const args: Record<string, unknown>[] = [];
		const parts: string[] = [];
		for (const widget of row.widgets) {
			// 勾选框的文字（传感器路径）跟在框后面；数值字段的文字就是这一行的字段标签。
			const trailing = widget.kind === 'sensor' ? ` ${widget.label}` : '';
			parts.push(`%${args.length + 1}${trailing}`);
			args.push(widgetArgs(widget));
			const unit = unitArg(widget);
			if (unit !== null) {
				parts.push(`%${args.length + 1}`);
				args.push(unit);
			}
		}
		// 第一行左边先写这一步的显示名，其余每行左边是这一行的参数标签。
		const head = rowIndex === 0 ? `${shape.primitiveLabel} ` : '';
		definition[`message${rowIndex}`] = `${head}${row.label} ${parts.join(' ')}`.trim();
		definition[`args${rowIndex}`] = args;
		rowIndex += 1;
	}

	// 没有参数的原语（stop_motion / brake / read_status）也得有个 message0，否则 Blockly 建不出块。
	if (shape.rows.length === 0) {
		definition['message0'] = shape.primitiveLabel;
		definition['args0'] = [];
	}

	return definition;
};

/**
 * 把目录里每一个「能力 × 原语」组合注册成一块积木。
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
