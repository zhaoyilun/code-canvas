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
 *   等待步（`task.wait`）就是普通步骤——它没有臂，所以**不进分支那套两臂逻辑**（见 `isPlanLayerNode`）。
 *
 * 图推不出来时（悬空引用、环、多个链头、分支没有出边）**不抛异常、也不静默少画**：
 * 把问题如实记成诊断交给界面，能画的那部分照画——少画一步比画错一步更难发现。
 */
import {
	canonicalJsonString,
	isJsonObject,
	type ConnectionTarget,
	type JsonValue,
	type WorkflowConnections,
	type WorkflowDeclaration,
	type WorkflowNode,
} from '@codecanvas/contracts';
import { formatNumberLiteral } from '@codecanvas/code-render';
import { TASK_BRANCH_NODE_TYPE, TASK_WAIT_NODE_TYPE } from '@codecanvas/task-import';

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
	/** 只有分支步有；分支没有出边（图坏了）时是空表。等待步与技能步都是空表。 */
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

/** 是不是等待步的节点（`task.wait`）。 */
export const isWaitNode = (node: WorkflowNode): boolean => node.type === TASK_WAIT_NODE_TYPE;

/**
 * 是不是**计划层**的节点：分支与等待。
 *
 * 为什么这两个归一类：它们都**没有实现可看**（技能步有，`action` 指向目录里的能力），
 * 所以选中它们时，代码面板与积木画布显示的是计划本身，而不是「某个能力做了什么」。
 * 判据只有这一处——三个视图都从这里问，不各写一遍 `type === ... || type === ...`。
 */
export const isPlanLayerNode = (node: WorkflowNode): boolean => isBranchNode(node) || isWaitNode(node);

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
			steps.push({ node, index, isBranch: false, isWait: isWaitNode(node), arms: [] });
			current = headOfPort(state, node, mainPorts(state.connections, node.id)[0] ?? [], '下一步');
			continue;
		}

		const { arms, continuation } = armsOf(state, node);
		steps.push({ node, index, isBranch: true, isWait: false, arms });
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
 * 臂里那一步的调用写法：`close_gripper_skill()`，有技能参数就照计划里的样子列出来。
 *
 * 代码面板与积木画布**共用这一个口径**：同一件事在两处长得一样，人才认得出说的是同一步。
 * `timeoutSec` 刻意不列：它不是技能参数（目录里没有这一栏），是这一步的超时——
 * 换句话说不属于这次调用；它在流程卡片上照旧显示着，一个字都没丢。
 */
export const planCallTextOf = (node: WorkflowNode): string => {
	const skill = node.parameters['action'];
	const name = typeof skill === 'string' && skill !== '' ? skill : '?';
	const args = Object.entries(node.parameters)
		.filter(([key]) => key !== 'action' && key !== 'step_id' && key !== 'timeoutSec')
		.map(([key, value]) => `${key}=${planLiteralOf(value)}`);
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
