/**
 * 代码面板渲染的验收测试（新模型：**一个模块 = 一个函数，面板显示它的实现**）。
 *
 * 四件事必须有机械证据：
 * 1. 渲染规则**可追溯到原语定义**（`catalog.primitives[].parameters`）——参数名与顺序一个都不手写；
 * 2. `$name` 占位取的是**本节点**的同名参数，字面量照原样；
 * 3. 行 ↔ implementation 步骤的映射（正反两向）真能对上，含注释行造成的偏移；
 * 4. 数字**不失真**——渲染出的字面量读回来必须还是原值；任务级限值照旧看得见。
 */
import { describe, expect, it } from 'vitest';
import { PHASE1_ROBOT_CATALOG } from '@codecanvas/capabilities';
import {
	computeWorkflowDigest,
	DEFAULT_LIMITS,
	findCapability,
	findPrimitive,
	WORKFLOW_FORMAT_VERSION,
	type CapabilityCatalog,
	type CatalogParameter,
	type JsonObject,
	type JsonValue,
	type WorkflowDeclaration,
	type WorkflowDeclarationDraft,
	type WorkflowNode,
} from '@codecanvas/contracts';
import { importTaskJson } from '@codecanvas/task-import';
import {
	callLines,
	lineOfStep,
	lineText,
	renderImplementation,
	stepIndexAtLine,
	type RenderedImplementation,
} from '../src/index';

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

const nodeOf = (parameters: JsonObject, overrides: Partial<WorkflowNode> = {}): WorkflowNode => ({
	id: overrides.id ?? 'nd_1',
	name: overrides.name ?? '测试节点',
	type: 'task.action',
	typeVersion: 1,
	parameters,
	position: { x: 0, y: 0 },
	disabled: false,
	...overrides,
});

/** 手工造的声明默认带一份协议缺省限值，免得每条用例都吃一条 limits 缺失的诊断。 */
const META_WITH_LIMITS: JsonObject = { limits: { ...DEFAULT_LIMITS } };

const declarationOf = (
	nodes: readonly WorkflowNode[],
	meta: JsonObject = META_WITH_LIMITS,
): WorkflowDeclaration => {
	const draft: WorkflowDeclarationDraft = {
		formatVersion: WORKFLOW_FORMAT_VERSION,
		id: 'wf_test',
		name: '测试声明',
		nodes: [...nodes],
		connections: {},
		meta,
	};
	return { ...draft, digest: computeWorkflowDigest(draft) };
};

/** 渲染一个节点（默认用一期设备目录 + 一份带限值的手工声明）。 */
const render = (
	parameters: JsonObject,
	options: { overrides?: Partial<WorkflowNode>; catalog?: CapabilityCatalog; declaration?: WorkflowDeclaration | null } = {},
): RenderedImplementation =>
	renderImplementation({
		node: nodeOf(parameters, options.overrides ?? {}),
		catalog: options.catalog ?? PHASE1_ROBOT_CATALOG,
		declaration: options.declaration === undefined ? declarationOf([nodeOf(parameters)]) : options.declaration,
	});

const texts = (program: RenderedImplementation): string[] => program.lines.map((line) => line.text);

/** 按动作取示例任务里的那个节点：它的参数就是任务的参数。 */
const sampleNode = (action: string): WorkflowNode => {
	const found = sampleDeclaration().nodes.find((node) => node.parameters['action'] === action);
	if (found === undefined) throw new Error(`sample task has no ${action} step`);
	return found;
};

const renderSample = (action: string, declaration: WorkflowDeclaration = sampleDeclaration()) => {
	const node = declaration.nodes.find((item) => item.parameters['action'] === action);
	if (node === undefined) throw new Error(`declaration has no ${action} step`);
	return renderImplementation({ node, catalog: PHASE1_ROBOT_CATALOG, declaration });
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
		const trimmed = part.trim();
		const eq = trimmed.indexOf('=');
		args.set(trimmed.slice(0, eq), trimmed.slice(eq + 1));
	}
	return args;
};

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

	it('避障停止（stop_if_obstacle）：传感器数组照字面量，阈值来自本节点', () => {
		const program = renderSample('stop_if_obstacle');

		expect(texts(program)).toEqual([
			'read_scan(sensor=["/scan0"])',
			'compare_below(threshold=0.5)',
			'brake()',
		]);
		expect(program.title).toBe('避障停止 · 实现');
		expect(program.diagnostics).toEqual([]);
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

	it('text 就是各行用换行拼起来（面板与文本两条路不会分叉）', () => {
		const program = renderSample('move');
		expect(program.text).toBe(program.lines.map((line) => line.text).join('\n'));
	});

	it('没选中模块时给空程序，不编造内容', () => {
		const declaration = sampleDeclaration();
		const program = renderImplementation({ node: null, catalog: PHASE1_ROBOT_CATALOG, declaration });

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
		}
	};

	it.each(PHASE1_ROBOT_CATALOG.capabilities.map((capability) => capability.capabilityRef))(
		'%s 的每一行调用：参数名与顺序逐字来自 catalog.primitives',
		(capabilityRef) => {
			const capability = findCapability(PHASE1_ROBOT_CATALOG, capabilityRef);
			expect(capability).toBeDefined();
			if (capability === undefined) return;

			const parameters: JsonObject = { step_id: 's1', action: capabilityRef };
			for (const parameter of capability.parameters) parameters[parameter.name] = paramValue(parameter.type);

			const program = render(parameters);

			// 行数 = implementation 步数；一行一个原语调用
			expect(program.lines).toHaveLength(capability.implementation.length);
			expect(program.callCount).toBe(capability.implementation.length);

			for (const [index, step] of capability.implementation.entries()) {
				const primitive = findPrimitive(PHASE1_ROBOT_CATALOG, step.step);
				expect(primitive).toBeDefined();
				if (primitive === undefined) continue;

				const line = lineText(program, index + 1);
				expect(line).not.toBeNull();
				if (line === null) continue;

				// 原语名 + 参数名序列 + 顺序，全部来自定义，测试这边只做对照
				expect(line.startsWith(`${step.step}(`)).toBe(true);
				expect([...argsOf(line).keys()]).toEqual(primitive.parameters.map((parameter) => parameter.name));
			}

			expect(program.diagnostics).toEqual([]);
		},
	);

	it('无参数的原语一律渲染成 `名字()`，不留空括号里的空格', () => {
		expect(texts(render({ step_id: 's1', action: 'stop' }))).toEqual(['stop_motion()']);
		expect(texts(render({ step_id: 's1', action: 'get_status' }))).toEqual(['read_status()']);
	});

	it('原语定义里没有的实参不渲染（实现写多了也不许偷偷进代码）', () => {
		const catalog: CapabilityCatalog = {
			...PHASE1_ROBOT_CATALOG,
			capabilities: [
				{
					capabilityRef: 'extra_args',
					label: '多余的实参',
					kind: 'skill',
					parameters: [{ name: 'v', label: '速度', type: 'number' }],
					implementation: [{ step: 'set_velocity', arguments: { linear: '$v', angular: 9, nope: 1 } }],
				},
			],
		};
		const program = render({ step_id: 's1', action: 'extra_args', v: 0.2 }, { catalog });

		// `nope` 在原语定义里没有 → 不进代码，只出诊断；`angular` 是字面量，照原样。
		expect(texts(program)).toEqual(['set_velocity(linear=0.2, angular=9.0)']);
		expect(program.diagnostics.map((diagnostic) => diagnostic.code)).toEqual([
			'code_render.argument.undeclared',
		]);
		expect(program.diagnostics[0]?.details).toMatchObject({ argument: 'nope' });
	});
});

describe('$name 占位与字面量', () => {
	it('$name 取本节点同名参数，改参数 → 那一行的数字跟着变', () => {
		const first = render({ step_id: 's1', action: 'move', linear: 0.2, angular: 0, duration: 5 }, {
			declaration: declarationOf([nodeOf({ step_id: 's1', action: 'move', linear: 0.2, angular: 0, duration: 5 })]),
		});
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

	it('$name 指不到本节点的参数时给诊断 + 占位符，不猜', () => {
		const catalog: CapabilityCatalog = {
			...PHASE1_ROBOT_CATALOG,
			capabilities: [
				{
					capabilityRef: 'dangling',
					label: '悬空引用',
					kind: 'skill',
					parameters: [],
					implementation: [{ step: 'wait', arguments: { seconds: '$duration' } }],
				},
			],
		};
		const program = render({ step_id: 's1', action: 'dangling' }, { catalog });

		expect(texts(program)).toEqual(['wait(seconds=null)']);
		expect(program.diagnostics.map((diagnostic) => diagnostic.code)).toEqual(['code_render.argument.missing']);
		expect(program.diagnostics[0]?.severity).toBe('warning');
	});

	it('传感器数组保持顺序；空数组与非数组都给诊断', () => {
		const many = render({ step_id: 's2', action: 'stop_if_obstacle', sensors: ['/scan1', '/scan0'], distance: 0.5 });
		expect(texts(many)[0]).toBe('read_scan(sensor=["/scan1", "/scan0"])');

		const empty = render({ step_id: 's2', action: 'stop_if_obstacle', sensors: [], distance: 0.5 });
		expect(texts(empty)[0]).toBe('read_scan(sensor=[])');
		expect(empty.diagnostics.map((diagnostic) => diagnostic.code)).toEqual([
			'code_render.argument.empty_sensor_array',
		]);

		const wrong = render({ step_id: 's2', action: 'stop_if_obstacle', sensors: '/scan0', distance: 0.5 });
		expect(texts(wrong)[0]).toBe('read_scan(sensor=[])');
		expect(wrong.diagnostics.map((diagnostic) => diagnostic.code)).toEqual([
			'code_render.argument.not_sensor_array',
		]);
	});
});

describe('行 ↔ implementation 步骤的映射', () => {
	it('每一行都带步骤号（0 基），steps[] 与之一一对应', () => {
		const program = renderSample('move');
		const capability = findCapability(PHASE1_ROBOT_CATALOG, 'move');
		expect(capability).toBeDefined();
		if (capability === undefined) return;

		expect(program.steps).toHaveLength(capability.implementation.length);
		expect(program.lines.map((line) => line.stepIndex)).toEqual([0, 1, 2]);
		expect(program.steps.map((step) => step.primitiveRef)).toEqual(
			capability.implementation.map((step) => step.step),
		);
		expect(program.steps.every((step) => step.known)).toBe(true);

		for (const step of program.steps) {
			expect(stepIndexAtLine(program, step.line)).toBe(step.index);
			expect(lineOfStep(program, step.index)).toBe(step.line);
			expect(program.lines[step.line - 1]?.primitiveRef).toBe(step.primitiveRef);
		}
	});

	it('注释行不占步骤号，但会让后面几行的行号整体偏移（映射不是 index+1 硬算的）', () => {
		const parameters: JsonObject = { step_id: 's1', action: 'move', linear: 0.2, angular: 0, duration: 5 };
		const program = renderImplementation({
			node: nodeOf(parameters, { disabled: true, name: '前进（停用）' }),
			catalog: PHASE1_ROBOT_CATALOG,
			declaration: declarationOf([nodeOf(parameters)]),
		});

		expect(texts(program)).toEqual([
			'# disabled: 前进（停用）',
			'set_velocity(linear=0.2, angular=0.0)',
			'wait(seconds=5.0)',
			'stop_motion()',
		]);
		expect(program.lines[0]).toMatchObject({ kind: 'comment', stepIndex: null, primitiveRef: null });
		expect(stepIndexAtLine(program, 1)).toBeNull();
		expect(program.lines.map((line) => line.stepIndex)).toEqual([null, 0, 1, 2]);
		expect(lineOfStep(program, 0)).toBe(2);
	});

	it('越界行号 / 步骤号给 null，不猜', () => {
		const program = renderSample('move');
		expect(stepIndexAtLine(program, 0)).toBeNull();
		expect(stepIndexAtLine(program, 999)).toBeNull();
		expect(lineOfStep(program, 99)).toBeNull();
		expect(lineText(program, 999)).toBeNull();
	});

	it('调用行数 = 实现步数，且每一行的步骤号都不重不漏', () => {
		for (const capability of PHASE1_ROBOT_CATALOG.capabilities) {
			const parameters: JsonObject = { step_id: 's1', action: capability.capabilityRef };
			for (const parameter of capability.parameters) {
				parameters[parameter.name] =
					parameter.type === 'sensor' ? ['/scan0'] : parameter.type === 'number' ? 1 : true;
			}
			const program = render(parameters);
			const indexes = callLines(program).map((line) => line.stepIndex);

			expect(callLines(program)).toHaveLength(capability.implementation.length);
			expect(indexes).toEqual(capability.implementation.map((_, index) => index));
		}
	});
});

describe('数值不失真', () => {
	it('渲染出来的每个数值实参读回来都是原值', () => {
		const declaration = sampleDeclaration();
		for (const node of declaration.nodes) {
			const program = renderImplementation({ node, catalog: PHASE1_ROBOT_CATALOG, declaration });
			for (const step of program.steps) {
				const line = lineText(program, step.line);
				expect(line).not.toBeNull();
				if (line === null) continue;
				const capability = findCapability(PHASE1_ROBOT_CATALOG, String(node.parameters['action']));
				const implementation = capability?.implementation[step.index];
				const primitive = findPrimitive(PHASE1_ROBOT_CATALOG, step.primitiveRef);
				if (implementation === undefined || primitive === undefined) continue;

				const args = argsOf(line);
				for (const parameter of primitive.parameters) {
					const rendered = args.get(parameter.name);
					expect(rendered).toBeDefined();
					const raw = implementation.arguments[parameter.name];
					// 只有引用本节点参数的实参才和节点上的数字比得上
					if (typeof raw !== 'string' || !raw.startsWith('$')) continue;
					const original = node.parameters[raw.slice(1)];
					// 传感器这类数组实参按字面量比；数值走「读回来还是原值」那条。
					if (Array.isArray(original)) {
						expect(JSON.parse(rendered as string)).toEqual(original);
					} else {
						expect(Number(rendered)).toBe(original);
					}
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

	it('取不到值的实参渲染成占位符并给诊断，不静默编一个数', () => {
		const program = render({ step_id: 's1', action: 'move', linear: 0.2 });
		expect(texts(program)).toEqual([
			'set_velocity(linear=0.2, angular=null)',
			'wait(seconds=null)',
			'stop_motion()',
		]);
		expect(program.diagnostics.map((diagnostic) => diagnostic.code)).toEqual([
			'code_render.argument.missing',
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

	it('实现指向的原语不在目录里 → error 诊断 + 说明行，步骤号仍然占位', () => {
		const catalog: CapabilityCatalog = {
			...PHASE1_ROBOT_CATALOG,
			capabilities: [
				{
					capabilityRef: 'broken',
					label: '断的',
					kind: 'skill',
					parameters: [],
					implementation: [
						{ step: 'wait', arguments: { seconds: 1 } },
						{ step: 'teleport', arguments: {} },
					],
				},
			],
		};
		const program = render({ step_id: 's1', action: 'broken' }, { catalog });

		expect(texts(program)).toEqual(['wait(seconds=1.0)', '# 目录里没有原语「teleport」']);
		expect(program.callCount).toBe(1);
		expect(program.steps.map((step) => step.known)).toEqual([true, false]);
		expect(program.lines[1]).toMatchObject({ kind: 'unsupported', stepIndex: 1, primitiveRef: 'teleport' });
		expect(program.diagnostics.map((diagnostic) => diagnostic.code)).toEqual([
			'code_render.primitive.unknown',
		]);
		expect(program.diagnostics[0]?.severity).toBe('error');
	});

	it('空目录也不崩：所有能力都按「查不到」处理', () => {
		const catalog: CapabilityCatalog = { ...PHASE1_ROBOT_CATALOG, capabilities: [
			{ capabilityRef: 'none', label: '空', kind: 'skill', parameters: [], implementation: [{ step: 'nothing', arguments: {} }] },
		] };
		const program = render({ step_id: 's1', action: 'move' }, { catalog });
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

	it('没有 meta.limits 时退到安全上限显示并给诊断', () => {
		const program = render({ step_id: 's1', action: 'stop' }, { declaration: declarationOf([nodeOf({ step_id: 's1', action: 'stop' })], {}) });
		expect(program.limits.present).toBe(false);
		expect(program.limits.numeric.map((limit) => limit.value)).toEqual([0.3, 1.2, 30.0]);
		expect(program.diagnostics.map((diagnostic) => diagnostic.code)).toContain('code_render.limits.missing');
	});
});

describe('整数字段', () => {
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
});
