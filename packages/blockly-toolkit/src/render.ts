/**
 * 声明 → 工作区（spec §4.1 的「读」方向）。
 *
 * 每个 step 一块积木，按数组顺序用 `next` 串成一条链；`block.id` 由 id 工厂分配后固定下来，
 * `block.data` 记住它对应哪个节点与哪个步骤——写回时靠这两个字段还原身份。
 * 这里不判断合法性：声明不合法与否是校验器的事，这里只如实画出来。
 */
import * as Blockly from 'blockly';
import {
	ALLOWED_ACTIONS,
	createUlidIdFactory,
	DiagnosticCollector,
	type Diagnostic,
	type JsonObject,
	type StableIdFactory,
	type TaskAction,
	type WorkflowDeclaration,
	type WorkflowNode,
} from '@codecanvas/contracts';
import { ACTION_BLOCK_SHAPE_BY_ACTION, type ActionBlockShape } from './blocks';
import { createBlockIndex, serializeBlockData, type BlockIdentity, type BlockIndex } from './identity';

export interface RenderOptions {
	readonly workspace: Blockly.Workspace;
	readonly declaration: WorkflowDeclaration;
	/** 缺省用 ULID 工厂；测试与重放注入确定性工厂。 */
	readonly idFactory?: StableIdFactory;
	/** nodeId → blockId，沿用上一次的分配，块 id 才在重画之间保持稳定。 */
	readonly blockIds?: ReadonlyMap<string, string>;
}

export interface RenderResult {
	readonly index: BlockIndex;
	readonly diagnostics: readonly Diagnostic[];
	/** 下一次重画要接着用的分配表。 */
	readonly blockIds: ReadonlyMap<string, string>;
}

export const actionFromParameters = (parameters: JsonObject): TaskAction | null => {
	const raw = parameters['action'];
	if (typeof raw !== 'string') return null;
	return (ALLOWED_ACTIONS as readonly string[]).includes(raw) ? (raw as TaskAction) : null;
};

export const stepIdFromParameters = (parameters: JsonObject, fallback: string): string => {
	const raw = parameters['step_id'];
	return typeof raw === 'string' && raw.length > 0 ? raw : fallback;
};

/**
 * 字段值 → 积木字段。声明里缺字段时用协议默认值顶上并给警告——
 * 积木画不出「空」，但也不能假装声明里有这个数。
 */
const fieldsForNode = (
	shape: ActionBlockShape,
	node: WorkflowNode,
	index: number,
	collector: DiagnosticCollector,
): Record<string, unknown> => {
	const fields: Record<string, unknown> = {};
	const parameters = node.parameters;

	for (const widget of shape.widgets) {
		if (widget.kind === 'number') {
			const raw = parameters[widget.parameter];
			if (typeof raw === 'number' && Number.isFinite(raw)) {
				fields[widget.fieldName] = raw;
				continue;
			}
			fields[widget.fieldName] = widget.value;
			collector.warning({
				code: 'blockly.render.missing_parameter',
				message: `参数 ${widget.parameter} 缺失或不是数字，积木先按协议默认值显示`,
				path: `nodes[${index}].parameters.${widget.parameter}`,
				ref: node.id,
				details: { action: shape.action, fallback: widget.value },
			});
			continue;
		}

		const rawSensors = parameters[widget.parameter];
		// 勾选框：声明里有这个数组就按数组勾，没有就按形状默认（新块的默认值是合法的）。
		const checked = Array.isArray(rawSensors) ? rawSensors.includes(widget.sensor) : widget.checked;
		fields[widget.fieldName] = checked;
	}

	return fields;
};

export const renderDeclaration = (options: RenderOptions): RenderResult => {
	const { workspace, declaration } = options;
	const idFactory = options.idFactory ?? createUlidIdFactory();
	const collector = new DiagnosticCollector();
	const blockIds = new Map(options.blockIds ?? []);
	const identities: BlockIdentity[] = [];
	const states: Blockly.serialization.blocks.State[] = [];

	workspace.clear();

	declaration.nodes.forEach((node, index) => {
		const action = actionFromParameters(node.parameters);
		if (action === null) {
			// 画不出来就说出来，不猜一个动作顶上。
			collector.error({
				code: 'blockly.render.unknown_action',
				message: `节点 ${node.id} 的 parameters.action 不是七种动作之一，这块积木画不出来`,
				path: `nodes[${index}].parameters.action`,
				ref: node.id,
			});
			return;
		}

		const shape = ACTION_BLOCK_SHAPE_BY_ACTION[action];
		const stepId = stepIdFromParameters(node.parameters, node.id);
		let blockId = blockIds.get(node.id);
		if (blockId === undefined) {
			blockId = idFactory.blockId();
			blockIds.set(node.id, blockId);
		}

		states.push({
			id: blockId,
			type: shape.type,
			x: node.position.x,
			y: node.position.y,
			data: serializeBlockData({ nodeId: node.id, stepId }),
			fields: fieldsForNode(shape, node, index, collector),
		});
		identities.push({ blockId, nodeId: node.id, stepId });
	});

	// 数组顺序 = 链的顺序：从尾往前挂 next，最后只 append 头一块，整条链一起进工作区。
	for (let index = states.length - 1; index > 0; index -= 1) {
		const previous = states[index - 1];
		const current = states[index];
		if (previous === undefined || current === undefined) continue;
		previous['next'] = { block: current };
	}
	const head = states[0];
	if (head !== undefined) Blockly.serialization.blocks.append(head, workspace);

	return { index: createBlockIndex(identities), diagnostics: collector.diagnostics, blockIds };
};

/** 从工作区里按顺序取出链上的积木：先按位置取顶层块，再顺着 `next` 走到底。 */
export const collectChainBlocks = (workspace: Blockly.Workspace): readonly Blockly.Block[] => {
	const ordered: Blockly.Block[] = [];
	for (const top of workspace.getTopBlocks(true)) {
		let current: Blockly.Block | null = top;
		const seen = new Set<string>();
		while (current !== null && !seen.has(current.id)) {
			seen.add(current.id);
			ordered.push(current);
			current = current.getNextBlock();
		}
	}
	return ordered;
};
