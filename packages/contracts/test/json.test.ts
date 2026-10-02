import { describe, expect, it } from 'vitest';
import { canonicalJsonString, canonicalizeJson, jsonDetail } from '../src/json';
import { sha256Hex } from '../src/sha256';

describe('稳定键序序列化', () => {
	it('递归排序键，且与书写顺序无关', () => {
		const a = { b: 1, a: { d: 1, c: 2 } };
		const b = { a: { c: 2, d: 1 }, b: 1 };
		expect(canonicalJsonString(a)).toBe('{"a":{"c":2,"d":1},"b":1}');
		expect(canonicalJsonString(a)).toBe(canonicalJsonString(b));
	});

	it('数组顺序不动', () => {
		expect(canonicalJsonString([3, 1, 2])).toBe('[3,1,2]');
	});

	it('undefined 键被丢弃，非有限数字按 JSON 语义落成 null', () => {
		expect(canonicalJsonString({ a: undefined, b: 1 })).toBe('{"b":1}');
		expect(canonicalJsonString({ a: Number.NaN, b: Number.POSITIVE_INFINITY })).toBe('{"a":null,"b":null}');
	});

	it('canonicalizeJson 对不可表示值返回 undefined', () => {
		expect(canonicalizeJson(undefined)).toBeUndefined();
		expect(canonicalizeJson(() => 1)).toBeUndefined();
		expect(jsonDetail(undefined)).toBeNull();
	});
});

describe('内容摘要', () => {
	it('键序不同的同一份内容得到同一个摘要', () => {
		const digestOf = (value: unknown): string => sha256Hex(canonicalJsonString(value));
		expect(digestOf({ x: [1, { b: 2, a: 3 }], y: 'z' })).toBe(digestOf({ y: 'z', x: [1, { a: 3, b: 2 }] }));
	});

	it('内容变了摘要就变', () => {
		const digestOf = (value: unknown): string => sha256Hex(canonicalJsonString(value));
		expect(digestOf({ x: 1 })).not.toBe(digestOf({ x: 2 }));
	});
});
