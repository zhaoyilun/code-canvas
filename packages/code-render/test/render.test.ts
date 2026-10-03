/**
 * 代码面板渲染的验收测试（**语句树 → 有结构的代码**）。
 *
 * 六件事必须有机械证据：
 * 1. 渲染规则**可追溯到原语定义**（`catalog.primitives[].parameters`）——参数名与顺序一个都不手写；
 * 2. `{kind:'param'}` 解析成**本节点同名参数的实际值**，字面量照原样；
 * 3. 树真的长成了程序：赋值一行、`if` 一行 + **缩进**的子语句；括号按优先级加，宁可多也不能错；
 * 4. 行 ↔ 步骤的正反映射（顶层下标 + 精确树路径），含注释行与 `if` 造成的偏移；
 * 5. 数字**不失真**——渲染出的字面量读回来必须还是原值；任务级限值照旧看得见；
 * 6. 目录里查不到的东西（能力 / 原语 / 引用）不假装认识；
 * 7. **委托**（`delegate`）照实说「实现在执行侧」，不编步骤、不冒充原语、不占原语计数。
 *
 * 这一版把老形状（`implementation: [{step, arguments}]`）的断言改成了语句树，
 * **一条用例都没删**：能平移的都平移，只属于老形状的那条（多给实参）换了构造方式。
 *
 * **输入用的是夹具目录（`./fixtures.ts`），不是 `PHASE1_ROBOT_CATALOG`**：示意目录会被真实实现整份替换，
 * 而这里断言的是渲染规则（缩进、括号、行 ↔ 路径映射、数值保精度），跟设备写了什么无关。
 * 真实目录自己只留两条冒烟断言，见 `catalog-smoke.test.ts`。
 */
import { describe, expect, it } from 'vitest';
import {
	findCapability,
	findPrimitive,
	type CapabilityCatalog,
	type CapabilitySpec,
	type CatalogParameter,
	type ImplStatement,
	type JsonObject,
	type JsonValue,
	type WorkflowDeclaration,
	type WorkflowNode,
} from '@codecanvas/contracts';
import { importTaskJson } from '@codecanvas/task-import';
import { ROBOFRAME_GRASP_CATALOG } from '@codecanvas/capabilities';
import {
	INDENT_UNIT,
	callLines,
	lineOfStep,
	lineText,
	linesOfTopStep,
	renderImplementation,
	stepIndexAtLine,
	stepPathAtLine,
	type RenderedImplementation,
} from '../src/index';
import { FIXTURE_CATALOG, fixtureDeclarationOf as declarationOf, fixtureNode as nodeOf } from './fixtures';

/** 与 `apps/studio/src/state/sample-task.ts` 同一份示例（跨包不能直接 import，故抄一份语料）。 */
const SAMPLE_TASK_JSON = `{
  "schema_version": "1.0",
  "task_id": "task-demo-001",
  "description": "前进，遇障停止后转向",
  "steps": [
    { "id": "s1", "action": "move", "linear": 0.2, "angular": 0.0, "duration": 5.0 },
    { "id": "s2", "action": "stop_if_obstacle", "sensors": ["/scan0"], "distance": 0.5 },
    { "id": "s3", "action": "turn", "angular": 0.8, "duration": 2.0 },
    { "id": "s4", "action": "stop" }
  ],
  "limits": {
    "max_linear": 0.3,
    "max_angular": 1.2,
    "max_duration": 30.0,
    "require_confirmation": true
  }
}
`;

const sampleDeclaration = (): WorkflowDeclaration => {
	const result = importTaskJson(SAMPLE_TASK_JSON);
	if (!result.ok) throw new Error('sample task must import');
	return result.declaration;
};

/** 渲染一个节点（默认用夹具目录 + 一份带限值的手工声明）。 */
const render = (
	parameters: JsonObject,
	options: { overrides?: Partial<WorkflowNode>; catalog?: CapabilityCatalog; declaration?: WorkflowDeclaration | null } = {},
): RenderedImplementation =>
	renderImplementation({
		node: nodeOf(parameters, options.overrides ?? {}),
		catalog: options.catalog ?? FIXTURE_CATALOG,
		declaration: options.declaration === undefined ? declarationOf([nodeOf(parameters)]) : options.declaration,
	});

/** 每一行的完整文本（**含行首缩进**——缩进是程序的一部分）。 */
const texts = (program: RenderedImplementation): string[] => program.lines.map((line) => line.text);

/** 去掉行首缩进后的文本：比对「这一行写了什么」时更清楚。 */
const trimmed = (program: RenderedImplementation): string[] =>
	program.lines.map((line) => line.text.trim());

/** 按动作取示例任务里的那个节点：它的参数就是任务的参数。 */
const sampleNode = (action: string): WorkflowNode => {
	const found = sampleDeclaration().nodes.find((node) => node.parameters['action'] === action);
	if (found === undefined) throw new Error(`sample task has no ${action} step`);
	return found;
};

const renderSample = (action: string, declaration: WorkflowDeclaration = sampleDeclaration()) => {
	const node = declaration.nodes.find((item) => item.parameters['action'] === action);
	if (node === undefined) throw new Error(`declaration has no ${action} step`);
	return renderImplementation({ node, catalog: FIXTURE_CATALOG, declaration });
};

/**
 * 调用行 → `名字=文本` 实参表。测试自己的解析器（不复用被测代码），
 * 按括号与引号深度切分，所以数组实参里的逗号不会被当成实参分隔符。
 */
const argsOf = (line: string): Map<string, string> => {
	const open = line.indexOf('(');
	const close = line.lastIndexOf(')');
	const body = line.slice(open + 1, close);
	const args = new Map<string, string>();
	if (body.trim() === '') return args;

	const parts: string[] = [];
	let current = '';
	let depth = 0;
	let quoted = false;
	for (const char of body) {
		if (char === '"') quoted = !quoted;
		if (!quoted && (char === '[' || char === '{')) depth += 1;
		if (!quoted && (char === ']' || char === '}')) depth -= 1;
		if (!quoted && depth === 0 && char === ',') {
			parts.push(current);
			current = '';
			continue;
		}
		current += char;
	}
	parts.push(current);

	for (const part of parts) {
		const item = part.trim();
		const eq = item.indexOf('=');
		args.set(item.slice(0, eq), item.slice(eq + 1));
	}
	return args;
};

/** 深度优先遍历语句树里的每条语句——用来把「每一条语句都渲染出来了」钉住。 */
const eachStatement = (statements: readonly ImplStatement[], visit: (statement: ImplStatement) => void): void => {
	for (const statement of statements) {
		visit(statement);
		if (statement.kind !== 'if') continue;
		eachStatement(statement.then, visit);
		eachStatement(statement.else ?? [], visit);
	}
};

/** 语句树里所有**调用**（语句调用 + 表达式调用）的路径与实参——检查参数名时的底稿。 */
const statementCalls = (
	statements: readonly ImplStatement[],
	prefix = '',
): { readonly path: string; readonly statement: ImplStatement & { kind: 'call' } }[] => {
	const found: { path: string; statement: ImplStatement & { kind: 'call' } }[] = [];
	statements.forEach((statement, index) => {
		const path = prefix === '' ? String(index) : `${prefix}.${index}`;
		if (statement.kind === 'call') found.push({ path, statement });
		if (statement.kind !== 'if') return;
		found.push(...statementCalls(statement.then, `${path}.then`));
		found.push(...statementCalls(statement.else ?? [], `${path}.else`));
	});
	return found;
};

/** 一条只含一个能力的目录：用例自己造病态实现时用（原语仍用夹具那份）。 */
const catalogWith = (capability: CapabilitySpec): CapabilityCatalog => ({
	...FIXTURE_CATALOG,
	capabilities: [capability],
});

describe('示例任务的模块 → 实现（逐字比对）', () => {
	it('前进（move）：三步原语，数值来自本节点的参数', () => {
		const program = renderSample('move');

		expect(texts(program)).toEqual([
			'set_velocity(linear=0.2, angular=0.0)',
			'wait(seconds=5.0)',
			'stop_motion()',
		]);
		expect(program.title).toBe('前进 · 实现');
		expect(program.capabilityLabel).toBe('前进');
		expect(program.callCount).toBe(3);
		expect(program.diagnostics).toEqual([]);
	});

	it('避障停止（stop_if_obstacle）：赋值 + if + **缩进的** brake——三行，缩进进文本', () => {
		const program = renderSample('stop_if_obstacle');

		// 这是验收标准里那三行：一个赋值、一个分支头、一条缩进一档的子语句。
		expect(texts(program)).toEqual([
			'reading = read_scan(sensors=["/scan0"])',
			'if reading < 0.5:',
			`${INDENT_UNIT}brake()`,
		]);
		expect(program.text).toBe(
			['reading = read_scan(sensors=["/scan0"])', 'if reading < 0.5:', '    brake()'].join('\n'),
		);
		expect(program.lines.map((line) => line.indent)).toEqual([0, 0, 1]);
		expect(program.title).toBe('避障停止 · 实现');
		expect(program.diagnostics).toEqual([]);
		// 「几个原语」= 渲染出调用的行数：赋值右边那次 read_scan；`brake()` 是另一条语句（step 1）。
		expect(program.callCount).toBe(2);
	});

	it('转向（turn）：实现里的字面量 `linear: 0` 照原样，`angular` 来自节点', () => {
		const program = renderSample('turn');

		expect(texts(program)).toEqual([
			'set_velocity(linear=0.0, angular=0.8)',
			'wait(seconds=2.0)',
			'stop_motion()',
		]);
		expect(program.diagnostics).toEqual([]);
	});

	it('停止（stop）：单步、无参数的原语渲染成 `stop_motion()`', () => {
		const program = renderSample('stop');
		expect(texts(program)).toEqual(['stop_motion()']);
		expect(program.title).toBe('停止 · 实现');
	});

	it('读取状态（get_status）：赋值右边是一个有返回值的原语调用', () => {
		// 示例任务里没有这一步，手工造一个同形状的节点（`get_status` 无参数）。
		const program = render({ step_id: 's5', action: 'get_status' });
		expect(texts(program)).toEqual(['status = read_status()']);
		expect(program.callCount).toBe(1);
		expect(program.diagnostics).toEqual([]);
	});

	it('text 就是各行用换行拼起来（面板与文本两条路不会分叉）', () => {
		const program = renderSample('stop_if_obstacle');
		expect(program.text).toBe(program.lines.map((line) => line.text).join('\n'));
	});

	it('没选中模块时给空程序，不编造内容', () => {
		const declaration = sampleDeclaration();
		const program = renderImplementation({ node: null, catalog: FIXTURE_CATALOG, declaration });

		expect(program.lines).toEqual([]);
		expect(program.steps).toEqual([]);
		expect(program.text).toBe('');
		expect(program.title).toBeNull();
		expect(program.callCount).toBe(0);
		// 限值仍是整个任务的，跟选中谁无关
		expect(program.limits.present).toBe(true);
	});
});

describe('渲染规则可追溯到原语定义（不许手写参数名）', () => {
	const paramValue = (type: CatalogParameter['type']): JsonValue => {
		switch (type) {
			case 'number':
				return 0.5;
			case 'boolean':
				return true;
			case 'sensor':
				return ['/scan0'];
			case 'string':
			case 'pose':
				return 'x';
			case 'json':
				return { joint: 0.5 };
		}
	};

	it.each(FIXTURE_CATALOG.capabilities.map((capability) => capability.capabilityRef))(
		'%s 的每一行调用：参数名与顺序逐字来自 catalog.primitives',
		(capabilityRef) => {
			const capability = findCapability(FIXTURE_CATALOG, capabilityRef);
			expect(capability).toBeDefined();
			if (capability === undefined) return;

			const parameters: JsonObject = { step_id: 's1', action: capabilityRef };
			for (const parameter of capability.parameters) parameters[parameter.name] = paramValue(parameter.type);

			const program = render(parameters);

			// 树里每一条**调用语句**都渲染成了一行调用，行号由映射查得到。
			const calls = statementCalls(capability.implementation);
			// 「几个原语」还包含表达式里的调用（`reading = read_scan(…)` 也算一次）
			expect(program.callCount).toBeGreaterThanOrEqual(calls.length);
			expect(callLines(program)).toHaveLength(calls.length);

			for (const { path, statement } of calls) {
				const primitive = findPrimitive(FIXTURE_CATALOG, statement.primitiveRef);
				expect(primitive).toBeDefined();
				if (primitive === undefined) continue;

				const line = lineOfStep(program, path);
				expect(line).not.toBeNull();
				if (line === null) continue;

				// 一条语句可能摊成多行（结构化载荷摊不下时），实参表要**整段**拼起来看，
				// 只看头一行会把摊在后面的实参漏掉。按精确路径取，嵌套调用不会把外层那行带进来。
				const text = program.lines
					.filter((item) => item.stepPath === path)
					.map((item) => item.text.trim())
					.join('');
				expect(text).not.toBe('');

				// 原语名 + 参数名序列 + 顺序，全部来自定义，测试这边只做对照
				expect(text.trim().startsWith(`${statement.primitiveRef}(`)).toBe(true);
				expect([...argsOf(text).keys()]).toEqual(primitive.parameters.map((parameter) => parameter.name));
			}

			expect(program.diagnostics).toEqual([]);
		},
	);

	it('无参数的原语一律渲染成 `名字()`，不留空括号里的空格', () => {
		expect(trimmed(render({ step_id: 's1', action: 'stop' }))).toEqual(['stop_motion()']);
		expect(trimmed(render({ step_id: 's1', action: 'get_status' }))).toEqual(['status = read_status()']);
		// 赋值右值是**调用**（叶子最紧的一档）→ 不加括号
		expect(trimmed(render({ step_id: 's1', action: 'get_status' }))).not.toContain('status = (read_status())');
	});

	it('原语定义里没有的实参不渲染（实现写多了也不许偷偷进代码）', () => {
		const program = render(
			{ step_id: 's1', action: 'extra_args', v: 0.2 },
			{
				catalog: catalogWith({
					capabilityRef: 'extra_args',
					label: '多余的实参',
					kind: 'skill',
					parameters: [{ name: 'v', label: '速度', type: 'number' }],
					implementation: [
						{
							kind: 'call',
							primitiveRef: 'set_velocity',
							arguments: { linear: 9, angular: { kind: 'param', name: 'v' }, nope: 1 },
						},
					],
				}),
			},
		);

		// `nope` 在原语定义里没有 → 不进代码，只出诊断；`linear` 是字面量，照原样。
		expect(texts(program)).toEqual(['set_velocity(linear=9.0, angular=0.2)']);
		expect(program.diagnostics.map((diagnostic) => diagnostic.code)).toEqual([
			'code_render.argument.undeclared',
		]);
		expect(program.diagnostics[0]?.details).toMatchObject({ argument: 'nope' });
	});
});

describe('语句树 → 代码：结构、缩进、优先级', () => {
	/** 一个把语句树各种形态都用上的能力：赋值、if/else、嵌套 binary、unary、嵌套调用。 */
	const branchy: CapabilitySpec = {
		capabilityRef: 'branchy',
		label: '带分支的',
		kind: 'skill',
		parameters: [{ name: 'v', label: '速度', type: 'number' }],
		implementation: [
			{
				kind: 'set',
				target: 'reading',
				value: { kind: 'call', primitiveRef: 'read_scan', arguments: { sensors: ['/scan0'] } },
			},
			{
				kind: 'if',
				condition: {
					kind: 'binary',
					operator: 'lt',
					left: { kind: 'binary', operator: 'multiply', left: { kind: 'param', name: 'v' }, right: { kind: 'literal', value: 2 } },
					right: { kind: 'literal', value: 0.5 },
				},
				then: [
					{ kind: 'call', primitiveRef: 'brake', arguments: {} },
					{
						kind: 'if',
						condition: { kind: 'unary', operator: 'not', value: { kind: 'literal', value: false } },
						then: [{ kind: 'call', primitiveRef: 'stop_motion', arguments: {} }],
						else: [{ kind: 'call', primitiveRef: 'set_velocity', arguments: { linear: 0, angular: 0 } }],
					},
				],
			},
		],
	};

	it('if/else 展开成多行，缩进按层加（4 个空格一档）', () => {
		const program = render({ action: 'branchy', v: 0.3 }, { catalog: catalogWith(branchy) });

		expect(texts(program)).toEqual([
			'reading = read_scan(sensors=["/scan0"])',
			'if (0.3) * 2.0 < 0.5:',
			'    brake()',
			'    if not false:',
			'        stop_motion()',
			'    else:',
			'        set_velocity(linear=0.0, angular=0.0)',
		]);
		expect(program.lines.map((line) => line.indent)).toEqual([0, 0, 1, 1, 2, 1, 2]);
		expect(program.lines.map((line) => line.kind)).toEqual([
			'set',
			'if',
			'call',
			'if',
			'call',
			'else',
			'call',
		]);
		expect(program.diagnostics).toEqual([]);
	});

	it('优先级：引用裹括号、字面量不裹（宁可多括号也别写错结合性）', () => {
		const program = render({ action: 'branchy', v: 0.3 }, { catalog: catalogWith(branchy) });
		// `v` 是引用（力度 5）落在 `*`（7）里 → 裹；`2` 是字面量（叶子，100）→ 不裹。
		// `<`（3）比 `*` 松 → 左操作数不裹；`0.5` 是字面量 → 不裹。
		expect(trimmed(program)[1]).toBe('if (0.3) * 2.0 < 0.5:');
		// `not` 的操作数若是字面量/引用，没有歧义 → 不加括号。
		expect(trimmed(program)[3]).toBe('if not false:');
	});

	it('字面量与引用在同一位置上的差别：引用裹、字面量不裹', () => {
		const withLiteral = render(
			{ action: 'op' },
			{
				catalog: catalogWith({
					capabilityRef: 'op',
					label: '运算符',
					kind: 'skill',
					parameters: [],
					implementation: [
						{
							kind: 'set',
							target: 'r',
							value: {
								kind: 'binary',
								operator: 'multiply',
								left: { kind: 'literal', value: 2 },
								right: { kind: 'binary', operator: 'add', left: { kind: 'literal', value: 1 }, right: { kind: 'literal', value: 3 } },
							},
						},
					],
				}),
			},
		);
		// `1 + 3`（6）比 `*`（7）松 → 裹；两个字面量自己是叶子 → 不裹。
		expect(texts(withLiteral)).toEqual(['r = (2.0 * (1.0 + 3.0))']);
	});

	it('嵌套调用与赋值右值：右值整体加括号，嵌套调用照原样', () => {
		const program = renderSample('stop_if_obstacle');
		expect(trimmed(program)[0]).toBe('reading = read_scan(sensors=["/scan0"])');
		// 单独一个引用（局部变量）在赋值右值上也加括号——孤立看认得出它是一个取值。
		const single = render(
			{ action: 'copy', v: 0.2 },
			{
				catalog: catalogWith({
					capabilityRef: 'copy',
					label: '复制',
					kind: 'skill',
					parameters: [{ name: 'v', label: '速度', type: 'number' }],
					implementation: [{ kind: 'set', target: 'x', value: { kind: 'param', name: 'v' } }],
				}),
			},
		);
		expect(texts(single)).toEqual(['x = (0.2)']);
	});

	it('binary 运算符用符号：`lt` → `<`、`add` → `+`……一个词都不漏', () => {
		const operators: readonly [string, string][] = [
			['lt', '<'],
			['lte', '<='],
			['gt', '>'],
			['gte', '>='],
			['eq', '=='],
			['neq', '!='],
			['add', '+'],
			['subtract', '-'],
			['multiply', '*'],
			['divide', '/'],
			['and', 'and'],
			['or', 'or'],
		];
		expect(operators).toHaveLength(12);
		for (const [operator, symbol] of operators) {
			const program = render(
				{ action: 'op' },
				{
					catalog: catalogWith({
						capabilityRef: 'op',
						label: '运算符',
						kind: 'skill',
						parameters: [],
						implementation: [
							{
								kind: 'set',
								target: 'r',
								value: {
									kind: 'binary',
									operator: operator as 'lt',
									left: { kind: 'literal', value: 1 },
									right: { kind: 'literal', value: 2 },
								},
							},
						],
					}),
				},
			);
			expect(texts(program)).toEqual([`r = (1.0 ${symbol} 2.0)`]);
		}
	});

	it('语句树里每一条语句都渲染出来了（一条不漏，也没多出来）', () => {
		const capability = findCapability(FIXTURE_CATALOG, 'stop_if_obstacle');
		expect(capability).toBeDefined();
		if (capability === undefined) return;

		const program = renderSample('stop_if_obstacle');
		const paths: string[] = [];
		eachStatement(capability.implementation, (statement) => {
			void statement;
			paths.push('visited');
		});
		// 只有两条顶层语句，却渲染出三行：if 的子语句也各占一行。
		expect(capability.implementation).toHaveLength(2);
		expect(program.lines).toHaveLength(3);
		expect(program.lines.map((line) => line.stepPath)).toEqual(['0', '1', '1.then.0']);
	});
});

describe('param 解析与字面量', () => {
	it('引用本节点同名参数，改参数 → 那一行的数字跟着变', () => {
		const first = render(
			{ step_id: 's1', action: 'move', linear: 0.2, angular: 0, duration: 5 },
			{ declaration: declarationOf([nodeOf({ step_id: 's1', action: 'move', linear: 0.2, angular: 0, duration: 5 })]) },
		);
		expect(texts(first)[0]).toBe('set_velocity(linear=0.2, angular=0.0)');

		const changed = render({ step_id: 's1', action: 'move', linear: 0.15, angular: 0, duration: 5 });
		expect(texts(changed)[0]).toBe('set_velocity(linear=0.15, angular=0.0)');
		// 只动了一个参数，另外两行不变
		expect(texts(changed)[1]).toBe('wait(seconds=5.0)');
	});

	it('字面量不引用节点参数：turn 的实现写死 linear=0，节点另给一个 linear 也不动它', () => {
		const program = render({ step_id: 's3', action: 'turn', angular: 0.8, duration: 2, linear: 0.9 });
		expect(texts(program)[0]).toBe('set_velocity(linear=0.0, angular=0.8)');
		expect(program.diagnostics).toEqual([]);
	});

	it('引用指不到本节点的参数时给诊断 + 占位符，不猜', () => {
		const program = render(
			{ step_id: 's1', action: 'dangling' },
			{
				catalog: catalogWith({
					capabilityRef: 'dangling',
					label: '悬空引用',
					kind: 'skill',
					parameters: [],
					implementation: [
						{ kind: 'call', primitiveRef: 'wait', arguments: { seconds: { kind: 'param', name: 'duration' } } },
					],
				}),
			},
		);

		expect(texts(program)).toEqual(['wait(seconds=null)']);
		expect(program.diagnostics.map((diagnostic) => diagnostic.code)).toEqual([
			'code_render.param.unresolved',
		]);
		expect(program.diagnostics[0]?.severity).toBe('warning');
	});

	it('局部变量写在左边、右边取节点参数的实际值（不是变量名）', () => {
		const program = renderSample('stop_if_obstacle');
		// `reading` 是本能力实现里 set 出来的局部变量，左边写名字、右边是读激光那个调用。
		expect(trimmed(program)[0]).toBe('reading = read_scan(sensors=["/scan0"])');
		// 条件里的 `reading` 是引用、`distance` 是本节点参数 0.5 → 写出来是数字。
		expect(trimmed(program)[1]).toBe('if reading < 0.5:');
	});

	it('传感器数组保持顺序；空数组与非数组都给诊断（实现里写死的也算）', () => {
		// 实现里直接写死的数组（匿名数组，`implArgumentSchema` 允许的形态）也过同一道闸。
		const hardcoded = render(
			{ action: 'hardcoded_sensors' },
			{
				catalog: catalogWith({
					capabilityRef: 'hardcoded_sensors',
					label: '写死的传感器',
					kind: 'skill',
					parameters: [],
					implementation: [
						{ kind: 'call', primitiveRef: 'read_scan', arguments: { sensors: ['/scan2', '/scan1'] } },
					],
				}),
			},
		);
		expect(texts(hardcoded)).toEqual(['read_scan(sensors=["/scan2", "/scan1"])']);
		expect(hardcoded.diagnostics).toEqual([]);

		const many = render({ step_id: 's2', action: 'stop_if_obstacle', sensors: ['/scan1', '/scan0'], distance: 0.5 });
		expect(texts(many)[0]).toBe('reading = read_scan(sensors=["/scan1", "/scan0"])');

		const empty = render({ step_id: 's2', action: 'stop_if_obstacle', sensors: [], distance: 0.5 });
		expect(texts(empty)[0]).toBe('reading = read_scan(sensors=[])');
		// 空数组不当成合法字面量：给诊断（与老形状同一条码）。
		expect(empty.diagnostics.map((diagnostic) => diagnostic.code)).toEqual([
			'code_render.argument.empty_sensor_array',
		]);

		const wrong = render({ step_id: 's2', action: 'stop_if_obstacle', sensors: '/scan0', distance: 0.5 });
		expect(texts(wrong)[0]).toBe('reading = read_scan(sensors=[])');
		expect(wrong.diagnostics.map((diagnostic) => diagnostic.code)).toEqual([
			'code_render.argument.not_sensor_array',
		]);
	});
});

describe('行 ↔ 语句树路径的映射', () => {
	it('每一行都带顶层步骤号（0 基）与精确路径，steps[] 与顶层语句一一对应', () => {
		const program = renderSample('move');
		const capability = findCapability(FIXTURE_CATALOG, 'move');
		expect(capability).toBeDefined();
		if (capability === undefined) return;

		expect(program.steps).toHaveLength(capability.implementation.length);
		expect(program.lines.map((line) => line.stepIndex)).toEqual([0, 1, 2]);
		expect(program.lines.map((line) => line.stepPath)).toEqual(['0', '1', '2']);
		expect(program.steps.map((step) => step.path)).toEqual(['0', '1', '2']);
		expect(program.steps.map((step) => step.primitiveRef)).toEqual(
			capability.implementation.map((statement) =>
				statement.kind === 'call' ? statement.primitiveRef : null,
			),
		);
		expect(program.steps.every((step) => step.known)).toBe(true);

		for (const step of program.steps) {
			expect(stepIndexAtLine(program, step.line)).toBe(step.index);
			expect(lineOfStep(program, step.path)).toBe(step.line);
			expect(program.lines[step.line - 1]?.primitiveRef).toBe(step.primitiveRef);
		}
	});

	it('一个 if 的多行都算同一步：顶层下标相同，路径各不相同', () => {
		const program = renderSample('stop_if_obstacle');

		expect(program.lines.map((line) => line.stepIndex)).toEqual([0, 1, 1]);
		expect(program.lines.map((line) => line.stepPath)).toEqual(['0', '1', '1.then.0']);
		expect(program.steps).toHaveLength(2);
		expect(program.steps[1]).toMatchObject({ index: 1, path: '1', kind: 'if', line: 2, lastLine: 3, lineCount: 2 });

		// 反向：第 1 步的所有行（1 基的行号），以及精确到 .then 那条
		expect(linesOfTopStep(program, 1).map((line) => line.line)).toEqual([2, 3]);
		expect(linesOfTopStep(program, 0).map((line) => line.line)).toEqual([1]);
		expect(lineOfStep(program, '1.then.0')).toBe(3);
		expect(stepPathAtLine(program, 3)).toBe('1.then.0');
		expect(stepIndexAtLine(program, 3)).toBe(1);
	});

	it('注释行不占步骤号，但会让后面几行的行号整体偏移（映射不是 index+1 硬算的）', () => {
		const parameters: JsonObject = { step_id: 's1', action: 'move', linear: 0.2, angular: 0, duration: 5 };
		const program = renderImplementation({
			node: nodeOf(parameters, { disabled: true, name: '前进（停用）' }),
			catalog: FIXTURE_CATALOG,
			declaration: declarationOf([nodeOf(parameters)]),
		});

		expect(texts(program)).toEqual([
			'# disabled: 前进（停用）',
			'set_velocity(linear=0.2, angular=0.0)',
			'wait(seconds=5.0)',
			'stop_motion()',
		]);
		expect(program.lines[0]).toMatchObject({ kind: 'comment', stepIndex: null, stepPath: null, primitiveRef: null });
		expect(stepIndexAtLine(program, 1)).toBeNull();
		expect(program.lines.map((line) => line.stepIndex)).toEqual([null, 0, 1, 2]);
		expect(lineOfStep(program, '0')).toBe(2);
		expect(linesOfTopStep(program, 0).map((line) => line.line)).toEqual([2]);
	});

	it('越界行号 / 路径给 null，不猜', () => {
		const program = renderSample('move');
		expect(stepIndexAtLine(program, 0)).toBeNull();
		expect(stepIndexAtLine(program, 999)).toBeNull();
		expect(stepPathAtLine(program, 0)).toBeNull();
		expect(lineOfStep(program, '99')).toBeNull();
		expect(lineOfStep(program, '9.then.0')).toBeNull();
		expect(linesOfTopStep(program, 99)).toEqual([]);
		expect(lineText(program, 999)).toBeNull();
	});

	it('调用行数 = 树里的调用条数，且每一行都指向真实的语句', () => {
		for (const capability of FIXTURE_CATALOG.capabilities) {
			const parameters: JsonObject = { step_id: 's1', action: capability.capabilityRef };
			for (const parameter of capability.parameters) {
				parameters[parameter.name] =
					parameter.type === 'sensor' ? ['/scan0'] : parameter.type === 'number' ? 1 : true;
			}
			const program = render(parameters);
			const calls = statementCalls(capability.implementation);

			expect(callLines(program)).toHaveLength(calls.length);
			// 每一行的路径都能在树里找到那条语句（顶层或任意嵌套深度）
			for (const line of callLines(program)) {
				expect(calls.map((call) => call.path)).toContain(line.stepPath);
			}
			// 顶层下标不重不漏，且 ≤ 顶层语句数
			expect([...new Set(program.lines.map((line) => line.stepIndex))]).toEqual(
				capability.implementation.map((_, index) => index),
			);
		}
	});
});

describe('数值不失真', () => {
	it('渲染出来的每个数值实参读回来都是原值', () => {
		const declaration = sampleDeclaration();
		for (const node of declaration.nodes) {
			const program = renderImplementation({ node, catalog: FIXTURE_CATALOG, declaration });
			for (const line of callLines(program)) {
				const capability = findCapability(FIXTURE_CATALOG, String(node.parameters['action']));
				const primitive = line.primitiveRef === null ? undefined : findPrimitive(FIXTURE_CATALOG, line.primitiveRef);
				if (capability === undefined || primitive === undefined) continue;

				const args = argsOf(line.text);
				for (const parameter of primitive.parameters) {
					const rendered = args.get(parameter.name);
					expect(rendered).toBeDefined();
					// 节点上的原值：能力参数就取同名那个
					const original = node.parameters[parameter.name];
					if (typeof original === 'number') expect(Number(rendered)).toBe(original);
					if (Array.isArray(original)) expect(JSON.parse(rendered as string)).toEqual(original);
				}
			}
		}
	});

	it('需要更多位小数时不会为了好看而截断', () => {
		const program = render({ step_id: 's3', action: 'turn', angular: 0.0625, duration: 0.125 });
		expect(texts(program)).toEqual([
			'set_velocity(linear=0.0, angular=0.0625)',
			'wait(seconds=0.125)',
			'stop_motion()',
		]);
	});

	it('整数值仍渲染成浮点（0 → 0.0、5 → 5.0），超大数值原样输出', () => {
		const program = render({ step_id: 's1', action: 'move', linear: 0, angular: 0, duration: 1 });
		expect(texts(program)[0]).toBe('set_velocity(linear=0.0, angular=0.0)');
		expect(texts(program)[1]).toBe('wait(seconds=1.0)');

		const huge = render({ step_id: 's3', action: 'turn', angular: 1e21, duration: 2 });
		expect(texts(huge)[0]).toBe('set_velocity(linear=0.0, angular=1e+21)');
	});

	it('实参引用的参数在本节点取不到值 → 占位符 + 诊断，不静默编一个数', () => {
		const program = render({ step_id: 's1', action: 'move', linear: 0.2 });
		expect(texts(program)).toEqual([
			'set_velocity(linear=0.2, angular=null)',
			'wait(seconds=null)',
			'stop_motion()',
		]);
		// 语句树里 `angular`/`duration` 是 `{kind:'param'}` 引用：取不到值走「引用解析不了」那条诊断。
		expect(program.diagnostics.map((diagnostic) => diagnostic.code)).toEqual([
			'code_render.param.unresolved',
			'code_render.param.unresolved',
		]);
	});

	it('原语缺了某个实参（连引用都没有）→ 占位符 + argument.missing', () => {
		const program = render(
			{ action: 'missing_arg' },
			{
				catalog: catalogWith({
					capabilityRef: 'missing_arg',
					label: '缺实参',
					kind: 'skill',
					parameters: [],
					implementation: [{ kind: 'call', primitiveRef: 'set_velocity', arguments: { linear: 0.2 } }],
				}),
			},
		);
		expect(texts(program)).toEqual(['set_velocity(linear=0.2, angular=null)']);
		expect(program.diagnostics.map((diagnostic) => diagnostic.code)).toEqual([
			'code_render.argument.missing',
		]);
	});
});

describe('目录里查不到的东西不假装认识', () => {
	it('能力不在目录里 → error 诊断 + 说明行，节点名仍显示出来', () => {
		const program = render({ step_id: 's1', action: 'publish_to_hardware' });

		expect(texts(program)).toEqual(['# 查不到能力「publish_to_hardware」的实现']);
		expect(program.lines[0]).toMatchObject({ kind: 'unsupported', stepIndex: null });
		expect(program.callCount).toBe(0);
		expect(program.title).toBe('publish_to_hardware · 实现');
		expect(program.diagnostics.map((diagnostic) => diagnostic.code)).toEqual([
			'code_render.capability.unknown',
		]);
		expect(program.diagnostics[0]?.severity).toBe('error');
	});

	it('节点连 action 都没有 → 另一条诊断，不冒充「能力不存在」', () => {
		const program = render({ step_id: 's1' });
		expect(program.diagnostics.map((diagnostic) => diagnostic.code)).toEqual([
			'code_render.node.action_missing',
		]);
		expect(program.lines[0]?.kind).toBe('unsupported');
	});

	it('实现指向的原语不在目录里 → error 诊断 + 说明行，这一步仍然占着行', () => {
		const program = render(
			{ step_id: 's1', action: 'broken' },
			{
				catalog: catalogWith({
					capabilityRef: 'broken',
					label: '断的',
					kind: 'skill',
					parameters: [],
					implementation: [
						{ kind: 'call', primitiveRef: 'wait', arguments: { seconds: 1 } },
						{ kind: 'call', primitiveRef: 'teleport', arguments: {} },
					],
				}),
			},
		);

		expect(trimmed(program)).toEqual(['wait(seconds=1.0)', '# 目录里没有原语「teleport」']);
		expect(program.callCount).toBe(1);
		expect(program.steps.map((step) => step.known)).toEqual([true, false]);
		expect(program.lines[1]).toMatchObject({
			kind: 'unsupported',
			stepIndex: 1,
			stepPath: '1',
			primitiveRef: 'teleport',
			known: false,
		});
		expect(program.diagnostics.map((diagnostic) => diagnostic.code)).toEqual([
			'code_render.primitive.unknown',
		]);
		expect(program.diagnostics[0]?.severity).toBe('error');
	});

	it('嵌套在 if 里的未知原语：缩进保住，诊断指得出路径', () => {
		const program = render(
			{ step_id: 's1', action: 'nested_broken' },
			{
				catalog: catalogWith({
					capabilityRef: 'nested_broken',
					label: '嵌套断的',
					kind: 'skill',
					parameters: [],
					implementation: [
						{
							kind: 'if',
							condition: { kind: 'literal', value: true },
							then: [{ kind: 'call', primitiveRef: 'teleport', arguments: {} }],
						},
					],
				}),
			},
		);

		expect(texts(program)).toEqual(['if true:', '    # 目录里没有原语「teleport」']);
		expect(program.diagnostics[0]?.details).toMatchObject({ stepPath: '0.then.0' });
		expect(program.callCount).toBe(0);
		expect(lineOfStep(program, '0.then.0')).toBe(2);
	});

	it('表达式里用了没声明返回值的原语 → 点出来，但照渲染', () => {
		const program = render(
			{ step_id: 's1', action: 'bad_expr' },
			{
				catalog: catalogWith({
					capabilityRef: 'bad_expr',
					label: '表达式用错原语',
					kind: 'skill',
					parameters: [],
					implementation: [
						{
							kind: 'set',
							target: 'x',
							value: { kind: 'call', primitiveRef: 'stop_motion', arguments: {} },
						},
					],
				}),
			},
		);

		expect(texts(program)).toEqual(['x = stop_motion()']);
		expect(program.diagnostics.map((diagnostic) => diagnostic.code)).toEqual([
			'code_render.primitive.not_returning',
		]);
	});

	it('空目录也不崩：所有能力都按「查不到」处理', () => {
		const program = render(
			{ step_id: 's1', action: 'move' },
			{
				catalog: {
					...FIXTURE_CATALOG,
					capabilities: [
						{
							capabilityRef: 'none',
							label: '空',
							kind: 'skill',
							parameters: [],
							implementation: [{ kind: 'call', primitiveRef: 'nothing', arguments: {} }],
						},
					],
				},
			},
		);
		expect(program.diagnostics.map((diagnostic) => diagnostic.code)).toEqual([
			'code_render.capability.unknown',
		]);
	});
});

describe('安全限值必须看得见（属于整个任务，不随选中的模块变）', () => {
	it('限值取自声明 meta，单位从引用它的字段上取', () => {
		const program = renderSample('move');
		expect(program.limits.present).toBe(true);
		expect(program.limits.numeric.map((limit) => [limit.name, limit.value, limit.unit, limit.text])).toEqual([
			['max_linear', 0.3, 'm/s', '0.3 m/s'],
			['max_angular', 1.2, 'rad/s', '1.2 rad/s'],
			['max_duration', 30, 's', '30 s'],
		]);
		expect(program.limits.requireConfirmation).toBe(true);
		expect(program.limits.numeric.every((limit) => limit.tightened === false)).toBe(true);
	});

	it('换一个选中的模块，限值一模一样（它是任务级的）', () => {
		const declaration = sampleDeclaration();
		const first = renderSample('move', declaration);
		const second = renderSample('stop', declaration);
		expect(second.limits).toEqual(first.limits);
	});

	it('收紧过的限值标出 tightened', () => {
		const declaration = declarationOf([nodeOf({ step_id: 's1', action: 'stop' })], {
			limits: { max_linear: 0.1, max_angular: 1.2, max_duration: 5.0, require_confirmation: false },
		});
		const program = render({ step_id: 's1', action: 'stop' }, { declaration });
		expect(program.limits.numeric.map((limit) => limit.tightened)).toEqual([true, false, true]);
		expect(program.limits.requireConfirmation).toBe(false);
	});

	it('声明层面拦不到的「放宽」在这里被点出来', () => {
		const declaration = declarationOf([nodeOf({ step_id: 's1', action: 'stop' })], {
			limits: { max_linear: 5, max_angular: 1.2, max_duration: 30.0, require_confirmation: true },
		});
		const program = render({ step_id: 's1', action: 'stop' }, { declaration });
		const exceeded = program.diagnostics.find(
			(diagnostic) => diagnostic.code === 'code_render.limit.exceeds_safety',
		);
		expect(exceeded?.severity).toBe('error');
		expect(exceeded?.details).toEqual({ value: 5, safety_ceiling: 0.3 });
	});

	it('没有 meta.limits 时退到安全上限，**但不报诊断**（不是每种任务格式都有这一栏）', () => {
		const program = render(
			{ step_id: 's1', action: 'stop' },
			{ declaration: declarationOf([nodeOf({ step_id: 's1', action: 'stop' })], {}) },
		);
		expect(program.limits.present).toBe(false);
		expect(program.limits.numeric.map((limit) => limit.value)).toEqual([0.3, 1.2, 30.0]);
		// 技能计划的 `meta` 里本来就没有 limits；为此报红字等于拿一期的尺子量别人。
		expect(program.diagnostics).toEqual([]);
	});
});

describe('整数字段与字符串字面量', () => {
	/**
	 * 目录里标了 `integer` 的参数（关节号、毫秒时长）不该渲染成 `3.0` / `1500.0`；
	 * 没标的仍然带小数——`joint`（角度）就是这一侧，90 度写成 `90.0` 是对的。
	 * 这条钉住的是「标记生效」与「没标记就别乱改」两件事。
	 */
	it('标了 integer 的不带小数，没标的照旧', () => {
		const program = render({ action: 'arm_joint', joint_id: 3, joint: 90, time: 1500 });
		expect(texts(program)[0]).toBe('drive_joint(joint_id=3, angle=90.0, time=1500)');
	});

	it('六关节的关节号不受影响（角度可小数）', () => {
		const program = render({
			action: 'arm6_joints',
			joint1: 10,
			joint2: 20,
			joint3: 30,
			joint4: 40,
			joint5: 50,
			joint6: 60,
			time: 1500,
		});
		expect(texts(program)[0]).toBe(
			'drive_joints(joint1=10.0, joint2=20.0, joint3=30.0, joint4=40.0, joint5=50.0, joint6=60.0, time=1500)',
		);
	});

	it('字符串与布尔字面量：加引号 / 写 true|false（字面量是叶子，不加括号）', () => {
		const program = render(
			{ action: 'literals' },
			{
				catalog: catalogWith({
					capabilityRef: 'literals',
					label: '字面量',
					kind: 'skill',
					parameters: [],
					implementation: [
						{ kind: 'set', target: 'a', value: { kind: 'literal', value: 'scan0' } },
						{ kind: 'set', target: 'b', value: { kind: 'literal', value: true } },
						{ kind: 'set', target: 'c', value: { kind: 'literal', value: false } },
					],
				}),
			},
		);
		expect(texts(program)).toEqual(['a = "scan0"', 'b = true', 'c = false']);
	});
});

describe('样例之外的目录形状（防回归）', () => {
	it('空实现清单的能力：渲染出空程序而不是崩溃', () => {
		const program = render(
			{ action: 'noop' },
			{
				catalog: catalogWith({
					capabilityRef: 'noop',
					label: '什么都不做',
					kind: 'skill',
					parameters: [],
					// 契约要求至少一条语句，这里放一条无参数调用，退化成一行。
					implementation: [{ kind: 'call', primitiveRef: 'stop_motion', arguments: {} }],
				}),
			},
		);
		expect(texts(program)).toEqual(['stop_motion()']);
		expect(program.lines[0]?.stepPath).toBe('0');
	});

	it('实现里引用不存在的局部变量时给诊断，不编值', () => {
		const program = render(
			{ action: 'weird' },
			{
				catalog: catalogWith({
					capabilityRef: 'weird',
					label: '怪引用',
					kind: 'skill',
					parameters: [],
					implementation: [
						{ kind: 'set', target: 'r', value: { kind: 'param', name: 'ghost' } },
					],
				}),
			},
		);
		expect(texts(program)).toEqual(['r = (null)']);
		expect(program.diagnostics.map((diagnostic) => diagnostic.code)).toEqual([
			'code_render.param.unresolved',
		]);
	});
});

/** 老测试里 `sampleNode` 用不上了，但保留它把「示例任务的节点」这条口径钉住（防语料漂移）。 */
describe('示例语料本身', () => {
	it('示例任务里那四步都还在，参数没被改过', () => {
		expect(sampleNode('move').parameters).toMatchObject({ linear: 0.2, angular: 0, duration: 5 });
		expect(sampleNode('stop_if_obstacle').parameters).toMatchObject({ sensors: ['/scan0'], distance: 0.5 });
	});
});

describe('实参位置的局部变量', () => {
	/**
	 * 这条曾经是错的：实参位置（`名字=值`）遇到局部变量时，渲染器会退回节点同名字段去取值，
	 * 取不到就渲染成 `null`——而 `set_velocity(linear=speed)` 才是这段程序真实的样子。
	 * 局部变量的值由运行时上一条赋值决定，渲染层算不出来，写名字是唯一诚实的做法。
	 */
	it('写变量名，而不是退回节点字段（那会渲染成 null）', () => {
		const program = render({ action: 'clamped_move', linear: 0.2, duration: 5 });
		const text = texts(program).join('\n');
		expect(text).toContain('set_velocity(linear=speed, angular=0.0)');
		expect(text).not.toContain('null');
		expect(program.diagnostics.filter((diagnostic) => diagnostic.severity === 'error')).toEqual([]);
	});

	it('夹限速那一支的赋值照样渲染出来（夹过才下发）', () => {
		const program = render({ action: 'clamped_move', linear: 0.9, duration: 5 });
		expect(texts(program).join('\n')).toContain('speed = 0.3');
	});
});

// ---------------------------------------------------------------------------
// 结构化载荷（`json` 类型的实参）
// ---------------------------------------------------------------------------

describe('结构化载荷：短的就地写，长的摊开，续行仍属于同一步', () => {
	/** `pose_dance` 的第 2 步是一整个嵌套结构，紧凑形态远超一行的容忍宽度。 */
	const LONG = {
		type: 'wave_dance_v1',
		active_waypoint_count: 48,
		base_pose: { '1': 0.02, '2': 0.54, '3': -0.82 },
		joints: { '5': { terms: [{ amplitude: 0.28, harmonic: 1 }] } },
	};

	const poseDance = (): RenderedImplementation => render({ step_id: 's1', action: 'pose_dance', duration: 2 });

	it('短的写成一行的紧凑 JSON，一条语句还是一行', () => {
		const program = poseDance();
		const first = program.lines[0];
		expect(first?.kind).toBe('call');
		expect(first?.text.trim()).toBe(
			'move_to_joint_positions(joint_positions={"1":0.02,"2":0.54}, duration_sec=2.0)',
		);
	});

	it('长的摊成多行：头一行是语句，续行标成 argument，收尾那行退回语句缩进', () => {
		const program = poseDance();
		const lines = linesOfTopStep(program, 1);
		expect(lines.length).toBeGreaterThan(3);
		expect(lines[0]?.kind).toBe('call');
		expect(lines[0]?.text.trimEnd().endsWith('joint_positions={')).toBe(true);
		expect(lines.at(-1)?.text.trim()).toBe('}, duration_sec=2.0)');
		for (const line of lines.slice(1)) {
			expect(line.kind, line.text).toBe('argument');
			expect(line.stepIndex).toBe(1);
			expect(line.stepPath).toBe('1');
			// 续行比语句深一档；只有收尾那行退回语句的缩进（读起来才像一次调用）。
			expect(line.indent).toBe(line === lines.at(-1) ? 0 : 1);
		}
		// 「几个原语」只数真正的调用行：两步就两个，续行不算。
		expect(callLines(program).length).toBe(2);
		expect(program.steps.length).toBe(2);
	});

	it('摊开的 JSON 读回来必须还是原值（不截断、不改写）', () => {
		const program = poseDance();
		const joined = linesOfTopStep(program, 1)
			.map((line) => line.text.trim())
			.join('\n');
		const prefix = 'move_to_joint_positions(joint_positions=';
		const suffix = ', duration_sec=2.0)';
		expect(joined.startsWith(prefix)).toBe(true);
		expect(joined.endsWith(suffix)).toBe(true);
		const body = joined.slice(prefix.length, joined.length - suffix.length);
		expect(body).toContain('\n');
		expect(JSON.parse(body)).toEqual(LONG);
	});

	it('行 ↔ 步骤的映射不被续行带偏：续行属于它那一句，且指向的那一行仍是语句头', () => {
		const program = poseDance();
		const lines = linesOfTopStep(program, 1);
		for (const line of lines) expect(stepIndexAtLine(program, line.line)).toBe(1);
		// 正向查询取到的是**头一行**（不是某条续行）——界面据此把整段高亮起来。
		expect(lineOfStep(program, '1')).toBe(lines[0]?.line);
		expect(lineText(program, lines[0]?.line ?? 0)?.trimEnd().endsWith('joint_positions={')).toBe(true);
	});
});

describe('委托：实现在执行侧，就照实说，不编步骤', () => {
	const pick = (overrides: JsonObject = {}): RenderedImplementation =>
		render({ step_id: 's1', action: 'pick_object', target_name: '红色方块', ...overrides });

	it('渲染成说明行 + 委托行两行，接口名与实参逐字写出', () => {
		const program = pick();
		expect(texts(program)).toEqual([
			'# 实现在执行侧，不在模板里：/manipulation/execute_pick',
			'delegate /manipulation/execute_pick(target_name="红色方块")',
		]);
		expect(program.lines.map((line) => line.kind)).toEqual(['comment', 'delegate']);
	});

	it('实参名与顺序来自**本能力的参数表**，不是原语表', () => {
		const program = pick();
		// 能力只有一个参数；原语表里没有任何原语叫 target_name。
		expect(argsOf(program.lines[1]?.text ?? '').get('target_name')).toBe('"红色方块"');
		expect(FIXTURE_CATALOG.primitives.some((primitive) => primitive.parameters.some((p) => p.name === 'target_name'))).toBe(false);
	});

	it('委托**不算**一次原语调用：调用行数为 0，但这一步照样占一步', () => {
		const program = pick();
		expect(callLines(program)).toEqual([]);
		expect(program.callCount).toBe(0);
		expect(program.steps).toHaveLength(1);
		expect(program.steps[0]).toMatchObject({ path: '0', kind: 'delegate', primitiveRef: null, known: true, lineCount: 2 });
	});

	it('说明行与委托行同属一步：联动高亮不会把说明行落下', () => {
		const program = pick();
		for (const line of program.lines) {
			expect(line.stepIndex).toBe(0);
			expect(line.stepPath).toBe('0');
			// 委托行不冒充原语：它调的不是本目录里的任何东西。
			expect(line.primitiveRef).toBeNull();
		}
		expect(stepIndexAtLine(program, 1)).toBe(0);
		expect(stepIndexAtLine(program, 2)).toBe(0);
		// 正向查询给的是**头一行**（说明行）——整段一起高亮。
		expect(lineOfStep(program, '0')).toBe(1);
	});

	it('嵌在 else 里也照旧：缩进一档、路径是 0.else.0、顶层仍只有一步', () => {
		const program = render({ step_id: 's1', action: 'guarded_pick', target_name: '方块', confirm: false });
		const delegate = program.lines.find((line) => line.kind === 'delegate');
		expect(delegate?.stepPath).toBe('0.else.0');
		expect(delegate?.indent).toBe(1);
		expect(delegate?.text).toBe(`${INDENT_UNIT}delegate /manipulation/execute_pick(target_name="方块")`);
		// 顶层一条 `if`，所以只占一步；里面那个 `brake()` 才是唯一的原语调用。
		expect(program.steps).toHaveLength(1);
		expect(callLines(program).map((line) => line.text.trim())).toEqual(['brake()']);
	});

	it('实参取不到值时给占位符 + 警告，不静默写一个空串', () => {
		const program = render({ step_id: 's1', action: 'pick_object' });
		expect(program.lines[1]?.text).toBe('delegate /manipulation/execute_pick(target_name=null)');
		expect(program.diagnostics.map((diagnostic) => diagnostic.code)).toContain('code_render.param.unresolved');
	});

	it('能力参数只是接口签名的**超集**：没交出去的参数不编占位符', () => {
		// `guarded_pick.confirm` 由同棵树里的 `if` 用掉，并不转发给接口——
		// 渲染成 `confirm=null` 就是凭空给接口加了一个它没有的实参。
		const program = render({ step_id: 's1', action: 'guarded_pick', target_name: '方块', confirm: true });
		const delegate = program.lines.find((line) => line.kind === 'delegate');
		expect(delegate?.text).toBe(`${INDENT_UNIT}delegate /manipulation/execute_pick(target_name="方块")`);
	});

	it('接上上游那份真目录：抓取技能的委托就是 /manipulation/execute_pick', () => {
		const grasp = ROBOFRAME_GRASP_CATALOG;
		const program = renderImplementation({
			node: nodeOf({ step_id: 's1', action: 'pick_object', target_name: '方块' }),
			catalog: grasp,
			declaration: declarationOf([nodeOf({})]),
		});
		expect(program.lines.some((line) => line.text.includes('delegate /manipulation/execute_pick('))).toBe(true);
		// 目录里的 10 个原语是上游 skill_library 的白名单，委托的接口名**不在**里面。
		expect(grasp.primitives.some((primitive) => primitive.primitiveRef.includes('/'))).toBe(false);
		expect(program.diagnostics.filter((diagnostic) => diagnostic.severity === 'error')).toEqual([]);
	});
});
