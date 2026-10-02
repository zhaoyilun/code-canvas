/**
 * 稳定 ID：生成时一次性分配，此后永不改变（spec §1.2 硬规则 1、2）。
 *
 * 这里刻意**不用内容哈希**当引用 ID——前作把 `blockId` 定义成 `uuidV5(内容路径)`，
 * 改标签、挪位置、重排语句都会换 ID。内容指纹只用来回答「这份产物是不是从那份声明来的」，
 * 那是 `digest` 的活，两者不要混。
 */
import { z } from 'zod';

/** 继承自前作的 `stableReferenceSchema`：能进 JSON 指针、能当 Map 键、能被 diff。 */
export const STABLE_REFERENCE_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._:-]*$/;
export const STABLE_REFERENCE_MIN_LENGTH = 1;
export const STABLE_REFERENCE_MAX_LENGTH = 128;

export const stableReferenceSchema = z
	.string()
	.min(STABLE_REFERENCE_MIN_LENGTH)
	.max(STABLE_REFERENCE_MAX_LENGTH)
	.regex(STABLE_REFERENCE_PATTERN, 'must match /^[a-zA-Z0-9][a-zA-Z0-9._:-]*$/');

export const isStableReference = (value: unknown): value is string =>
	typeof value === 'string' &&
	value.length >= STABLE_REFERENCE_MIN_LENGTH &&
	value.length <= STABLE_REFERENCE_MAX_LENGTH &&
	STABLE_REFERENCE_PATTERN.test(value);

export const STABLE_ID_PREFIXES = {
	workflow: 'wf_',
	node: 'nd_',
	block: 'bl_',
} as const;

export type StableIdKind = keyof typeof STABLE_ID_PREFIXES;

/** 「id 谁生成、怎么生成」的唯一答案（plan §2 布局纪律）。 */
export interface StableIdFactory {
	workflowId(): string;
	nodeId(): string;
	blockId(): string;
}

export interface UlidOptions {
	/** 时钟注入：测试与重放用固定时间。 */
	readonly now?: () => number;
	/** 随机源注入：测试用确定性字节流。 */
	readonly randomBytes?: (size: number) => Uint8Array;
}

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const TIME_CHARS = 10;
const RANDOM_CHARS = 16;
const RANDOM_BYTES = 10;

const encodeTime = (milliseconds: number): string => {
	let remaining = Math.max(0, Math.floor(milliseconds));
	let encoded = '';
	for (let i = 0; i < TIME_CHARS; i += 1) {
		encoded = CROCKFORD.charAt(remaining % 32) + encoded;
		remaining = Math.floor(remaining / 32);
	}
	return encoded;
};

const encodeRandom = (bytes: Uint8Array): string => {
	let buffer = 0;
	let bits = 0;
	let encoded = '';
	for (const byte of bytes) {
		buffer = (buffer << 8) | byte;
		bits += 8;
		while (bits >= 5) {
			encoded += CROCKFORD.charAt((buffer >>> (bits - 5)) & 31);
			bits -= 5;
		}
	}
	if (bits > 0) encoded += CROCKFORD.charAt((buffer << (5 - bits)) & 31);
	return encoded.slice(0, RANDOM_CHARS).padEnd(RANDOM_CHARS, '0');
};

const incrementBytes = (bytes: Uint8Array): boolean => {
	for (let i = bytes.length - 1; i >= 0; i -= 1) {
		const current = bytes[i] as number;
		if (current < 0xff) {
			bytes[i] = current + 1;
			return true;
		}
		bytes[i] = 0;
	}
	return false;
};

const defaultRandomBytes = (size: number): Uint8Array => {
	const bytes = new Uint8Array(size);
	globalThis.crypto.getRandomValues(bytes);
	return bytes;
};

/**
 * ULID 生成器。同一毫秒内连续生成时把随机段当计数器递增，
 * 这样「批量生成一批 id」不会撞号，也不会因为毫秒相同而乱序。
 */
export const createUlidGenerator = (options: UlidOptions = {}): (() => string) => {
	const now = options.now ?? (() => Date.now());
	const randomBytes = options.randomBytes ?? defaultRandomBytes;
	let lastTime = -1;
	let lastBytes: Uint8Array | null = null;
	let lastEncoded = '';

	return () => {
		let time = Math.floor(now());
		let bytes: Uint8Array;
		if (lastBytes !== null && time === lastTime) {
			bytes = lastBytes;
			if (!incrementBytes(bytes)) {
				time += 1;
				bytes = randomBytes(RANDOM_BYTES);
			}
		} else {
			bytes = randomBytes(RANDOM_BYTES);
		}
		lastTime = time;
		lastBytes = bytes;
		lastEncoded = encodeTime(time) + encodeRandom(bytes);
		return lastEncoded;
	};
};

export const createIdFactory = (generate: () => string): StableIdFactory => ({
	workflowId: () => `${STABLE_ID_PREFIXES.workflow}${generate()}`,
	nodeId: () => `${STABLE_ID_PREFIXES.node}${generate()}`,
	blockId: () => `${STABLE_ID_PREFIXES.block}${generate()}`,
});

/** 默认工厂：真实时钟 + 系统随机源。 */
export const createUlidIdFactory = (options: UlidOptions = {}): StableIdFactory =>
	createIdFactory(createUlidGenerator(options));

/** mulberry32：种子化 PRNG。确定性重放用，不做密码学用途。 */
const createSeededRandom = (seed: string): (() => number) => {
	let state = 2166136261;
	for (let i = 0; i < seed.length; i += 1) {
		state ^= seed.charCodeAt(i);
		state = Math.imul(state, 16777619);
	}
	return () => {
		state = (state + 0x6d2b79f5) | 0;
		let t = state;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
};

export interface DeterministicIdOptions {
	readonly seed?: string;
	/** 固定时间戳，缺省 0——同一 (seed, now) 下产出逐字节相同的 id 串。 */
	readonly now?: number;
}

/**
 * 确定性工厂：同一 seed（同一固定时间）下产出的 id 完全可重放。
 * 用于「同一输入连续两次，规范化产物字节级相同」这类验收，以及固定测试夹具。
 * 它不是生产默认值——真实导入永远该用 `createUlidIdFactory()` 拿唯一 id。
 */
export const createDeterministicIdFactory = (options: DeterministicIdOptions = {}): StableIdFactory => {
	const random = createSeededRandom(options.seed ?? 'codecanvas');
	const randomBytes = (size: number): Uint8Array => {
		const bytes = new Uint8Array(size);
		for (let i = 0; i < size; i += 1) bytes[i] = Math.floor(random() * 256) & 0xff;
		return bytes;
	};
	return createUlidIdFactory({ now: () => options.now ?? 0, randomBytes });
};
