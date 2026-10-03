/**
 * 计划的结构：从 `connections` 推出「谁接谁」，以及分支的两条臂。
 *
 * 三个视图问的是同一件事（顺序是什么、这一步后面跟着谁），所以判据只有这一份：
 *
 * - 结构的权威在 **`connections`**，不在 `nodes` 的声明顺序、也不在 `position`（spec §1.2）。
 *   声明里的坐标只是画布外观，分支的两条臂在 y 上错开 ±140，那是给人看的，不是语义。
 * - 分支的语义全在那**三格出边**里（`@codecanvas/task-import` 的 skill-plan.ts 定的）：
 *   `main[0]` = then 臂的头、`main[1]` = else 臂的头、`main[2]` = 这一层里 `if` 之后的后续步骤。
 *   两臂的链尾**不接任何东西**（这一版不做汇合点），所以「走一步」就是顺着 `main[0]` 往下取。
 * - 普通步骤只有一格出边：下一步。没有出边就是链尾。
 *   等待步（`task.wait`）与原语步（`task.primitive`）就是普通步骤——它们没有臂，
 *   所以**不进分支那套两臂逻辑**（见 `isPlanLayerNode`）。
 *
 * 图推不出来时（悬空引用、环、多个链头、分支没有出边）**不抛异常、也不静默少画**：
 * 把问题如实记成诊断交给界面，能画的那部分照画——少画一步比画错一步更难发现。
 */
import {
	canonicalJsonString,
	findPrimitive,
	isJsonObject,
	type CapabilityCatalog,
	type ConnectionTarget,
	type JsonValue,
	type PrimitiveSpec,
	type WorkflowConnections,
	type WorkflowDeclaration,
	type WorkflowNode,
} from '@codecanvas/contracts';
import { formatNumberLiteral } from '@codecanvas/code-render';
import { TASK_BRANCH_NODE_TYPE, TASK_PRIMITIVE_NODE_TYPE, TASK_WAIT_NODE_TYPE } from '@codecanvas/task-import';

/** 计划层的一条问题。`nodeId` 有的问题指向具体一步，界面据此把话说到那一步上。 */
export interface PlanDiagnostic {
	readonly code: string;
	readonly message: string;
	readonly nodeId?: string;
}

/**
 * 一条臂。`note` 是「这条臂是空的」时给人看的那句话——
 * 空臂必须说明白（尤其是没有 `else` 的时候），画一片空白等于让人以为画漏了。
 */
export interface PlanArm {
	readonly kind: 'then' | 'else';
	readonly steps: readonly PlanStep[];
	readonly note: string | null;
}

export interface PlanStep {
	readonly node: WorkflowNode;
	/** 声明里的位置（0 基）：徽标上的「第几步」与另外两栏是同一个数。 */
	readonly index: number;
	readonly isBranch: boolean;
	/** 是不是等待步（`task.wait`）。它没有臂，所以与 `isBranch` 互斥。 */
	readonly isWait: boolean;
	/** 是不是原语步（`task.primitive`）。同样没有臂，所以与 `isBranch` 互斥。 */
	readonly isPrimitive: boolean;
	/** 只有分支步有；分支没有出边（图坏了）时是空表。等待步、原语步与技能步都是空表。 */
	readonly arms: readonly PlanArm[];
}

export interface PlanStructure {
	readonly steps: readonly PlanStep[];
	readonly diagnostics: readonly PlanDiagnostic[];
}

/** 单独看某一个分支节点：它的两条臂，以及走这条支路时发现的问题。 */
export interface BranchPlan {
	readonly node: WorkflowNode;
	readonly index: number;
	readonly arms: readonly PlanArm[];
	readonly diagnostics: readonly PlanDiagnostic[];
}

export const isBranchNode = (node: WorkflowNode): boolean => node.type === TASK_BRANCH_NODE_TYPE;

/** 是不是等待步（`task.wait`）。 */
export const isWaitNode = (node: WorkflowNode): boolean => node.type === TASK_WAIT_NODE_TYPE;

/** 是不是原语步（`task.primitive`）：直接叫一个原子动作，不经过任何能力。 */
export const isPrimitiveNode = (node: WorkflowNode): boolean => node.type === TASK_PRIMITIVE_NODE_TYPE;

/**
 * 是不是**计划层**的节点：分支、等待与原语。
 *
 * 为什么这三个归一类：它们都**没有实现可看**（技能步有，`action` 指向目录里的能力），
 * 所以选中它们时，代码面板与积木画布显示的是计划本身，而不是「某个能力做了什么」。
 * 原语步尤其如此：它叫的那个原语**不是能力**（目录里没有它的 `implementation`），
 * 拿它去 `catalog.capabilities` 里查只会得到一句「查不到这个能力」——那是把这一步说错了。
 * 判据只有这一处——三个视图都从这里问，不各写一遍 `type === ... || type === ...`。
 */
export const isPlanLayerNode = (node: WorkflowNode): boolean =>
	isBranchNode(node) || isWaitNode(node) || isPrimitiveNode(node);

/** 一个节点那三格出边。没有这一项就是三格都没有——「没连过线」与「连了个空」是两件事。 */
const mainPorts = (
	connections: WorkflowConnections,
	nodeId: string,
): readonly (readonly ConnectionTarget[])[] => {
	const main = connections[nodeId]?.['main'];
	return [main?.[0] ?? [], main?.[1] ?? [], main?.[2] ?? []];
};

const hasConnectionEntry = (connections: WorkflowConnections, nodeId: string): boolean =>
	connections[nodeId]?.['main'] !== undefined;

interface WalkState {
	readonly connections: WorkflowConnections;
	readonly byId: ReadonlyMap<string, WorkflowNode>;
	readonly indexOf: ReadonlyMap<string, number>;
	/** 已经画过的节点：环、以及同一个节点被两条边指到，都靠它停住。 */
	readonly seen: Set<string>;
	readonly diagnostics: PlanDiagnostic[];
}

const walkStateOf = (declaration: WorkflowDeclaration): WalkState => {
	const byId = new Map<string, WorkflowNode>();
	const indexOf = new Map<string, number>();
	declaration.nodes.forEach((node, index) => {
		byId.set(node.id, node);
		indexOf.set(node.id, index);
	});
	return { connections: declaration.connections, byId, indexOf, seen: new Set<string>(), diagnostics: [] };
};

/** 一格出边的头。一格里有多个目标时只画第一个，并如实说一声。 */
const headOfPort = (
	state: WalkState,
	node: WorkflowNode,
	slot: readonly ConnectionTarget[],
	label: string,
): string | null => {
	if (slot.length === 0) return null;
	if (slot.length > 1) {
		state.diagnostics.push({
			code: 'flow.graph.multiple_successors',
			message: `节点「${node.name}」的${label}上有 ${String(slot.length)} 个后继，只画了第一个（一格出边只该有一个目标）`,
			nodeId: node.id,
		});
	}
	return slot[0]?.node ?? null;
};

/**
 * 一个分支节点 → 它的两条臂 + 后续的头。
 *
 * 两条臂各自递归下去（臂里还能再分支），`seen` 是**全程共用**的：跨臂的环也拦得住。
 * 没有出边那一项时不画臂，只报一声——那时臂的内容根本无从谈起，硬画就是编。
 */
const armsOf = (state: WalkState, node: WorkflowNode): { arms: readonly PlanArm[]; continuation: string | null } => {
	if (!hasConnectionEntry(state.connections, node.id)) {
		state.diagnostics.push({
			code: 'flow.graph.branch_unlinked',
			message: `分支「${node.name}」没有出边，两条臂画不出来`,
			nodeId: node.id,
		});
		return { arms: [], continuation: null };
	}

	const ports = mainPorts(state.connections, node.id);
	const thenHead = headOfPort(state, node, ports[0] ?? [], '「那么」这一格');
	const elseHead = headOfPort(state, node, ports[1] ?? [], '「否则」这一格');
	const thenSteps = thenHead === null ? [] : walkChain(state, thenHead);
	const elseSteps = elseHead === null ? [] : walkChain(state, elseHead);

	if (thenSteps.length === 0) {
		// 计划层保证 `then` 至少一步（见 skill-plan.ts 的校验器），空了说明声明被改坏了。
		state.diagnostics.push({
			code: 'flow.graph.empty_then_arm',
			message: `分支「${node.name}」的「那么」是空的：条件成立时这一步什么都不做`,
			nodeId: node.id,
		});
	}

	return {
		arms: [
			{
				kind: 'then',
				steps: thenSteps,
				note: thenSteps.length === 0 ? '「那么」这一格是空的：条件成立时这一步什么都不做' : null,
			},
			{
				kind: 'else',
				steps: elseSteps,
				note: elseSteps.length === 0 ? '没有否则：条件不成立时这一步什么都不做' : null,
			},
		],
		continuation: headOfPort(state, node, ports[2] ?? [], '分支之后的后续'),
	};
};

/** 从链头一路走到链尾，返回这一层的步骤（分支步自带它的两条臂）。 */
const walkChain = (state: WalkState, head: string | null): PlanStep[] => {
	const steps: PlanStep[] = [];
	let current = head;

	while (current !== null) {
		const node = state.byId.get(current);
		if (node === undefined) {
			state.diagnostics.push({
				code: 'flow.graph.dangling_reference',
				message: `连线指向的节点 ${current} 不在声明里，往下画不出来`,
			});
			break;
		}
		if (state.seen.has(node.id)) {
			state.diagnostics.push({
				code: 'flow.graph.cycle',
				message: `「${node.name}」又被指回来了（环），这里停住以免无限展开`,
				nodeId: node.id,
			});
			break;
		}
		state.seen.add(node.id);
		const index = state.indexOf.get(node.id) ?? 0;

		if (!isBranchNode(node)) {
			steps.push({ node, index, isBranch: false, isWait: isWaitNode(node), isPrimitive: isPrimitiveNode(node), arms: [] });
			current = headOfPort(state, node, mainPorts(state.connections, node.id)[0] ?? [], '下一步');
			continue;
		}

		const { arms, continuation } = armsOf(state, node);
		steps.push({ node, index, isBranch: true, isWait: false, isPrimitive: false, arms });
		current = continuation;
	}

	return steps;
};

const namesOf = (nodes: readonly WorkflowNode[]): string =>
	nodes
		.slice(0, 3)
		.map((node) => `「${node.name}」`)
		.join('、') + (nodes.length > 3 ? ` 等 ${String(nodes.length)} 个` : '');

/**
 * 一份声明 → 一列步骤（分支自带臂）。
 *
 * 链头是**没有入边的节点**。多个链头、没有链头（整体是个环）都不猜一个「第一个」顶上：
 * 照声明顺序各走各的，把问题说出来。
 */
export const planStructureOf = (declaration: WorkflowDeclaration | null): PlanStructure => {
	if (declaration === null) return { steps: [], diagnostics: [] };

	const state = walkStateOf(declaration);
	const nodes = declaration.nodes;

	// 一条连线都没有：这份声明没说要连谁，顺序就是它自己的声明顺序（老行为），不额外报问题。
	const hasEdges = nodes.some((node) => mainPorts(declaration.connections, node.id).some((slot) => slot.length > 0));
	if (!hasEdges) {
		return {
			steps: nodes.map((node) => ({
				node,
				index: state.indexOf.get(node.id) ?? 0,
				isBranch: isBranchNode(node),
				isWait: isWaitNode(node),
				isPrimitive: isPrimitiveNode(node),
				arms: [],
			})),
			diagnostics: [],
		};
	}

	const incoming = new Set<string>();
	for (const node of nodes) {
		for (const slot of mainPorts(declaration.connections, node.id)) {
			for (const target of slot) incoming.add(target.node);
		}
	}
	const heads = nodes.filter((node) => !incoming.has(node.id));
	if (heads.length === 0) {
		state.diagnostics.push({
			code: 'flow.graph.no_head',
			message: '每一步都被别的步骤指着（没有链头，整份声明是个环），按声明顺序把它画出来',
		});
	} else if (heads.length > 1) {
		state.diagnostics.push({
			code: 'flow.graph.multiple_heads',
			message: `这份声明有 ${String(heads.length)} 个链头：${namesOf(heads)}，它们各自从最外层画起`,
		});
	}

	const steps: PlanStep[] = [];
	for (const head of heads) steps.push(...walkChain(state, head.id));

	// 走不到的节点（环里的、被悬空引用挡住的）不许静默丢掉：说出来，再按声明顺序补在最后。
	const missed = nodes.filter((node) => !state.seen.has(node.id));
	if (missed.length > 0) {
		state.diagnostics.push({
			code: 'flow.graph.unreachable_node',
			message: `有 ${String(missed.length)} 个节点从链头走不到（环或悬空引用）：${namesOf(missed)}，补在最后`,
		});
		for (const node of missed) {
			if (state.seen.has(node.id)) continue;
			steps.push(...walkChain(state, node.id));
		}
	}

	return { steps, diagnostics: state.diagnostics };
};

/**
 * 某一个分支节点的两条臂。
 *
 * 与 `planStructureOf` 分开是因为**代码面板与积木画布只看被选中的那一个节点**：
 * 选中它就该看得到它的臂，哪怕它挂在一条从链头走不到的支路上（那种声明是坏的，但如实画出来比空白有用）。
 */
export const branchPlanOf = (declaration: WorkflowDeclaration | null, nodeId: string): BranchPlan | null => {
	if (declaration === null) return null;
	const node = declaration.nodes.find((candidate) => candidate.id === nodeId);
	if (node === undefined || !isBranchNode(node)) return null;

	const state = walkStateOf(declaration);
	// 先把它自己记成走过的：环指回它时能停住。
	state.seen.add(node.id);
	const { arms } = armsOf(state, node);
	return { node, index: state.indexOf.get(node.id) ?? 0, arms, diagnostics: state.diagnostics };
};

// ---------------------------------------------------------------------------
// 执行路径（`1.then.0`）→ 那一步的节点
// ---------------------------------------------------------------------------

/** 路径里的一段是不是下标。只认非负整数：负号、小数、空串都不是路径的一部分。 */
const PLAN_INDEX = /^\d+$/;

/**
 * 执行路径 → 那一步的节点。
 *
 * 路径的口径与执行侧同一份（`@codecanvas/robot3d` 的 `plan.ts`）：第一段是**顶层下标**（0 基），
 * 之后 `then` / `else` 各带一个臂内下标往下接，例如 `1.then.0.else.1`。
 * 走的是 `planStructureOf` 那棵树，**不是拿路径去索引 `declaration.nodes`**——
 * 声明里节点是平铺的，臂里的节点排在分支后面，「路径的第几段」与「声明里的第几个节点」不是一回事。
 *
 * 推不出来就是 `null`：越界、格式不对、以及**悬空**（那段路径指着一个不存在的位置——
 * 技能步后面接 `then`、空臂里取第 0 步、臂名不是 `then`/`else`）。
 * 一律不猜、不抛：调用方拿到 `null` 就什么都不做，选中与运行标记都不该落在一个编出来的位置上。
 */
export const nodeAtPlanPath = (declaration: WorkflowDeclaration | null, path: string): WorkflowNode | null => {
	if (declaration === null) return null;

	const segments = path.split('.');
	// 段数必须是奇数：下标、臂、下标……最后收在下标上（`1.then` 停在臂上，不是一个位置）。
	if (segments.length % 2 === 0) return null;

	let steps: readonly PlanStep[] = planStructureOf(declaration).steps;
	/** 当前这一步的臂：下一段若是 `then` / `else`，就从这里挑一条往下走。 */
	let arms: readonly PlanArm[] = [];
	let node: WorkflowNode | null = null;

	for (const [position, segment] of segments.entries()) {
		if (position % 2 === 1) {
			const arm = arms.find((candidate) => candidate.kind === segment);
			if (arm === undefined) return null;
			steps = arm.steps;
			continue;
		}

		if (!PLAN_INDEX.test(segment)) return null;
		const step = steps[Number(segment)];
		if (step === undefined) return null;
		node = step.node;
		// 技能步与等待步的 `arms` 是空表，所以后面还跟着臂时下一轮必然挑不出臂来——那正是悬空。
		arms = step.arms;
	}

	return node;
};

/**
 * 一份声明 → **每一条走得到的执行路径**（路径 → 那一步的节点）。
 *
 * 为什么要有反向那一趟：`nodeAtPlanPath` 答的是「这条路径是哪一步」，而模型手里只有
 * 「这是第几步」——它要把路径写进规格，就得有一张能照抄的表。这张表**由我们列出来给它**
 * （提示词材料里那一块），而不是让它自己去推：推一遍就多一处可能推错的地方，
 * 而推错的后果是整整三处视图的联动都不生效。
 *
 * 口径与 `nodeAtPlanPath` 严格互逆（同一棵 `planStructureOf` 的树、同一个 `topIndex`）：
 * 遍历时逐个位置拼出路径，臂里的那一步排在自己的分支步后面，于是 `1.then.0` 这种也在这里。
 *
 * **链尾那几步没有臂**，所以它们的路径就是它在**本层**的下标——顶层第 3 步是 `2`，
 * 某条臂里的第 1 步是 `1.then.0`。同一层里同一个下标只会走到一个节点，所以路径唯一。
 */
export const planPathsOf = (declaration: WorkflowDeclaration | null): ReadonlyMap<string, WorkflowNode> => {
	const paths = new Map<string, WorkflowNode>();
	if (declaration === null) return paths;

	/** 已经收过的那几个节点：同一个节点只认**第一次**走到的那条路（见下）。 */
	const claimed = new Set<string>();
	const visit = (steps: readonly PlanStep[], prefix: string): void => {
		steps.forEach((step, index) => {
			const path = prefix === '' ? String(index) : `${prefix}.${String(index)}`;
			// 同一个节点被两条路走到（两条臂汇到同一步——那份声明是坏的，校验会拦）时，
			// 认哪条都在理，但只能认一条：屏幕上的「当前在第几步」只有一个答案。
			if (!paths.has(path) && !claimed.has(step.node.id)) {
				paths.set(path, step.node);
				claimed.add(step.node.id);
			}
			for (const arm of step.arms) visit(arm.steps, `${path}.${arm.kind}`);
		});
	};
	visit(planStructureOf(declaration).steps, '');
	return paths;
};

/**
 * 某一步的节点 → 它的执行路径（`planPathsOf` 的第一条；多了取最短的那条）。
 *
 * 用途只有一处：「人选中了某一步」这一路也要能变成一条路径，与设备报的那条同一个口径
 * ——两条路（选中 / 在跑）于是走同一份判据，而不是各写一套。
 */
export const planPathOf = (declaration: WorkflowDeclaration | null, nodeId: string | null): string | null => {
	if (nodeId === null) return null;
	for (const [path, node] of planPathsOf(declaration)) {
		if (node.id === nodeId) return path;
	}
	return null;
};

// ---------------------------------------------------------------------------
// 条件：人话给画布看，代码形态给代码面板看
// ---------------------------------------------------------------------------

/** 条件字段的中文名。字段全集在契约里（`BRANCH_CONDITION_FIELDS`），只有中文名没处可取，写在这里。 */
const CONDITION_FIELD_LABELS: Readonly<Record<string, string>> = { 'last.success': '上一步成功' };

const fieldLabelOf = (field: string): string => CONDITION_FIELD_LABELS[field] ?? field;

const displayJson = (value: JsonValue | undefined): string =>
	value === undefined ? '—' : canonicalJsonString(value);

/** 条件在三处的显示形态：卡头一句人话、`data-*` 三个原值、代码面板一行代码。 */
export interface ConditionView {
	/** 人话（不带开头的「如果」）：`上一步成功 == 假`。 */
	readonly text: string;
	readonly field: string;
	readonly op: string;
	/** 声明里原样的取值（JSON 写法：`false` / `true`），给机器对账。 */
	readonly value: string;
	/** 字段与算符都读得出来；读不出来时人话是「条件缺失」。 */
	readonly readable: boolean;
}

export const conditionViewOf = (node: WorkflowNode): ConditionView => {
	const raw = node.parameters['condition'];
	if (!isJsonObject(raw)) {
		return { text: '条件缺失', field: '', op: '', value: '', readable: false };
	}
	const field = typeof raw['field'] === 'string' ? raw['field'] : '';
	const op = typeof raw['op'] === 'string' ? raw['op'] : '';
	const value = raw['value'];
	const readable = field !== '' && op !== '';
	if (!readable) return { text: '条件缺失', field, op, value: displayJson(value), readable: false };

	// 布尔取值说「真 / 假」：条件是给人判断的，`false` 还得多想一步。
	const shown = typeof value === 'boolean' ? (value ? '真' : '假') : displayJson(value);
	return {
		text: `${fieldLabelOf(field)} ${op} ${shown}`,
		field,
		op,
		value: displayJson(value),
		readable: true,
	};
};

/**
 * 同一个条件的**代码形态**：`last.success == False`。
 * 字段名与算符照声明原样（它们是执行侧真的会看的量），取值用 Python 的布尔字面量——
 * 这段代码是计划层的写法，不是某个能力的实现（见代码面板上那句注记）。
 * 读不出来时返回 null，调用方据此写一行说明，而不是编一个条件。
 */
export const conditionCodeOf = (node: WorkflowNode): string | null => {
	const view = conditionViewOf(node);
	if (!view.readable) return null;
	const raw = node.parameters['condition'];
	const value = isJsonObject(raw) ? raw['value'] : undefined;
	const literal = typeof value === 'boolean' ? (value ? 'True' : 'False') : displayJson(value);
	return `${view.field} ${view.op} ${literal}`;
};

// ---------------------------------------------------------------------------
// 一步技能调用的写法（代码面板与积木共用同一个口径）
// ---------------------------------------------------------------------------

/** 计划里的字面量：数字照代码面板那一套（整数也带一位小数），布尔说 True/False。 */
export const planLiteralOf = (value: JsonValue | undefined): string => {
	if (value === undefined) return '—';
	if (typeof value === 'number') return formatNumberLiteral(value);
	if (typeof value === 'boolean') return value ? 'True' : 'False';
	if (typeof value === 'string') return JSON.stringify(value);
	return JSON.stringify(value) ?? 'null';
};

/**
 * 节点参数里**不是这次调用实参**的那几个键。
 *
 * `step_id` 是节点的语义身份；`action` / `primitive` 是「这次叫的是谁」（已经写在函数名里了）；
 * `timeoutSec` 与 `onFailure` 是**这一步自己的属性**（目录里没有这两栏，由 `@codecanvas/task-import`
 * 按原名平铺进来）。它们照旧在流程卡片上显示着，只是不冒充实参——一次调用里没有
 * 「失败也往下走」这种参数。
 */
const CALL_STEP_KEYS = new Set(['step_id', 'action', 'primitive', 'timeoutSec', 'onFailure']);

/** 这一步给了的那些实参（顺序照节点参数；要按声明排序的用法见 `primitiveCallTextOf`）。 */
const planArgumentsOf = (node: WorkflowNode): readonly (readonly [string, JsonValue])[] =>
	Object.entries(node.parameters).filter(([key]) => !CALL_STEP_KEYS.has(key));

/**
 * 臂里那一步的调用写法：`close_gripper_skill()`，有技能参数就照计划里的样子列出来。
 *
 * 代码面板与积木画布**共用这一个口径**：同一件事在两处长得一样，人才认得出说的是同一步。
 * `timeoutSec` 与 `onFailure` 刻意不列：它们不是技能参数（目录里没有这两栏），是这一步自己的属性——
 * 换句话说不属于这次调用；它们在流程卡片上照旧显示着，一个字都没丢。
 */
export const planCallTextOf = (node: WorkflowNode): string => {
	const skill = node.parameters['action'];
	const name = typeof skill === 'string' && skill !== '' ? skill : '?';
	const args = planArgumentsOf(node).map(([key, value]) => `${key}=${planLiteralOf(value)}`);
	return `${name}(${args.join(', ')})`;
};

// ---------------------------------------------------------------------------
// 原语步（`task.primitive`）：名字与实参都从目录读
// ---------------------------------------------------------------------------

/**
 * 原语的显示名：目录里那个 `label`（「张开夹爪」），查不到就照出原名——**不编一个**。
 *
 * 视图里没有第二份原语名表：目录是设备报上来的，写死一份就会在换设备之后显示成标识符。
 */
export const primitiveLabelOf = (catalog: CapabilityCatalog | null, primitiveRef: string): string =>
	catalog === null ? primitiveRef : (findPrimitive(catalog, primitiveRef)?.label ?? primitiveRef);

/** 这一步叫的是哪个原语（节点参数里那一个；读不出来就是空串）。 */
export const primitiveRefOf = (node: WorkflowNode): string => {
	const ref = node.parameters['primitive'];
	return typeof ref === 'string' ? ref : '';
};

/** 这一步叫的那个原语在目录里的定义；查不到（或没有目录）就是 `null`。 */
export const primitiveSpecOf = (catalog: CapabilityCatalog | null, node: WorkflowNode): PrimitiveSpec | null =>
	catalog === null ? null : (findPrimitive(catalog, primitiveRefOf(node)) ?? null);

/**
 * 原语步的写法：`open_gripper()` / `move_to_named_pose(pose_name="home")`。
 *
 * **实参按原语声明的顺序与名字**（`catalog.primitives[].parameters`），与 `@codecanvas/code-render`
 * 渲染实现里那些原语调用的口径一致——同一台设备上的同一个原语，在实现里与在计划里长得一样。
 * 没给的参数不补一行（计划只写了它要给的那些，没给的由执行侧用默认值）；
 * 目录里查不到这个原语时退回节点参数的顺序，照实写出来，不假装知道它的声明顺序。
 */
export const primitiveCallTextOf = (node: WorkflowNode, catalog: CapabilityCatalog | null = null): string => {
	const ref = primitiveRefOf(node);
	const name = ref === '' ? '?' : ref;
	const declared = primitiveSpecOf(catalog, node)?.parameters ?? [];
	const order = new Map(declared.map((parameter, index) => [parameter.name, index]));
	// 声明里有的按声明排，没有的（改坏的声明）排在后面——排序稳定，所以它们自己那一段仍按原顺序。
	const args = planArgumentsOf(node)
		.map((entry, index) => ({ entry, rank: order.get(entry[0]) ?? declared.length + index }))
		.sort((left, right) => left.rank - right.rank)
		.map(({ entry: [key, value] }) => `${key}=${planLiteralOf(value)}`);
	return `${name}(${args.join(', ')})`;
};

// ---------------------------------------------------------------------------
// 等待步（`task.wait`）：一句人话 + 一行代码，都是同一个数
// ---------------------------------------------------------------------------

/**
 * 等待步的秒数。声明里那个数**原样**读出来；读不出来（不是数字）就是 `null`。
 *
 * 判据（正数、上限十分钟）在校验器那边（`@codecanvas/contracts` 的 `validateSkillPlan`），
 * 这里只是显示——坏声明也照画，该报的错由诊断说。
 */
export const waitSecondsOf = (value: JsonValue | undefined): number | null =>
	typeof value === 'number' && Number.isFinite(value) ? value : null;

/**
 * 等待步的那句人话：`等待 2 秒`。
 *
 * **就一个数**：这里不摆「几秒怎么说」的表（1 秒说「1 秒」、60 秒说「一分钟」那种），
 * 表格一多，卡片、积木、面板就会各说各的；声明里是 2 就写 2。
 */
export const waitLabelOf = (value: JsonValue | undefined): string => {
	const seconds = waitSecondsOf(value);
	return seconds === null ? '等待（秒数读不出来）' : `等待 ${String(seconds)} 秒`;
};

/**
 * 等待步的**代码写法**：`wait(2.0)`——与技能调用的写法同一层（计划层），
 * 秒数照代码面板那一套（整数也带一位小数），于是代码行、积木、卡片说的是同一个数。
 */
export const planWaitCallTextOf = (node: WorkflowNode): string => {
	const seconds = waitSecondsOf(node.parameters['seconds']);
	return `wait(${seconds === null ? '?' : formatNumberLiteral(seconds)})`;
};

// ---------------------------------------------------------------------------
// 技能步的失败处置（`onFailure`）：一句人话，判据从节点参数读
// ---------------------------------------------------------------------------

/**
 * 这一步**失败之后还往下走吗**。
 *
 * 判据**从节点参数读**（`onFailure` 与 `timeoutSec` 一样：它不是技能参数，是这一步自己的属性，
 * 由 `@codecanvas/task-import` 按原名平铺进 `parameters`），视图里**不另立一份字段表**——
 * 那张表一写就是第二份真相，导入侧改了键名这边就静默失准。
 *
 * 只有 `'continue'` 才算数：缺省、`'stop'` 与任何读不出来的值都按缺省（停）处理——
 * 与执行侧同一个口径（`apps/robot3d/src/roboframe/plan.ts`），也与契约里那条安全立场一致。
 * **带这一栏的是技能步与原语步**（两者都会成会败），等待与分支上它不存在（契约那边就报错）。
 */
export const continuesOnFailure = (node: WorkflowNode): boolean => node.parameters['onFailure'] === 'continue';

/**
 * 那句人话：`失败也往下走`。
 *
 * 写在流程卡上（分支卡的条件、等待卡的「等待 N 秒」都是这个位置上的同类东西）：
 * 一句话，说的是这一步的失败处置——不把 `'continue'` 这种机器词摆给人看，
 * 也不解释「后面的分叉因此能分到 false 那条臂」（那是读计划的人顺着往下看就知道的事）。
 */
export const CONTINUE_ON_FAILURE_NOTE = '失败也往下走';
