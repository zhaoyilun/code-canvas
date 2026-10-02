/**
 * 代码面板渲染的验收测试。
 *
 * 三件事必须有机械证据：
 * 1. 渲染出来的名字与格式**可追溯到校验器**（`describeActionFields`），不是这里手写的一套；
 * 2. 行 ↔ nodeId 的映射（正反两向）真能对上，含注释行与多行节点；
 * 3. 数字**不失真**——渲染出的字面量读回来必须还是原值。
 */
import { describe, expect, it } from 'vitest';
import {
	ALLOWED_ACTIONS,
	computeWorkflowDigest,
	createDeterministicIdFactory,
	DEFAULT_LIMITS,
	describeActionFields,
	WORKFLOW_FORMAT_VERSION,
	type JsonObject,
	type JsonValue,
	type TaskAction,
	type WorkflowDeclaration,
	type WorkflowDeclarationDraft,
	type WorkflowNode,
} from '@codecanvas/contracts';
import { importTaskJson } from '@codecanvas/task-import';
import {
	callLines,
	lineText,
	nodeIdAtLine,
	renderDeclaration,
	spanOfNode,
	type RenderedProgram,
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
	const result = importTaskJson(SAMPLE_TASK_JSON, {
		idFactory: createDeterministicIdFactory({ seed: 'code-render' }),
	});
	if (!result.ok) throw new Error('sample task must import');
	return result.declaration;
};

const nodeOf = (id: string, parameters: JsonObject, overrides: Partial<WorkflowNode> = {}): WorkflowNode => ({
	id,
	name: id,
	type: 'task.action',
	typeVersion: 1,
	parameters,
	position: { x: 0, y: 0 },
	disabled: false,
	...overrides,
});

/** 手工造的声明默认带一份协议缺省限值，免得每条用例都吃一条 limits 缺失的诊断。 */
const META_WITH_LIMITS: JsonObject = { limits: { ...DEFAULT_LIMITS } };

const declarationOf = (nodes: readonly WorkflowNode[], meta: JsonObject = META_WITH_LIMITS): WorkflowDeclaration => {
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

const renderOne = (
	parameters: JsonObject,
	overrides: Partial<WorkflowNode> = {},
	meta: JsonObject = META_WITH_LIMITS,
): RenderedProgram => renderDeclaration(declarationOf([nodeOf('nd_1', parameters, overrides)], meta));

/** 取调用行里的 `名字=文本` 实参表（测试自己的解析器，不复用被测代码）。 */
const argsOf = (line: string): Map<string, string> => {
	const open = line.indexOf('(');
	const close = line.lastIndexOf(')');
	const body = line.slice(open + 1, close);
	const args = new Map<string, string>();
	if (body.trim() === '') return args;
	for (const part of body.split(', ')) {
		const eq = part.indexOf('=');
		args.set(part.slice(0, eq), part.slice(eq + 1));
	}
	return args;
};

const paramsFor = (action: TaskAction): JsonObject => {
	const parameters: JsonObject = { action };
	for (const field of describeActionFields(action)) {
		const value: JsonValue =
			field.kind === 'sensors' ? ['/scan0'] : (field.defaultValue ?? field.min ?? field.exclusiveMin ?? 1);
		parameters[field.name] = value;
	}
	return parameters;
};

describe('示例任务 → 调用文本', () => {
	it('四行调用，逐字比对', () => {
		const program = renderDeclaration(sampleDeclaration());

		expect(program.lines.map((line) => line.text)).toEqual([
			'# 前进，遇障停止后转向 · task-demo-001',
			'move(linear=0.2, angular=0.0, duration=5.0)',
			'stop_if_obstacle(sensors=["/scan0"], distance=0.5)',
			'turn(angular=0.8, duration=2.0)',
			'stop()',
		]);
		expect(program.callCount).toBe(4);
		expect(program.lines).toHaveLength(5);
		expect(program.diagnostics).toEqual([]);
	});

	it('text 就是各行用换行拼起来（面板与文本两条路不会分叉）', () => {
		const program = renderDeclaration(sampleDeclaration());
		expect(program.text).toBe(program.lines.map((line) => line.text).join('\n'));
	});

	it('渲染不出协议里不存在的语言（图里那些写法）', () => {
		const { text } = renderDeclaration(sampleDeclaration());
		expect(text).not.toMatch(/\bangle\s*=/);
		expect(text).not.toMatch(/publish_to_hardware/);
		expect(text).not.toMatch(/\bif\b/);
		// turn 的参数是 angular + duration，没有 angle
		expect(text).toContain('turn(angular=0.8, duration=2.0)');
	});

	it('空声明给空程序，不编造内容', () => {
		const program = renderDeclaration(null);
		expect(program.lines).toEqual([]);
		expect(program.text).toBe('');
		expect(program.callCount).toBe(0);
		expect(program.spans).toEqual([]);
		expect(program.limits.present).toBe(false);
	});
});

describe('行 ↔ nodeId 映射', () => {
	it('每个节点一段，段内每一行都能反查回该节点', () => {
		const declaration = sampleDeclaration();
		const program = renderDeclaration(declaration);

		expect(program.spans).toHaveLength(declaration.nodes.length);
		for (const [index, node] of declaration.nodes.entries()) {
			const span = spanOfNode(program, node.id);
			expect(span).not.toBeNull();
			if (span === null) continue;
			expect(span.startLine).toBe(index + 2); // 第 1 行是头部注释
			expect(span.endLine).toBe(index + 2);
			expect(nodeIdAtLine(program, span.startLine)).toBe(node.id);
			expect(nodeIdAtLine(program, span.endLine)).toBe(node.id);
			expect(span.stepId).toBe(`s${index + 1}`);
			expect(lineText(program, span.startLine)).toBe(program.lines[span.startLine - 1]?.text);
		}
	});

	it('非节点行（头部注释）没有归属节点', () => {
		const program = renderDeclaration(sampleDeclaration());
		expect(nodeIdAtLine(program, 1)).toBeNull();
		expect(program.lines[0]?.nodeId).toBeNull();
	});

	it('越界行号给 null，不猜', () => {
		const program = renderDeclaration(sampleDeclaration());
		expect(nodeIdAtLine(program, 0)).toBeNull();
		expect(nodeIdAtLine(program, 999)).toBeNull();
		expect(lineText(program, 999)).toBeNull();
	});

	it('调用行与节点一一对应：调用行数 = 节点数', () => {
		const declaration = sampleDeclaration();
		const program = renderDeclaration(declaration);
		const mapped = new Set(callLines(program).map((line) => line.nodeId));
		expect(mapped.size).toBe(declaration.nodes.length);
	});

	it('disabled 节点占注释 + 调用两行，两行都归它', () => {
		const program = renderOne({ action: 'stop' }, { disabled: true });
		expect(program.lines.map((line) => line.text)).toEqual([
			'# 测试声明',
			'# disabled: nd_1',
			'stop()',
		]);
		expect(nodeIdAtLine(program, 2)).toBe('nd_1');
		expect(nodeIdAtLine(program, 3)).toBe('nd_1');
		expect(spanOfNode(program, 'nd_1')).toMatchObject({ startLine: 2, endLine: 3 });
	});

	it('名字里带换行也不会让行号错位', () => {
		const program = renderDeclaration(
			declarationOf([nodeOf('nd_1', { action: 'stop' })], { task_id: 't1' }),
		);
		const withNewline = renderDeclaration({
			...declarationOf([nodeOf('nd_1', { action: 'stop' })]),
			name: '第一行\n第二行',
		});
		expect(program.lines[0]?.text).toBe('# 测试声明 · t1');
		expect(withNewline.lines[0]?.text).toBe('# 第一行 第二行');
		expect(withNewline.lines).toHaveLength(2);
	});
});

describe('渲染规则可追溯到校验器', () => {
	it.each([...ALLOWED_ACTIONS])('%s 的参数名与顺序全部来自 describeActionFields', (action) => {
		const program = renderOne(paramsFor(action));
		const call = callLines(program)[0];
		expect(call).toBeDefined();
		if (call === undefined) return;

		expect(argsOf(call.text).size).toBe(describeActionFields(action).length);
		expect([...argsOf(call.text).keys()]).toEqual(describeActionFields(action).map((field) => field.name));
		expect(call.text.startsWith(`${action}(`)).toBe(true);
		expect(program.diagnostics).toEqual([]);
	});

	it('arm6_joints 按描述表顺序出七个实参（`time` 不是整数字段，按浮点渲染）', () => {
		const program = renderOne(paramsFor('arm6_joints'));
		expect(lineText(program, 2)).toBe(
			'arm6_joints(joint1=0.0, joint2=0.0, joint3=0.0, joint4=0.0, joint5=0.0, joint6=0.0, time=1500.0)',
		);
	});

	it('缺省值来自字段描述，不是这里另写的（time 省略 → 1500）', () => {
		const program = renderOne({ action: 'arm_joint', joint_id: 3, joint: 90 });
		expect(lineText(program, 2)).toBe('arm_joint(joint_id=3, joint=90.0, time=1500.0)');
		expect(program.diagnostics).toEqual([]);
	});

	it('只有 `integer: true` 的字段渲染成整数（joint_id），其余字段一位小数打底', () => {
		const program = renderOne({ action: 'arm_joint', joint_id: 3, joint: 90, time: 1500 });
		expect(lineText(program, 2)).toBe('arm_joint(joint_id=3, joint=90.0, time=1500.0)');
	});

	it('凑不出调用时（action 不在协议里）给诊断 + 说明行，节点仍可高亮', () => {
		const program = renderOne({ action: 'publish_to_hardware' });
		expect(program.lines[1]).toMatchObject({ kind: 'unsupported', nodeId: 'nd_1' });
		expect(program.callCount).toBe(0);
		expect(program.diagnostics.map((diagnostic) => diagnostic.code)).toEqual([
			'code_render.node.action_unknown',
		]);
		expect(program.diagnostics[0]?.severity).toBe('error');
	});
});

describe('数值不失真', () => {
	it('渲染出来的每个数值实参读回来都是原值', () => {
		const declaration = sampleDeclaration();
		const program = renderDeclaration(declaration);

		for (const node of declaration.nodes) {
			const span = spanOfNode(program, node.id);
			expect(span).not.toBeNull();
			if (span === null || span.action === null) continue;
			const call = lineText(program, span.startLine);
			expect(call).not.toBeNull();
			if (call === null) continue;

			const args = argsOf(call);
			for (const field of describeActionFields(span.action)) {
				const rendered = args.get(field.name);
				expect(rendered).toBeDefined();
				const original = node.parameters[field.name];
				if (field.kind === 'sensors') {
					expect(JSON.parse(rendered as string)).toEqual(original);
				} else {
					expect(Number(rendered)).toBe(original);
				}
			}
		}
	});

	it('需要更多位小数时不会为了好看而截断', () => {
		const program = renderOne({ action: 'turn', angular: 0.0625, duration: 0.125 });
		expect(lineText(program, 2)).toBe('turn(angular=0.0625, duration=0.125)');
	});

	it('整数值的浮点字段仍渲染成浮点（0 → 0.0）', () => {
		const program = renderOne({ action: 'move', linear: 0, angular: 0, duration: 1 });
		expect(lineText(program, 2)).toBe('move(linear=0.0, angular=0.0, duration=1.0)');
	});

	it('取不到值的字段渲染成 null 并给诊断，不静默编一个数', () => {
		const program = renderOne({ action: 'move', linear: 0.2 });
		expect(lineText(program, 2)).toBe('move(linear=0.2, angular=null, duration=null)');
		expect(program.diagnostics.map((diagnostic) => diagnostic.code)).toEqual([
			'code_render.field.missing',
			'code_render.field.missing',
		]);
	});

	it('传感器数组按字面量渲染，多个传感器保持顺序', () => {
		const program = renderOne({ action: 'stop_if_obstacle', sensors: ['/scan1', '/scan0'], distance: 0.5 });
		expect(lineText(program, 2)).toBe('stop_if_obstacle(sensors=["/scan1", "/scan0"], distance=0.5)');
	});
});

describe('安全限值必须看得见', () => {
	it('限值取自声明 meta，单位从引用它的字段上取', () => {
		const program = renderDeclaration(sampleDeclaration());
		expect(program.limits.present).toBe(true);
		expect(program.limits.numeric.map((limit) => [limit.name, limit.value, limit.unit, limit.text])).toEqual([
			['max_linear', 0.3, 'm/s', '0.3 m/s'],
			['max_angular', 1.2, 'rad/s', '1.2 rad/s'],
			['max_duration', 30, 's', '30 s'],
		]);
		expect(program.limits.requireConfirmation).toBe(true);
		expect(program.limits.numeric.every((limit) => limit.tightened === false)).toBe(true);
	});

	it('收紧过的限值标出 tightened', () => {
		const declaration = declarationOf([nodeOf('nd_1', { action: 'stop' })], {
			limits: { max_linear: 0.1, max_angular: 1.2, max_duration: 5.0, require_confirmation: false },
		});
		const program = renderDeclaration(declaration);
		expect(program.limits.numeric.map((limit) => limit.tightened)).toEqual([true, false, true]);
		expect(program.limits.requireConfirmation).toBe(false);
	});

	it('声明层面拦不到的「放宽」在这里被点出来', () => {
		const declaration = declarationOf([nodeOf('nd_1', { action: 'stop' })], {
			limits: { max_linear: 5, max_angular: 1.2, max_duration: 30.0, require_confirmation: true },
		});
		const program = renderDeclaration(declaration);
		const exceeded = program.diagnostics.find(
			(diagnostic) => diagnostic.code === 'code_render.limit.exceeds_safety',
		);
		expect(exceeded?.severity).toBe('error');
		expect(exceeded?.details).toEqual({ value: 5, safety_ceiling: 0.3 });
	});

	it('没有 meta.limits 时退到安全上限显示并给诊断', () => {
		const program = renderOne({ action: 'stop' }, {}, {});
		expect(program.limits.present).toBe(false);
		expect(program.limits.numeric.map((limit) => limit.value)).toEqual([0.3, 1.2, 30.0]);
		expect(program.diagnostics.map((diagnostic) => diagnostic.code)).toContain('code_render.limits.missing');
	});
});
