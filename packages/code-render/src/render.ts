/**
 * 声明 → 代码面板文本（**编译产物，只读**，spec §4.1）。
 *
 * 形态：一行一个步骤调用，参数名与取值格式全部从校验器推导（`describeActionFields`）——
 * 这里不手写任何参数名，也不认识协议以外的写法。协议变了，改校验器一处，这里跟着变。
 *
 * 不渲染什么（图里那份伪代码里有、一期协议里没有的东西）：`angle`、`publish_to_hardware`、
 * `if obstacle(...)`。`turn` 的参数是 `angular` + `duration`，障碍判断是原子动作
 * `stop_if_obstacle`——照图手写出来的会是一门无法执行、无法校验的语言。
 *
 * 顺带产出**行 ↔ nodeId 的映射**（`lines[].nodeId` 反向、`spans[]` 正向），供界面高亮。
 */
import {
	ALLOWED_ACTIONS,
	DiagnosticCollector,
	describeActionFields,
	jsonDetail,
	type Diagnostic,
	type JsonValue,
	type TaskAction,
	type WorkflowDeclaration,
	type WorkflowNode,
} from '@codecanvas/contracts';
import { EMPTY_LIMITS, describeLimits, type RenderedLimits } from './limits';
import { renderFieldValue } from './values';

/** 行号从 1 起，与编辑器行号一致。 */
export interface RenderedLine {
	readonly line: number;
	readonly text: string;
	/** `call` = 由某个节点编译出的调用；`comment` = 头部/说明；`unsupported` = 编译不了的节点。 */
	readonly kind: 'call' | 'comment' | 'unsupported';
	/** 这一行由哪个节点渲染而来；非节点行是 null。 */
	readonly nodeId: string | null;
}

/** 一个节点渲染在哪些行（含它的注释行）。 */
export interface NodeLineSpan {
	readonly nodeId: string;
	readonly nodeName: string;
	/** `parameters.step_id`：语义身份，重排步骤也不会变。 */
	readonly stepId: string | null;
	/** 编译出来的动作；编译不了时是 null。 */
	readonly action: TaskAction | null;
	readonly startLine: number;
	readonly endLine: number;
}

export interface RenderedProgram {
	/** 完整文本，等于所有行用 `\n` 连接（末尾不带换行）。 */
	readonly text: string;
	readonly lines: readonly RenderedLine[];
	readonly spans: readonly NodeLineSpan[];
	readonly limits: RenderedLimits;
	readonly diagnostics: readonly Diagnostic[];
	/** 调用行数——「几步就有几个调用」。 */
	readonly callCount: number;
}

const ACTION_NAMES: readonly string[] = ALLOWED_ACTIONS;

const isTaskAction = (value: JsonValue | undefined): value is TaskAction =>
	typeof value === 'string' && ACTION_NAMES.includes(value);

/** 名字里可能带换行（schema 只要求非空字符串）；进了注释必须压成一行，否则行号会错位。 */
const singleLine = (text: string): string => text.replace(/\s+/g, ' ').trim();

const readString = (value: JsonValue | undefined): string | null => (typeof value === 'string' ? value : null);

/** 一个节点的调用文本：参数名与顺序都来自字段描述。 */
const renderCall = (node: WorkflowNode, action: TaskAction, collector: DiagnosticCollector): string => {
	const args = describeActionFields(action).map((field) => {
		const rendered = renderFieldValue(field, node.parameters[field.name], action, node.id, collector);
		return `${rendered.name}=${rendered.text}`;
	});
	return `${action}(${args.join(', ')})`;
};

export const renderDeclaration = (declaration: WorkflowDeclaration | null): RenderedProgram => {
	const collector = new DiagnosticCollector();
	const lines: RenderedLine[] = [];
	const spans: NodeLineSpan[] = [];

	const push = (text: string, kind: RenderedLine['kind'], nodeId: string | null): void => {
		lines.push({ line: lines.length + 1, text, kind, nodeId });
	};

	if (declaration === null) {
		return {
			text: '',
			lines: [],
			spans: [],
			limits: EMPTY_LIMITS,
			diagnostics: collector.diagnostics,
			callCount: 0,
		};
	}

	const taskId = readString(declaration.meta['task_id']);
	const header = `# ${singleLine(declaration.name)}${taskId === null ? '' : ` · ${taskId}`}`;
	push(singleLine(header), 'comment', null);

	for (const node of declaration.nodes) {
		const startLine = lines.length + 1;
		const rawAction = node.parameters['action'];
		let action: TaskAction | null = null;

		if (!isTaskAction(rawAction)) {
			// 不认识的动作不假装认识：渲染成说明行 + 诊断，节点仍占一行以便界面高亮。
			collector.error({
				code: 'code_render.node.action_unknown',
				message: `节点「${singleLine(node.name)}」的 action 不在协议里，编译不出调用`,
				path: `nodes.${node.id}.parameters.action`,
				ref: node.id,
				details: { value: jsonDetail(rawAction), allowed: [...ALLOWED_ACTIONS] },
			});
			push(`# 编译不了：「${singleLine(node.name)}」的 action 不在协议里`, 'unsupported', node.id);
		} else {
			action = rawAction;
			if (node.disabled) push(`# disabled: ${singleLine(node.name)}`, 'comment', node.id);
			push(renderCall(node, action, collector), 'call', node.id);
		}

		spans.push({
			nodeId: node.id,
			nodeName: node.name,
			stepId: readString(node.parameters['step_id']),
			action,
			startLine,
			endLine: lines.length,
		});
	}

	return {
		text: lines.map((line) => line.text).join('\n'),
		lines,
		spans,
		limits: describeLimits(declaration.meta, declaration.id, collector),
		diagnostics: collector.diagnostics,
		callCount: lines.filter((line) => line.kind === 'call').length,
	};
};

/** 正向查询：这个节点渲染在哪些行。 */
export const spanOfNode = (program: RenderedProgram, nodeId: string): NodeLineSpan | null =>
	program.spans.find((span) => span.nodeId === nodeId) ?? null;

/** 反向查询：这一行是哪个节点渲染的（1-based 行号）。 */
export const nodeIdAtLine = (program: RenderedProgram, line: number): string | null =>
	program.lines.find((item) => item.line === line)?.nodeId ?? null;

/** 只有调用行参与「几步几个调用」的计数与样式。 */
export const callLines = (program: RenderedProgram): readonly RenderedLine[] =>
	program.lines.filter((line) => line.kind === 'call');

/** 某一行的文本；越界给 null。 */
export const lineText = (program: RenderedProgram, line: number): string | null =>
	program.lines.find((item) => item.line === line)?.text ?? null;
