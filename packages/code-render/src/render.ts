/**
 * 一个模块（流程画布上的一个节点）→ 它的**实现**：spec §4.1 的代码面板内容。
 *
 * 粒度是「工作流上的一个模块 = 一个函数」：节点的 `parameters.action` 就是 `capabilityRef`，
 * 代码面板显示这个能力在目录里的 `implementation`——机器为了执行它具体做了什么。
 *
 * 三条不许破的规矩：
 * - **参数名与顺序来自 `catalog.primitives`**（原语定义），这里一个参数名都不手写；
 * - 目录里没有的能力/原语不假装认识：给诊断 + 说明行，节点名照样显示；
 * - 行 ↔ 步骤的映射**在这里产出**（`lines[].stepIndex` 与 `steps[]`），界面只读不重算。
 *
 * 限值一并返回：它是**整个任务**的安全上限（`meta.limits`），不随选中哪个模块变，
 * 所以放在同一个程序对象里交给面板，界面不用自己再去拼一遍。
 */
import {
	DiagnosticCollector,
	findCapability,
	findPrimitive,
	jsonDetail,
	type CapabilityCatalog,
	type Diagnostic,
	type WorkflowDeclaration,
	type WorkflowNode,
} from '@codecanvas/contracts';
import { EMPTY_LIMITS, describeLimits, type RenderedLimits } from './limits';
import { renderArgument } from './values';

/** 行号从 1 起，与编辑器行号一致。 */
export interface RenderedLine {
	readonly line: number;
	readonly text: string;
	/** `call` = 一个原语调用；`unsupported` = 目录里查不到、只能说明；`comment` = 节点自身的注记。 */
	readonly kind: 'call' | 'unsupported' | 'comment';
	/** 这一行对应 `implementation` 的第几步（**0 基**）；注释行是 null。 */
	readonly stepIndex: number | null;
	/** 这一行调的原语名；注释行是 null。 */
	readonly primitiveRef: string | null;
}

/** `implementation` 里的一步渲染在哪儿。 */
export interface RenderedStepSpan {
	/** 在 `capability.implementation` 里的位置（0 基）。 */
	readonly index: number;
	readonly primitiveRef: string;
	/** 渲染到第几行（1 基）。 */
	readonly line: number;
	/** 这一步的原语在目录里查得到。查不到时那一行是说明行，不是调用。 */
	readonly known: boolean;
}

export interface RenderedImplementation {
	readonly nodeId: string | null;
	readonly nodeName: string | null;
	/** 面板标题「<能力的 label> · 实现」；没有可显示的模块时是 null。 */
	readonly title: string | null;
	readonly capabilityRef: string | null;
	readonly capabilityLabel: string | null;
	/** 完整文本，等于所有行用 `\n` 连接（末尾不带换行）。 */
	readonly text: string;
	readonly lines: readonly RenderedLine[];
	readonly steps: readonly RenderedStepSpan[];
	/** 整个任务的安全限值（不随选中模块变）。 */
	readonly limits: RenderedLimits;
	readonly diagnostics: readonly Diagnostic[];
	/** 渲染出来的原语调用行数——「实现里有几步就有几个调用」（查不到的原语不算）。 */
	readonly callCount: number;
}

export interface ImplementationRenderInput {
	/** 当前选中的模块；null = 什么都没选（面板给空状态）。 */
	readonly node: WorkflowNode | null;
	/** 设备（插件）提供的能力目录：原语定义与能力实现都从它来。 */
	readonly catalog: CapabilityCatalog;
	/** 声明本身，只为了取任务级限值；null 时退到协议安全上限。 */
	readonly declaration: WorkflowDeclaration | null;
}

/** 名字里可能带换行（schema 只要求非空字符串）；进了注释必须压成一行，否则行号会错位。 */
const singleLine = (text: string): string => text.replace(/\s+/g, ' ').trim();

const emptyProgram = (limits: RenderedLimits, diagnostics: readonly Diagnostic[]): RenderedImplementation => ({
	nodeId: null,
	nodeName: null,
	title: null,
	capabilityRef: null,
	capabilityLabel: null,
	text: '',
	lines: [],
	steps: [],
	limits,
	diagnostics,
	callCount: 0,
});

export const renderImplementation = (input: ImplementationRenderInput): RenderedImplementation => {
	const collector = new DiagnosticCollector();
	const { node, catalog, declaration } = input;
	const limits =
		declaration === null ? EMPTY_LIMITS : describeLimits(declaration.meta, declaration.id, collector);

	if (node === null) return emptyProgram(limits, collector.diagnostics);

	const lines: RenderedLine[] = [];
	const steps: RenderedStepSpan[] = [];
	const push = (text: string, kind: RenderedLine['kind'], stepIndex: number | null, primitiveRef: string | null): void => {
		lines.push({ line: lines.length + 1, text, kind, stepIndex, primitiveRef });
	};

	const rawAction = node.parameters['action'];
	const action = typeof rawAction === 'string' ? rawAction : null;
	const capability = action === null ? undefined : findCapability(catalog, action);

	if (capability === undefined) {
		// 不认识的动作不假装认识：给诊断 + 一行说明，节点名照旧显示出来（面板仍告诉你在看谁）。
		if (action === null) {
			collector.error({
				code: 'code_render.node.action_missing',
				message: `节点「${singleLine(node.name)}」没有 parameters.action，查不到能力`,
				path: `nodes.${node.id}.parameters.action`,
				ref: node.id,
				details: { value: jsonDetail(rawAction) },
			});
		} else {
			collector.error({
				code: 'code_render.capability.unknown',
				message: `目录「${catalog.displayName}」里没有能力「${action}」，渲染不出实现`,
				path: `nodes.${node.id}.parameters.action`,
				ref: node.id,
				details: { value: action, catalog: catalog.catalogRef, revision: catalog.revisionRef },
			});
		}
		push(`# 查不到能力「${action ?? '?'}」的实现`, 'unsupported', null, null);
		return {
			nodeId: node.id,
			nodeName: node.name,
			title: `${action ?? singleLine(node.name)} · 实现`,
			capabilityRef: action,
			capabilityLabel: null,
			text: lines.map((line) => line.text).join('\n'),
			lines,
			steps,
			limits,
			diagnostics: collector.diagnostics,
			callCount: 0,
		};
	}

	if (node.disabled) push(`# disabled: ${singleLine(node.name)}`, 'comment', null, null);

	for (const [index, implementationStep] of capability.implementation.entries()) {
		const primitive = findPrimitive(catalog, implementationStep.step);

		if (primitive === undefined) {
			collector.error({
				code: 'code_render.primitive.unknown',
				message: `目录里没有原语「${implementationStep.step}」，这一步渲染不出调用`,
				path: `nodes.${node.id}.parameters.action`,
				ref: node.id,
				details: { capability: capability.capabilityRef, step: implementationStep.step, index },
			});
			push(`# 目录里没有原语「${implementationStep.step}」`, 'unsupported', index, implementationStep.step);
			steps.push({ index, primitiveRef: implementationStep.step, line: lines.length, known: false });
			continue;
		}

		// 实参表里多出来的键不渲染（名字与顺序由原语定义决定），但要说出来——静默丢掉等于骗人。
		const declared = new Set(primitive.parameters.map((parameter) => parameter.name));
		for (const name of Object.keys(implementationStep.arguments)) {
			if (declared.has(name)) continue;
			collector.warning({
				code: 'code_render.argument.undeclared',
				message: `${qualifiedName(capability.capabilityRef, implementationStep.step)} 多给了实参 ${name}，原语定义里没有它，不渲染`,
				path: `nodes.${node.id}.parameters.action`,
				ref: node.id,
				details: { primitive: implementationStep.step, argument: name, parameters: [...declared] },
			});
		}

		const rendered = primitive.parameters.map((parameter) =>
			renderArgument(
				parameter,
				implementationStep.arguments[parameter.name],
				{ primitiveRef: implementationStep.step, nodeParameters: node.parameters, nodeId: node.id },
				collector,
			),
		);
		push(
			`${implementationStep.step}(${rendered.map((argument) => `${argument.name}=${argument.text}`).join(', ')})`,
			'call',
			index,
			implementationStep.step,
		);
		steps.push({ index, primitiveRef: implementationStep.step, line: lines.length, known: true });
	}

	return {
		nodeId: node.id,
		nodeName: node.name,
		title: `${capability.label} · 实现`,
		capabilityRef: capability.capabilityRef,
		capabilityLabel: capability.label,
		text: lines.map((line) => line.text).join('\n'),
		lines,
		steps,
		limits,
		diagnostics: collector.diagnostics,
		callCount: lines.filter((line) => line.kind === 'call').length,
	};
};

/** 诊断消息里的「谁」：`能力.原语`，读的人一眼能找到是哪个调用的实参出了问题。 */
const qualifiedName = (capabilityRef: string, primitiveRef: string): string => `${capabilityRef} 的 ${primitiveRef}`;

/** 这一行对应 `implementation` 的第几步（0 基）；注释行与越界行号给 null。 */
export const stepIndexAtLine = (program: RenderedImplementation, line: number): number | null =>
	program.lines.find((item) => item.line === line)?.stepIndex ?? null;

/** 反向查询：第 n 步（0 基）渲染在第几行。 */
export const lineOfStep = (program: RenderedImplementation, index: number): number | null =>
	program.steps.find((step) => step.index === index)?.line ?? null;

/** 某一行的文本；越界给 null。 */
export const lineText = (program: RenderedImplementation, line: number): string | null =>
	program.lines.find((item) => item.line === line)?.text ?? null;

/** 只有调用行参与「几步几个调用」的计数与样式。 */
export const callLines = (program: RenderedImplementation): readonly RenderedLine[] =>
	program.lines.filter((line) => line.kind === 'call');
