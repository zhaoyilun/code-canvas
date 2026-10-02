/**
 * 任务 JSON → workflow 声明（spec §0 那条链的第一步）。
 *
 * 转换只做三件事：每个 step 变一个节点、按顺序串成一条链、把 limits/task_id/description 收进 meta。
 * 校验归 `@codecanvas/contracts`，这里绝不重复判断——非法任务原样把诊断交回去，不抛裸异常。
 */
import {
	computeWorkflowDigest,
	createUlidIdFactory,
	DiagnosticCollector,
	TASK_SCHEMA_VERSION,
	WORKFLOW_FORMAT_VERSION,
	validateTask,
	type Diagnostic,
	type JsonObject,
	type StableIdFactory,
	type TaskStep,
	type ValidatedTask,
	type WorkflowConnections,
	type WorkflowDeclaration,
	type WorkflowDeclarationDraft,
	type WorkflowNode,
} from '@codecanvas/contracts';

/** 所有任务步骤共用一种节点类型，具体动作在 `parameters.action` 里（引擎按 type+typeVersion 找实现）。 */
export const TASK_ACTION_NODE_TYPE = 'task.action';
export const TASK_ACTION_NODE_TYPE_VERSION = 1;
export const NODE_HORIZONTAL_SPACING = 220;

export interface ImportTaskOptions {
	/** 缺省用 ULID 工厂；测试与重放注入确定性工厂。 */
	readonly idFactory?: StableIdFactory;
	/** 执行端已接受的 task_id。 */
	readonly seenTaskIds?: readonly string[];
}

export type TaskImportResult =
	| { readonly ok: true; readonly declaration: WorkflowDeclaration; readonly diagnostics: readonly Diagnostic[] }
	| { readonly ok: false; readonly diagnostics: readonly Diagnostic[] };

/** step → `parameters`（不透明载荷，但只有校验器认识的字段会进来）。 */
const stepParameters = (step: TaskStep): JsonObject => {
	const base: JsonObject = { step_id: step.id, action: step.action };
	switch (step.action) {
		case 'move':
			return { ...base, linear: step.linear, angular: step.angular, duration: step.duration };
		case 'turn':
			return { ...base, angular: step.angular, duration: step.duration };
		case 'stop':
			return base;
		case 'get_status':
			return base;
		case 'stop_if_obstacle':
			return { ...base, sensors: [...step.sensors], distance: step.distance };
		case 'arm_joint':
			return { ...base, joint_id: step.joint_id, joint: step.joint, time: step.time };
		case 'arm6_joints':
			return {
				...base,
				joint1: step.joint1,
				joint2: step.joint2,
				joint3: step.joint3,
				joint4: step.joint4,
				joint5: step.joint5,
				joint6: step.joint6,
				time: step.time,
			};
	}
};

const workflowName = (task: ValidatedTask): string => {
	const description = task.description?.trim();
	return description === undefined || description.length === 0 ? task.task_id : description;
};

export const buildWorkflowDeclaration = (task: ValidatedTask, idFactory: StableIdFactory): WorkflowDeclaration => {
	const nodes: WorkflowNode[] = task.steps.map((step, index) => ({
		id: idFactory.nodeId(),
		// 显示名工作流内唯一即可；语义身份永远是 step_id，重排步骤不会换 id。
		name: `${index + 1}. ${step.action}`,
		type: TASK_ACTION_NODE_TYPE,
		typeVersion: TASK_ACTION_NODE_TYPE_VERSION,
		parameters: stepParameters(step),
		position: { x: index * NODE_HORIZONTAL_SPACING, y: 0 },
		disabled: false,
	}));

	const connections: WorkflowConnections = {};
	for (let index = 0; index < nodes.length - 1; index += 1) {
		const source = nodes[index];
		const target = nodes[index + 1];
		if (source === undefined || target === undefined) continue;
		connections[source.id] = { main: [[{ node: target.id, input: 0 }]] };
	}

	const meta: JsonObject = {
		schema_version: TASK_SCHEMA_VERSION,
		task_id: task.task_id,
		...(task.description === undefined ? {} : { description: task.description }),
		limits: { ...task.limits },
	};

	const draft: WorkflowDeclarationDraft = {
		formatVersion: WORKFLOW_FORMAT_VERSION,
		id: idFactory.workflowId(),
		name: workflowName(task),
		nodes,
		connections,
		meta,
	};

	return { ...draft, digest: computeWorkflowDigest(draft) };
};

export const importTask = (input: unknown, options: ImportTaskOptions = {}): TaskImportResult => {
	const validation = validateTask(input, options.seenTaskIds === undefined ? {} : { seenTaskIds: options.seenTaskIds });
	if (!validation.ok) return { ok: false, diagnostics: validation.diagnostics };

	const declaration = buildWorkflowDeclaration(validation.task, options.idFactory ?? createUlidIdFactory());
	return { ok: true, declaration, diagnostics: validation.diagnostics };
};

export const importTaskJson = (text: string, options: ImportTaskOptions = {}): TaskImportResult => {
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch (error) {
		const collector = new DiagnosticCollector();
		collector.error({
			code: 'task_import.json_parse_error',
			message: 'task JSON could not be parsed',
			details: { reason: error instanceof Error ? error.message : String(error) },
		});
		return { ok: false, diagnostics: collector.diagnostics };
	}
	return importTask(parsed, options);
};
