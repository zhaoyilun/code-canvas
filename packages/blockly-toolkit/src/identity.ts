/**
 * 积木身份：`blockId ↔ nodeId ↔ 实现树里的位置`。
 *
 * 几个 id 各指一件事：`nodeId` 是声明里的稳定引用（流程画布上那张卡），`blockId` 是积木自己的
 * 稳定引用，`stepId` 是任务步骤的语义身份（spec §1.2），而 `capabilityRef` / `stepPath` 说的是
 * 「这块积木在**模块内部**的哪一处」——实现是一棵语句树，所以位置是一串**下标路径**
 * （`"1"` 是顶层第二条语句，`"1.then.0"` 是它的 then 分支第一条，`"1.condition.right"` 是
 * 它条件右边的表达式），不是一个扁平序号。
 *
 * `stepIndex` 是路径的第一段（顶层语句下标）——**选中联动与代码行对齐用的就是它**：
 * 跨模块谈「第 3 步」没有意义，模块内部的「第几步」只数顶层语句，数到嵌套里的数字块没有意义。
 *
 * 积木把这些放在 `block.data` 里——Blockly 官方给应用留的那个字段，会随工作区序列化一起存。
 * 写回时**只认 `data`，不解析块类型名**：类型名是为了颜色与注册，不是身份。
 */
import type * as Blockly from 'blockly';
import { topLevelStepIndexOf } from './blocks';

export interface BlockIdentity {
	readonly blockId: string;
	readonly nodeId: string;
	readonly stepId: string;
	readonly capabilityRef: string;
	/** 这个节点在实现语句树里的下标路径。 */
	readonly stepPath: string;
	/** 顶层语句下标（0 基）——嵌套节点记的是它所属的那条顶层语句。 */
	readonly stepIndex: number;
	/** 节点标签（`call_stmt` / `if` / `ref_num`…），给诊断与人看。 */
	readonly nodeTag: string;
	readonly primitiveRef: string | null;
}

export interface BlockIndex {
	readonly order: readonly BlockIdentity[];
	readonly byBlockId: ReadonlyMap<string, BlockIdentity>;
	/**
	 * nodeId → 该节点的**第一块**积木（实现里的第一条语句）。
	 * 一个节点在画布上是一棵树，而选中联动只问「这个节点在哪」——取树根当锚点。
	 */
	readonly byNodeId: ReadonlyMap<string, BlockIdentity>;
	/** 顶层语句下标 → 那一步的积木（选中步高亮按它找块）。 */
	readonly byTopLevelStep: ReadonlyMap<number, BlockIdentity>;
	/** 下标路径 → 那一处的积木。 */
	readonly byStepPath: ReadonlyMap<string, BlockIdentity>;
}

/** 进 `data` 的载荷：blockId 以 Blockly 自己的 `block.id` 为准，两处存会漂。 */
export interface BlockDataPayload {
	readonly nodeId: string;
	readonly stepId: string;
	readonly capabilityRef: string;
	/** 下标路径：树里的位置。 */
	readonly stepPath: string;
	readonly nodeTag: string;
	readonly primitiveRef: string | null;
}

export const serializeBlockData = (payload: BlockDataPayload): string =>
	JSON.stringify({
		nodeId: payload.nodeId,
		stepId: payload.stepId,
		capabilityRef: payload.capabilityRef,
		stepPath: payload.stepPath,
		nodeTag: payload.nodeTag,
		...(payload.primitiveRef === null ? {} : { primitiveRef: payload.primitiveRef }),
	});

const isNonEmptyString = (value: unknown): value is string => typeof value === 'string' && value.length > 0;

/**
 * 解析 `block.data`；不是我们写的那份就返回 null。
 *
 * 四个字段缺一不可：只有 nodeId/stepId 的老载荷（扁平步骤那一版）、或从别处搬来的块，
 * 都算「认出来的块」之外——写回时如实报诊断，不给它编一个位置。
 * `primitiveRef` 是可选的：赋值块与条件块本来就不对应任何原语。
 */
export const parseBlockData = (raw: string | null | undefined): BlockDataPayload | null => {
	if (raw === null || raw === undefined || raw.length === 0) return null;
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return null;
	}
	if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
	const record = parsed as Record<string, unknown>;
	const nodeId = record['nodeId'];
	const stepId = record['stepId'];
	const capabilityRef = record['capabilityRef'];
	const stepPath = record['stepPath'];
	const nodeTag = record['nodeTag'];
	const primitiveRef = record['primitiveRef'];
	if (!isNonEmptyString(nodeId) || !isNonEmptyString(stepId)) return null;
	if (!isNonEmptyString(capabilityRef) || !isNonEmptyString(stepPath)) return null;
	if (!isNonEmptyString(nodeTag)) return null;
	if (primitiveRef !== undefined && !isNonEmptyString(primitiveRef)) return null;
	return { nodeId, stepId, capabilityRef, stepPath, nodeTag, primitiveRef: primitiveRef ?? null };
};

/** 从一块积木读出它的身份；没有 `data` 说明它不是这个画布画出来的块。 */
export const identityOfBlock = (block: Blockly.Block): BlockIdentity | null => {
	const payload = parseBlockData(block.data);
	if (payload === null) return null;
	return {
		blockId: block.id,
		...payload,
		stepIndex: topLevelStepIndexOf(payload.stepPath) ?? 0,
	};
};

export const createBlockIndex = (identities: readonly BlockIdentity[]): BlockIndex => {
	const byBlockId = new Map<string, BlockIdentity>();
	const byNodeId = new Map<string, BlockIdentity>();
	const byTopLevelStep = new Map<number, BlockIdentity>();
	const byStepPath = new Map<string, BlockIdentity>();
	for (const identity of identities) {
		byBlockId.set(identity.blockId, identity);
		byStepPath.set(identity.stepPath, identity);
		// 先到先得：`order` 是树的前序（父在子前、语句按顺序），所以第一条就是树根。
		if (!byNodeId.has(identity.nodeId)) byNodeId.set(identity.nodeId, identity);
		if (identity.stepPath === String(identity.stepIndex) && !byTopLevelStep.has(identity.stepIndex)) {
			byTopLevelStep.set(identity.stepIndex, identity);
		}
	}
	return { order: [...identities], byBlockId, byNodeId, byTopLevelStep, byStepPath };
};
