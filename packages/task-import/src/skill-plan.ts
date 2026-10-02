/**
 * 技能计划 → workflow 声明。与 `convert.ts` 平级：**一台设备一套任务格式**，
 * 但两条路汇进同一份声明，后面三个视图一点都不知道任务原来是哪种格式。
 *
 * 转换只做三件事：每个 plan 步变一个节点、按顺序串成一条链、把 robot/description 收进 meta。
 * 校验归 `@codecanvas/contracts` 的 `validateSkillPlan`（判据是**目录**），这里绝不重复判断。
 *
 * 一个 plan 步 → 一个节点：
 *
 * ```text
 * { step: 'skill', skill: 'wave_hello', params: { … } }
 *   →  parameters: { action: 'wave_hello', …params }
 * ```
 *
 * `action` 这个键是三个视图的接缝（`findCapability` 认它），技能的参数就平铺在它旁边——
 * 于是「点开一个模块看它的实现」这条路，与一期任务那条完全一样，不用多一套机制。
 */
import {
	computeWorkflowDigest,
	createUlidIdFactory,
	DiagnosticCollector,
	SKILL_PLAN_SCHEMA_VERSION,
	WORKFLOW_FORMAT_VERSION,
	validateSkillPlan,
	type CapabilityCatalog,
	type Diagnostic,
	type JsonObject,
	type SkillPlan,
	type StableIdFactory,
	type WorkflowConnections,
	type WorkflowDeclaration,
	type WorkflowDeclarationDraft,
	type WorkflowNode,
} from '@codecanvas/contracts';
import { NODE_HORIZONTAL_SPACING, TASK_ACTION_NODE_TYPE, TASK_ACTION_NODE_TYPE_VERSION } from './convert';

export interface ImportSkillPlanOptions {
	/** 设备报上来的目录。技能与参数都照它判。 */
	readonly catalog: CapabilityCatalog;
	/** 缺省用 ULID 工厂；测试与重放注入确定性工厂。 */
	readonly idFactory?: StableIdFactory;
	/** 计划要送给哪台机器人；给了就与计划里的 `robot` 对照。 */
	readonly expectedRobot?: string;
}

export type SkillPlanImportResult =
	| { readonly ok: true; readonly declaration: WorkflowDeclaration; readonly diagnostics: readonly Diagnostic[] }
	| { readonly ok: false; readonly diagnostics: readonly Diagnostic[] };

export const buildDeclarationFromPlan = (
	plan: SkillPlan,
	catalog: CapabilityCatalog,
	idFactory: StableIdFactory,
): WorkflowDeclaration => {
	const nodes: WorkflowNode[] = plan.plan.map((step, index) => {
		const parameters: JsonObject = { action: step.skill, ...(step.params ?? {}) };
		// 超时**不**是技能参数（目录里没这一栏），所以它带着原名进节点参数：
		// 技能自己声明的参数在三个视图里渲染，它只在任务 JSON 视图里露面，来回一趟不丢。
		if (step.timeoutSec !== undefined) parameters['timeoutSec'] = step.timeoutSec;
		return {
			id: idFactory.nodeId(),
			// 显示名用目录里的中文标签——「打招呼」比 `wave_hello` 更像这个界面上该有的东西。
			name: `${String(index + 1)}. ${
				catalog.capabilities.find((item) => item.capabilityRef === step.skill)?.label ?? step.skill
			}`,
			type: TASK_ACTION_NODE_TYPE,
			typeVersion: TASK_ACTION_NODE_TYPE_VERSION,
			parameters,
			position: { x: index * NODE_HORIZONTAL_SPACING, y: 0 },
			disabled: false,
		};
	});

	const connections: WorkflowConnections = {};
	for (let index = 0; index < nodes.length - 1; index += 1) {
		const source = nodes[index];
		const target = nodes[index + 1];
		if (source === undefined || target === undefined) continue;
		connections[source.id] = { main: [[{ node: target.id, input: 0 }]] };
	}

	const meta: JsonObject = {
		schemaVersion: SKILL_PLAN_SCHEMA_VERSION,
		robot: plan.robot,
		...(plan.description === undefined ? {} : { description: plan.description }),
	};

	const draft: WorkflowDeclarationDraft = {
		formatVersion: WORKFLOW_FORMAT_VERSION,
		id: idFactory.workflowId(),
		name: plan.description?.trim() ?? plan.robot,
		nodes,
		connections,
		meta,
	};

	return { ...draft, digest: computeWorkflowDigest(draft) };
};

export const importSkillPlan = (
	input: unknown,
	options: ImportSkillPlanOptions,
): SkillPlanImportResult => {
	const validation = validateSkillPlan(input, {
		catalog: options.catalog,
		...(options.expectedRobot === undefined ? {} : { expectedRobot: options.expectedRobot }),
	});
	if (!validation.ok) return { ok: false, diagnostics: validation.diagnostics };

	const declaration = buildDeclarationFromPlan(
		validation.plan,
		options.catalog,
		options.idFactory ?? createUlidIdFactory(),
	);
	return { ok: true, declaration, diagnostics: validation.diagnostics };
};

export const importSkillPlanJson = (text: string, options: ImportSkillPlanOptions): SkillPlanImportResult => {
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch (error) {
		const collector = new DiagnosticCollector();
		collector.error({
			code: 'skill_plan_import.json_parse_error',
			message: '计划 JSON 解析不了',
			details: { reason: error instanceof Error ? error.message : String(error) },
		});
		return { ok: false, diagnostics: collector.diagnostics };
	}
	return importSkillPlan(parsed, options);
};
