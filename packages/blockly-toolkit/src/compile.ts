/**
 * 工作区 → 声明（spec §4.1 的「写」方向，全系统唯一的写路径）。
 *
 * 规则：**只改 parameters**。`id` / `name` / `type` / `typeVersion` / `position` 从原声明里
 * 按身份取回，`formatVersion` / `id` / `name` / `meta` 原样带过去。链的顺序就是节点的顺序。
 *
 * 合法性判定一律交给校验器：先跑 `validateWorkflowDeclaration`（声明形状 + 摘要），
 * 再用声明还原出一份任务 JSON 跑 `validateTask`（参数约束）。任一不过 → 不给声明，只给诊断。
 */
import type * as Blockly from 'blockly';
import {
	computeWorkflowDigest,
	createUlidIdFactory,
	DiagnosticCollector,
	validateTask,
	validateWorkflowDeclaration,
	type Diagnostic,
	type JsonObject,
	type JsonValue,
	type StableIdFactory,
	type TaskAction,
	type ConnectionTarget,
	type WorkflowConnections,
	type WorkflowDeclaration,
	type WorkflowDeclarationDraft,
	type WorkflowNode,
} from '@codecanvas/contracts';
import { TASK_ACTION_NODE_TYPE, TASK_ACTION_NODE_TYPE_VERSION } from '@codecanvas/task-import';
import { ACTION_BLOCK_SHAPE_BY_ACTION, actionOfBlockType, type ActionBlockShape } from './blocks';
import { createBlockIndex, identityOfBlock, type BlockIdentity, type BlockIndex } from './identity';
import { collectChainBlocks } from './render';

export interface CompileOptions {
	readonly workspace: Blockly.Workspace;
	/** 作为身份来源的原声明。 */
	readonly base: WorkflowDeclaration;
	readonly idFactory?: StableIdFactory;
}

export interface CompileResult {
	readonly ok: boolean;
	/** 校验不过就是 null——真相不动。 */
	readonly declaration: WorkflowDeclaration | null;
	readonly diagnostics: readonly Diagnostic[];
	/** blockId ↔ nodeId ↔ stepId，给选中联动与映射表用。 */
	readonly index: BlockIndex;
}

const isChecked = (raw: unknown): boolean => raw === true || raw === 'TRUE';

/** 把已有诊断搬进收集器（保持首次出现的顺序）。 */
const absorb = (collector: DiagnosticCollector, diagnostics: readonly Diagnostic[]): void => {
	for (const diagnostic of diagnostics) {
		const input = {
			code: diagnostic.code,
			message: diagnostic.message,
			...(diagnostic.path === undefined ? {} : { path: diagnostic.path }),
			...(diagnostic.ref === undefined ? {} : { ref: diagnostic.ref }),
			...(diagnostic.details === undefined ? {} : { details: diagnostic.details }),
		};
		if (diagnostic.severity === 'error') collector.error(input);
		else if (diagnostic.severity === 'warning') collector.warning(input);
		else collector.info(input);
	}
};

/** 积木字段 → 协议参数。缺值就报错，不替它编一个数。 */
const parametersFromBlock = (
	shape: ActionBlockShape,
	block: Blockly.Block,
	stepId: string,
	collector: DiagnosticCollector,
): JsonObject => {
	const parameters: JsonObject = { step_id: stepId, action: shape.action };

	for (const parameter of shape.parameters) {
		const widgets = shape.widgets.filter((widget) => widget.parameter === parameter);
		const first = widgets[0];
		if (first === undefined) continue;

		if (first.kind === 'number') {
			const raw: unknown = block.getFieldValue(first.fieldName);
			if (typeof raw === 'number' && Number.isFinite(raw)) {
				parameters[parameter] = raw;
			} else {
				collector.error({
					code: 'blockly.compile.missing_field',
					message: `积木 ${block.type} 的字段 ${first.fieldName} 没有数值，这一步参数不完整`,
					ref: block.id,
					details: { action: shape.action, field: first.fieldName },
				});
			}
			continue;
		}

		const sensors: JsonValue[] = [];
		for (const widget of widgets) {
			if (widget.kind !== 'sensor') continue;
			if (isChecked(block.getFieldValue(widget.fieldName))) sensors.push(widget.sensor);
		}
		parameters[parameter] = sensors;
	}

	return parameters;
};

/**
 * 声明还原成任务 JSON：参数校验跑的是导入时那一套校验器，不是另写一份。
 *
 * 注意这一步是导入的**逆映射**：声明里步骤的语义身份叫 `parameters.step_id`（spec §1.2），
 * 任务 JSON 里同一个东西叫 `steps[].id`——名字不同，指同一件事。
 */
export type TaskPayloadResult =
	| { readonly ok: true; readonly task: unknown }
	| { readonly ok: false; readonly diagnostics: readonly Diagnostic[] };

export const stepPayload = (parameters: JsonObject): JsonObject => {
	const step: JsonObject = { ...parameters };
	const stepId = step['step_id'];
	delete step['step_id'];
	return typeof stepId === 'string' ? { id: stepId, ...step } : step;
};

export const taskPayloadFromDeclaration = (declaration: WorkflowDeclaration): TaskPayloadResult => {
	const collector = new DiagnosticCollector();
	const meta = declaration.meta;
	const taskId = meta['task_id'];
	const schemaVersion = meta['schema_version'];
	const limits = meta['limits'];

	if (typeof taskId !== 'string' || taskId.length === 0) {
		collector.error({
			code: 'blockly.compile.missing_task_metadata',
			message: '声明 meta 里没有 task_id，参数没法按任务协议校验',
			path: 'meta.task_id',
		});
	}
	if (typeof schemaVersion !== 'string') {
		collector.error({
			code: 'blockly.compile.missing_task_metadata',
			message: '声明 meta 里没有 schema_version',
			path: 'meta.schema_version',
		});
	}
	if (typeof limits !== 'object' || limits === null || Array.isArray(limits)) {
		collector.error({
			code: 'blockly.compile.missing_task_metadata',
			message: '声明 meta 里没有 limits，限值判定就没有尺子',
			path: 'meta.limits',
		});
	}
	if (collector.hasErrors) return { ok: false, diagnostics: collector.diagnostics };

	const description = meta['description'];
	return {
		ok: true,
		task: {
			schema_version: schemaVersion,
			task_id: taskId,
			...(typeof description === 'string' ? { description } : {}),
			steps: declaration.nodes.map((node) => stepPayload(node.parameters)),
			limits,
		},
	};
};

const uniqueNodeName = (index: number, action: TaskAction, used: ReadonlySet<string>): string => {
	const candidate = `${index + 1}. ${action}`;
	let name = candidate;
	let suffix = 2;
	while (used.has(name)) {
		name = `${candidate} #${suffix}`;
		suffix += 1;
	}
	return name;
};

const sequentialConnections = (nodes: readonly WorkflowNode[]): WorkflowConnections => {
	const connections: WorkflowConnections = {};
	for (let index = 0; index < nodes.length - 1; index += 1) {
		const source = nodes[index];
		const target = nodes[index + 1];
		if (source === undefined || target === undefined) continue;
		const branch: ConnectionTarget[] = [{ node: target.id, input: 0 }];
		connections[source.id] = { main: [branch] };
	}
	return connections;
};

export const compileWorkspace = (options: CompileOptions): CompileResult => {
	const { workspace, base } = options;
	const idFactory = options.idFactory ?? createUlidIdFactory();
	const collector = new DiagnosticCollector();
	const baseById = new Map(base.nodes.map((node) => [node.id, node]));
	const blocks = collectChainBlocks(workspace);

	// 名字在工作流内唯一：先占住「还在画布上的原有节点」的名字，新块再往后排。
	const survivingNames = new Set<string>();
	for (const block of blocks) {
		const identity = identityOfBlock(block);
		const baseNode = identity === null ? undefined : baseById.get(identity.nodeId);
		if (baseNode !== undefined) survivingNames.add(baseNode.name);
	}

	const nodes: WorkflowNode[] = [];
	const identities: BlockIdentity[] = [];

	blocks.forEach((block, index) => {
		const action = actionOfBlockType(block.type);
		if (action === null) {
			collector.error({
				code: 'blockly.compile.unknown_block',
				message: `画布上有一块不是任务动作的积木（${block.type}），它进不了声明`,
				ref: block.id,
			});
			return;
		}

		const known = identityOfBlock(block);
		const baseNode = known === null ? undefined : baseById.get(known.nodeId);
		const nodeId = baseNode?.id ?? idFactory.nodeId();
		const stepId = known?.stepId ?? nodeId;
		const shape = ACTION_BLOCK_SHAPE_BY_ACTION[action];
		const position = baseNode?.position ?? {
			x: block.getRelativeToSurfaceXY().x,
			y: block.getRelativeToSurfaceXY().y,
		};

		nodes.push({
			id: nodeId,
			name: baseNode?.name ?? uniqueNodeName(index, action, survivingNames),
			type: baseNode?.type ?? TASK_ACTION_NODE_TYPE,
			typeVersion: baseNode?.typeVersion ?? TASK_ACTION_NODE_TYPE_VERSION,
			parameters: parametersFromBlock(shape, block, stepId, collector),
			position,
			disabled: baseNode?.disabled ?? false,
		});
		identities.push({ blockId: block.id, nodeId, stepId });
	});

	const draft: WorkflowDeclarationDraft = {
		formatVersion: base.formatVersion,
		id: base.id,
		name: base.name,
		nodes,
		connections: sequentialConnections(nodes),
		meta: base.meta,
	};
	const declaration: WorkflowDeclaration = { ...draft, digest: computeWorkflowDigest(draft) };

	const workflowValidation = validateWorkflowDeclaration(declaration);
	absorb(collector, workflowValidation.diagnostics);

	if (workflowValidation.ok) {
		const payload = taskPayloadFromDeclaration(declaration);
		if (!payload.ok) {
			absorb(collector, payload.diagnostics);
		} else {
			absorb(collector, validateTask(payload.task).diagnostics);
		}
	}

	const index = createBlockIndex(identities);
	if (collector.hasErrors) return { ok: false, declaration: null, diagnostics: collector.diagnostics, index };
	return { ok: true, declaration, diagnostics: collector.diagnostics, index };
};
