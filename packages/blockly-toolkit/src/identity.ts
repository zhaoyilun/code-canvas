/**
 * 积木身份：`blockId ↔ nodeId ↔ stepId`（spec §4.2 的第一行映射）。
 *
 * 三个 id 是三件事：`nodeId` 是声明里的稳定引用（生成即固定），`blockId` 是积木自己的
 * 稳定引用，`stepId` 是任务步骤的语义身份。积木把后两者的对应关系放在 `block.data` 里
 * ——Blockly 官方给应用留的那个字段，会随工作区序列化一起存。
 */
import type * as Blockly from 'blockly';

export interface BlockIdentity {
	readonly blockId: string;
	readonly nodeId: string;
	readonly stepId: string;
}

export interface BlockIndex {
	readonly order: readonly BlockIdentity[];
	readonly byBlockId: ReadonlyMap<string, BlockIdentity>;
	readonly byNodeId: ReadonlyMap<string, BlockIdentity>;
}

/** 只有 nodeId / stepId 进 `data`：blockId 以 Blockly 自己的 `block.id` 为准，两处存会漂。 */
export interface BlockDataPayload {
	readonly nodeId: string;
	readonly stepId: string;
}

export const serializeBlockData = (payload: BlockDataPayload): string =>
	JSON.stringify({ nodeId: payload.nodeId, stepId: payload.stepId });

const isNonEmptyString = (value: unknown): value is string => typeof value === 'string' && value.length > 0;

/** 解析 `block.data`；不是我们写的那份就返回 null（新拖进来的块没有 data）。 */
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
	if (!isNonEmptyString(nodeId) || !isNonEmptyString(stepId)) return null;
	return { nodeId, stepId };
};

/** 从一块积木读出它的身份；没有 `data` 说明它是新块（nodeId/stepId 待分配）。 */
export const identityOfBlock = (block: Blockly.Block): BlockIdentity | null => {
	const payload = parseBlockData(block.data);
	if (payload === null) return null;
	return { blockId: block.id, nodeId: payload.nodeId, stepId: payload.stepId };
};

export const createBlockIndex = (identities: readonly BlockIdentity[]): BlockIndex => {
	const byBlockId = new Map<string, BlockIdentity>();
	const byNodeId = new Map<string, BlockIdentity>();
	for (const identity of identities) {
		byBlockId.set(identity.blockId, identity);
		byNodeId.set(identity.nodeId, identity);
	}
	return { order: [...identities], byBlockId, byNodeId };
};
