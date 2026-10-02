/**
 * 一个模块（流程画布上的一个节点）→ 它的**实现**：spec §4.1 的代码面板内容。
 *
 * 粒度是「工作流上的一个模块 = 一个函数」：节点的 `parameters.action` 就是 `capabilityRef`，
 * 代码面板显示这个能力在目录里的 `implementation`——机器为了执行它具体做了什么。
 *
 * **实现是一棵语句树**（`call` / `set` / `if`，见 `@codecanvas/contracts` 的 `capability.ts`），
 * 所以这里是**递归**渲染：语句 → 表达式 → 语句。`if` 展开成多行、给子语句加缩进，
 * 因为「一串平铺的调用」看不出这是一段程序——数据形状改好了，渲染就得跟上。
 *
 * 四条不许破的规矩：
 * - **参数名与顺序来自 `catalog.primitives`**（原语定义），这里一个参数名都不手写；
 * - 目录里没有的能力/原语不假装认识：给诊断 + 说明行，节点名照样显示；
 * - 行 ↔ 步骤的映射**在这里产出**（`lines[].stepPath` / `lines[].stepIndex` / `steps[]`），界面只读不重算；
 * - **缩进是文本的一部分**（4 个空格），不靠 CSS——复制的文本和面板上看到的必须是同一段程序。
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
	type CapabilitySpec,
	type Diagnostic,
	type ImplArgument,
	type ImplExpression,
	type ImplStatement,
	type PrimitiveSpec,
	type WorkflowDeclaration,
	type WorkflowNode,
} from '@codecanvas/contracts';
import { EMPTY_LIMITS, describeLimits, type RenderedLimits } from './limits';
import { asRenderable, formatJsonLiteral, renderByType, renderConstant, valueMessage } from './values';

/** 缩进一档 = 4 个空格。 */
export const INDENT_UNIT = '    ';

/** 行号从 1 起，与编辑器行号一致。 */
export interface RenderedLine {
	readonly line: number;
	/** 完整源码文本，**含行首缩进**（缩进是程序的一部分，不是样式）。 */
	readonly text: string;
	/** 缩进档数（0 = 顶层）。 */
	readonly indent: number;
	/** `call`/`set` = 一条语句；`if`/`else` = 分支头；`unsupported` = 目录里查不到；`comment` = 节点自身的注记。 */
	/**
	 * `call`/`set` = 一条语句；`if`/`else` = 分支头；`unsupported` = 目录里查不到；
	 * `comment` = 节点自身的注记；`argument` = 一条**续行**——
	 * 实参是结构化载荷、摊位摊不下时才摊开的那几行。它属于上面那条语句，
	 * 所以不计入「几个原语」，也不单独占一步。
	 */
	readonly kind: 'call' | 'set' | 'if' | 'else' | 'unsupported' | 'comment' | 'argument';
	/** 这一行所属的**顶层**语句下标（0 基）；注释行是 null。界面联动只认它。 */
	readonly stepIndex: number | null;
	/** 这一行精确对应的树路径，例如 `"1"`、`"1.then.0"`、`"1.else.2"`；注释行是 null。 */
	readonly stepPath: string | null;
	/** 这一行调的原语名；赋值/分支/注释行是 null。 */
	readonly primitiveRef: string | null;
	/** 这一行调的原语在目录里查得到（说明行是 false）。 */
	readonly known: boolean;
}

/** `implementation` 里的一条**顶层**语句渲染在哪儿。 */
export interface RenderedStepSpan {
	/** 在 `capability.implementation` 里的位置（0 基）。 */
	readonly index: number;
	/** 树路径，顶层就是下标本身：`"0"`、`"1"`…… */
	readonly path: string;
	/** 该顶层语句的种类；界面据此决定这一步长什么样。 */
	readonly kind: ImplStatement['kind'];
	/** 顶层语句直接调的那个原语；`set` / `if` 没有就是 null。 */
	readonly primitiveRef: string | null;
	/** 渲染到第几行（1 基）——这一行的**头**（`if` 的条件行就是头）。 */
	line: number;
	/** 它渲染出的最后一行（1 基）；`if` 含整个 then/else 体。渲染完后回填。 */
	lastLine: number;
	/** 这一步渲染出的所有行数。渲染完后回填。 */
	lineCount: number;
	/** 这一步调的原语在目录里查得到；`set` / `if` 恒为 true（它自己不是调用）。 */
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
	/** 渲染出来的原语调用数：语句调用 + 表达式里的调用（查不到的与注释不算）。 */
	readonly callCount: number;
}

export interface ImplementationRenderInput {
	/** 当前选中的模块；null = 什么都没选（面板给空状态）。 */
	readonly node: WorkflowNode | null;
	/**
	 * 设备（插件）提供的能力目录：原语定义与能力实现都从它来。
	 *
	 * 允许 null：目录是设备属性，界面有可能还没定下来（没导入过、也没选中设备）。
	 * 那时不给一份「就近挑的」目录——挑错了会渲染出另一台机器的实现，那比空着坏得多。
	 */
	readonly catalog: CapabilityCatalog | null;
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

const indentOf = (depth: number): string => INDENT_UNIT.repeat(depth);

const joinLines = (lines: readonly RenderedLine[]): string => lines.map((line) => line.text).join('\n');

/** 诊断消息里的「谁」：`能力.路径`，读的人一眼能找到是哪个调用出的问题。 */
const at = (node: WorkflowNode, stepPath: string): string =>
	`${String(node.parameters['action'] ?? '?')} 的 ${stepPath}`;

const isImplExpression = (argument: ImplArgument): argument is ImplExpression =>
	typeof argument === 'object' && argument !== null && !Array.isArray(argument);

type Kind = RenderedLine['kind'];

/** 压一行（行号 = 已产出行数 + 1），返回它的行号。 */
type PushLine = (
	text: string,
	kind: Kind,
	depth: number,
	stepIndex: number | null,
	stepPath: string | null,
	primitiveRef: string | null,
	known: boolean,
) => number;

interface RenderState {
	readonly capability: CapabilitySpec;
	readonly catalog: CapabilityCatalog;
	readonly node: WorkflowNode;
	readonly collector: DiagnosticCollector;
	readonly lines: RenderedLine[];
	readonly steps: RenderedStepSpan[];
	readonly push: PushLine;
	/** 本能力实现里 `set` 过的局部变量名（`{kind:'param'}` 的第一顺位解析目标）。 */
	readonly locals: readonly string[];
	/** 表达式里渲染出的调用数（赋值右边、条件里、嵌套实参里那些）。 */
	expressionCalls: number;
}

/**
 * 递归渲染一个能力实现。
 *
 * 内部状态只有四样：已产出的行、顶层语句的 span、一条诊断收集器、
 * 表达式调用的计数。行号永远等于已产出行数 + 1，所以嵌套展开多少层都不会把映射算错。
 */
export const renderImplementation = (input: ImplementationRenderInput): RenderedImplementation => {
	const collector = new DiagnosticCollector();
	const { node, catalog, declaration } = input;
	const limits =
		declaration === null ? EMPTY_LIMITS : describeLimits(declaration.meta, declaration.id, collector);

	if (node === null) return emptyProgram(limits, collector.diagnostics);

	const lines: RenderedLine[] = [];

	const steps: RenderedStepSpan[] = [];

	if (catalog === null) {
		// 没有目录就查不到能力，也就没有实现可渲染。**照实说**，不去猜一份。
		collector.error({
			code: 'code_render.catalog.missing',
			message: `没有目录，渲染不出「${singleLine(node.name)}」的实现`,
			path: `nodes.${node.id}.parameters.action`,
			ref: node.id,
		});
		// 这里还不能用 `push`（它下面才定义）——直接压一行，内容和推出来的完全一样。
		lines.push({
			line: 1,
			text: `# 没有目录，渲染不出「${singleLine(node.name)}」的实现`,
			indent: 0,
			kind: 'unsupported',
			stepIndex: null,
			stepPath: null,
			primitiveRef: null,
			known: false,
		});
		return {
			nodeId: node.id,
			nodeName: node.name,
			title: `${singleLine(node.name)} · 实现`,
			capabilityRef: null,
			capabilityLabel: null,
			text: joinLines(lines),
			lines,
			steps,
			limits,
			diagnostics: collector.diagnostics,
			callCount: 0,
		};
	}

	const push: PushLine = (text, kind, depth, stepIndex, stepPath, primitiveRef, known) => {
		lines.push({
			line: lines.length + 1,
			text: indentOf(depth) + text,
			indent: depth,
			kind,
			stepIndex,
			stepPath,
			primitiveRef,
			known,
		});
		return lines.length;
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
		push(`# 查不到能力「${action ?? '?'}」的实现`, 'unsupported', 0, null, null, null, false);
		return {
			nodeId: node.id,
			nodeName: node.name,
			title: `${action ?? singleLine(node.name)} · 实现`,
			capabilityRef: action,
			capabilityLabel: null,
			text: joinLines(lines),
			lines,
			steps,
			limits,
			diagnostics: collector.diagnostics,
			callCount: 0,
		};
	}

	if (node.disabled) push(`# disabled: ${singleLine(node.name)}`, 'comment', 0, null, null, null, true);

	const state: RenderState = {
		capability,
		catalog,
		node,
		collector,
		lines,
		steps,
		push,
		locals: localsOf(capability),
		expressionCalls: 0,
	};

	renderBody(state, capability.implementation, 0, null, null, null);

	return {
		nodeId: node.id,
		nodeName: node.name,
		title: `${capability.label} · 实现`,
		capabilityRef: capability.capabilityRef,
		capabilityLabel: capability.label,
		text: joinLines(lines),
		lines,
		steps,
		limits,
		diagnostics: collector.diagnostics,
		// 「几个原语」= 语句调用 + 表达式里的调用——`reading = read_scan(...)` 也是一次调用。
		callCount: lines.filter((line) => line.kind === 'call' && line.known).length + state.expressionCalls,
	};
};

/**
 * 渲染一串语句。
 *
 * 顶层每条语句**登记一个 span**（`steps[]`），嵌套语句共享所属顶层的 span——
 * 于是「第 n 步」在树里始终指「第 n 条顶层语句」，与界面口径一致。
 *
 * 前两个参数是「我是不是顶层」的唯一判据（不是可省参数）：顶层传 `null`，
 * 嵌套时**必须**把外层的 `topIndex` 与 `topSpan` 原样传下去——漏传就会把子语句当顶层，
 * 于是「第几步」全错（`0.then.0` 会被记成第 0 步）。
 */
const renderBody = (
	state: RenderState,
	statements: readonly ImplStatement[],
	depth: number,
	topIndex: number | null,
	parentPath: string | null,
	topSpan: RenderedStepSpan | null,
): void => {
	statements.forEach((statement, index) => {
		const path = parentPath === null ? String(index) : `${parentPath}.${index}`;

		if (topSpan === null) {
			// 顶层：先占位，等这条语句（含它的分支）渲染完再回填 lastLine / lineCount。
			const head = state.lines.length + 1;
			const span: RenderedStepSpan = {
				index,
				path,
				kind: statement.kind,
				primitiveRef: statement.kind === 'call' ? statement.primitiveRef : null,
				line: head,
				lastLine: head,
				lineCount: 0,
				known: statement.kind !== 'call' || findPrimitive(state.catalog, statement.primitiveRef) !== undefined,
			};
			state.steps.push(span);
			renderStatement(state, statement, path, index, depth, span);
			span.lineCount = state.lines.length - head + 1;
			span.lastLine = state.lines.length;
			return;
		}
		renderStatement(state, statement, path, topIndex, depth, topSpan);
	});
};

const renderStatement = (
	state: RenderState,
	statement: ImplStatement,
	path: string,
	topIndex: number | null,
	depth: number,
	topSpan: RenderedStepSpan,
): void => {
	const { push, node, collector, capability } = state;

	if (statement.kind === 'call') {
		const primitive = findPrimitive(state.catalog, statement.primitiveRef);
		if (primitive === undefined) {
			unknownPrimitive(state, statement.primitiveRef, path, false);
			push(
				`# 目录里没有原语「${statement.primitiveRef}」`,
				'unsupported',
				depth,
				topIndex,
				path,
				statement.primitiveRef,
				false,
			);
			return;
		}
		// 顶层语句的实参允许摊成多行（结构化载荷摊不下时）。头一行是语句本身，
		// 续行标成 `argument`——它们属于同一步，不该被算成新的原语调用。
		const [head, ...rest] = `${statement.primitiveRef}(${renderArguments(
			state,
			primitive,
			statement.arguments,
			path,
			true,
		)})`.split('\n');
		push(head ?? '', 'call', depth, topIndex, path, statement.primitiveRef, true);
		rest.forEach((line, index) => {
			// 最后一行是收尾的 `})`：退回到语句本身的缩进，读起来才像一次调用。
			const lineDepth = index === rest.length - 1 ? depth : depth + 1;
			push(line, 'argument', lineDepth, topIndex, path, statement.primitiveRef, true);
		});
		return;
	}

	if (statement.kind === 'set') {
		// 赋值的右值永远加括号：孤立看也认得出这是一整个取值。
		const value = renderExpression(state, statement.value, path, true);
		push(`${statement.target} = ${value}`, 'set', depth, topIndex, path, null, true);
		return;
	}

	// if：条件行 + 缩进一档的 then 体；有 else 就再接一行 `else:` 与它的体。
	push(
		`if ${renderExpression(state, statement.condition, path, false)}:`,
		'if',
		depth,
		topIndex,
		path,
		null,
		true,
	);

	// ty: 嵌套语句**继承**所属顶层语句的 stepIndex 与 span——「第几步」在树里只认顶层。
	renderBody(state, statement.then, depth + 1, topIndex, `${path}.then`, topSpan);

	if (statement.else === undefined) return;
	push('else:', 'else', depth, topIndex, path, null, true);
	renderBody(state, statement.else, depth + 1, topIndex, `${path}.else`, topSpan);
};

/** `{kind:'param'}` 的解析范围：本能力实现里 `set` 过的局部变量 + 本能力的参数。 */
const localsOf = (capability: CapabilitySpec): readonly string[] => {
	const targets: string[] = [];
	const visit = (statements: readonly ImplStatement[]): void => {
		for (const statement of statements) {
			if (statement.kind === 'set') targets.push(statement.target);
			if (statement.kind !== 'if') continue;
			visit(statement.then);
			visit(statement.else ?? []);
		}
	};
	visit(capability.implementation);
	return targets;
};

const unknownPrimitive = (state: RenderState, primitiveRef: string, path: string, nested: boolean): void => {
	state.collector.error({
		code: 'code_render.primitive.unknown',
		message: nested
			? `目录里没有原语「${primitiveRef}」，这一步的表达式渲染不出来`
			: `目录里没有原语「${primitiveRef}」，这一步渲染不出调用`,
		path: `nodes.${state.node.id}.parameters.action`,
		ref: state.node.id,
		details: { capability: state.capability.capabilityRef, step: primitiveRef, stepPath: path },
	});
};

// ---------------------------------------------------------------------------
// 调用与实参
// ---------------------------------------------------------------------------

/**
 * 实参表文本：`参数名=值` 用 `, ` 连接。
 *
 * **参数名与顺序逐字来自原语定义**——实现里多给的实参不渲染（静默丢掉等于骗人，所以给警告），
 * 缺的实参渲染成占位符（`null`/`[]`）并给警告，绝不猜。
 */
const renderArguments = (
	state: RenderState,
	primitive: PrimitiveSpec,
	args: Readonly<Record<string, ImplArgument>>,
	path: string,
	multiline = false,
): string => {
	const { node, collector } = state;
	const declared = new Set(primitive.parameters.map((parameter) => parameter.name));

	for (const name of Object.keys(args)) {
		if (declared.has(name)) continue;
		collector.warning({
			code: 'code_render.argument.undeclared',
			message: `${at(node, path)} 的 ${primitive.primitiveRef} 多给了实参 ${name}，原语定义里没有它，不渲染`,
			path: `nodes.${node.id}.parameters.action`,
			ref: node.id,
			details: { primitive: primitive.primitiveRef, argument: name, parameters: [...declared], stepPath: path },
		});
	}

	return primitive.parameters
		.map((parameter) =>
			`${parameter.name}=${renderArgument(state, primitive, parameter, args[parameter.name], path, multiline)}`,
		)
		.join(', ');
};

/** 只由字符串组成的数组（传感器列表这种实参）。 */
const isStringArray = (value: unknown): value is readonly string[] =>
	Array.isArray(value) && value.every((item) => typeof item === 'string');

/** 一个实参 → 文本。缺省 / 取值不符都给警告 + 占位符，不静默编一个值。 */
const renderArgument = (
	state: RenderState,
	primitive: PrimitiveSpec,
	parameter: PrimitiveSpec['parameters'][number],
	raw: ImplArgument | undefined,
	path: string,
	multiline = false,
): string => {
	const { node, collector } = state;
	const where = `${at(node, path)} 的 ${primitive.primitiveRef}.${parameter.name}`;

	if (raw === undefined) {
		collector.warning({
			code: 'code_render.argument.missing',
			message: `${where} 没有实参，渲染成占位符`,
			path: `nodes.${node.id}.parameters.${parameter.name}`,
			ref: node.id,
			details: { primitive: primitive.primitiveRef, parameter: parameter.name, stepPath: path },
		});
		return renderByType(parameter.type, undefined, parameter.integer === true).text;
	}

	// 结构化载荷：写死的字面量（`{"1": 0.02, …}`）是常态，摊不开就摊成多行。
	// 这一条要在表达式那条路之前——字面量也是表达式，先走那边就永远只有紧凑形态。
	if (parameter.type === 'json' && isImplExpression(raw) && raw.kind === 'literal') {
		return formatJsonLiteral(raw.value, multiline);
	}

	// 表达式实参：值（数字/字符串/布尔）按**原语定义**提示类型，结构（比较、嵌套调用……）自带形状。
	if (isImplExpression(raw)) {
		const text = renderExpression(state, raw, path, false, parameter);
		// 表达式实参也要过「取值可用吗」这道闸：空数组/非数组在字面量那边会给诊断，
		// 在表达式这边（例如实现里写死的 `read_scan(sensors: [])`）同样不能静默放行。
		// 只查**字面量**：`{kind:'param'}` 是引用，它的类型由原语定义那条路管。
		if (parameter.type === 'sensor' && raw.kind === 'literal' && (!isStringArray(raw.value) || raw.value.length === 0)) {
			collector.warning({
				code: isStringArray(raw.value) ? 'code_render.argument.empty_sensor_array' : 'code_render.argument.not_sensor_array',
				message: `${where} 的传感器实参不是一个非空字符串数组，照原样写出`,
				path: `nodes.${node.id}.parameters.${parameter.name}`,
				ref: node.id,
				details: { primitive: primitive.primitiveRef, parameter: parameter.name, stepPath: path },
			});
		}
		return text;
	}

	const rendered = renderByType(parameter.type, asRenderable(raw), parameter.integer === true);
	if (rendered.code === null) return rendered.text;
	collector.warning({
		code: rendered.code,
		message: `${where} ${valueMessage(rendered.code)}`,
		path: `nodes.${node.id}.parameters`,
		ref: node.id,
		details: {
			primitive: primitive.primitiveRef,
			parameter: parameter.name,
			expected: parameter.type,
			value: jsonDetail(raw),
			stepPath: path,
		},
	});
	return rendered.text;
};

// ---------------------------------------------------------------------------
// 表达式：递归 + 按优先级加括号
// ---------------------------------------------------------------------------

/**
 * 二元运算符的符号与结合力度（数越大越紧）。`and`/`or` 与比较同级——宁可多括号也别写错结合性。
 * 用 Map 而不是 Record：查不到的运算符要能被 `precedenceOf` 明确拒绝，不许静默当 0。
 */
const BINARY = new Map<string, { readonly symbol: string; readonly precedence: number }>([
	['multiply', { symbol: '*', precedence: 7 }],
	['divide', { symbol: '/', precedence: 7 }],
	['add', { symbol: '+', precedence: 6 }],
	['subtract', { symbol: '-', precedence: 6 }],
	['lt', { symbol: '<', precedence: 3 }],
	['lte', { symbol: '<=', precedence: 3 }],
	['gt', { symbol: '>', precedence: 3 }],
	['gte', { symbol: '>=', precedence: 3 }],
	['eq', { symbol: '==', precedence: 3 }],
	['neq', { symbol: '!=', precedence: 3 }],
	['and', { symbol: 'and', precedence: 3 }],
	['or', { symbol: 'or', precedence: 3 }],
]);

/** 运算符的符号与力度。契约把运算符枚举钉死了，查不到说明契约与渲染器分叉了——直接抛。 */
const binaryOf = (operator: string): { readonly symbol: string; readonly precedence: number } => {
	const found = BINARY.get(operator);
	if (found === undefined) throw new Error(`unknown binary operator: ${operator}`);
	return found;
};

/** 叶子（字面量 / 引用 / 调用）的结合力度最高，永远不会被加括号。 */
const LEAF_PRECEDENCE = 100;
/**
 * 单独一个引用（`param`）的力度：比所有运算符低、比顶层阈值（0）高——
 * 于是 `x = (0.2)` 加括号（孤立看也认得出这是一个取值），
 * 而 `if reading < 0.5:` 里的 `reading` 不加（它是 `<` 的操作数，不是嵌套）。
 */
const CONSTANT_PRECEDENCE = 5;
const UNARY_PRECEDENCE = 8;

/**
 * 表达式 → 文本。
 *
 * `alwaysParen`：这是不是一个**顶层表达式**（赋值的右值、`if` 的条件）——是就永远加括号，
 * 孤立看也认得出这是一整个取值；嵌套的按优先级判断（`precedence` 低的子表达式裹起来）。
 */
const renderExpression = (
	state: RenderState,
	expression: ImplExpression,
	path: string,
	alwaysParen: boolean,
	declaredParameter?: PrimitiveSpec['parameters'][number],
): string => {
	const { node, collector } = state;

	switch (expression.kind) {
		case 'literal': {
			const value = renderConstant(expression.value, false, collector, {
				code: `${at(node, path)} 的字面量`,
				message: '实现里的字面量不是能写进代码的取值，渲染成 null',
				path: `nodes.${node.id}.parameters.action`,
				ref: node.id,
				details: { stepPath: path },
			});
			// 字面量落在实参位置上：原语定义说这个参数是什么类型，就按它渲染（`integer` 也认）。
			// 字面量本身是叶子：`(1.0) + (2.0)` 只是噪音，所以它从不被裹括号。
			if (declaredParameter !== undefined && declaredParameter.type === 'json') {
				return formatJsonLiteral(expression.value, false);
			}
			if (declaredParameter !== undefined && declaredParameter.type !== 'sensor') {
				return renderByType(
					declaredParameter.type,
					asRenderable(expression.value),
					declaredParameter.integer === true,
				).text;
			}
			return value.text;
		}

		case 'param': {
			const text = renderParam(state, expression, path, declaredParameter);
			return wrap(text, CONSTANT_PRECEDENCE, 0, alwaysParen);
		}

		case 'call': {
			const primitive = findPrimitive(state.catalog, expression.primitiveRef);
			if (primitive === undefined) {
				unknownPrimitive(state, expression.primitiveRef, path, true);
				return `/* 目录里没有原语「${expression.primitiveRef}」 */`;
			}
			if (primitive.returns === undefined) {
				// 没声明 `returns` 就说明它不返回值；出现在表达式里是目录写错了，点出来但照渲染。
				collector.error({
					code: 'code_render.primitive.not_returning',
					message: `${at(node, path)} 的 ${primitive.primitiveRef} 没有声明返回值，却出现在表达式里`,
					path: `nodes.${node.id}.parameters.action`,
					ref: node.id,
					details: { primitive: primitive.primitiveRef, stepPath: path },
				});
			}
			state.expressionCalls += 1;
			// 调用是叶子里最紧的：`x = read_status()` 不该变成 `x = (read_status())`。
			return `${expression.primitiveRef}(${renderArguments(state, primitive, expression.arguments, path)})`;
		}

		case 'binary': {
			const operator = binaryOf(expression.operator);
			const left = renderOperand(state, expression.left, path, operator.precedence, declaredParameter);
			const right = renderOperand(state, expression.right, path, operator.precedence, declaredParameter);
			return wrap(`${left} ${operator.symbol} ${right}`, operator.precedence, 0, alwaysParen);
		}

		case 'unary': {
			const prefix = expression.operator === 'not' ? 'not ' : '-';
			const operand = renderOperand(state, expression.value, path, UNARY_PRECEDENCE, declaredParameter);
			// `not false` / `not x` 没有歧义，不给操作数加括号（`-(x)` 才是该加的那种）。
			const bare = expression.value.kind === 'literal' || expression.value.kind === 'param';
			return wrap(`${prefix}${operand}`, UNARY_PRECEDENCE, 0, alwaysParen && !bare);
		}
	}
};

/** 子表达式：结合力度低于父运算符就裹括号（阈值给的是**父运算符自己的**力度）。 */
const renderOperand = (
	state: RenderState,
	expression: ImplExpression,
	path: string,
	parentPrecedence: number,
	declaredParameter?: PrimitiveSpec['parameters'][number],
): string => {
	const text = renderExpression(state, expression, path, false, declaredParameter);
	return wrap(text, precedenceOf(expression), parentPrecedence, false);
};

const precedenceOf = (expression: ImplExpression): number => {
	if (expression.kind === 'binary') return binaryOf(expression.operator).precedence;
	if (expression.kind === 'unary') return UNARY_PRECEDENCE;
	// 字面量是叶子：它旁边加括号只会变成噪音（`(1.0) + (2.0)`）。
	if (expression.kind === 'literal') return LEAF_PRECEDENCE;
	if (expression.kind === 'param') return CONSTANT_PRECEDENCE;
	return LEAF_PRECEDENCE;
};

const wrap = (text: string, precedence: number, threshold: number, force: boolean): string =>
	force || precedence < threshold ? `(${text})` : text;

/**
 * `{kind:'param'}` → 文本。三种引用分得清清楚楚：
 *
 * 1. **局部变量**（本能力实现里 `set` 过的名字，如 `reading`）→ **写名字**。
 *    它的值由运行时上一条赋值决定，渲染层算不出来；而名字正是这段程序里真实存在的东西
 *    （`reading = read_scan(...)` 上一行刚给过它）。写 `null` 才是把程序说错。
 * 2. **本能力的参数**（如 `linear`）→ **写本节点同名参数的实际值**（`0.2`）。
 *    这就是「同一份实现被不同参数复用」那条链：改积木上的数字，这里跟着变。
 * 3. 两边都不是 → 诊断 + 占位符 `null`，绝不猜。
 */
const renderParam = (
	state: RenderState,
	expression: ImplExpression & { kind: 'param' },
	path: string,
	declaredParameter?: PrimitiveSpec['parameters'][number],
): string => {
	const { node, collector, capability, locals } = state;
	const name: string = expression.name;
	const isLocal = locals.includes(name);
	const isCapabilityParameter = capability.parameters.some((parameter) => parameter.name === name);

	// 局部变量一律写名字——**实参位置也一样**（`set_velocity(linear=speed)`）。
	// 它的值由运行时上一条赋值决定，渲染层算不出来；退回节点的同名字段只会渲染成 `null`，
	// 那才是把程序说错。目录里原先没有这种用法，现在有了（实现先夹一次限速再下发）。
	if (isLocal) return name;

	const value = node.parameters[name];
	if (value === undefined) {
		collector.warning({
			code: 'code_render.param.unresolved',
			message:
				isLocal || isCapabilityParameter
					? `${at(node, path)} 的 ${name} 在本节点取不到值，渲染成占位符`
					: `${at(node, path)} 引用了 ${name}，它既不是局部变量也不是本能力的参数，渲染成占位符`,
			path: `nodes.${node.id}.parameters.${name}`,
			ref: node.id,
			details: { name, local: isLocal, capabilityParameter: isCapabilityParameter, stepPath: path },
		});
		return 'null';
	}

	if (declaredParameter !== undefined) {
		// 实参位置：按原语定义渲染（含 `integer`）。取不到合法取值时给诊断 + 占位符，
		// 与实现里直接写死的实参走同一条码（引用与字面量不该有两套口径）。
		if (declaredParameter.type === 'json') return formatJsonLiteral(value, false);
		const asValue = asRenderable(value);
		const rendered = renderByType(declaredParameter.type, asValue, declaredParameter.integer === true);
		if (rendered.code !== null) {
			collector.warning({
				code: rendered.code,
				message: `${at(node, path)} 的 ${name} ${valueMessage(rendered.code)}`,
				path: `nodes.${node.id}.parameters.${name}`,
				ref: node.id,
				details: { name, expected: declaredParameter.type, stepPath: path, value: jsonDetail(value) },
			});
		}
		return rendered.text;
	}

	return renderConstant(value, false, collector, {
		code: `${at(node, path)} 的 ${name}`,
		message: `引用 ${name} 的取值不是能写进代码的值，渲染成 null`,
		path: `nodes.${node.id}.parameters.${name}`,
		ref: node.id,
		details: { name, local: isLocal, stepPath: path },
	}).text;
};

// ---------------------------------------------------------------------------
// 反向查询：行 ↔ 步骤（界面只读这两向，不自己重算）
// ---------------------------------------------------------------------------

/** 这一行对应 `implementation` 的第几步（**顶层下标**，0 基）；注释行与越界行号给 null。 */
export const stepIndexAtLine = (program: RenderedImplementation, line: number): number | null =>
	program.lines.find((item) => item.line === line)?.stepIndex ?? null;

/** 这一行的精确树路径（`"1"`、`"1.then.0"`）；注释行与越界行号给 null。 */
export const stepPathAtLine = (program: RenderedImplementation, line: number): string | null =>
	program.lines.find((item) => item.line === line)?.stepPath ?? null;

/** 反向查询：树路径渲染在第几行；指不到给 null。 */
export const lineOfStep = (program: RenderedImplementation, stepPath: string): number | null =>
	program.lines.find((line) => line.stepPath === stepPath)?.line ?? null;

/** 反向查询：第 n 条**顶层**语句占的所有行（一个 `if` 会是好几行）。 */
export const linesOfTopStep = (
	program: RenderedImplementation,
	topIndex: number,
): readonly RenderedLine[] => program.lines.filter((line) => line.stepIndex === topIndex);

/** 某一行的文本；越界给 null。 */
export const lineText = (program: RenderedImplementation, line: number): string | null =>
	program.lines.find((item) => item.line === line)?.text ?? null;

/** 只有真正渲染出调用的行参与「几个原语」的计数与样式（说明行、赋值行、分支头不算）。 */
export const callLines = (program: RenderedImplementation): readonly RenderedLine[] =>
	program.lines.filter((line) => line.kind === 'call' && line.known);
