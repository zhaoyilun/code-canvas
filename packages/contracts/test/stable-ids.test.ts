import { describe, expect, it } from 'vitest';
import {
	createDeterministicIdFactory,
	createUlidIdFactory,
	isStableReference,
	STABLE_ID_PREFIXES,
	STABLE_REFERENCE_PATTERN,
} from '../src/stable-ids';

const ULID_LENGTH = 26;

describe('稳定 ID', () => {
	it('前缀分层 + ULID 本体 + 满足稳定引用词法', () => {
		const factory = createUlidIdFactory();
		const workflowId = factory.workflowId();
		const nodeId = factory.nodeId();
		const blockId = factory.blockId();
		expect(workflowId.startsWith(STABLE_ID_PREFIXES.workflow)).toBe(true);
		expect(nodeId.startsWith(STABLE_ID_PREFIXES.node)).toBe(true);
		expect(blockId.startsWith(STABLE_ID_PREFIXES.block)).toBe(true);
		for (const id of [workflowId, nodeId, blockId]) {
			expect(id.length).toBe(STABLE_ID_PREFIXES.node.length + ULID_LENGTH);
			expect(STABLE_REFERENCE_PATTERN.test(id)).toBe(true);
			expect(isStableReference(id)).toBe(true);
		}
	});

	it('批量生成不撞号，且同一毫秒内字典序递增（不会乱序）', () => {
		const factory = createUlidIdFactory({ now: () => 1_700_000_000_000 });
		const ids = Array.from({ length: 2000 }, () => factory.nodeId());
		expect(new Set(ids).size).toBe(ids.length);
		for (let index = 1; index < ids.length; index += 1) {
			expect((ids[index] as string) > (ids[index - 1] as string)).toBe(true);
		}
	});

	it('时钟注入生效', () => {
		const factory = createUlidIdFactory({ now: () => 0, randomBytes: (size) => new Uint8Array(size) });
		// 时间 0 + 全零随机段：Crockford base32 里 0 就是 '0'。
		expect(factory.nodeId()).toBe(`${STABLE_ID_PREFIXES.node}${'0'.repeat(ULID_LENGTH)}`);
	});

	it('确定性工厂可重放：同 seed 同序列，异 seed 异序列', () => {
		const first = createDeterministicIdFactory({ seed: 'fixture-a' });
		const again = createDeterministicIdFactory({ seed: 'fixture-a' });
		const other = createDeterministicIdFactory({ seed: 'fixture-b' });
		const sequenceOf = (factory: ReturnType<typeof createDeterministicIdFactory>): string[] =>
			Array.from({ length: 5 }, () => factory.nodeId());
		expect(sequenceOf(first)).toEqual(sequenceOf(again));
		expect(sequenceOf(first)).not.toEqual(sequenceOf(other));
	});

	it('确定性工厂仍然产出合法引用', () => {
		const factory = createDeterministicIdFactory();
		for (const id of [factory.workflowId(), factory.nodeId(), factory.blockId()]) {
			expect(isStableReference(id)).toBe(true);
		}
	});
});

describe('稳定引用词法', () => {
	it('接受 spec 里的字符集', () => {
		for (const value of ['nd_01J', 'a', 'A.b:C-d_e', '1', 'x'.repeat(128)]) {
			expect(isStableReference(value), value).toBe(true);
		}
	});

	it('拒绝越界形态', () => {
		for (const value of ['', '_leading', '.dot', '-dash', ':colon', 'has space', 'x'.repeat(129), 42, null, undefined]) {
			expect(isStableReference(value), String(value)).toBe(false);
		}
	});
});
