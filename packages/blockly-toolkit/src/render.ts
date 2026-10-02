/**
 * 声明 + 能力目录 → 工作区（spec §4.1 的「读」方向）。
 *
 * **画布画的是「当前这一个模块的实现」，不是整条任务链**：
 * 取当前选中的节点，用它的 `parameters.action` 去目录里查能力，拿到 `implementation`
 * ——一棵**语句树**——然后递归地长成积木：赋值块、C 形的条件块、嵌在条件里的比较块、
 * 再嵌进比较两侧的引用块与数字块。顶层语句之间用 `next` 串成一条链。
 * 没选中任何节点时取声明里的第一个——画布空着，用户不知道要干什么。
 *
 * 字段值分两种（见 `blocks.ts` 的 `ArgumentBinding`）：绑到能力参数的填节点同名参数的实际值，
 * 目录里写死的字面量照原样显示。这里不判断合法性：声明不合法与否是校验器的事，这里只如实画出来。
 * 目录自己写歪了（悬空引用、漏给实参、类型进不了表达式、原语查不到）在这里报诊断——
 * 那是目录的毛病，不是声明的问题。
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
	describeImplementation,
	isUnknownShape,
	registerImplementationBlocks,
	topLevelStepIndexOf,
	type ImplementationBlockShape,
	type ImplementationWidget,
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

/** 块 id 的分配键：同一个节点下按树里的下标路径分。 */
export const blockKeyOf = (nodeId: string, stepPath: string): string => `${nodeId}#${stepPath}`;

/**
 * 字段值 → 积木字段。
 *
 * 绑到能力参数的有值就用值；缺了（或不是数字/字符串）用协议默认值顶上并给警告——
 * 积木画不出「空」，但也不能假装声明里有这个数。只读字段不用管：它显示的就是目录里那个值。
 */
const fieldsForShape = (
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
				details: { capability: shape.capabilityRef, stepPath: shape.stepPath, fallback: widget.value },
			});
			continue;
		}

		if (widget.kind === 'text') {
			fields[widget.fieldName] = typeof raw === 'string' ? raw : widget.value;
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

		// 只读字段：绑了参数但类型上没有可编辑控件（`pose`），显示声明里的值。
		fields[widget.fieldName] = typeof raw === 'string' || typeof raw === 'number' ? String(raw) : widget.text;
	}

	return fields;
};

/** 目录自身的毛病（悬空名字、漏给实参、类型进不了表达式、原语查不到）在这里报。 */
const checkShape = (
	shape: ImplementationBlockShape,
	node: WorkflowNode,
	nodeIndex: number,
	collector: DiagnosticCollector,
): void => {
	const path = `nodes[${String(nodeIndex)}].parameters.action`;

	if (isUnknownShape(shape)) {
		collector.error({
			code: 'blockly.render.unknown_primitive',
			message: `能力 ${shape.capabilityRef} 的实现里「${shape.stepPath}」引用了目录 ${shape.primitiveRef ?? '?'} 里没有的原语，这一处只能画成占位块`,
			path,
			ref: node.id,
			details: { capability: shape.capabilityRef, stepPath: shape.stepPath, primitive: shape.primitiveRef ?? '' },
		});
	}

	for (const widget of shape.widgets) {
		const binding = widget.binding;
		if (binding.kind === 'unbound') {
			collector.warning({
				code: 'blockly.render.unbound_argument',
				message: `能力 ${shape.capabilityRef} 的实现里「${shape.stepPath}」没给参数 ${widget.parameter} 的实参，画布只能留空`,
				path,
				ref: node.id,
				details: { capability: shape.capabilityRef, stepPath: shape.stepPath, parameter: widget.parameter },
			});
			continue;
		}
		if (binding.kind === 'dangling') {
			collector.warning({
				code: 'blockly.render.dangling_argument',
				message: `能力 ${shape.capabilityRef} 的实现里引用了既不是能力参数、也不是局部变量的 ${binding.name}，这一处只读显示原样`,
				path,
				ref: node.id,
				details: { capability: shape.capabilityRef, stepPath: shape.stepPath, name: binding.name },
			});
			continue;
		}
		if (binding.kind === 'not-a-value') {
			collector.warning({
				code: 'blockly.render.param_not_a_value',
				message: `能力参数 ${binding.name} 的类型进不了表达式（契约只认 number / string / boolean），这一处只读显示名字`,
				path,
				ref: node.id,
				details: { capability: shape.capabilityRef, stepPath: shape.stepPath, parameter: binding.name },
			});
		}
	}

	for (const input of shape.valueInputs) checkShape(input.child, node, nodeIndex, collector);
	for (const input of shape.statementInputs) {
		for (const child of input.blocks) checkShape(child, node, nodeIndex, collector);
	}
};

interface StateContext {
	readonly node: WorkflowNode;
	readonly stepId: string;
	readonly capability: CapabilitySpec;
	readonly nodeIndex: number;
	readonly idFactory: StableIdFactory;
	readonly blockIds: Map<string, string>;
	readonly identities: BlockIdentity[];
	readonly collector: DiagnosticCollector;
}

/** 一串语句 → 用 `next` 串起来的链，返回链头（空就是 null）。 */
const statementChain = (states: readonly Blockly.serialization.blocks.State[]): Blockly.serialization.blocks.State | null => {
	for (let index = states.length - 1; index > 0; index -= 1) {
		const previous = states[index - 1];
		const current = states[index];
		if (previous === undefined || current === undefined) continue;
		previous['next'] = { block: current };
	}
	return states[0] ?? null;
};

/**
 * 一个节点 → 一块积木的序列化状态，值输入与语句口**递归**下去。
 *
 * 位置只有链头给：嵌在输入里的块由父块摆位，给了 `x/y` 反而会让 Blockly 把它当独立块。
 */
const stateForShape = (shape: ImplementationBlockShape, context: StateContext): Blockly.serialization.blocks.State => {
	const { node, stepId, capability, nodeIndex, idFactory, blockIds, identities, collector } = context;

	const key = blockKeyOf(node.id, shape.stepPath);
	let blockId = blockIds.get(key);
	if (blockId === undefined) {
		blockId = idFactory.blockId();
		blockIds.set(key, blockId);
	}

	identities.push({
		blockId,
		nodeId: node.id,
		stepId,
		capabilityRef: capability.capabilityRef,
		stepPath: shape.stepPath,
		stepIndex: topLevelStepIndexOf(shape.stepPath) ?? 0,
		nodeTag: shape.tag,
		primitiveRef: shape.primitiveRef,
	});

	const state: Blockly.serialization.blocks.State = {
		id: blockId,
		type: shape.type,
		data: serializeBlockData({
			nodeId: node.id,
			stepId,
			capabilityRef: capability.capabilityRef,
			stepPath: shape.stepPath,
			nodeTag: shape.tag,
			primitiveRef: shape.primitiveRef,
		}),
		fields: fieldsForShape(shape, node, nodeIndex, collector),
	};

	const inputs: Record<string, Blockly.serialization.blocks.ConnectionState> = {};
	for (const input of shape.valueInputs) {
		const child = stateForShape(input.child, context);
		inputs[input.name] = input.asShadow ? { shadow: child } : { block: child };
	}
	for (const input of shape.statementInputs) {
		const head = statementChain(input.blocks.map((child) => stateForShape(child, context)));
		if (head !== null) inputs[input.name] = { block: head };
	}
	if (Object.keys(inputs).length > 0) state.inputs = inputs;

	return state;
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
	// 目录里每个能力的每个节点都得先是 Blockly 认得的块类型，才画得出来。
	// 这里替调用方做掉（幂等）——否则「忘了注册」会以一句 Invalid block definition 出现在运行时。
	registerImplementationBlocks(catalog);
	const idFactory = options.idFactory ?? createUlidIdFactory();
	const collector = new DiagnosticCollector();
	const blockIds = new Map(options.blockIds ?? []);
	const identities: BlockIdentity[] = [];

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

	const statements = describeImplementation(catalog, capability);
	// checkShape 自己会往下递归，所以只从顶层语句进去一次——重复检查会把同一条诊断报好几遍。
	for (const statement of statements) checkShape(statement, node, nodeIndex, collector);

	const context: StateContext = {
		node,
		stepId: stepIdFromParameters(node.parameters, node.id),
		capability,
		nodeIndex,
		idFactory,
		blockIds,
		identities,
		collector,
	};
	const states = statements.map((statement) => stateForShape(statement, context));
	const head = statementChain(states);
	if (head !== null) {
		// 画布只显示这一个模块，位置不来自流程画布——链自己会顺着 `next` 往下排。
		head['x'] = 32;
		head['y'] = 32;
		Blockly.serialization.blocks.append(head, workspace);
	}
	preventStructuralEdits(workspace);

	return {
		index: createBlockIndex(identities),
		diagnostics: collector.diagnostics,
		blockIds,
		nodeId: node.id,
		capability,
	};
};

/**
 * 工作区里这块积木挂的字段里，有没有绑到能力参数的那些（写回只认这些）。
 * 这是给「选中联动」与诊断用的轻量判据，不参与编译。
 */
export const writableWidgetsOf = (shape: ImplementationBlockShape): readonly ImplementationWidget[] =>
	shape.widgets.filter((widget) => widget.binding.kind === 'parameter');

/**
 * 工作区里的**每一块**积木，按树的前序排（父在子前、语句按顺序）。
 *
 * 旧模型下实现是扁平一串，`next` 走到头就是全部；现在是树，嵌在条件里、比较里的块
 * 也是这个模块的实现的一部分——写回时漏掉它们，就会「用户改的数字没进真相」。
 * `getAllBlocks()` 的顺序是 Blockly 内部顺序（与树无关），所以这里自己走一遍输入表。
 */
export const collectImplementationBlocks = (workspace: Blockly.Workspace): readonly Blockly.Block[] => {
	const ordered: Blockly.Block[] = [];
	const seen = new Set<string>();
	const visit = (block: Blockly.Block): void => {
		if (seen.has(block.id)) return;
		seen.add(block.id);
		ordered.push(block);
		for (const input of block.inputList) {
			const target = input.connection?.targetBlock();
			if (target !== null && target !== undefined) visit(target);
		}
		// `next`（下一条语句）不是 inputList 里的一项，是块自己的连接——单独跟一遍。
		const next = block.getNextBlock();
		if (next !== null) visit(next);
	};
	for (const top of workspace.getTopBlocks(true)) visit(top);
	return ordered;
};

/** 从工作区里按顺序取出顶层那串语句：先按位置取顶层块，再顺着 `next` 走到底。 */
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
