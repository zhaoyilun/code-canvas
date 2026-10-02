/**
 * 七种动作的积木定义——**从校验器推导，不是手写七块**（spec §1.1、§4.1）。
 *
 * 字段、字段类型、默认值、单位、取值范围提示，全部来自
 * `@codecanvas/contracts` 的 `ACTION_SPECS` / `describeActionFields` / `describeActionLabel` /
 * `ALLOWED_SENSORS`；传感器数组这种 Blockly 没有原生控件的字段，按白名单逐项展开成勾选框
 * （一条规则，不是一张表）。显示名也读协议给的 `label`，这里不自带一份「动作/字段 → 中文」的映射。
 * 协议改了，这里是零改动。
 */
import * as Blockly from 'blockly';
import {
	ACTION_SPECS,
	ALLOWED_ACTIONS,
	ALLOWED_SENSORS,
	describeActionFields,
	describeActionLabel,
	type ProtocolFieldSummary,
	type TaskAction,
	type TaskSensor,
} from '@codecanvas/contracts';

/** 类型名 = 前缀 + 动作名，七个动作一个不落地长出来。 */
export const ACTION_BLOCK_TYPE_PREFIX = 'cc_task_action_';

/**
 * 一行只摆一个协议字段：标签在左、输入框在右，纵向排开。
 * 横着排会把输入框挤到看不清（`arm6_joints` 有七个字段），换行规则就这一条。
 */
export const MAX_FIELDS_PER_ROW = 1;

/**
 * 单位不占主行宽度：它是紧跟输入框的一个小字号标签（`field_label` 的 class），
 * 由视图侧用 `--cc-fs-xs` 定字号。单位同时留在字段 tooltip 里，信息不丢。
 */
export const BLOCK_UNIT_CLASS = 'cc-block-unit';

/** 数值字段的单位标签字段名：与数值字段名同族但不会撞名。 */
export const unitFieldName = (fieldName: string): string => `unit_${fieldName}`;

export const actionBlockType = (action: TaskAction): string => `${ACTION_BLOCK_TYPE_PREFIX}${action}`;

export const actionOfBlockType = (type: string): TaskAction | null => {
	if (!type.startsWith(ACTION_BLOCK_TYPE_PREFIX)) return null;
	const candidate = type.slice(ACTION_BLOCK_TYPE_PREFIX.length);
	return (ALLOWED_ACTIONS as readonly string[]).includes(candidate) ? (candidate as TaskAction) : null;
};

/** 主题里每个动作占一个 blockStyle（色值在主题里，不在这张表里）。 */
export const blockStyleName = (action: TaskAction): string => `cc_${action}`;

/** `/scan0` → `sensor_scan0`：字段名由传感器名机械地推出来。 */
export const sensorFieldName = (sensor: TaskSensor): string => `sensor${sensor.replace(/[^a-zA-Z0-9]+/g, '_')}`;

export type BlockWidget =
	| {
			readonly kind: 'number';
			/** Blockly 字段名（协议参数名与字段名同名）。 */
			readonly fieldName: string;
			/** 协议参数名。 */
			readonly parameter: string;
			readonly value: number;
			/** 协议给的单位（可能没有）。 */
			readonly unit?: string;
			/** 单位标签的 Blockly 字段名；没有单位时为 undefined。 */
			readonly unitFieldName?: string;
			readonly tooltip: string;
		}
	| {
			readonly kind: 'sensor';
			readonly fieldName: string;
			/** 悬停提示里的协议参数名。 */
			readonly parameter: string;
			readonly sensor: TaskSensor;
			/** 勾选框自己的文字（传感器路径，协议取值，照抄不译）。 */
			readonly label: string;
			readonly checked: boolean;
			readonly tooltip: string;
		};

/** 一行 = 一个协议字段：`label` 是这一行的字段标签（协议给的中文显示名）。 */
export interface ActionBlockRow {
	readonly parameter: string;
	readonly label: string;
	readonly widgets: readonly BlockWidget[];
}

export interface ActionBlockShape {
	readonly action: TaskAction;
	/** 动作的显示名（协议给的 `label`，不是这里编的）。 */
	readonly label: string;
	readonly type: string;
	readonly style: string;
	readonly summary: string;
	/** 协议字段名，顺序就是协议顺序（读回参数时按它取）。 */
	readonly parameters: readonly string[];
	readonly widgets: readonly BlockWidget[];
	readonly rows: readonly ActionBlockRow[];
}

/**
 * 新积木的默认值：优先协议给的 `defaultValue`，其次区间下界，
 * 再次「开区间下界向上取整」（`duration > 0` → 1、`0 < distance ≤ 2` → 1）。
 * 全是从描述里算出来的，没有协议之外的数字。
 */
const numericDefault = (field: ProtocolFieldSummary): number => {
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

/** tooltip 里协议字段名与单位都留着：主行只写显示名，信息不能跟着一起省掉。 */
const tooltipFor = (field: ProtocolFieldSummary): string =>
	[
		`${field.name}（${field.label}）`,
		field.unit === undefined ? '' : `单位 ${field.unit}`,
		field.description,
		rangeHint(field),
	]
		.filter((part) => part.length > 0)
		.join('；');

/** 一个动作 → 一块积木的形状。一行 = 一个协议字段，所以行是边遍历字段边长出来的。 */
export const describeActionBlock = (action: TaskAction): ActionBlockShape => {
	const fields = describeActionFields(action);
	const widgets: BlockWidget[] = [];
	const rows: ActionBlockRow[] = [];

	for (const field of fields) {
		const rowWidgets: BlockWidget[] = [];
		if (field.kind === 'sensors') {
			// 数组字段没有原生控件：白名单里每一项一个勾选框，勾上的就是数组内容。
			ALLOWED_SENSORS.forEach((sensor, index) => {
				rowWidgets.push({
					kind: 'sensor',
					fieldName: sensorFieldName(sensor),
					parameter: field.name,
					sensor,
					label: sensor,
					// 新积木默认勾第一个，否则一落地就是非法状态。
					checked: index === 0,
					tooltip: `${field.label}：${field.description}（勾选即进 ${field.name} 数组）`,
				});
			});
		} else {
			rowWidgets.push({
				kind: 'number',
				fieldName: field.name,
				parameter: field.name,
				value: numericDefault(field),
				unit: field.unit,
				unitFieldName: field.unit === undefined ? undefined : unitFieldName(field.name),
				tooltip: tooltipFor(field),
			});
		}
		widgets.push(...rowWidgets);
		rows.push({ parameter: field.name, label: field.label, widgets: rowWidgets });
	}

	return {
		action,
		label: describeActionLabel(action),
		type: actionBlockType(action),
		style: blockStyleName(action),
		summary: ACTION_SPECS[action].summary,
		parameters: fields.map((field) => field.name),
		widgets,
		rows,
	};
};

/** 七块积木，顺序就是协议里 `ALLOWED_ACTIONS` 的顺序。 */
export const ACTION_BLOCK_SHAPES: readonly ActionBlockShape[] = ALLOWED_ACTIONS.map(describeActionBlock);

export const ACTION_BLOCK_SHAPE_BY_ACTION: Readonly<Record<TaskAction, ActionBlockShape>> = Object.fromEntries(
	ACTION_BLOCK_SHAPES.map((shape) => [shape.action, shape]),
) as Readonly<Record<TaskAction, ActionBlockShape>>;

const widgetArgs = (widget: BlockWidget): Record<string, unknown> =>
	widget.kind === 'number'
		? // 刻意不给 min/max：Blockly 的数值字段会**静默夹住**越界输入，
			// 那正是 spec §4.1 禁止的「静默修正」。越界一律由校验器给诊断。
			{ type: 'field_number', name: widget.fieldName, value: widget.value }
		: { type: 'field_checkbox', name: widget.fieldName, checked: widget.checked };

/** 单位标签：只读小字，字号由视图侧的 `.cc-block-unit` 定；不参与序列化，也不进参数。 */
const unitArg = (widget: BlockWidget): Record<string, unknown> | null =>
	widget.kind === 'number' && widget.unit !== undefined && widget.unitFieldName !== undefined
		? { type: 'field_label', name: widget.unitFieldName, text: widget.unit, class: BLOCK_UNIT_CLASS }
		: null;

/**
 * 积木上的单位一览（tooltip 用）：主行只有显示名，单位在这里按协议字段名列一份，
 * 好跟代码面板里的 `linear=...` 对上号。
 */
const unitsHint = (shape: ActionBlockShape): string =>
	shape.rows
		.flatMap((row) =>
			row.widgets.flatMap((widget) =>
				widget.kind === 'number' && widget.unit !== undefined ? [`${widget.parameter} ${widget.unit}`] : [],
			),
		)
		.join('、');

/** 动作名（协议名）排在前面：显示名是给眼睛的，协议名是给对账的。 */
export const blockTooltip = (shape: ActionBlockShape): string => {
	const units = unitsHint(shape);
	const head = `${shape.action}（${shape.label}）：${shape.summary}`;
	return units.length === 0 ? head : `${head}（单位：${units}）`;
};

/** 形状 → Blockly 的积木 JSON（行内参数编号跨行连续，这是 Blockly 的规矩）。 */
export const buildBlockDefinition = (shape: ActionBlockShape): Record<string, unknown> => {
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
		// 第一行左边先写动作的显示名，其余每行左边是这一行的字段标签。
		const head = rowIndex === 0 ? `${shape.label} ` : '';
		definition[`message${rowIndex}`] = `${head}${row.label} ${parts.join(' ')}`.trim();
		definition[`args${rowIndex}`] = args;
		rowIndex += 1;
	}

	// 没有字段的动作（stop / get_status）也得有个 message0，否则 Blockly 建不出块。
	if (shape.rows.length === 0) {
		definition['message0'] = shape.label;
		definition['args0'] = [];
	}

	return definition;
};

let registered = false;

/** 幂等注册：同一个 Blockly 实例上重复注册会覆盖，这里挡一道。 */
export const registerActionBlocks = (blockly: typeof Blockly = Blockly): void => {
	if (registered) return;
	const fresh = ACTION_BLOCK_SHAPES.filter((shape) => blockly.Blocks[shape.type] === undefined);
	if (fresh.length > 0) blockly.defineBlocksWithJsonArray(fresh.map(buildBlockDefinition));
	registered = true;
};

/** 工具箱：一个「任务动作」分类，七块积木（色由主题的 categoryStyle 给，这里不写色值）。 */
export const TOOLBOX_CATEGORY_NAME = '任务动作';

export const buildActionToolbox = (): Blockly.utils.toolbox.ToolboxInfo => ({
	kind: 'categoryToolbox',
	contents: [
		{
			kind: 'category',
			name: TOOLBOX_CATEGORY_NAME,
			categorystyle: 'cc_task_actions',
			contents: ALLOWED_ACTIONS.map((action) => ({ kind: 'block', type: actionBlockType(action) })),
			// Blockly 把可选字段写成 `T | undefined` 的必填项，这里如实填空。
			id: undefined,
			colour: undefined,
			cssconfig: undefined,
			hidden: undefined,
		},
	],
});
