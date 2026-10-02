/**
 * 积木形状必须从校验器推导：字段名、顺序、默认值都能在 `describeActionFields` 里找到出处。
 * 这几条断言就是「不是手写七块」的机器口径。
 */
import { describe, expect, it } from 'vitest';
import * as Blockly from 'blockly';
import { ALLOWED_ACTIONS, ALLOWED_SENSORS, describeActionFields, describeActionLabel, taskStepParameterSchemas } from '@codecanvas/contracts';
import {
	ACTION_BLOCK_SHAPES,
	ACTION_BLOCK_TYPE_PREFIX,
	BLOCK_UNIT_CLASS,
	MAX_FIELDS_PER_ROW,
	actionBlockType,
	actionOfBlockType,
	buildActionToolbox,
	buildBlockDefinition,
	describeActionBlock,
	registerActionBlocks,
	sensorFieldName,
	unitFieldName,
	TOOLBOX_CATEGORY_NAME,
	type ActionBlockShape,
} from '../src/blocks';
import { firstToolboxCategory, toolboxBlockTypes } from './fixtures';

const defaultsFromShape = (shape: ActionBlockShape): Record<string, unknown> => {
	const parameters: Record<string, unknown> = {};
	for (const parameter of shape.parameters) {
		const widgets = shape.widgets.filter((widget) => widget.parameter === parameter);
		const first = widgets[0];
		if (first === undefined) continue;
		parameters[parameter] =
			first.kind === 'number'
				? first.value
				: widgets.flatMap((widget) => (widget.kind === 'sensor' && widget.checked ? [widget.sensor] : []));
	}
	return parameters;
};

describe('七种动作的积木形状', () => {
	it('七个动作一个不落，类型名由动作名推导', () => {
		expect(ACTION_BLOCK_SHAPES.map((shape) => shape.action)).toEqual([...ALLOWED_ACTIONS]);
		for (const action of ALLOWED_ACTIONS) {
			expect(actionBlockType(action)).toBe(`${ACTION_BLOCK_TYPE_PREFIX}${action}`);
			expect(actionOfBlockType(actionBlockType(action))).toBe(action);
		}
		expect(actionOfBlockType('logic_compare')).toBeNull();
		expect(actionOfBlockType(`${ACTION_BLOCK_TYPE_PREFIX}fly`)).toBeNull();
	});

	it('字段名与顺序逐字等于 describeActionFields', () => {
		for (const action of ALLOWED_ACTIONS) {
			const shape = describeActionBlock(action);
			const expected = describeActionFields(action).map((field) => field.name);
			expect(shape.parameters, action).toEqual(expected);
			// 形状里的参数名只能是协议给的字段，不能多也不能少。
			expect([...new Set(shape.widgets.map((widget) => widget.parameter))], action).toEqual(expected);
		}
	});

	it('数组字段按白名单展开成逐项勾选框', () => {
		const shape = describeActionBlock('stop_if_obstacle');
		const sensors = shape.widgets.filter((widget) => widget.parameter === 'sensors');
		expect(sensors.map((widget) => (widget.kind === 'sensor' ? widget.sensor : null))).toEqual([...ALLOWED_SENSORS]);
		expect(sensors.map((widget) => widget.fieldName)).toEqual(ALLOWED_SENSORS.map(sensorFieldName));
	});

	it('缺省值没有协议之外的数字，且都过得了参数 schema', () => {
		for (const action of ALLOWED_ACTIONS) {
			const shape = describeActionBlock(action);
			const parsed = taskStepParameterSchemas[action].safeParse(defaultsFromShape(shape));
			expect(parsed.success, `${action}: ${parsed.success ? '' : JSON.stringify(parsed.error.issues)}`).toBe(true);
		}
	});

	it('数值默认值只从 default/min/开区间下界推出来', () => {
		const move = describeActionBlock('move');
		const byName = (name: string): number => {
			const widget = move.widgets.find((candidate) => candidate.parameter === name);
			if (widget === undefined || widget.kind !== 'number') throw new Error(`没有字段 ${name}`);
			return widget.value;
		};
		// linear/angular 没有上下界也没有默认值 → 0；duration 是 `> 0` → 1。
		expect(byName('linear')).toBe(0);
		expect(byName('angular')).toBe(0);
		expect(byName('duration')).toBe(1);

		const arm = describeActionBlock('arm_joint');
		const jointId = arm.widgets.find((widget) => widget.parameter === 'joint_id');
		const time = arm.widgets.find((widget) => widget.parameter === 'time');
		expect(jointId?.kind === 'number' ? jointId.value : null).toBe(1); // min = 1
		expect(time?.kind === 'number' ? time.value : null).toBe(1500); // 协议给的 defaultValue
	});

	it('一行一个字段：每行只装同一个协议参数的控件，标签就是协议给的显示名', () => {
		for (const shape of ACTION_BLOCK_SHAPES) {
			const fields = describeActionFields(shape.action);
			// 行数 = 协议字段数（stop / get_status 没有字段，就是零行）。
			expect(shape.rows.length, shape.action).toBe(shape.parameters.length);
			// 行的顺序就是协议顺序，控件一个不少、一个不多。
			expect(shape.rows.map((row) => row.parameter), shape.action).toEqual([...shape.parameters]);
			expect(shape.rows.map((row) => row.widgets).flat(), shape.action).toEqual([...shape.widgets]);
			// 行标签逐字等于协议字段的显示名——不给动作/字段另编一套中文。
			expect(shape.rows.map((row) => row.label), shape.action).toEqual(fields.map((field) => field.label));
			for (const row of shape.rows) {
				// 一行里的控件必须属于同一个字段——「标签在左、输入框在右」就靠这条。
				const parameters = new Set(row.widgets.map((widget) => widget.parameter));
				expect([...parameters], shape.action).toEqual([row.parameter]);
				expect(parameters.size, shape.action).toBeLessThanOrEqual(MAX_FIELDS_PER_ROW);
			}
		}
		expect(describeActionBlock('stop').rows).toHaveLength(0);
		// arm6_joints 七个字段 → 七行（原先是三行三列挤在一横排上）。
		expect(describeActionBlock('arm6_joints').rows).toHaveLength(7);
		// 传感器数组是一个字段：两个勾选框仍在同一行，它们本来就只有几个字宽。
		expect(describeActionBlock('stop_if_obstacle').rows[0]?.widgets).toHaveLength(ALLOWED_SENSORS.length);
		// 动作显示名同样来自协议。
		expect(describeActionBlock('move').label).toBe(describeActionLabel('move'));
	});

	it('字段标签只写显示名，单位另给小字号标签且 tooltip 里留一份', () => {
		const move = describeActionBlock('move');
		const angular = move.widgets.find((widget) => widget.parameter === 'angular');
		if (angular === undefined || angular.kind !== 'number') throw new Error('move 应当有 angular 数值字段');
		// 主标签不再拼单位：`角速度`，不是 `angular (rad/s)`。
		const angularRow = move.rows.find((row) => row.parameter === 'angular');
		expect(angularRow?.label).toBe('角速度');
		expect(angular.unit).toBe('rad/s');
		// 协议字段名与单位都留在 tooltip 里，信息不丢。
		expect(angular.tooltip).toContain('angular（角速度）');
		expect(angular.tooltip).toContain('单位 rad/s');

		const definition = buildBlockDefinition(move);
		expect(definition['message0']).toBe('前进 线速度 %1 %2');
		const args = definition['args0'];
		if (!Array.isArray(args)) throw new Error('args0 应当是数组');
		// 单位是紧跟数值字段的只读标签，走小字号 class。
		expect(args[1]).toEqual({
			type: 'field_label',
			name: unitFieldName('linear'),
			text: 'm/s',
			class: BLOCK_UNIT_CLASS,
		});
		// 单位信息不丢：积木 tooltip 里按协议字段名列了一遍（好跟代码面板对上号）。
		expect(String(definition['tooltip'])).toContain('move（前进）');
		expect(String(definition['tooltip'])).toContain('单位：linear m/s、angular rad/s、duration s');
		// 没有单位的字段不会凭空长出单位标签（arm_joint 的 joint_id 就没有单位）。
		const arm = buildBlockDefinition(describeActionBlock('arm_joint'));
		const jointIdArgs = arm['args0'];
		if (!Array.isArray(jointIdArgs)) throw new Error('args0 应当是数组');
		expect(jointIdArgs.map((arg) => (arg as Record<string, unknown>)['type'])).toEqual(['field_number']);
	});

	it('传感器那一行：标签在左，勾选框带着自己的路径文字在右', () => {
		const guard = buildBlockDefinition(describeActionBlock('stop_if_obstacle'));
		expect(guard['message0']).toBe(`避障停止 传感器 %1 ${ALLOWED_SENSORS[0]} %2 ${ALLOWED_SENSORS[1]}`);
		expect(guard['message1']).toBe('距离 %1 %2');
	});

	it('任何一行的任何字段都不带 min/max', () => {
		for (const shape of ACTION_BLOCK_SHAPES) {
			const definition = buildBlockDefinition(shape);
			for (const [key, value] of Object.entries(definition)) {
				if (!key.startsWith('args')) continue;
				if (!Array.isArray(value)) throw new Error(`${shape.action}.${key} 应当是数组`);
				for (const arg of value as Record<string, unknown>[]) {
					// Blockly 的数值字段会**静默夹住**越界输入，那是 spec §4.1 禁止的「静默修正」。
					expect(Object.keys(arg), `${shape.action}.${key}`).not.toContain('min');
					expect(Object.keys(arg), `${shape.action}.${key}`).not.toContain('max');
					if (arg['type'] === 'field_number') {
						expect(Object.keys(arg).sort()).toEqual(['name', 'type', 'value']);
					}
				}
			}
		}
	});

	it('tooltip 来自协议描述，积木 JSON 不夹 min/max', () => {
		const move = buildBlockDefinition(describeActionBlock('move'));
		expect(String(move['tooltip'])).toContain('持续 duration 秒');
		// 行必须真的是行：inputsInline 会把 message1… 并回同一行，一行一个字段就白排了。
		expect(move['inputsInline']).toBe(false);
		const args = move['args0'];
		expect(Array.isArray(args)).toBe(true);
		if (!Array.isArray(args)) throw new Error('args0 应当是数组');
		const numberArgs = (args as Record<string, unknown>[]).filter((arg) => arg['type'] === 'field_number');
		expect(numberArgs).toHaveLength(1);
		for (const arg of numberArgs) {
			// 静默夹住越界输入是 spec §4.1 禁止的「静默修正」，所以字段上不设边界。
			expect(Object.keys(arg).sort()).toEqual(['name', 'type', 'value']);
		}
		// 单位标签是只读文字：没有 value，更不会有边界。
		const labelArgs = (args as Record<string, unknown>[]).filter((arg) => arg['type'] === 'field_label');
		expect(labelArgs).toHaveLength(1);
		for (const arg of labelArgs) expect(Object.keys(arg).sort()).toEqual(['class', 'name', 'text', 'type']);
		expect(move['style']).toBe('cc_move');
		expect(move['previousStatement']).toBeNull();
		expect(move['nextStatement']).toBeNull();
	});

	it('注册后能建块，字段默认值与推导一致', () => {
		registerActionBlocks();
		const workspace = new Blockly.Workspace();
		try {
			for (const shape of ACTION_BLOCK_SHAPES) {
				const block = workspace.newBlock(shape.type);
				for (const widget of shape.widgets) {
					const value: unknown = block.getFieldValue(widget.fieldName);
					if (widget.kind === 'number') expect(value, `${shape.action}.${widget.fieldName}`).toBe(widget.value);
					else expect(value, `${shape.action}.${widget.fieldName}`).toBe(widget.checked ? 'TRUE' : 'FALSE');
				}
				block.dispose(false);
			}
		} finally {
			workspace.dispose();
		}
	});
});

describe('工具箱', () => {
	it('一个分类、七块积木，顺序按协议', () => {
		const toolbox = buildActionToolbox();
		expect(toolbox.contents).toHaveLength(1);
		const category = firstToolboxCategory(toolbox);
		expect(category?.name).toBe(TOOLBOX_CATEGORY_NAME);
		expect(category?.categorystyle).toBe('cc_task_actions');
		expect(toolboxBlockTypes(toolbox)).toEqual(ALLOWED_ACTIONS.map(actionBlockType));
		// 分类颜色由主题给（categorystyle），这里不出现色值。
		expect(category?.colour).toBeUndefined();
	});
});
