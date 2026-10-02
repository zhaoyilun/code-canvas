/**
 * 实现积木的形状必须从**能力目录**推导，不许手写：字段名、顺序、可写/只读、默认值
 * 都能在 `catalog.primitives[].parameters` 与这一步的 `arguments` 里找到出处。
 * 这几条断言就是「不是手写一张字段表」的机器口径。
 */
import { describe, expect, it } from 'vitest';
import * as Blockly from 'blockly';
import {
	ALLOWED_SENSORS,
	describeActionFields,
	findCapability,
	findPrimitive,
	type CapabilityCatalog,
	type CapabilitySpec,
	type PrimitiveSpec,
} from '@codecanvas/contracts';
import {
	BLOCK_UNIT_CLASS,
	IMPLEMENTATION_BLOCK_TYPE_PREFIX,
	IMPLEMENTATION_TYPE_SEPARATOR,
	MAX_FIELDS_PER_ROW,
	blockStyleName,
	blockTooltip,
	buildBlockDefinition,
	capabilityParameterOf,
	describeCapabilityImplementation,
	describeCatalogImplementations,
	describeImplementationStep,
	implementationBlockType,
	isImplementationBlockType,
	literalFieldName,
	literalText,
	registerImplementationBlocks,
	sensorFieldName,
	unitFieldName,
	type ImplementationBlockShape,
	type ImplementationWidget,
} from '../src/blocks';
import { BROKEN_CATALOG, FIXTURE_CATALOG } from './fixtures';

const capabilityOf = (catalog: CapabilityCatalog, ref: string): CapabilitySpec => {
	const found = findCapability(catalog, ref);
	if (found === undefined) throw new Error(`目录里应当有 ${ref}`);
	return found;
};

const primitiveOf = (catalog: CapabilityCatalog, ref: string): PrimitiveSpec => {
	const found = findPrimitive(catalog, ref);
	if (found === undefined) throw new Error(`目录里应当有原语 ${ref}`);
	return found;
};

/** 某个能力实现里的第 index 步的形状（与渲染器同一条推导路径）。 */
const shapeOf = (capabilityRef: string, index: number, catalog: CapabilityCatalog = FIXTURE_CATALOG): ImplementationBlockShape => {
	const capability = capabilityOf(catalog, capabilityRef);
	const step = capability.implementation[index];
	if (step === undefined) throw new Error(`${capabilityRef} 的实现里没有第 ${String(index + 1)} 步`);
	const shape = describeImplementationStep(catalog, capability, step, index);
	if (shape === null) throw new Error(`${capabilityRef} 第 ${String(index + 1)} 步的原语不在目录里`);
	return shape;
};

/** 值从节点参数来的字段（可写）；写回只认这些。 */
const writable = (shape: ImplementationBlockShape): readonly ImplementationWidget[] =>
	shape.widgets.filter((widget) => widget.binding.kind === 'parameter');

describe('实现积木的形状（从能力目录推导）', () => {
	it('目录里每个能力的每一步都长出一块积木，类型名由（能力, 原语）推导', () => {
		const expectedCount = FIXTURE_CATALOG.capabilities.reduce(
			(total, capability) => total + capability.implementation.length,
			0,
		);
		expect(describeCatalogImplementations(FIXTURE_CATALOG)).toHaveLength(expectedCount);

		for (const capability of FIXTURE_CATALOG.capabilities) {
			capability.implementation.forEach((step, index) => {
				const shape = shapeOf(capability.capabilityRef, index);
				expect(shape.primitiveRef).toBe(step.step);
				expect(shape.stepIndex).toBe(index);
				expect(shape.type).toBe(
					implementationBlockType(FIXTURE_CATALOG.catalogRef, capability.capabilityRef, step.step, index),
				);
				expect(shape.style).toBe(blockStyleName(capability.capabilityRef));
				expect(shape.type.startsWith(IMPLEMENTATION_BLOCK_TYPE_PREFIX)).toBe(true);
				expect(shape.type).toContain(IMPLEMENTATION_TYPE_SEPARATOR);
				expect(isImplementationBlockType(shape.type)).toBe(true);
				// 原语名与显示名都来自目录，不是这里编的。
				expect(shape.primitiveLabel).toBe(primitiveOf(FIXTURE_CATALOG, step.step).label);
				expect(shape.capabilityLabel).toBe(capability.label);
			});
		}
		expect(isImplementationBlockType('logic_compare')).toBe(false);
		// 不同能力下的同一个原语是两块不同的积木（颜色跟着模块走）；
		// 不同目录下的同名能力/原语也是（形状可能完全不同）；
		// 同一条实现里的第 1、2 步也是——两步的实参绑定可能不一样，字段就长得不一样。
		expect(implementationBlockType('c1', 'move', 'set_velocity', 0)).not.toBe(
			implementationBlockType('c1', 'turn', 'set_velocity', 0),
		);
		expect(implementationBlockType('c1', 'move', 'set_velocity', 0)).not.toBe(
			implementationBlockType('c2', 'move', 'set_velocity', 0),
		);
		expect(implementationBlockType('c1', 'move', 'wait', 0)).not.toBe(
			implementationBlockType('c1', 'move', 'wait', 1),
		);
	});

	it('字段名与顺序逐字等于目录里原语的参数表', () => {
		for (const capability of FIXTURE_CATALOG.capabilities) {
			capability.implementation.forEach((step, index) => {
				const primitive = primitiveOf(FIXTURE_CATALOG, step.step);
				const expected = primitive.parameters.map((parameter) => parameter.name);
				const shape = describeImplementationStep(FIXTURE_CATALOG, capability, step, index);
				if (shape === null) throw new Error(`${capability.capabilityRef} 第 ${String(index + 1)} 步画不出来`);
				expect(shape.parameters, `${capability.capabilityRef}#${String(index)}`).toEqual(expected);
				// 形状里的参数名只能是目录给的，不能多也不能少。
				expect([...new Set(shape.widgets.map((widget) => widget.parameter))], capability.capabilityRef).toEqual(
					expected,
				);
			});
		}
		// 没有参数的原语（停止运动）不长字段。
		expect(shapeOf('stop', 0).parameters).toEqual([]);
	});

	it('sensor 类型参数按白名单展开成逐项勾选框', () => {
		const shape = shapeOf('stop_if_obstacle', 0); // read_scan（传感器 ← $sensors）
		const sensors = shape.widgets.filter((widget) => widget.parameter === 'sensor');
		expect(sensors.map((widget) => (widget.kind === 'sensor' ? widget.sensor : null))).toEqual([...ALLOWED_SENSORS]);
		expect(sensors.map((widget) => widget.fieldName)).toEqual(ALLOWED_SENSORS.map(sensorFieldName));
		// 两个勾选框绑的是同一个能力参数：勾上的集合就是 `sensors` 数组。
		const bound = sensors.map((widget) => (widget.binding.kind === 'parameter' ? widget.binding.parameter : null));
		expect(new Set(bound)).toEqual(new Set(['sensors']));
	});

	it('可写/只读由实参决定：$name 可写，字面量只读', () => {
		// turn 的第一步：linear 在目录里写死 0（原语要它，能力没有这个参数）。
		const turn = shapeOf('turn', 0);
		const linear = turn.widgets.find((widget) => widget.parameter === 'linear');
		if (linear === undefined) throw new Error('set_velocity 应当有 linear 字段');
		expect(linear.kind).toBe('literal');
		expect(linear.binding).toEqual({ kind: 'literal', value: 0 });
		expect(linear.kind === 'literal' ? linear.text : null).toBe(literalText(0));
		expect(linear.kind === 'literal' ? linear.text : null).toBe('0');

		const angular = turn.widgets.find((widget) => widget.parameter === 'angular');
		expect(angular?.kind).toBe('number');
		expect(angular?.binding).toEqual({ kind: 'parameter', parameter: 'angular' });
		expect(capabilityParameterOf('$angular')).toBe('angular');
		expect(capabilityParameterOf(0)).toBeNull();
		expect(capabilityParameterOf('$')).toBeNull();

		// 只读字段的名字与可写字段分得开：写回时按名字就能一眼认出谁不该写。
		expect(linear.fieldName).toBe(literalFieldName('linear'));
		expect(writable(turn).map((widget) => widget.parameter)).toEqual(['angular']);
		expect(writable(shapeOf('move', 0)).map((widget) => widget.parameter)).toEqual(['linear', 'angular']);
	});

	it('可写字段的缺省值只从协议描述推出来（没有协议之外的数字）', () => {
		const numberDefault = (shape: ImplementationBlockShape, parameter: string): number => {
			const widget = shape.widgets.find((candidate) => candidate.parameter === parameter);
			if (widget === undefined || widget.kind !== 'number') throw new Error(`没有数值字段 ${parameter}`);
			return widget.value;
		};

		// move 的 linear/angular 没有上下界也没有默认值 → 0；wait ← $duration 是 `> 0` → 1。
		expect(numberDefault(shapeOf('move', 0), 'linear')).toBe(0);
		expect(numberDefault(shapeOf('move', 0), 'angular')).toBe(0);
		expect(numberDefault(shapeOf('move', 1), 'seconds')).toBe(1);
		// arm_joint 的 time 有协议给的 defaultValue → 1500；joint_id 有下界 1。
		expect(numberDefault(shapeOf('arm_joint', 0), 'time')).toBe(1500);
		expect(numberDefault(shapeOf('arm_joint', 0), 'joint_id')).toBe(1);

		// 这几个默认值都能在协议描述里找到出处（协议改了它们就跟着变）。
		expect(describeActionFields('move').find((field) => field.name === 'duration')?.exclusiveMin).toBe(0);
		expect(describeActionFields('arm_joint').find((field) => field.name === 'time')?.defaultValue).toBe(1500);
	});

	it('一行一个参数：每行只装同一个参数的控件，标签就是参数标签', () => {
		for (const shape of describeCatalogImplementations(FIXTURE_CATALOG)) {
			const primitive = primitiveOf(FIXTURE_CATALOG, shape.primitiveRef);
			// 行数 = 原语参数数（停止运动没有参数，就是零行）。
			expect(shape.rows.length, shape.type).toBe(shape.parameters.length);
			expect(shape.rows.map((row) => row.parameter), shape.type).toEqual([...shape.parameters]);
			expect(shape.rows.map((row) => row.widgets).flat(), shape.type).toEqual([...shape.widgets]);
			expect(shape.rows.map((row) => row.label), shape.type).toEqual(
				primitive.parameters.map((parameter) => parameter.label),
			);
			for (const row of shape.rows) {
				// 一行里的控件必须属于同一个参数——「标签在左、输入框在右」就靠这条。
				const parameters = new Set(row.widgets.map((widget) => widget.parameter));
				expect([...parameters], shape.type).toEqual([row.parameter]);
				expect(parameters.size, shape.type).toBeLessThanOrEqual(MAX_FIELDS_PER_ROW);
			}
		}
		// 传感器两条勾选框仍在同一行：它们本来就只有几个字宽。
		expect(shapeOf('stop_if_obstacle', 0).rows[0]?.widgets).toHaveLength(ALLOWED_SENSORS.length);
		// drive_joints 七个参数 → 七行（不挤在一横排上）。
		expect(shapeOf('arm6_joints', 0).rows).toHaveLength(7);
		expect(shapeOf('stop', 0).rows).toHaveLength(0);
	});

	it('字段标签只写显示名，单位另给小字号标签且 tooltip 里留一份', () => {
		const move = shapeOf('move', 0);
		const linear = move.widgets.find((widget) => widget.parameter === 'linear');
		if (linear === undefined || linear.kind !== 'number') throw new Error('move 应当有 linear 数值字段');
		// 主标签不再拼单位：`线速度`，不是 `linear (m/s)`。
		expect(move.rows.find((row) => row.parameter === 'linear')?.label).toBe('线速度');
		expect(linear.unit).toBe('m/s');
		expect(linear.unitFieldName).toBe(unitFieldName('linear'));
		// 原语参数名、它绑到哪个能力参数、单位与范围都留在 tooltip 里。
		expect(linear.tooltip).toContain('linear ← $linear（线速度）');
		expect(linear.tooltip).toContain('单位 m/s');

		const definition = buildBlockDefinition(move);
		expect(definition['message0']).toBe('下发速度 线速度 %1 %2');
		const args = definition['args0'];
		if (!Array.isArray(args)) throw new Error('args0 应当是数组');
		// 单位是紧跟数值字段的只读标签，走小字号 class。
		expect(args[1]).toEqual({
			type: 'field_label',
			name: unitFieldName('linear'),
			text: 'm/s',
			class: BLOCK_UNIT_CLASS,
		});
		// 单位信息不丢：积木 tooltip 里按参数名列了一遍（好跟节点参数对上号）。
		expect(String(definition['tooltip'])).toContain('前进 的实现第 1 步');
		expect(String(definition['tooltip'])).toContain('set_velocity');
		expect(String(definition['tooltip'])).toContain('单位：linear m/s、angular rad/s');
		// 没有单位的字段不会凭空长出单位标签（drive_joint 的 joint_id 就没有单位）。
		const arm = buildBlockDefinition(shapeOf('arm_joint', 0));
		const jointIdArgs = arm['args0'];
		if (!Array.isArray(jointIdArgs)) throw new Error('args0 应当是数组');
		expect(jointIdArgs.map((arg) => (arg as Record<string, unknown>)['type'])).toEqual(['field_number']);
	});

	it('传感器那一行与控制台文字：勾选框带着自己的路径文字在右，只读字面量也是一行', () => {
		const guard = buildBlockDefinition(shapeOf('stop_if_obstacle', 0));
		expect(guard['message0']).toBe(`读取激光 传感器 %1 ${ALLOWED_SENSORS[0]} %2 ${ALLOWED_SENSORS[1]}`);
		// 只读字段（目录写死的字面量）也占自己那一行，值就是目录里的原样。
		const turn = buildBlockDefinition(shapeOf('turn', 0));
		expect(turn['message0']).toBe('下发速度 线速度 %1');
		expect(turn['args0']).toEqual([{ type: 'field_label', name: literalFieldName('linear'), text: '0' }]);
	});

	it('任何一行的任何字段都不带 min/max', () => {
		for (const shape of describeCatalogImplementations(FIXTURE_CATALOG)) {
			const definition = buildBlockDefinition(shape);
			for (const [key, value] of Object.entries(definition)) {
				if (!key.startsWith('args')) continue;
				if (!Array.isArray(value)) throw new Error(`${shape.type}.${key} 应当是数组`);
				for (const arg of value as Record<string, unknown>[]) {
					// Blockly 的数值字段会**静默夹住**越界输入，那是 spec §4.1 禁止的「静默修正」。
					expect(Object.keys(arg), `${shape.type}.${key}`).not.toContain('min');
					expect(Object.keys(arg), `${shape.type}.${key}`).not.toContain('max');
					if (arg['type'] === 'field_number') {
						expect(Object.keys(arg).sort()).toEqual(['name', 'type', 'value']);
					}
				}
			}
		}
	});

	it('tooltip 说明这是哪个模块的第几步，积木 JSON 行必须真的是行', () => {
		const move = buildBlockDefinition(shapeOf('move', 0));
		// 新模型下积木不表示「任务第几步」，而是「这个模块内部第几步」——tooltip 说清楚。
		expect(blockTooltip(shapeOf('move', 1))).toContain('前进 的实现第 2 步');
		expect(blockTooltip(shapeOf('move', 1))).toContain('等待');
		// 行必须真的是行：inputsInline 会把 message1… 并回同一行，一行一个字段就白排了。
		expect(move['inputsInline']).toBe(false);
		expect(move['previousStatement']).toBeNull();
		expect(move['nextStatement']).toBeNull();
		expect(move['style']).toBe(blockStyleName('move'));
	});

	it('注册后能建块，字段默认值与推导一致；重复注册不重复定义', () => {
		const registered = registerImplementationBlocks(FIXTURE_CATALOG);
		expect(registered).toEqual(describeCatalogImplementations(FIXTURE_CATALOG).map((shape) => shape.type));
		// 幂等：已经注册过的类型不再回锅（同一个 Blockly 实例上重复注册会覆盖）。
		expect(registerImplementationBlocks(FIXTURE_CATALOG)).toEqual([]);

		const workspace = new Blockly.Workspace();
		try {
			for (const shape of describeCatalogImplementations(FIXTURE_CATALOG)) {
				const block = workspace.newBlock(shape.type);
				for (const widget of shape.widgets) {
					const value: unknown = block.getFieldValue(widget.fieldName);
					if (widget.kind === 'number') expect(value, `${shape.type}.${widget.fieldName}`).toBe(widget.value);
					else if (widget.kind === 'literal')
						expect(String(value), `${shape.type}.${widget.fieldName}`).toBe(widget.text);
					else expect(value, `${shape.type}.${widget.fieldName}`).toBe(widget.checked ? 'TRUE' : 'FALSE');
				}
				block.dispose(false);
			}
		} finally {
			workspace.dispose();
		}
	});
});

describe('目录有缺陷时', () => {
	it('悬空 $name 只读显示原样，漏给实参标成 unbound，缺原语的那一步不出形状', () => {
		const capability = capabilityOf(BROKEN_CATALOG, 'move');
		const shapes = describeCapabilityImplementation(BROKEN_CATALOG, capability);

		// 四条实现里，最后一条引用的原语不存在 → 只出三块形状。
		expect(capability.implementation).toHaveLength(4);
		expect(shapes.map((shape) => shape.primitiveRef)).toEqual(['wait', 'wait', 'wait']);

		const dangling = shapes[1];
		const unbound = shapes[2];
		expect(dangling?.widgets[0]?.binding).toEqual({ kind: 'literal', value: '$missing' });
		expect(dangling?.widgets[0]?.kind === 'literal' ? dangling.widgets[0].text : null).toBe('$missing');
		expect(dangling?.widgets[0]?.tooltip).toContain('$missing');

		expect(unbound?.widgets[0]?.binding).toEqual({ kind: 'unbound' });
		expect(unbound?.widgets[0]?.kind === 'literal' ? unbound.widgets[0].text : null).toBe('—');
		expect(unbound?.widgets[0]?.tooltip).toContain('目录没给这一步的实参');

		// 正常那一步仍然是可写的，序号各自独立（徽标数的是实现里的第几步）。
		expect(shapes[0]?.widgets[0]?.binding).toEqual({ kind: 'parameter', parameter: 'duration' });
		expect(shapes.map((shape) => shape.stepIndex)).toEqual([0, 1, 2]);
		expect(dangling === undefined ? '' : blockTooltip(dangling)).toContain('第 2 步');
	});

	it('形状里不出现目录没写过的参数', () => {
		// compare_below 只声明了 threshold：能力那边多给了参数也不会长到积木上。
		expect(Object.keys(capabilityOf(FIXTURE_CATALOG, 'stop_if_obstacle').implementation[1]?.arguments ?? {})).toEqual([
			'threshold',
		]);
		expect(shapeOf('stop_if_obstacle', 1).parameters).toEqual(['threshold']);
	});
});
