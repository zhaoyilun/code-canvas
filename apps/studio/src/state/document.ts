/**
 * Studio 的唯一真相：导入后的 workflow 声明，加上当前的选中项。
 *
 * 每个视图都从这里读；**只有积木画布可以写回**（docs/spec.md §4.1）。
 * 写回走 `applyDeclaration`，它连过两道闸才改真相：先结构、再任务协议语义。
 *
 * 用模块级 ref 做单例——这个应用是单文档单窗口，不需要更重的东西。
 */
import { computed, ref, shallowRef } from 'vue';
import {
	type Diagnostic,
	type JsonObject,
	type WorkflowDeclaration,
	type WorkflowDeclarationDraft,
	type WorkflowNode,
	TASK_SCHEMA_VERSION,
	computeWorkflowDigest,
	validateTask,
	validateWorkflowDeclaration,
} from '@codecanvas/contracts';
import { TASK_ACTION_NODE_TYPE, importTaskJson } from '@codecanvas/task-import';
import { SAMPLE_TASK_JSON } from './sample-task';

const declaration = shallowRef<WorkflowDeclaration | null>(null);
const diagnostics = ref<Diagnostic[]>([]);

/** 选中项：节点与积木是一对，映射表负责把一侧推成另一侧（M3）。 */
const selectedNodeId = ref<string | null>(null);
const selectedBlockId = ref<string | null>(null);

/**
 * 把声明还原成一份任务，交给权威校验器。
 *
 * 声明层的 schema **故意不解释 `parameters`**（spec §1.2 把它定为不透明载荷），
 * 所以「越界参数」在那一层根本拦不住——`distance = 0`、`joint_id = 9`、
 * `action = 'fly'` 都会被结构校验放行。写回通道必须自己再走一趟任务层，
 * 否则改坏的积木会静默进真相。
 *
 * `validateTask` 是与 `docs/reference/task_protocol.py` 逐条对照过的那个，
 * 所以这里是拿最权威的尺子量。
 */
const declarationToTask = (decl: WorkflowDeclaration): unknown => {
	const meta = decl.meta;
	const steps = decl.nodes
		.filter((node) => node.type === TASK_ACTION_NODE_TYPE)
		.map((node) => {
			const parameters = node.parameters;
			const step: JsonObject = {};
			for (const [key, value] of Object.entries(parameters)) {
				if (key === 'step_id') continue;
				if (value !== undefined) step[key] = value;
			}
			// `step_id` 是节点侧的语义身份，还原成协议里那个 `id`。
			if (parameters.step_id !== undefined) step.id = parameters.step_id;
			return step;
		});

	const task: JsonObject = {
		schema_version: meta.schema_version ?? TASK_SCHEMA_VERSION,
		task_id: meta.task_id ?? decl.id,
		steps,
		limits: meta.limits ?? {},
	};
	if (meta.description !== undefined) task.description = meta.description;
	return task;
};

/** 载入任务 JSON。成功才换真相；失败只留诊断，界面保持原样。 */
function loadTaskJson(text: string): boolean {
	const result = importTaskJson(text);
	diagnostics.value = [...result.diagnostics];
	if (!result.ok) return false;
	declaration.value = result.declaration;
	selectedNodeId.value = null;
	selectedBlockId.value = null;
	return true;
}

/**
 * 积木写回的入口。**这是唯一能改真相的通道。**
 * 任何一道闸不过，就只留诊断、真相不动——非法状态不许进系统。
 */
function applyDeclaration(next: WorkflowDeclaration): boolean {
	// 调用方只管改内容，摘要这里替它重算——否则每个调用方都得记得这一手，
	// 迟早有人忘，然后被第一道闸拒得莫名其妙。
	const sealed: WorkflowDeclarationDraft = { ...next, digest: computeWorkflowDigest(next) };

	const structural = validateWorkflowDeclaration(sealed);
	if (!structural.ok) {
		diagnostics.value = [...structural.diagnostics];
		return false;
	}

	const semantic = validateTask(declarationToTask(structural.declaration));
	if (!semantic.ok) {
		diagnostics.value = [...semantic.diagnostics];
		return false;
	}

	diagnostics.value = [...structural.diagnostics];
	declaration.value = structural.declaration;
	return true;
}

/**
 * 选中实现里的第几步（语句树的下标，0 基）。
 *
 * 它必须跟节点一起变：跨模块谈「第 3 步」没有意义，所以换节点时清空。
 * 代码行与积木块都靠它对齐——「点代码某行 → 高亮积木那一步」就是这条。
 */
const selectedStepIndex = ref<number | null>(null);

function select(nodeId: string | null, blockId: string | null = null): void {
	// 取消选中（nodeId 为 null）也要清步选中：否则会出现「没有任何节点被选中，
	// 但某一步还亮着」这种自相矛盾的状态——守卫只比较 nodeId 变没变是拦不住它的。
	if (nodeId === null || selectedNodeId.value !== nodeId) selectedStepIndex.value = null;
	selectedNodeId.value = nodeId;
	selectedBlockId.value = blockId;
}

function selectStep(index: number | null): void {
	selectedStepIndex.value = index;
}

export function useStudioDocument() {
	return {
		declaration,
		diagnostics,
		selectedNodeId,
		selectedBlockId,
		selectedStepIndex,
		nodes: computed<readonly WorkflowNode[]>(() => declaration.value?.nodes ?? []),
		selectedNode: computed<WorkflowNode | null>(() => {
			const id = selectedNodeId.value;
			if (id === null) return null;
			return declaration.value?.nodes.find((node) => node.id === id) ?? null;
		}),
		hasDeclaration: computed(() => declaration.value !== null),
		loadTaskJson,
		applyDeclaration,
		select,
		selectStep,
	};
}

/** 首次挂载时灌入示例任务，让三个视图有东西可显示。 */
export function loadSampleTask(): boolean {
	return loadTaskJson(SAMPLE_TASK_JSON);
}
