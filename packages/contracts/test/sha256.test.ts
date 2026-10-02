import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { sha256Hex } from '../src/sha256';

const NODE_CRYPTO = (input: string): string => createHash('sha256').update(input, 'utf8').digest('hex');

const SAMPLES = [
	'',
	'a',
	'abc',
	'hello 鲸鲸 🐋',
	'x'.repeat(55),
	'x'.repeat(56),
	'x'.repeat(63),
	'x'.repeat(64),
	'x'.repeat(65),
	'x'.repeat(1000),
	'{"a":1,"b":[1,2,3]}',
];

describe('sha256Hex', () => {
	it('已知向量', () => {
		expect(sha256Hex('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
		expect(sha256Hex('')).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
	});

	it('与 node:crypto 逐字一致（含分组边界与多字节字符）', () => {
		for (const sample of SAMPLES) {
			expect(sha256Hex(sample), `sample length ${sample.length}`).toBe(NODE_CRYPTO(sample));
		}
	});
});
