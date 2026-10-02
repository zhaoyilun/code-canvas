/**
 * 积木身份：`blockId ↔ nodeId ↔ stepId`，外加「这是哪个能力的实现里的第几步」。
 *
 * 几个 id 各指一件事：`nodeId` 是声明里的稳定引用（流程画布上那张卡），
 * `blockId` 是积木自己的稳定引用，`stepId` 是任务步骤的语义身份（spec §1.2），
 * 而 `capabilityRef` / `stepIndex` 说的是「这块积木在**模块内部**的位置」——
 * 一个节点对应多块积木（一个能力实现里的每一步一块），所以后者才是画布这一侧的坐标。
 *
 * 积木把这些放在 `block.data` 里——Blockly 官方给应用留的那个字段，会随工作区序列化一起存。
 * 写回时**只认 `data`，不解析块类型名**：类型名是为了颜色与注册，不是身份。
 */
import type * as Blockly from 'blockly';

export interface BlockIdentity {
	readonly blockId: string;
	readonly nodeId: string;
	readonly stepId: string;
	readonly capabilityRef: string;
	readonly primitiveRef: string;
	/** 在能力 `implementation` 里的位置（0 基）。 */
	readonly stepIndex: number;
}

export interface BlockIndex {
	readonly order: readonly BlockIdentity[];
	readonly byBlockId: ReadonlyMap<string, BlockIdentity>;
	/**
	 * nodeId → 该节点的**第一块**积木。
	 * 一个节点在画布上是一串积木，而选中联动只问「这个节点在哪」——取第一块当锚点。
	 */
	readonly byNodeId: ReadonlyMap<string, BlockIdentity>;
}

/** 进 `data` 的载荷：blockId 以 Blockly 自己的 `block.id` 为准，两处存会漂。 */
export interface BlockDataPayload {
	readonly nodeId: string;
	readonly stepId: string;
	readonly capabilityRef: string;
	readonly primitiveRef: string;
	readonly stepIndex: number;
}

export const serializeBlockData = (payload: BlockDataPayload): string =>
	JSON.stringify({
		nodeId: payload.nodeId,
		stepId: payload.stepId,
		capabilityRef: payload.capabilityRef,
		primitiveRef: payload.primitiveRef,
		stepIndex: payload.stepIndex,
	});

const isNonEmptyString = (value: unknown): value is string => typeof value === 'string' && value.length > 0;

/**
 * 解析 `block.data`；不是我们写的那份就返回 null。
 *
 * 五种字段缺一不可：只有 nodeId/stepId 的老载荷、或从别处搬来的块，都算「认出来的块」之外——
 * 写回时如实报诊断，不给它编一个位置。
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
	const primitiveRef = record['primitiveRef'];
	const stepIndex = record['stepIndex'];
	if (!isNonEmptyString(nodeId) || !isNonEmptyString(stepId)) return null;
	if (!isNonEmptyString(capabilityRef) || !isNonEmptyString(primitiveRef)) return null;
	if (typeof stepIndex !== 'number' || !Number.isInteger(stepIndex) || stepIndex < 0) return null;
	return { nodeId, stepId, capabilityRef, primitiveRef, stepIndex };
};

/** 从一块积木读出它的身份；没有 `data` 说明它不是这个画布画出来的块。 */
export const identityOfBlock = (block: Blockly.Block): BlockIdentity | null => {
	const payload = parseBlockData(block.data);
	if (payload === null) return null;
	return { blockId: block.id, ...payload };
};

export const createBlockIndex = (identities: readonly BlockIdentity[]): BlockIndex => {
	const byBlockId = new Map<string, BlockIdentity>();
	const byNodeId = new Map<string, BlockIdentity>();
	for (const identity of identities) {
		byBlockId.set(identity.blockId, identity);
		// 先到先得：`order` 就是实现顺序，所以第一块就是这一步模块的锚点。
		if (!byNodeId.has(identity.nodeId)) byNodeId.set(identity.nodeId, identity);
	}
	return { order: [...identities], byBlockId, byNodeId };
};
