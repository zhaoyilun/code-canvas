/**
 * 计划层的代码形态：选中一个**计划层节点**（分支 / 等待 / 原语）时代码面板显示什么。
 *
 * 这一层与「能力的实现」是两码事，判据也不一样：
 *
 * - 能力的实现来自目录（`capability.implementation`，见 `@codecanvas/code-render`）——
 *   一个模块 = 一个能力，代码是这个能力在机器上具体做了什么；
 * - 分支是**任务计划**里的一条结构化语句（`if / else`），它的臂里装的是**技能调用**
 *   （`close_gripper_skill()`）与等待（`wait(2.0)`），不是某个能力的原语实现。硬把臂里的技能展开成原语，
 *   等于把「计划」和「实现」两层揉成一层，看不出这句话是在哪一层说的。
 *   要看那一步的实现：点那一行 —— 选中那一步，面板换成它的实现。
 * - 等待步（`task.wait`）**没有实现可看**（它不是能力调用，目录里没有它），所以选中它时
 *   面板显示的就是计划层的那一行 `wait(2.0)`——这正是「计划层的代码」最纯粹的样子。
 * - 原语步（`task.primitive`）同理：它叫的那个原语**不是能力**（目录里没有它的 `implementation`），
 *   拿它走「能力实现」那条路只会得到一句「查不到这个能力」。它显示的是那一行原语调用
 *   （`open_gripper()`），实参按原语声明的顺序与名字写——与实现里那些调用同一个口径。
 *
 * 行的形状与 `RenderedLine` 对齐（行号、缩进、`stepIndex`、`stepPath`），
 * 面板那一套渲染、徽标、高亮因此不用为它另写一遍。多出来的一件事是 `nodeId`：
 * 计划层每一行都对应**一个真实的节点**（分支自己，或臂里那一步、或等待步/原语步自己），
 * 于是这一行能点、能连到流程卡片与积木上（跨栏连线只认 `data-node-id`）。
 */
import { INDENT_UNIT, type RenderedLine } from '@codecanvas/code-render';
import type { CapabilityCatalog, Diagnostic, WorkflowDeclaration, WorkflowNode } from '@codecanvas/contracts';
import {
	branchPlanOf,
	conditionCodeOf,
	isPrimitiveNode,
	isWaitNode,
	planCallTextOf,
	planWaitCallTextOf,
	primitiveCallTextOf,
	type PlanDiagnostic,
	type PlanStep,
} from '../shared/plan-structure';

/** 面板上那句「这是哪一层的代码」。计划层节点选中时显示，普通模块不显示（那两件事不许混）。 */
export const PLAN_LAYER_NOTE =
	'这是计划层的代码：臂里每一步是一次技能调用（技能名就是那一步的技能），等待就是 wait(秒数)，直接叫原语就是一行原语调用（如 open_gripper()），不是那个能力的实现。点某一行进那一步，才看得到它的实现。';

/** 计划层的一行。`nodeId` 是这一行说的那一步；注释行没有节点。 */
export interface PlanLine extends RenderedLine {
	readonly nodeId: string | null;
}

export interface PlanProgram {
	readonly nodeId: string;
	/** 标题：「<节点名> · 计划」。 */
	readonly title: string;
	readonly lines: readonly PlanLine[];
	/** 走这两条臂时发现的问题（悬空引用、环、空臂……）。 */
	readonly diagnostics: readonly Diagnostic[];
}

/**
 * 这一行指的是哪个节点（普通实现行没有这个字段 → null）。
 * 面板据此决定「点这一行是选步，还是进另一步」。
 */
export const lineNodeId = (line: RenderedLine | PlanLine): string | null =>
	'nodeId' in line && typeof line.nodeId === 'string' ? line.nodeId : null;

/**
 * 分支节点 = 这个「模块」里唯一的一条顶层语句，所以它所有行的顶层下标都是 0。
 * 徽标因此只挂在 `if` 那一行（面板按「顶层下标变了才挂徽标」判，见 CodePanel 的 `stepHeads`）。
 */
const STATEMENT_INDEX = 0;

interface LineWriter {
	readonly lines: PlanLine[];
}

const push = (
	writer: LineWriter,
	text: string,
	kind: RenderedLine['kind'],
	indent: number,
	stepPath: string | null,
	nodeId: string | null,
): void => {
	writer.lines.push({
		line: writer.lines.length + 1,
		text: INDENT_UNIT.repeat(indent) + text,
		indent,
		kind,
		stepIndex: STATEMENT_INDEX,
		stepPath,
		primitiveRef: null,
		known: true,
		nodeId,
	});
};

/** 一条臂里的步骤：普通步骤一行调用（技能步就是调用，等待步就是 `wait(秒数)`，原语步就是原语调用），嵌套的分支递归成一段 `if / else`。 */
const writeSteps = (
	writer: LineWriter,
	steps: readonly PlanStep[],
	indent: number,
	basePath: string,
	catalog: CapabilityCatalog | null,
): void => {
	steps.forEach((step, index) => {
		const path = `${basePath}.${String(index)}`;
		if (step.isBranch) {
			writeBranch(writer, step.node, step.arms, indent, path, catalog);
			return;
		}
		// 等待步、原语步与技能步都是「一行计划」，只是写法不一样：
		// `wait(2.0)` / `open_gripper()` / `close_gripper_skill()`。
		const text = step.isWait
			? planWaitCallTextOf(step.node)
			: step.isPrimitive
				? primitiveCallTextOf(step.node, catalog)
				: planCallTextOf(step.node);
		push(writer, text, 'call', indent, path, step.node.id);
	});
};

/** 一个分支节点 → `if <条件>:` + 两条臂（臂空就说清楚，不画一片空白）。 */
const writeBranch = (
	writer: LineWriter,
	node: WorkflowNode,
	arms: readonly { readonly kind: 'then' | 'else'; readonly steps: readonly PlanStep[] }[],
	indent: number,
	path: string,
	catalog: CapabilityCatalog | null,
): void => {
	const condition = conditionCodeOf(node);
	if (condition === null) {
		push(writer, '# 条件读不出来（声明里的 condition 缺 field 或 op），两条臂照画', 'comment', indent, path, node.id);
	} else {
		push(writer, `if ${condition}:`, 'if', indent, path, node.id);
	}

	if (arms.length === 0) {
		push(writer, '# 这个分支没有出边，两条臂画不出来', 'comment', indent + 1, `${path}.arms`, null);
		return;
	}

	const thenArm = arms.find((arm) => arm.kind === 'then');
	const elseArm = arms.find((arm) => arm.kind === 'else');

	if (thenArm === undefined || thenArm.steps.length === 0) {
		push(writer, '# 「那么」这一格是空的：条件成立时这一步什么都不做', 'comment', indent + 1, `${path}.then`, null);
	} else {
		writeSteps(writer, thenArm.steps, indent + 1, `${path}.then`, catalog);
	}

	if (elseArm === undefined || elseArm.steps.length === 0) {
		// 没有否则要说出来：`if` 后面直接结束，读代码的人会以为画漏了一段。
		push(writer, '# 没有否则：条件不成立时这一步什么都不做', 'comment', indent + 1, `${path}.else`, null);
		return;
	}
	push(writer, 'else:', 'else', indent, `${path}.else`, node.id);
	writeSteps(writer, elseArm.steps, indent + 1, `${path}.else`, catalog);
};

/** 计划层的问题 → 面板底下那条警告列表（它认的就是 `Diagnostic` 的形状）。 */
const asDiagnostics = (diagnostics: readonly PlanDiagnostic[]): readonly Diagnostic[] =>
	diagnostics.map((diagnostic) => ({
		code: diagnostic.code,
		severity: 'warning',
		message: diagnostic.message,
		...(diagnostic.nodeId === undefined ? {} : { ref: diagnostic.nodeId }),
	}));

/**
 * 选中的节点是**计划层节点** → 它的计划层代码；别的节点（或声明还没来）→ null，
 * 由调用方退回「能力实现」那条路。
 *
 * 三种计划层节点各显示什么：
 * - 分支 → 这一层的 `if / else`（臂里是技能调用、等待与原语调用）；
 * - 等待 → 它自己那一行 `wait(2.0)`。等待步没有能力可查、没有实现可看，
 *   硬走「能力实现」那条路只会得到一句「查不到能力」——那是把「这一步只是等一会儿」说错了；
 * - 原语 → 它自己那一行原语调用（`open_gripper()`）。理由与等待步同一条：
 *   原语**不是能力**（目录里没有它的实现），去 `catalog.capabilities` 里查必然查不到。
 *
 * `catalog` 只用来读**原语的参数声明顺序**（实参照它排，与实现里的调用同一个口径）；
 * 给不出时按节点参数的顺序写，照实写出来，不编一个顺序。
 */
export const planProgramOf = (
	declaration: WorkflowDeclaration | null,
	nodeId: string,
	catalog: CapabilityCatalog | null = null,
): PlanProgram | null => {
	if (declaration === null) return null;
	const selected = declaration.nodes.find((node) => node.id === nodeId);

	if (selected !== undefined && (isWaitNode(selected) || isPrimitiveNode(selected))) {
		const writer: LineWriter = { lines: [] };
		const text = isWaitNode(selected) ? planWaitCallTextOf(selected) : primitiveCallTextOf(selected, catalog);
		push(writer, text, 'call', 0, String(STATEMENT_INDEX), selected.id);
		return { nodeId: selected.id, title: `${selected.name} · 计划`, lines: writer.lines, diagnostics: [] };
	}

	const plan = branchPlanOf(declaration, nodeId);
	if (plan === null) return null;

	const writer: LineWriter = { lines: [] };
	writeBranch(writer, plan.node, plan.arms, 0, String(STATEMENT_INDEX), catalog);

	return {
		nodeId: plan.node.id,
		title: `${plan.node.name} · 计划`,
		lines: writer.lines,
		diagnostics: asDiagnostics(plan.diagnostics),
	};
};
