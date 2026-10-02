/**
 * 声明 + 能力目录 → 工作区（spec §4.1 的「读」方向）。
 *
 * **画布画的是「当前这一个模块的实现」，不是整条任务链**：
 * 取当前选中的节点，用它的 `parameters.action` 去目录里查能力，拿到 `implementation`，
 * 每一步一块积木，按实现顺序用 `next` 串成一条链。
 * 没选中任何节点时取声明里的第一个——画布空着，用户不知道要干什么。
 *
 * 字段值分两种（见 `blocks.ts` 的 `ArgumentBinding`）：`$name` 填节点同名参数的实际值，
 * 字面量照目录原样显示。这里不判断合法性：声明不合法与否是校验器的事，这里只如实画出来。
 */
import * as Blockly from 'blockly';
import {
	createUlidIdFactory,
	DiagnosticCollector,
	findCapability,
	type CapabilityCatalog,
	type CapabilitySpec,
	type Diagnostic,
	type JsonObject,
	type StableIdFactory,
	type WorkflowDeclaration,
	type WorkflowNode,
} from '@codecanvas/contracts';
import {
	describeImplementationStep,
	registerImplementationBlocks,
	type ImplementationBlockShape,
} from './blocks';
import { createBlockIndex, serializeBlockData, type BlockIdentity, type BlockIndex } from './identity';

export interface RenderOptions {
	readonly workspace: Blockly.Workspace;
	readonly declaration: WorkflowDeclaration;
	/** 能力目录：实现从哪来。画布不认识设备，只认识这份目录。 */
	readonly catalog: CapabilityCatalog;
	/** 当前显示的模块（节点 id）。缺省或 null → 声明里的第一个节点。 */
	readonly selectedNodeId?: string | null;
	/** 缺省用 ULID 工厂；测试与重放注入确定性工厂。 */
	readonly idFactory?: StableIdFactory;
	/** blockKey → blockId，沿用上一次的分配，块 id 才在重画之间保持稳定。 */
	readonly blockIds?: ReadonlyMap<string, string>;
}

export interface RenderResult {
	readonly index: BlockIndex;
	readonly diagnostics: readonly Diagnostic[];
	/** 下一次重画要接着用的分配表。 */
	readonly blockIds: ReadonlyMap<string, string>;
	/** 画布这次画的是哪个节点（缺省第一个）。 */
	readonly nodeId: string | null;
	/** 这个节点指向的能力；查不到就是 null（配上一条 error 诊断）。 */
	readonly capability: CapabilitySpec | null;
}

/** 节点参数里的能力引用：`parameters.action` 就是 `capabilityRef`（spec §4.1）。 */
export const capabilityRefFromParameters = (parameters: JsonObject): string | null => {
	const raw = parameters['action'];
	return typeof raw === 'string' && raw.length > 0 ? raw : null;
};

export const stepIdFromParameters = (parameters: JsonObject, fallback: string): string => {
	const raw = parameters['step_id'];
	return typeof raw === 'string' && raw.length > 0 ? raw : fallback;
};

/**
 * 画布该显示哪个模块：选中的那个，没选中就是第一个。
 * 三个视图都从这一份口径读，免得「画布显示第一个、高亮却什么都没亮」各说各的。
 */
export const activeNodeOf = (
	declaration: WorkflowDeclaration | null,
	selectedNodeId: string | null,
): WorkflowNode | null => {
	const nodes = declaration?.nodes ?? [];
	if (nodes.length === 0) return null;
	if (selectedNodeId !== null) {
		const selected = nodes.find((node) => node.id === selectedNodeId);
		if (selected !== undefined) return selected;
	}
	return nodes[0] ?? null;
};

/** 块 id 的分配键：同一个节点下按实现序号分。 */
export const blockKeyOf = (nodeId: string, stepIndex: number): string => `${nodeId}#${String(stepIndex)}`;

/**
 * 字段值 → 积木字段。
 *
 * `$name` 的有值就用值；缺了（或不是数字）用协议默认值顶上并给警告——积木画不出「空」，
 * 但也不能假装声明里有这个数。字面量字段不用管：它显示的就是目录写的那个值。
 */
const fieldsForStep = (
	shape: ImplementationBlockShape,
	node: WorkflowNode,
	nodeIndex: number,
	collector: DiagnosticCollector,
): Record<string, unknown> => {
	const fields: Record<string, unknown> = {};
	const parameters = node.parameters;

	for (const widget of shape.widgets) {
		if (widget.binding.kind !== 'parameter') {
			if (widget.kind === 'literal') fields[widget.fieldName] = widget.text;
			continue;
		}
		const parameter = widget.binding.parameter;
		const raw = parameters[parameter];

		if (widget.kind === 'number') {
			if (typeof raw === 'number' && Number.isFinite(raw)) {
				fields[widget.fieldName] = raw;
				continue;
			}
			fields[widget.fieldName] = widget.value;
			collector.warning({
				code: 'blockly.render.missing_parameter',
				message: `参数 ${parameter} 缺失或不是数字，积木先按协议默认值显示`,
				path: `nodes[${String(nodeIndex)}].parameters.${parameter}`,
				ref: node.id,
				details: { capability: shape.capabilityRef, step: shape.primitiveRef, fallback: widget.value },
			});
			continue;
		}

		if (widget.kind === 'sensor') {
			// 声明里有这个数组就按数组勾，没有就按形状默认（新块的默认值是合法的）。
			const checked = Array.isArray(raw) ? raw.includes(widget.sensor) : widget.checked;
			fields[widget.fieldName] = checked;
			continue;
		}

		if (widget.kind === 'boolean') {
			fields[widget.fieldName] = raw === true;
			continue;
		}

		// 只读字段：绑了参数但类型上没有可编辑控件（`pose` / `string`），显示声明里的值。
		fields[widget.fieldName] = typeof raw === 'string' || typeof raw === 'number' ? String(raw) : widget.text;
	}

	return fields;
};

/** 目录自身的毛病（悬空 `$name`、漏给实参）在这里报：它们不是声明的问题，是目录的问题。 */
const checkBindings = (
	shape: ImplementationBlockShape,
	node: WorkflowNode,
	nodeIndex: number,
	collector: DiagnosticCollector,
): void => {
	for (const widget of shape.widgets) {
		const binding = widget.binding;
		if (binding.kind === 'unbound') {
			collector.warning({
				code: 'blockly.render.unbound_argument',
				message: `能力 ${shape.capabilityRef} 的实现第 ${String(shape.stepIndex + 1)} 步（${shape.primitiveRef}）没给参数 ${widget.parameter} 的实参，画布只能留空`,
				path: `nodes[${String(nodeIndex)}].parameters.action`,
				ref: node.id,
				details: { capability: shape.capabilityRef, step: shape.primitiveRef, parameter: widget.parameter },
			});
			continue;
		}
		if (binding.kind === 'literal' && typeof binding.value === 'string' && binding.value.startsWith('$')) {
			// `$name` 落在字面量分支上只有一个原因：这个 `name` 不在能力参数表里（悬空引用）。
			collector.warning({
				code: 'blockly.render.dangling_argument',
				message: `能力 ${shape.capabilityRef} 的实现里引用了不存在的参数 ${binding.value}，这一步的 ${widget.parameter} 只读显示原样`,
				path: `nodes[${String(nodeIndex)}].parameters.action`,
				ref: node.id,
				details: { capability: shape.capabilityRef, step: shape.primitiveRef, argument: binding.value },
			});
		}
	}
};

/** 实现里每一步一块积木；缺原语的那一步画不出来，如实报错、不猜一块顶上。 */
const statesForNode = (
	catalog: CapabilityCatalog,
	capability: CapabilitySpec,
	node: WorkflowNode,
	nodeIndex: number,
	idFactory: StableIdFactory,
	blockIds: Map<string, string>,
	identities: BlockIdentity[],
	collector: DiagnosticCollector,
): Blockly.serialization.blocks.State[] => {
	const states: Blockly.serialization.blocks.State[] = [];
	const stepId = stepIdFromParameters(node.parameters, node.id);

	capability.implementation.forEach((step, stepIndex) => {
		const shape = describeImplementationStep(catalog, capability, step, stepIndex);
		if (shape === null) {
			collector.error({
				code: 'blockly.render.unknown_primitive',
				message: `能力 ${capability.capabilityRef} 的实现第 ${String(stepIndex + 1)} 步引用了目录里没有的原语 ${step.step}，这块积木画不出来`,
				path: `nodes[${String(nodeIndex)}].parameters.action`,
				ref: node.id,
				details: { capability: capability.capabilityRef, step: step.step, stepIndex },
			});
			return;
		}

		checkBindings(shape, node, nodeIndex, collector);

		const key = blockKeyOf(node.id, stepIndex);
		let blockId = blockIds.get(key);
		if (blockId === undefined) {
			blockId = idFactory.blockId();
			blockIds.set(key, blockId);
		}

		states.push({
			id: blockId,
			type: shape.type,
			// 画布只显示这一个模块，位置不来自流程画布——链自己会顺着 `next` 往下排。
			...(stepIndex === 0 ? { x: 32, y: 32 } : {}),
			data: serializeBlockData({
				nodeId: node.id,
				stepId,
				capabilityRef: capability.capabilityRef,
				primitiveRef: shape.primitiveRef,
				stepIndex,
			}),
			fields: fieldsForStep(shape, node, nodeIndex, collector),
		});
		identities.push({
			blockId,
			nodeId: node.id,
			stepId,
			capabilityRef: capability.capabilityRef,
			primitiveRef: shape.primitiveRef,
			stepIndex,
		});
	});

	return states;
};

/**
 * 结构只读：积木改不了实现——删不掉（也没有垃圾桶），只留「改字段」这一条写路径。
 *
 * **刻意不禁用拖动**：拖位置既不改实现也不进声明（写回读的是 `data` 里的身份，不是画布顺序），
 * 而 Blockly 只在可拖动时才给积木挂 `blocklyDraggable` 这个类——跨栏连线的积木锚点选择器
 * （`views/mapping/measure.ts` 的 `g.blocklyDraggable[data-node-id]`）正认它。为了「看起来更只读」
 * 把另一栏的连线弄断，不划算。
 */
const preventStructuralEdits = (workspace: Blockly.Workspace): void => {
	for (const block of workspace.getAllBlocks(false)) block.setDeletable(false);
};

export const renderDeclaration = (options: RenderOptions): RenderResult => {
	const { workspace, declaration, catalog } = options;
	// 目录里每个「能力 × 原语」都得先是 Blockly 认得的块类型，才画得出来。
	// 这里替调用方做掉（幂等）——否则「忘了注册」会以一句 Invalid block definition 出现在运行时。
	registerImplementationBlocks(catalog);
	const idFactory = options.idFactory ?? createUlidIdFactory();
	const collector = new DiagnosticCollector();
	const blockIds = new Map(options.blockIds ?? []);
	const identities: BlockIdentity[] = [];
	const blocks: Blockly.serialization.blocks.State[] = [];

	workspace.clear();

	const node = activeNodeOf(declaration, options.selectedNodeId ?? null);
	if (node === null) {
		collector.info({
			code: 'blockly.render.no_node',
			message: '这份声明里没有节点，画布没有可显示的模块',
			path: 'nodes',
		});
		return { index: createBlockIndex([]), diagnostics: collector.diagnostics, blockIds, nodeId: null, capability: null };
	}

	const nodeIndex = declaration.nodes.indexOf(node);
	const capabilityRef = capabilityRefFromParameters(node.parameters);
	const capability = capabilityRef === null ? undefined : findCapability(catalog, capabilityRef);

	if (capability === undefined) {
		// 画不出来就说出来，不猜一个能力顶上。
		collector.error({
			code: 'blockly.render.unknown_capability',
			message:
				capabilityRef === null
					? `节点 ${node.id} 的 parameters.action 不是字符串，画布不知道它是什么模块`
					: `节点 ${node.id} 的能力 ${capabilityRef} 不在目录 ${catalog.catalogRef} 里，画布画不出它的实现`,
			path: `nodes[${String(nodeIndex)}].parameters.action`,
			ref: node.id,
			details: { catalog: catalog.catalogRef, capabilityRef: capabilityRef ?? '' },
		});
		return { index: createBlockIndex([]), diagnostics: collector.diagnostics, blockIds, nodeId: node.id, capability: null };
	}

	blocks.push(
		...statesForNode(catalog, capability, node, nodeIndex, idFactory, blockIds, identities, collector),
	);

	// 实现顺序 = 链的顺序：从尾往前挂 next，最后只 append 头一块，整条链一起进工作区。
	for (let index = blocks.length - 1; index > 0; index -= 1) {
		const previous = blocks[index - 1];
		const current = blocks[index];
		if (previous === undefined || current === undefined) continue;
		previous['next'] = { block: current };
	}
	const head = blocks[0];
	if (head !== undefined) Blockly.serialization.blocks.append(head, workspace);
	preventStructuralEdits(workspace);

	return {
		index: createBlockIndex(identities),
		diagnostics: collector.diagnostics,
		blockIds,
		nodeId: node.id,
		capability,
	};
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
