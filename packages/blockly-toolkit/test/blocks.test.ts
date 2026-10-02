/**
 * 实现积木的形状必须从**能力目录**推导，不许手写：字段名、顺序、可写/只读、默认值，
 * 以及**树的形状本身**（哪里是赋值、哪里是条件、条件里嵌着什么），都能在
 * `catalog.primitives[].parameters` 与 `capability.implementation` 里找到出处。
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
	CONDITION_INPUT_NAME,
	ELSE_INPUT_NAME,
	IMPLEMENTATION_BLOCK_TYPE_PREFIX,
	IMPLEMENTATION_TYPE_SEPARATOR,
	LEFT_INPUT_NAME,
	MAX_FIELDS_PER_ROW,
	RIGHT_INPUT_NAME,
	THEN_INPUT_NAME,
	VALUE_INPUT_NAME,
	blockStyleName,
	buildBlockDefinition,
	describeCapabilityImplementation,
	describeCatalogImplementations,
	describeImplementation,
	describeNodeAtPath,
	flattenShape,
	implementationBlockType,
	isImplementationBlockType,
	isUnknownShape,
	literalFieldName,
	LITERAL_FIELD_LIMIT,
	literalText,
	truncateLiteralText,
	registerImplementationBlocks,
	resolveImplementationPath,
	sensorFieldName,
	topLevelStepIndexOf,
	unitFieldName,
	type ImplementationBlockShape,
	type ImplementationWidget,
} from '../src/blocks';
import { ROBOFRAME_SO101_CATALOG } from '@codecanvas/capabilities';
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

/** 某个能力实现树里某个下标路径上的形状（与渲染器同一条推导路径）。 */
const shapeAt = (
	capabilityRef: string,
	path: string,
	catalog: CapabilityCatalog = FIXTURE_CATALOG,
): ImplementationBlockShape => {
	const shape = describeNodeAtPath(catalog, capabilityOf(catalog, capabilityRef), path);
	if (shape === null) throw new Error(`${capabilityRef} 的 ${path} 上应当有一个节点`);
	return shape;
};

/** 值从节点参数来的字段（可写）；写回只认这些。 */
const writable = (shape: ImplementationBlockShape): readonly ImplementationWidget[] =>
	shape.widgets.filter((widget) => widget.binding.kind === 'parameter');

describe('实现积木的形状（从能力目录推导）', () => {
	it('实现树里每个节点都长出一块积木，类型名由（能力, 标签, 路径）推导', () => {
		const nodeCount = FIXTURE_CATALOG.capabilities.reduce(
			(total, capability) =>
				total +
				describeImplementation(FIXTURE_CATALOG, capability).reduce((sum, shape) => sum + flattenShape(shape).length, 0),
			0,
		);
		expect(describeCatalogImplementations(FIXTURE_CATALOG)).toHaveLength(nodeCount);

		for (const capability of FIXTURE_CATALOG.capabilities) {
			const statements = describeImplementation(FIXTURE_CATALOG, capability);
			expect(statements.length, capability.capabilityRef).toBe(capability.implementation.length);
			statements.forEach((shape, index) => {
				// 顶层语句就是「实现里的第几步」：路径只有一段，序号就是它。
				expect(shape.stepPath).toBe(String(index));
				expect(shape.topLevel).toBe(true);
				expect(shape.stepIndex).toBe(index);
				for (const node of flattenShape(shape)) {
					expect(node.type.startsWith(IMPLEMENTATION_BLOCK_TYPE_PREFIX), node.type).toBe(true);
					expect(node.type).toContain(IMPLEMENTATION_TYPE_SEPARATOR);
					expect(isImplementationBlockType(node.type)).toBe(true);
					expect(node.type).toBe(
						implementationBlockType(FIXTURE_CATALOG.catalogRef, capability.capabilityRef, node.tag, node.stepPath),
					);
					expect(node.style).toBe(blockStyleName(capability.capabilityRef));
					expect(node.capabilityLabel).toBe(capability.label);
					// 每个节点的路径都能反查回目录里的那个节点——路径不是画布自己编的坐标。
					expect(resolveImplementationPath(capability, node.stepPath), node.stepPath).not.toBeNull();
				}
			});
		}

		expect(isImplementationBlockType('logic_compare')).toBe(false);
		// 同一个原语在树里两处出现，就是两块不同的积木（路径进了类型名）。
		expect(implementationBlockType('c1', 'move', 'wait', '0')).not.toBe(
			implementationBlockType('c1', 'move', 'wait', '1'),
		);
		// 不同能力、不同目录下的同名原语也是。
		expect(implementationBlockType('c1', 'move', 'set_velocity', '0')).not.toBe(
			implementationBlockType('c1', 'turn', 'set_velocity', '0'),
		);
		expect(implementationBlockType('c1', 'move', 'wait', '0')).not.toBe(
			implementationBlockType('c2', 'move', 'wait', '0'),
		);
		// 同一个位置上的不同节点种类也分得开：语句调用 / 值调用 / 引用 / 数字各是一个类型。
		expect(implementationBlockType('c1', 'cap', 'call_stmt', '0')).not.toBe(
			implementationBlockType('c1', 'cap', 'call_value', '0'),
		);
		expect(implementationBlockType('c1', 'cap', 'ref_num', '1.condition.right')).not.toBe(
			implementationBlockType('c1', 'cap', 'ref_read', '1.condition.right'),
		);
	});

	it('调用块的字段名与顺序逐字等于目录里原语的参数表', () => {
		for (const capability of FIXTURE_CATALOG.capabilities) {
			for (const statement of describeImplementation(FIXTURE_CATALOG, capability)) {
				for (const shape of flattenShape(statement)) {
					if (shape.primitiveRef === null || shape.rows.length === 0) continue;
					const primitive = primitiveOf(FIXTURE_CATALOG, shape.primitiveRef);
					const expected = primitive.parameters.map((parameter) => parameter.name);
					expect(shape.parameters, `${capability.capabilityRef}@${shape.stepPath}`).toEqual(expected);
					expect(shape.rows.map((row) => row.parameter), shape.type).toEqual(expected);
					// 形状里的字段名只能是目录给的，不能多也不能少。
					expect(
						shape.widgets.every((widget) => expected.includes(widget.parameter)),
						`${shape.type}: ${shape.widgets.map((widget) => widget.parameter).join(',')}`,
					).toBe(true);
					expect([...new Set(shape.rows.map((row) => row.parameter))], shape.type).toEqual(expected);
				}
			}
		}
		// 没有参数的原语（停止运动 / 紧急刹停）不长字段。
		expect(shapeAt('stop', '0').parameters).toEqual([]);
		expect(shapeAt('stop', '0').rows).toEqual([]);
	});

	it('避障停止长成一棵语句树：设 → 如果，条件里是比较，两侧是引用与数字，if 里嵌着刹停', () => {
		// 这就是要生成的形状，逐节点钉住：
		//   设 [reading] 为 ( 读取激光(["/scan0"]) )
		//   如果 ( [reading] < [0.5] ) 那么 { 紧急刹停 }
		const set = shapeAt('stop_if_obstacle', '0');
		expect(set.role).toBe('set');
		expect(set.atom).toBe('reading');
		expect(set.topLevel).toBe(true);
		expect(set.valueInputs.map((input) => input.name)).toEqual([VALUE_INPUT_NAME]);

		const scan = set.valueInputs[0]?.child;
		if (scan === undefined) throw new Error('赋值的值输入里应当有读取激光');
		expect(scan.role).toBe('call-value');
		expect(scan.stepPath).toBe('0.value');
		expect(scan.primitiveRef).toBe('read_scan');
		expect(scan.topLevel).toBe(false);
		expect(scan.stepIndex).toBe(0);
		// 传感器参数白名单展开成勾选框，绑的是同一个能力参数。
		const sensors = scan.widgets.filter((widget) => widget.kind === 'sensor');
		expect(sensors.map((widget) => (widget.kind === 'sensor' ? widget.sensor : null))).toEqual([...ALLOWED_SENSORS]);
		expect(sensors.map((widget) => (widget.kind === 'sensor' ? widget.fieldName : null))).toEqual(
			ALLOWED_SENSORS.map(sensorFieldName),
		);

		const guard = shapeAt('stop_if_obstacle', '1');
		expect(guard.role).toBe('if');
		expect(guard.topLevel).toBe(true);
		expect(guard.statementInputs.map((input) => input.name)).toEqual([THEN_INPUT_NAME]);

		const condition = guard.valueInputs[0]?.child;
		if (condition === undefined) throw new Error('条件输入里应当有比较块');
		expect(condition.role).toBe('binary');
		expect(condition.tag).toBe('bin_lt');
		expect(condition.valueInputs.map((input) => input.name)).toEqual([LEFT_INPUT_NAME, RIGHT_INPUT_NAME]);

		const left = condition.valueInputs[0]?.child;
		const right = condition.valueInputs[1]?.child;
		// 左边是局部变量 reading：只读引用块（它的值是算出来的，不是节点参数）。
		expect(left?.role).toBe('param-read');
		expect(left?.widgets[0]?.binding).toEqual({ kind: 'local', name: 'reading' });
		expect(left?.stepPath).toBe('1.condition.left');
		// 右边是能力参数 distance：可写的数字块，值来自节点的 parameters。
		expect(right?.role).toBe('param-number');
		expect(right?.widgets[0]?.binding).toEqual({ kind: 'parameter', parameter: 'distance' });
		expect(right?.rows[0]?.label).toBe('距离');
		expect(right?.stepPath).toBe('1.condition.right');

		const then = guard.statementInputs[0]?.blocks ?? [];
		expect(then.map((shape) => shape.role)).toEqual(['call-statement']);
		expect(then[0]?.stepPath).toBe('1.then.0');
		expect(then[0]?.primitiveRef).toBe('brake');
		expect(then[0]?.topLevel).toBe(false);
		// 嵌套节点记的是它所属的那条顶层语句——选中联动按这个数对齐代码行。
		expect(then[0]?.stepIndex).toBe(1);
	});

	it('if 的否则半边长成三段的 C 形块，then / else 两侧的路径各自往下数', () => {
		const catalog: CapabilityCatalog = {
			...FIXTURE_CATALOG,
			catalogRef: 'else_fixture',
			capabilities: [
				{
					capabilityRef: 'move',
					label: '前进',
					kind: 'skill',
					parameters: [{ name: 'distance', label: '距离', type: 'number' }],
					implementation: [
						{
							kind: 'if',
							condition: {
								kind: 'binary',
								operator: 'lt',
								left: { kind: 'param', name: 'distance' },
								right: { kind: 'literal', value: 0.5 },
							},
							then: [
								{ kind: 'call', primitiveRef: 'stop_motion', arguments: {} },
								{ kind: 'call', primitiveRef: 'wait', arguments: { seconds: { kind: 'param', name: 'distance' } } },
							],
							else: [{ kind: 'call', primitiveRef: 'stop_motion', arguments: {} }],
						},
					],
				},
			],
		};
		const shape = shapeAt('move', '0', catalog);
		expect(shape.role).toBe('if-else');
		expect(shape.statementInputs.map((input) => input.name)).toEqual([THEN_INPUT_NAME, ELSE_INPUT_NAME]);
		expect(shape.statementInputs[0]?.blocks.map((block) => block.stepPath)).toEqual(['0.then.0', '0.then.1']);
		expect(shape.statementInputs[1]?.blocks.map((block) => block.stepPath)).toEqual(['0.else.0']);
		// 写死的字面量当 shadow：它不是可换的零件，是目录里那一个值。
		const right = shape.valueInputs[0]?.child.valueInputs[1];
		expect(right?.child.role).toBe('literal-number');
		expect(right?.asShadow).toBe(true);
		expect(right?.child.atom).toBe('0.5');
		// 三段的 message 真的是三段。
		const definition = buildBlockDefinition(shape);
		expect(definition['message0']).toBe('如果 %1 那么 %2 否则 %3');
		expect((definition['args0'] as Record<string, unknown>[]).map((arg) => arg['type'])).toEqual([
			'input_value',
			'input_statement',
			'input_statement',
		]);
	});

	it('可写/只读由实参决定：指向能力参数的可写，目录里写死的字面量只读', () => {
		// turn 的第一步：linear 在目录里写死 0（原语要它，能力没有这个参数）。
		const turn = shapeAt('turn', '0');
		const linear = turn.widgets.find((widget) => widget.parameter === 'linear');
		if (linear === undefined) throw new Error('set_velocity 应当有 linear 字段');
		expect(linear.kind).toBe('literal');
		expect(linear.binding).toEqual({ kind: 'literal', value: 0 });
		expect(linear.kind === 'literal' ? linear.text : null).toBe(literalText(0));
		expect(linear.kind === 'literal' ? linear.text : null).toBe('0');

		const angular = turn.widgets.find((widget) => widget.parameter === 'angular');
		expect(angular?.kind).toBe('number');
		expect(angular?.binding).toEqual({ kind: 'parameter', parameter: 'angular' });

		// 只读字段的名字与可写字段分得开：写回时按名字就能一眼认出谁不该写。
		expect(linear.fieldName).toBe(literalFieldName('linear'));
		expect(writable(turn).map((widget) => widget.parameter)).toEqual(['angular']);
		expect(writable(shapeAt('move', '0')).map((widget) => widget.parameter)).toEqual(['linear', 'angular']);
	});

	it('可写字段的缺省值只从协议描述推出来（没有协议之外的数字）', () => {
		const numberDefault = (shape: ImplementationBlockShape, parameter: string): number => {
			const widget = shape.widgets.find((candidate) => candidate.parameter === parameter);
			if (widget === undefined || widget.kind !== 'number') throw new Error(`没有数值字段 ${parameter}`);
			return widget.value;
		};

		// move 的 linear/angular 没有上下界也没有默认值 → 0；wait ← $duration 是 `> 0` → 1。
		expect(numberDefault(shapeAt('move', '0'), 'linear')).toBe(0);
		expect(numberDefault(shapeAt('move', '0'), 'angular')).toBe(0);
		expect(numberDefault(shapeAt('move', '1'), 'seconds')).toBe(1);
		// arm_joint 的 time 有协议给的 defaultValue → 1500；joint_id 有下界 1。
		expect(numberDefault(shapeAt('arm_joint', '0'), 'time')).toBe(1500);
		expect(numberDefault(shapeAt('arm_joint', '0'), 'joint_id')).toBe(1);

		// 这几个默认值都能在协议描述里找到出处（协议改了它们就跟着变）。
		expect(describeActionFields('move').find((field) => field.name === 'duration')?.exclusiveMin).toBe(0);
		expect(describeActionFields('arm_joint').find((field) => field.name === 'time')?.defaultValue).toBe(1500);
	});

	it('一行一个参数：每行只装同一个参数的控件，标签就是参数标签', () => {
		for (const shape of describeCatalogImplementations(FIXTURE_CATALOG)) {
			if (shape.primitiveRef === null || shape.rows.length === 0) continue;
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
				expect(parameters.size, shape.type).toBeLessThanOrEqual(MAX_FIELDS_PER_ROW);
				// 字段型与值输入型二选一，不能都摆。
				expect(row.input === undefined || row.widgets.length === 0, shape.type).toBe(true);
			}
		}
		// 传感器两条勾选框仍在同一行：它们本来就只有几个字宽。
		const scan = shapeAt('stop_if_obstacle', '0.value');
		expect(scan.rows[0]?.widgets).toHaveLength(ALLOWED_SENSORS.length);
		// drive_joints 七个参数 → 七行（不挤在一横排上）。
		expect(shapeAt('arm6_joints', '0').rows).toHaveLength(7);
	});

	it('字段标签只写显示名，单位另给小字号标签且 tooltip 里留一份', () => {
		const move = shapeAt('move', '0');
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
		expect(move.tooltip).toContain('前进 的实现第 1 步');
		expect(move.tooltip).toContain('set_velocity');
		expect(move.tooltip).toContain('单位：linear m/s、angular rad/s');
		// 表达式位置上的参数块不挂单位（`0.5 m` 在运算里是噪音）。
		const threshold = shapeAt('stop_if_obstacle', '1.condition.right').widgets[0];
		expect(threshold?.kind === 'number' ? threshold.unit : undefined).toBeUndefined();
		// 没有单位的字段不会凭空长出单位标签（drive_joint 的 joint_id 就没有单位）。
		const arm = buildBlockDefinition(shapeAt('arm_joint', '0'));
		const jointIdArgs = arm['args0'];
		if (!Array.isArray(jointIdArgs)) throw new Error('args0 应当是数组');
		expect((jointIdArgs as Record<string, unknown>[]).map((arg) => arg['type'])).toEqual(['field_number']);
	});

	it('传感器那一行与控制台文字：勾选框带着自己的路径文字在右，只读字面量也是一行', () => {
		const scan = buildBlockDefinition(shapeAt('stop_if_obstacle', '0.value'));
		expect(scan['message0']).toBe(`读取激光 传感器 %1 ${ALLOWED_SENSORS[0]} %2 ${ALLOWED_SENSORS[1]}`);
		// 只读字段（目录写死的字面量）也占自己那一行，值就是目录里的原样。
		const turn = buildBlockDefinition(shapeAt('turn', '0'));
		expect(turn['message0']).toBe('下发速度 线速度 %1');
		expect(turn['args0']).toEqual([{ type: 'field_label', name: literalFieldName('linear'), text: '0' }]);
		// 赋值块与条件块的整句人话。
		expect(buildBlockDefinition(shapeAt('stop_if_obstacle', '0'))['message0']).toBe('设 %1 为 %2');
		expect(buildBlockDefinition(shapeAt('stop_if_obstacle', '1'))['message0']).toBe('如果 %1 那么 %2');
		// 引用块与比较块：引用只写名字，比较把两个操作数摆在同一行。
		expect(buildBlockDefinition(shapeAt('stop_if_obstacle', '1.condition.left'))['message0']).toBe('%1');
		const comparison = buildBlockDefinition(shapeAt('stop_if_obstacle', '1.condition'));
		expect(comparison['message0']).toBe('%1 < %2');
		expect(comparison['inputsInline']).toBe(true);
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

	it('语句块与值块的形状分得开：前者有 previous/next，后者只有 output', () => {
		const statement = buildBlockDefinition(shapeAt('move', '0'));
		expect(statement['previousStatement']).toBeNull();
		expect(statement['nextStatement']).toBeNull();
		expect(statement['output']).toBeUndefined();
		// 语句块一行一个字段：inputsInline 会把 message1… 并回同一行。
		expect(statement['inputsInline']).toBe(false);

		const value = buildBlockDefinition(shapeAt('stop_if_obstacle', '0.value'));
		expect(value['output']).toBeNull();
		expect(value['previousStatement']).toBeUndefined();
	});

	it('tooltip 说明这是哪个模块的第几步（嵌套节点说路径），行必须真的是行', () => {
		// 新模型下积木不表示「任务第几步」，而是「这个模块内部第几步」——tooltip 说清楚。
		expect(shapeAt('move', '1').tooltip).toContain('前进 的实现第 2 步');
		expect(shapeAt('move', '1').tooltip).toContain('等待');
		// 嵌套节点没有「第几步」，给路径（调试时能一眼定位到树里哪一处）。
		expect(shapeAt('stop_if_obstacle', '1.then.0').tooltip).toContain('路径 1.then.0');
		expect(shapeAt('move', '0').style).toBe(blockStyleName('move'));
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
					// 只有字段型的控件能在块上直接读到值；值输入型的在子块里。
					if (shape.rows.every((row) => row.input !== undefined) && shape.rows.length > 0) continue;
					const value: unknown = block.getFieldValue(widget.fieldName);
					if (widget.kind === 'number') expect(value, `${shape.type}.${widget.fieldName}`).toBe(widget.value);
					else if (widget.kind === 'text') expect(value, `${shape.type}.${widget.fieldName}`).toBe(widget.value);
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

describe('路径就是树里的位置', () => {
	it('顶层语句下标取路径第一段；嵌套路径记住它属于哪条顶层语句', () => {
		expect(topLevelStepIndexOf('0')).toBe(0);
		expect(topLevelStepIndexOf('1')).toBe(1);
		expect(topLevelStepIndexOf('1.then.0')).toBe(1);
		expect(topLevelStepIndexOf('1.condition.right')).toBe(1);
		expect(topLevelStepIndexOf('不是路径')).toBeNull();
	});

	it('反查：路径 → 目录里的那个节点，语句与表达式各回各的', () => {
		const capability = capabilityOf(FIXTURE_CATALOG, 'stop_if_obstacle');
		const statement = resolveImplementationPath(capability, '1');
		expect(statement?.kind).toBe('statement');
		const expression = resolveImplementationPath(capability, '1.condition.right');
		expect(expression?.kind).toBe('expression');
		expect(expression?.kind === 'expression' ? expression.expression.kind : null).toBe('param');
		// 树里没有的地方一律 null，不猜一个节点顶上。
		expect(resolveImplementationPath(capability, '9')).toBeNull();
		expect(resolveImplementationPath(capability, '1.else.0')).toBeNull();
		expect(resolveImplementationPath(capability, '0.condition.left')).toBeNull();
	});
});

describe('目录有缺陷时', () => {
	it('悬空名字、漏给实参、类型进不了表达式、未知原语，四种各长各的块', () => {
		const capability = capabilityOf(BROKEN_CATALOG, 'move');
		const shapes = describeImplementation(BROKEN_CATALOG, capability).map((shape) => flattenShape(shape));
		expect(capability.implementation).toHaveLength(6);

		// 第 2 条：`{kind:'param', name:'missing'}` 既不是能力参数也不是局部变量 → 只读引用块。
		const dangling = shapeAt('move', '1', BROKEN_CATALOG);
		expect(dangling.rows[0]?.input).toBe('seconds');
		expect(dangling.valueInputs[0]?.child.widgets[0]?.binding).toEqual({ kind: 'dangling', name: 'missing' });
		expect(dangling.valueInputs[0]?.child.widgets[0]?.kind === 'literal'
			? dangling.valueInputs[0]?.child.widgets[0]?.text
			: null,
		).toBe('missing');

		// 第 3 条：原语要 seconds，实现里没写 → 只读的 `—`。
		const unbound = shapeAt('move', '2', BROKEN_CATALOG);
		expect(unbound.widgets[0]?.binding).toEqual({ kind: 'unbound' });
		expect(unbound.widgets[0]?.kind === 'literal' ? unbound.widgets[0].text : null).toBe('—');

		// 第 4 条：目录里没有这个原语（语句位置）→ 占位块。
		expect(isUnknownShape(shapeAt('move', '3', BROKEN_CATALOG))).toBe(true);
		// 第 5 条：嵌在赋值里的未知原语（表达式位置）→ 值占位块。
		const nested = shapeAt('move', '4.value', BROKEN_CATALOG);
		expect(isUnknownShape(nested)).toBe(true);
		expect(nested.role).toBe('unknown-value');

		// 第 6 条：sensor 类型的参数进不了表达式 → 只读引用块（不是可写的数字块）。
		const notAValue = shapeAt('move', '5', BROKEN_CATALOG);
		expect(notAValue.valueInputs[0]?.child.role).toBe('param-read');
		expect(notAValue.valueInputs[0]?.child.widgets[0]?.binding).toEqual({ kind: 'not-a-value', name: 'sensors' });

		// 正常那一步仍然是可写的。
		expect(shapeAt('move', '0', BROKEN_CATALOG).widgets[0]?.binding).toEqual({
			kind: 'parameter',
			parameter: 'duration',
		});
		expect(shapes.flat().every((shape) => shape.capabilityRef === 'move')).toBe(true);
	});

	it('形状里不出现目录没写过的参数', () => {
		// wait 只声明了 seconds：形状里的行就是它一条，不多不少。
		const wait = shapeAt('move', '0', BROKEN_CATALOG);
		expect(wait.parameters).toEqual(['seconds']);
		expect(wait.rows.map((row) => row.parameter)).toEqual(['seconds']);
		// 字段上的 `parameter` 是**这一行**（原语参数的槽位），绑到哪个能力参数由 binding 说。
		expect(wait.widgets[0]?.parameter).toBe('seconds');
		expect(wait.widgets[0]?.binding).toEqual({ kind: 'parameter', parameter: 'duration' });
	});
});

// ---------------------------------------------------------------------------
// 结构化载荷（`json` 类型的实参）画到积木上
// ---------------------------------------------------------------------------

describe('结构化载荷：画得下，且截断是明说的', () => {
	it('短的结构化载荷摊成紧凑 JSON，不是 `[object Object]`', () => {
		expect(literalText({ '1': 0.02, '2': 0.54 })).toBe('{"1":0.02,"2":0.54}');
		expect(literalText([1, 2])).toBe('[1,2]');
		// 字符串数组仍是老写法（`/scan0` 比 `["/scan0"]` 好读）
		expect(literalText(['/scan0'])).toBe('/scan0');
	});

	it('长到画布放不下的截断**明说**：尾巴上写着总共多少字，短的一字不动', () => {
		const payload = { type: 'wave_dance_v1', joints: { '5': { terms: [{ amplitude: 0.28 }] } } };
		const full = literalText(payload);
		const shown = truncateLiteralText(full);
		expect(full.length).toBeGreaterThan(LITERAL_FIELD_LIMIT);
		expect(shown.startsWith(full.slice(0, LITERAL_FIELD_LIMIT))).toBe(true);
		expect(shown).toContain(`共 ${full.length} 字`);
		expect(truncateLiteralText('{"1":0.02}')).toBe('{"1":0.02}');
	});

	it('上游真实的轨迹模板：积木上截断显示，全文进 tooltip——一个字都没丢', () => {
		// `wave_hello` 的第 3 步 `move_through_joint_positions`，实参是一整棵轨迹模板。
		const capability = capabilityOf(ROBOFRAME_SO101_CATALOG, 'wave_hello');
		const call = describeNodeAtPath(ROBOFRAME_SO101_CATALOG, capability, '2');
		if (call === null) throw new Error('预期第 3 步有一个节点');
		const literal = describeNodeAtPath(ROBOFRAME_SO101_CATALOG, capability, '2.arguments.trajectory_template');
		if (literal === null) throw new Error('预期轨迹模板那个实参有一个节点');

		const widget = literal.widgets[0];
		expect(widget?.kind).toBe('literal');
		if (widget?.kind !== 'literal') throw new Error('预期是只读字面量字段');
		expect(widget.binding.kind).toBe('literal');
		if (widget.binding.kind !== 'literal') throw new Error('预期绑定是字面量');

		const full = literalText(widget.binding.value);
		expect(full.length).toBeGreaterThan(LITERAL_FIELD_LIMIT);
		expect(widget.text).toBe(truncateLiteralText(full));
		expect(widget.tooltip).toContain(full);
		// 载荷本身原样留在绑定里（画布不回写它，但形状里记着真值）。
		expect(widget.binding.value).toMatchObject({ type: 'single_joint_wave_v1', joint: '5', amplitude: 0.35 });
		// 积木上写的是原语名，不是整坨 JSON。
		expect(call.detail).toContain('move_through_joint_positions');
	});
});
