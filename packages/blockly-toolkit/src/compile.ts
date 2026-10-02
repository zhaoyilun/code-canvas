/**
 * 工作区 → 声明（spec §4.1 的「写」方向，全系统唯一的写路径）。
 *
 * 画布只显示**一个模块的实现**（一棵语句树），所以写回也不是「按画布顺序重建整条链」，
 * 而是**只给这一个节点的 parameters 打补丁**：
 *   - 结构（节点顺序、连线、位置、名字、身份）一律原样带过来，画布碰不到；
 *   - 只有那些绑着能力参数的字段能写——写的就是节点 `parameters[name]`，实现结构改不了。
 *
 * 写回要**走完树**：嵌在条件里、比较里的数字块也是这个模块实现的一部分，
 * 漏掉它们就会出现「用户改的数字没进真相」。所以遍历的是 `collectImplementationBlocks`
 * （整棵树的前序），每一块按它 `data` 里的**下标路径**回目录里找回自己的形状，
 * 再按形状取字段——路径对不上就报 `blockly.compile.unknown_step`，不猜。
 *
 * 合法性判定一律交给校验器：先跑 `validateWorkflowDeclaration`（声明形状 + 摘要），
 * 再把声明交给调用方给的**任务语义尺子**（`validateDeclaration`）跑一遍参数约束。任一不过 → 不给声明，只给诊断。
 */
import type * as Blockly from 'blockly';
import {
	computeWorkflowDigest,
	DiagnosticCollector,
	findCapability,
	validateWorkflowDeclaration,
	type CapabilityCatalog,
	type Diagnostic,
	type JsonObject,
	type JsonValue,
	type WorkflowDeclaration,
	type WorkflowDeclarationDraft,
} from '@codecanvas/contracts';
import { describeNodeAtPath, type ImplementationBlockShape, type ImplementationWidget } from './blocks';
import { createBlockIndex, identityOfBlock, type BlockIndex } from './identity';
import { collectImplementationBlocks } from './render';

export interface CompileOptions {
	readonly workspace: Blockly.Workspace;
	/** 作为身份来源的原声明：补丁打在它身上，其它部分一字不动。 */
	readonly base: WorkflowDeclaration;
	readonly catalog: CapabilityCatalog;
	/**
	 * **第二道闸**（任务语义）由调用方给：任务格式是设备属性，工具包不该假定是哪一种。
	 *
	 * 一期协议的七种动作、技能计划的技能名，各有各的判据与各自的诊断码——
	 * 写死在这里，换一台设备就会拿错尺子：一份完全合法的技能计划会因为
	 * 「meta 里没有 task_id」被拒（那份 meta 里本来就不该有它）。
	 * 所以这里只负责问一句「这份声明你收不收」，答话的是知道格式的那一层。
	 *
	 * 不给就跑不了这一道闸——那时会**如实报一条警告**，不假装校验过了。
	 */
	readonly validateDeclaration?: (
		declaration: WorkflowDeclaration,
	) => { readonly ok: boolean; readonly diagnostics: readonly Diagnostic[] };
	/**
	 * 只读块：画布上有些块只是**显示**，不属于任何能力的实现，也就没有可回写的参数
	 * （例如分支节点的计划视图：它画的是这一层的结构，不是某份实现）。
	 *
	 * 不把它们挑出来，写回就会把它们当成「来路不明的积木」逐块报错，界面上弹出几条
	 * 看不出所以然的红字——而那份声明其实一个字节都没错。
	 */
	readonly isReadOnlyBlock?: (block: Blockly.Block) => boolean;
}

export interface CompileResult {
	readonly ok: boolean;
	/** 校验不过就是 null——真相不动。 */
	readonly declaration: WorkflowDeclaration | null;
	readonly diagnostics: readonly Diagnostic[];
	/** blockId ↔ nodeId ↔ 实现位置，给选中联动与映射表用。 */
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

/** 一组同参数控件（传感器勾选框）→ 数组值。 */
const sensorsFromGroup = (widgets: readonly ImplementationWidget[], block: Blockly.Block): JsonValue[] => {
	const sensors: JsonValue[] = [];
	for (const widget of widgets) {
		const parameter = widget.binding.kind === 'parameter' ? widget.binding.parameter : null;
		if (widget.kind !== 'sensor' || parameter === null) continue;
		if (isChecked(block.getFieldValue(widget.fieldName))) sensors.push(widget.sensor);
	}
	return sensors;
};

/**
 * 一块积木 → 它对节点参数的贡献。
 *
 * 只读字段（字面量、没有可编辑控件的类型）一律跳过：它们显示的是目录里的东西，不是可写的值。
 * 缺值的必填字段报错（`blockly.compile.missing_field`），不替它编一个数。
 */
const parametersFromShape = (
	shape: ImplementationBlockShape,
	block: Blockly.Block,
	collector: DiagnosticCollector,
): JsonObject => {
	const parameters: JsonObject = {};
	const written = new Set<string>();

	for (const widget of shape.widgets) {
		if (widget.binding.kind !== 'parameter') continue;
		const parameter = widget.binding.parameter;

		if (widget.kind === 'number') {
			if (written.has(parameter)) continue;
			const raw: unknown = block.getFieldValue(widget.fieldName);
			if (typeof raw === 'number' && Number.isFinite(raw)) {
				parameters[parameter] = raw;
			} else {
				collector.error({
					code: 'blockly.compile.missing_field',
					message: `积木 ${block.type} 的字段 ${widget.fieldName} 没有数值，这一步参数不完整`,
					ref: block.id,
					details: { capability: shape.capabilityRef, stepPath: shape.stepPath, field: widget.fieldName },
				});
			}
			written.add(parameter);
			continue;
		}

		if (widget.kind === 'text') {
			if (written.has(parameter)) continue;
			const raw: unknown = block.getFieldValue(widget.fieldName);
			parameters[parameter] = typeof raw === 'string' ? raw : String(raw ?? '');
			written.add(parameter);
			continue;
		}

		if (widget.kind === 'sensor') {
			if (written.has(parameter)) continue;
			parameters[parameter] = sensorsFromGroup(shape.widgets, block);
			written.add(parameter);
			continue;
		}

		if (widget.kind === 'boolean') {
			if (written.has(parameter)) continue;
			parameters[parameter] = isChecked(block.getFieldValue(widget.fieldName));
			written.add(parameter);
		}
	}

	return parameters;
};

/** 一个节点的参数补丁 + 它从哪块积木来（诊断里要点名）。 */
interface Patch {
	readonly parameters: JsonObject;
	readonly sources: Map<string, string>;
}

/**
 * 画布上的每一块积木 → 它那个节点要改的参数。
 *
 * 认不出来的块（没有 `data`、`data` 不是这一版载荷）一律报错：
 * 写回通道宁可停下，也不把来路不明的东西并进真相。
 * 同一个参数被两块积木同时写（实现树里两处引用同一个能力参数）时**先到先得**并给警告——
 * 结果确定，也不静默丢掉后面那块上的改动。
 */
const collectPatches = (
	workspace: Blockly.Workspace,
	base: WorkflowDeclaration,
	catalog: CapabilityCatalog,
	collector: DiagnosticCollector,
	isReadOnlyBlock?: (block: Blockly.Block) => boolean,
): Map<string, Patch> => {
	const patches = new Map<string, Patch>();

	for (const block of collectImplementationBlocks(workspace)) {
		// 只读块直接跳过：它们没有可回写的参数，也不是「来路不明」。
		if (isReadOnlyBlock?.(block) === true) continue;
		const identity = identityOfBlock(block);
		if (identity === null) {
			collector.error({
				code: 'blockly.compile.unknown_block',
				message: `画布上有一块不是这次渲染画出来的积木（${block.type}），它进不了声明`,
				ref: block.id,
			});
			continue;
		}
		const node = base.nodes.find((candidate) => candidate.id === identity.nodeId);
		if (node === undefined) {
			collector.error({
				code: 'blockly.compile.unknown_node',
				message: `积木 ${block.id} 指向的节点 ${identity.nodeId} 不在声明里`,
				ref: block.id,
				details: { nodeId: identity.nodeId },
			});
			continue;
		}
		const capability = findCapability(catalog, identity.capabilityRef);
		const shape =
			capability === undefined ? null : describeNodeAtPath(catalog, capability, identity.stepPath);
		if (shape === null) {
			collector.error({
				code: 'blockly.compile.unknown_step',
				message: `积木 ${block.id} 对应的实现位置（${identity.capabilityRef} 的 ${identity.stepPath}）在目录 ${catalog.catalogRef} 里查不到`,
				ref: block.id,
				details: {
					capability: identity.capabilityRef,
					stepPath: identity.stepPath,
					nodeTag: identity.nodeTag,
					primitive: identity.primitiveRef ?? '',
				},
			});
			continue;
		}

		const parameters = parametersFromShape(shape, block, collector);
		const patch = patches.get(node.id) ?? { parameters: {}, sources: new Map<string, string>() };

		for (const [parameter, value] of Object.entries(parameters)) {
			const previous = patch.parameters[parameter];
			if (previous !== undefined && JSON.stringify(previous) !== JSON.stringify(value)) {
				collector.warning({
					code: 'blockly.compile.conflicting_value',
					message: `参数 ${parameter} 被两块积木同时写（已取 ${patch.sources.get(parameter) ?? '先到的那块'}，忽略 ${block.id} 上的值）`,
					ref: block.id,
					details: { parameter, kept: previous, ignored: value },
				});
				continue;
			}
			patch.parameters[parameter] = value;
			if (!patch.sources.has(parameter)) patch.sources.set(parameter, block.id);
		}
		patches.set(node.id, patch);
	}

	return patches;
};

export const compileWorkspace = (options: CompileOptions): CompileResult => {
	const { workspace, base, catalog } = options;
	const collector = new DiagnosticCollector();

	const patches = collectPatches(workspace, base, catalog, collector, options.isReadOnlyBlock);

	// 只改 parameters：`id` / `name` / `type` / `typeVersion` / `position` / `disabled` 原样带过来，
	// 节点顺序、连线、`meta` 也是——实现结构不归画布管。
	const nodes = base.nodes.map((node) => {
		const patch = patches.get(node.id);
		if (patch === undefined) return node;
		return { ...node, parameters: { ...node.parameters, ...patch.parameters } };
	});

	const draft: WorkflowDeclarationDraft = {
		formatVersion: base.formatVersion,
		id: base.id,
		name: base.name,
		nodes,
		connections: base.connections,
		meta: base.meta,
	};
	const declaration: WorkflowDeclaration = { ...draft, digest: computeWorkflowDigest(draft) };

	const workflowValidation = validateWorkflowDeclaration(declaration);
	absorb(collector, workflowValidation.diagnostics);

	if (workflowValidation.ok) {
		if (options.validateDeclaration === undefined) {
			collector.warning({
				code: 'blockly.compile.no_semantic_gate',
				message: '没有给任务语义的尺子，这份声明只过了结构校验',
				path: 'meta',
			});
		} else {
			const semantic = options.validateDeclaration(declaration);
			absorb(collector, semantic.diagnostics);
		}
	}

	const index = createBlockIndex(
		collectImplementationBlocks(workspace).flatMap((block) => {
			const identity = identityOfBlock(block);
			return identity === null ? [] : [identity];
		}),
	);
	if (collector.hasErrors) return { ok: false, declaration: null, diagnostics: collector.diagnostics, index };
	return { ok: true, declaration, diagnostics: collector.diagnostics, index };
};
