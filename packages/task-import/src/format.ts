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
} from '@codecanvas/contracts';
import { TASK_ACTION_NODE_TYPE, importTaskJson } from './convert';
import { importSkillPlanJson } from './skill-plan';

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

/** 动作节点按声明顺序取出来；只有动作节点参与任务——别的类型（将来会有）不是任务步骤。 */
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
 * 声明还原成技能计划。
 *
 * 技能参数就是节点参数里除了 `action` / `timeoutSec` 之外的那些——
 * 当初导入时把它们平铺进来的，还原时原样收回去。
 */
export const declarationToSkillPlan = (declaration: WorkflowDeclaration): JsonObject => {
	const meta = declaration.meta;
	const plan: JsonObject[] = actionNodes(declaration).map((node) => {
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
	});

	const document: JsonObject = {
		schemaVersion: SKILL_PLAN_SCHEMA_VERSION,
		robot: String(meta['robot'] ?? ''),
		plan,
	};
	if (meta['description'] !== undefined) document['description'] = meta['description'];
	return document;
};

export const SKILL_PLAN_FORMAT: TaskFormat = {
	formatRef: 'skill_plan',
	label: '技能计划',
	describe: '一串技能调用；技能名与参数由这台设备的目录给，可以随时增删。',
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
