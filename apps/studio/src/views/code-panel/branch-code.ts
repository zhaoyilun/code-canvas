/**
 * 计划层的代码形态：选中一个**分支节点**时代码面板显示什么。
 *
 * 这一层与「能力的实现」是两码事，判据也不一样：
 *
 * - 能力的实现来自目录（`capability.implementation`，见 `@codecanvas/code-render`）——
 *   一个模块 = 一个能力，代码是这个能力在机器上具体做了什么；
 * - 分支是**任务计划**里的一条结构化语句（`if / else`），它的臂里装的是**技能调用**
 *   （`close_gripper_skill()`），不是某个能力的原语实现。硬把臂里的技能展开成原语，
 *   等于把「计划」和「实现」两层揉成一层，看不出这句话是在哪一层说的。
 *   要看那一步的实现：点那一行 —— 选中那一步，面板换成它的实现。
 *
 * 行的形状与 `RenderedLine` 对齐（行号、缩进、`stepIndex`、`stepPath`），
 * 面板那一套渲染、徽标、高亮因此不用为它另写一遍。多出来的一件事是 `nodeId`：
 * 计划层每一行都对应**一个真实的节点**（分支自己，或臂里那一步），
 * 于是这一行能点、能连到流程卡片与积木上（跨栏连线只认 `data-node-id`）。
 */
import { INDENT_UNIT, type RenderedLine } from '@codecanvas/code-render';
import type { Diagnostic, WorkflowDeclaration, WorkflowNode } from '@codecanvas/contracts';
import {
	branchPlanOf,
	conditionCodeOf,
	planCallTextOf,
	type PlanDiagnostic,
	type PlanStep,
} from '../flow/plan-structure';

/** 面板上那句「这是哪一层的代码」。分支节点选中时显示，普通模块不显示（那两件事不许混）。 */
export const PLAN_LAYER_NOTE =
	'这是计划层的代码：臂里每一步是一次技能调用（技能名就是那一步的技能），不是那个能力的实现。点某一行进那一步，才看得到它的实现。';

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

/** 一条臂里的步骤：普通步骤一行调用，嵌套的分支递归成一段 `if / else`。 */
const writeSteps = (writer: LineWriter, steps: readonly PlanStep[], indent: number, basePath: string): void => {
	steps.forEach((step, index) => {
		const path = `${basePath}.${String(index)}`;
		if (!step.isBranch) {
			push(writer, planCallTextOf(step.node), 'call', indent, path, step.node.id);
			return;
		}
		writeBranch(writer, step.node, step.arms, indent, path);
	});
};

/** 一个分支节点 → `if <条件>:` + 两条臂（臂空就说清楚，不画一片空白）。 */
const writeBranch = (
	writer: LineWriter,
	node: WorkflowNode,
	arms: readonly { readonly kind: 'then' | 'else'; readonly steps: readonly PlanStep[] }[],
	indent: number,
	path: string,
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
		writeSteps(writer, thenArm.steps, indent + 1, `${path}.then`);
	}

	if (elseArm === undefined || elseArm.steps.length === 0) {
		// 没有否则要说出来：`if` 后面直接结束，读代码的人会以为画漏了一段。
		push(writer, '# 没有否则：条件不成立时这一步什么都不做', 'comment', indent + 1, `${path}.else`, null);
		return;
	}
	push(writer, 'else:', 'else', indent, `${path}.else`, node.id);
	writeSteps(writer, elseArm.steps, indent + 1, `${path}.else`);
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
 * 选中的节点是分支节点 → 它的计划层代码；不是分支节点（或声明还没来）→ null，
 * 由调用方退回「能力实现」那条路。
 */
export const planProgramOf = (declaration: WorkflowDeclaration | null, nodeId: string): PlanProgram | null => {
	const plan = branchPlanOf(declaration, nodeId);
	if (plan === null) return null;

	const writer: LineWriter = { lines: [] };
	writeBranch(writer, plan.node, plan.arms, 0, String(STATEMENT_INDEX));

	return {
		nodeId: plan.node.id,
		title: `${plan.node.name} · 计划`,
		lines: writer.lines,
		diagnostics: asDiagnostics(plan.diagnostics),
	};
};
