/**
 * 积木形状必须从校验器推导：字段名、顺序、默认值都能在 `describeActionFields` 里找到出处。
 * 这几条断言就是「不是手写七块」的机器口径。
 */
import { describe, expect, it } from 'vitest';
import * as Blockly from 'blockly';
import { ALLOWED_ACTIONS, ALLOWED_SENSORS, describeActionFields, taskStepParameterSchemas } from '@codecanvas/contracts';
import {
	ACTION_BLOCK_SHAPES,
	ACTION_BLOCK_TYPE_PREFIX,
	MAX_WIDGETS_PER_ROW,
	actionBlockType,
	actionOfBlockType,
	buildActionToolbox,
	buildBlockDefinition,
	describeActionBlock,
	registerActionBlocks,
	sensorFieldName,
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

	it('一行最多三个字段，超了就换行', () => {
		for (const shape of ACTION_BLOCK_SHAPES) {
			for (const row of shape.rows) expect(row.length).toBeLessThanOrEqual(MAX_WIDGETS_PER_ROW);
			expect(shape.rows.flat()).toEqual([...shape.widgets]);
		}
		expect(describeActionBlock('stop').rows).toHaveLength(0);
		expect(describeActionBlock('arm6_joints').rows).toHaveLength(3);
	});

	it('tooltip 来自协议描述，积木 JSON 不夹 min/max', () => {
		const move = buildBlockDefinition(describeActionBlock('move'));
		expect(String(move['tooltip'])).toContain('持续 duration 秒');
		const args = move['args0'];
		expect(Array.isArray(args)).toBe(true);
		if (!Array.isArray(args)) throw new Error('args0 应当是数组');
		for (const arg of args) {
			// 静默夹住越界输入是 spec §4.1 禁止的「静默修正」，所以字段上不设边界。
			expect(Object.keys(arg as Record<string, unknown>).sort()).toEqual(['name', 'type', 'value']);
		}
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
