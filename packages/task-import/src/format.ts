/**
 * 任务格式登记处：**一台设备一套任务格式**，但对上层只有一张脸。
 *
 * 为什么要有这一层：一期协议的词汇表是七个写死的动作，而 RoboFrame 的设备听的是一串技能调用，
 * 技能可以随时增删。所以「任务长什么样」不是全局常量，是**设备属性**——
 * 选哪台设备，就决定了入口收什么样的 JSON、写回时拿哪把尺子量、JSON 视图还原成什么形状。
 *
 * 三个视图（流程 / 积木 / 代码）完全不知道这回事：两条路都汇进同一份 `WorkflowDeclaration`。
 * 这一层是唯一分叉的地方，分叉点小到能一眼看完。
 *
 * 每个格式要能回答四个问题：
 * - `parse`：这段文本能不能变成声明（不能就给带路径的诊断，不抛异常）；
 * - `fromDeclaration`：声明还原成这个格式的任务 JSON（JSON 视图与第二道闸都用它）；
 * - `validateDeclaration`：拿这个格式的尺子量一遍声明（写回的第二道闸）；
 * - `describe`：一句话说清这是什么格式，界面上要如实标出来。
 */
import {
	SKILL_PLAN_SCHEMA_VERSION,
	TASK_SCHEMA_VERSION,
	validateSkillPlan,
	validateTask,
	type CapabilityCatalog,
	type Diagnostic,
	type JsonObject,
	type StableIdFactory,
	type WorkflowDeclaration,
	type WorkflowNode,
} from '@codecanvas/contracts';
import { TASK_ACTION_NODE_TYPE, importTaskJson } from './convert';
import { TASK_BRANCH_NODE_TYPE, importSkillPlanJson } from './skill-plan';

/** 两条路都把「成/不成」说成同一个形状，上层不用分情况。 */
export type DeclarationImportResult =
	| { readonly ok: true; readonly declaration: WorkflowDeclaration; readonly diagnostics: readonly Diagnostic[] }
	| { readonly ok: false; readonly diagnostics: readonly Diagnostic[] };

export interface TaskFormatContext {
	/** 设备报上来的目录。技能名、参数名与类型都照它判。 */
	readonly catalog: CapabilityCatalog;
	/** 缺省用 ULID 工厂；测试与重放注入确定性工厂。 */
	readonly idFactory?: StableIdFactory;
	/** 一期协议：执行端已接受的 task_id。 */
	readonly seenTaskIds?: readonly string[];
}

export type TaskFormatRef = 'phase1_task' | 'skill_plan';

export interface TaskFormat {
	readonly formatRef: TaskFormatRef;
	/** 界面上显示的名字。 */
	readonly label: string;
	/** 一句话：这个格式是干什么的。 */
	readonly describe: string;
	parse(text: string, context: TaskFormatContext): DeclarationImportResult;
	/** 声明 → 这个格式的任务 JSON。**还原**，不是第二份真相：三个视图仍以声明为准。 */
	fromDeclaration(declaration: WorkflowDeclaration): JsonObject;
	/** 写回的第二道闸。 */
	validateDeclaration(
		declaration: WorkflowDeclaration,
		context: TaskFormatContext,
	): { readonly ok: boolean; readonly diagnostics: readonly Diagnostic[] };
}

// ---------------------------------------------------------------------------
// 声明 → 任务 JSON（两个格式共用的骨架）
// ---------------------------------------------------------------------------

/** 动作节点按声明顺序取出来。一期协议只有动作节点是步骤；技能计划那边还认分支节点（见下）。 */
const actionNodes = (declaration: WorkflowDeclaration) =>
	declaration.nodes.filter((node) => node.type === TASK_ACTION_NODE_TYPE);

// ---------------------------------------------------------------------------
// 一期协议
// ---------------------------------------------------------------------------

/**
 * 声明还原成一期任务 JSON。
 *
 * 声明层的 schema **故意不解释 `parameters`**（spec §1.2 定为不透明载荷），
 * 所以还原这一步是「参数语义」唯一的落点：第二道闸与 JSON 视图都从这里过。
 */
export const declarationToTask = (declaration: WorkflowDeclaration): JsonObject => {
	const meta = declaration.meta;
	const steps: JsonObject[] = actionNodes(declaration).map((node) => {
		const parameters = node.parameters;
		const step: JsonObject = {};
		for (const [key, value] of Object.entries(parameters)) {
			if (key === 'step_id') continue;
			if (value !== undefined) step[key] = value;
		}
		// `step_id` 是节点侧的语义身份，还原成协议里那个 `id`。
		if (parameters['step_id'] !== undefined) step['id'] = parameters['step_id'];
		return step;
	});

	const task: JsonObject = {
		schema_version: meta['schema_version'] ?? TASK_SCHEMA_VERSION,
		task_id: meta['task_id'] ?? declaration.id,
		steps,
		limits: meta['limits'] ?? {},
	};
	if (meta['description'] !== undefined) task['description'] = meta['description'];
	return task;
};

export const PHASE1_TASK_FORMAT: TaskFormat = {
	formatRef: 'phase1_task',
	label: '一期任务协议',
	describe: '七个固定动作（前进、转向、停止、避障停止、读状态、单关节、六关节）。',
	parse: (text, context) =>
		importTaskJson(text, context.seenTaskIds === undefined ? {} : { seenTaskIds: context.seenTaskIds }),
	fromDeclaration: declarationToTask,
	validateDeclaration: (declaration) => {
		const result = validateTask(declarationToTask(declaration));
		return { ok: result.ok, diagnostics: result.diagnostics };
	},
};

// ---------------------------------------------------------------------------
// 技能计划
// ---------------------------------------------------------------------------

/**
 * `task.branch` 节点那三格出边的位置（与导入侧是同一套约定，位置就是语义）：
 * `main[0]` 是 then 那一臂，`main[1]` 是 else 那一臂，`main[2]` 是**这一层里 `if` 之后的那些步**。
 * 空的那一格导入时写的是 `[]`，还原时读成「没有」。
 */
const BRANCH_THEN_PORT = 0;
const BRANCH_ELSE_PORT = 1;
const BRANCH_CONTINUATION_PORT = 2;

/** 普通步骤只有一格出边：下一步。 */
const NEXT_PORT = 0;

/** 参与任务还原的节点类型。别的类型（将来会有）不是计划步。 */
const isTaskNode = (node: WorkflowNode): boolean =>
	node.type === TASK_ACTION_NODE_TYPE || node.type === TASK_BRANCH_NODE_TYPE;

/**
 * 声明还原成技能计划。
 *
 * 技能参数就是节点参数里除了 `action` / `timeoutSec` 之外的那些——
 * 当初导入时把它们平铺进来的，还原时原样收回去。
 *
 * 分支（`task.branch`）倒着走回去，同样三格出边：两条臂各自递归，
 * 而 `main[2]` 接在**分支节点自己**身上，不是从两条臂的链尾走回来的——
 * 所以「`if` 之后的步骤」还原出来与走了哪一臂无关，两条臂仍然各自收尾，这里没有汇合点。
 *
 * **没有分支的声明走旧路**（动作节点按声明顺序就是步骤顺序）。这不是偷懒：
 * 一份手拼的、压根没有 `connections` 的声明，形状就是平铺的一串，只有按声明顺序读才对得上；
 * 有分支才需要走图——那时出边是唯一的真相，声明顺序只用来挑链头。
 */
export const declarationToSkillPlan = (declaration: WorkflowDeclaration): JsonObject => {
	const nodesById = new Map(declaration.nodes.map((node) => [node.id, node]));

	/** 某一步第 `port` 格出边指向谁；格子空着（或这一步压根不在）就是 `undefined`。 */
	const portHead = (nodeId: string, port: number): string | undefined =>
		declaration.connections[nodeId]?.main?.[port]?.[0]?.node;

	const skillStep = (node: WorkflowNode): JsonObject => {
		const params: JsonObject = {};
		let timeoutSec: number | undefined;
		for (const [key, value] of Object.entries(node.parameters)) {
			if (key === 'action' || value === undefined) continue;
			if (key === 'timeoutSec') {
				if (typeof value === 'number') timeoutSec = value;
				continue;
			}
			params[key] = value;
		}
		const step: JsonObject = { step: 'skill', skill: String(node.parameters['action'] ?? '') };
		if (Object.keys(params).length > 0) step['params'] = params;
		if (timeoutSec !== undefined) step['timeoutSec'] = timeoutSec;
		return step;
	};

	/** 分支节点 → `if` 步：条件原样收回，两条臂各自递归；同层的后续由调用方顺着第三格接着走。 */
	const branchStep = (node: WorkflowNode, visited: Set<string>): JsonObject => {
		const step: JsonObject = {
			step: 'if',
			// 条件当初是原样放进节点参数的，这里原样收回来；真丢了就给 null，让校验器去报。
			condition: node.parameters['condition'] ?? null,
			then: restoreList(portHead(node.id, BRANCH_THEN_PORT), visited),
		};
		const elseHead = portHead(node.id, BRANCH_ELSE_PORT);
		if (elseHead !== undefined) step['else'] = restoreList(elseHead, visited);
		return step;
	};

	/** 从链头顺着出边走，还原出这一层的步骤。`visited` 挡被改坏的声明里的环（同一步不还原两次）。 */
	const restoreList = (headId: string | undefined, visited: Set<string>): JsonObject[] => {
		const steps: JsonObject[] = [];
		let current = headId;
		while (current !== undefined) {
			if (visited.has(current)) break;
			visited.add(current);
			const node = nodesById.get(current);
			if (node === undefined) break;
			if (node.type === TASK_BRANCH_NODE_TYPE) {
				steps.push(branchStep(node, visited));
				current = portHead(node.id, BRANCH_CONTINUATION_PORT);
				continue;
			}
			if (node.type !== TASK_ACTION_NODE_TYPE) break; // 别的节点类型不是计划步
			steps.push(skillStep(node));
			current = portHead(node.id, NEXT_PORT);
		}
		return steps;
	};

	const hasBranch = declaration.nodes.some((node) => node.type === TASK_BRANCH_NODE_TYPE);

	let plan: JsonObject[];
	if (!hasBranch) {
		// 平铺的声明：动作节点按声明顺序就是步骤顺序——没有出边也读得对。
		plan = declaration.nodes.filter((node) => node.type === TASK_ACTION_NODE_TYPE).map((node) => skillStep(node));
	} else {
		// 顶层链的头：没有入边的第一个任务节点。导入时它就是 `nodes[0]`；
		// 声明被改坏时退回第一个任务节点，反正写回的第二道闸正要拿它量。
		const incoming = new Set<string>();
		for (const ports of Object.values(declaration.connections)) {
			for (const groups of Object.values(ports)) {
				for (const group of groups) {
					for (const target of group) incoming.add(target.node);
				}
			}
		}
		const taskNodes = declaration.nodes.filter(isTaskNode);
		const head = taskNodes.find((node) => !incoming.has(node.id)) ?? taskNodes[0];
		plan = restoreList(head?.id, new Set<string>());
	}

	const meta = declaration.meta;
	// 键序照冻结的形状（`description` 跟在 `robot` 后面）：于是「声明 → 原文」是**字节等价**的还原，
	// 不只是深等价——JSON 视图显示的就是同一份东西的另一种写法。
	const document: JsonObject = {
		schemaVersion: SKILL_PLAN_SCHEMA_VERSION,
		robot: String(meta['robot'] ?? ''),
		...(meta['description'] === undefined ? {} : { description: meta['description'] }),
		plan,
	};
	return document;
};

export const SKILL_PLAN_FORMAT: TaskFormat = {
	formatRef: 'skill_plan',
	label: '技能计划',
	describe: '一串技能调用，可以按「上一步成没成」分叉；技能名与参数由这台设备的目录给，可以随时增删。',
	parse: (text, context) =>
		importSkillPlanJson(text, {
			catalog: context.catalog,
			...(context.idFactory === undefined ? {} : { idFactory: context.idFactory }),
			...(context.catalog.robotName === undefined ? {} : { expectedRobot: context.catalog.robotName }),
		}),
	fromDeclaration: declarationToSkillPlan,
	validateDeclaration: (declaration, context) => {
		const document = declarationToSkillPlan(declaration);
		const result = validateSkillPlan(document, {
				catalog: context.catalog,
				...(context.catalog.robotName === undefined ? {} : { expectedRobot: context.catalog.robotName }),
			},
		);
		return { ok: result.ok, diagnostics: result.diagnostics };
	},
};

export const TASK_FORMATS: Readonly<Record<TaskFormatRef, TaskFormat>> = {
	phase1_task: PHASE1_TASK_FORMAT,
	skill_plan: SKILL_PLAN_FORMAT,
};

export const findTaskFormat = (formatRef: TaskFormatRef): TaskFormat => TASK_FORMATS[formatRef];
