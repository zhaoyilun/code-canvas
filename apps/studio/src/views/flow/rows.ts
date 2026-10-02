/**
 * 流程画布上那一列卡片：把**计划结构**摊成能顺序渲染的行。
 *
 * 为什么要摊：分支是嵌套的（臂里还能再分支），而嵌套要模板递归。这里把嵌套摊成
 * 「卡片行 + 它自己的臂行」，模板照着画；缩进的语义是 DOM 嵌套（臂里的卡片在 `.flow-arm` 里），
 * 不是拿 CSS 猜出来的——否则「哪张卡属于哪条臂」在 DOM 上就无迹可查，验收只能靠肉眼。
 *
 * 卡片上的参数摘要仍走 `summary.ts` 那一套（判据只有校验器一个来源）；
 * 分支卡是唯一的例外：它没有 `action`，参数**只有条件本身**，所以卡头旁边画的是条件的人话，
 * 而不是「这个动作没有参数」——那句话在分支上是错的（它不是动作，也就谈不上没有参数）。
 */
import type { Diagnostic, WorkflowNode } from '@codecanvas/contracts';
import { TASK_BRANCH_NODE_TYPE } from '@codecanvas/task-import';
import {
	actionLabel,
	nodeAction,
	nodeActionName,
	nodeDiagnostics,
	nodeStepId,
	summarizeNodeParameters,
	type NodeLimits,
	type ParameterSummary,
} from './summary';
import { conditionViewOf, type ConditionView, type PlanStep } from '../shared/plan-structure';

export interface FlowCardModel {
	readonly node: WorkflowNode;
	/** 声明里的位置（0 基）。徽标上的「第几步」= `index + 1`。 */
	readonly index: number;
	/** 卡头显示的文字：动作的中文名，分支卡是「分支」。 */
	readonly action: string;
	/** 协议里的名字（分支卡是节点类型），只进 `data-action`。 */
	readonly actionName: string;
	readonly stepId: string | null;
	readonly parameters: readonly ParameterSummary[];
	readonly diagnostics: readonly Diagnostic[];
	/** 只有分支卡有：这一层的条件（人话 + 原值）。 */
	readonly condition: ConditionView | null;
}

export interface FlowCardRow {
	readonly kind: 'card';
	readonly key: string;
	readonly card: FlowCardModel;
	/** 分支卡的两条臂（普通卡是空表），紧跟在卡片后面渲染。 */
	readonly arms: readonly FlowArmRow[];
}

export interface FlowArmRow {
	readonly kind: 'arm';
	readonly key: string;
	readonly arm: 'then' | 'else';
	/** 嵌套层数（最外层分支的臂是 0），只进 `data-depth` 与验收，不参与排版。 */
	readonly depth: number;
	/** 这条臂是空的时给人看的那句话；有内容就是 null。 */
	readonly note: string | null;
	readonly rows: readonly FlowRow[];
}

export type FlowRow = FlowCardRow | FlowArmRow;

/**
 * 分支卡的参数：`condition` 已经单画一行了，这里只收**别的东西**。
 * 正常的声明里它是空的（分支节点的参数只有条件）；多出来的键照原样列出来，不偷偷咽掉。
 */
const branchExtraParameters = (node: WorkflowNode, limits: NodeLimits): readonly ParameterSummary[] => {
	const { condition: _condition, ...rest } = node.parameters;
	return Object.keys(rest).length === 0 ? [] : summarizeNodeParameters(rest, null, limits);
};

const cardOf = (step: PlanStep, diagnostics: readonly Diagnostic[], limits: NodeLimits): FlowCardModel => ({
	node: step.node,
	index: step.index,
	action: step.isBranch ? '分支' : actionLabel(step.node),
	actionName: step.isBranch ? TASK_BRANCH_NODE_TYPE : nodeActionName(step.node),
	stepId: nodeStepId(step.node),
	parameters: step.isBranch
		? branchExtraParameters(step.node, limits)
		: summarizeNodeParameters(step.node.parameters, nodeAction(step.node), limits),
	diagnostics: nodeDiagnostics(diagnostics, step.node, step.index),
	condition: step.isBranch ? conditionViewOf(step.node) : null,
});

/** 一串步骤 → 一串行。臂里的步骤走同一条路（`depth + 1`），只是包在自己的臂行里。 */
export const buildFlowRows = (
	steps: readonly PlanStep[],
	diagnostics: readonly Diagnostic[],
	limits: NodeLimits,
	depth = 0,
): readonly FlowRow[] =>
	steps.map((step) => ({
		kind: 'card' as const,
		key: `card:${step.node.id}`,
		card: cardOf(step, diagnostics, limits),
		arms: step.arms.map((arm) => ({
			kind: 'arm' as const,
			key: `arm:${step.node.id}:${arm.kind}`,
			arm: arm.kind,
			depth,
			note: arm.note,
			rows: buildFlowRows(arm.steps, diagnostics, limits, depth + 1),
		})),
	}));
