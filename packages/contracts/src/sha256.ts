/**
 * 纯 TS 的 SHA-256。
 *
 * 为什么不用 `node:crypto`：contracts 是源码直出的包，会被浏览器侧的视图导入，
 * 引一个 Node 内置模块会把整个前端构建带崩。实现本身有测试对 `node:crypto` 逐字校验。
 */

const ROUND_CONSTANTS = new Uint32Array([
	0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
	0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
	0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
	0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
	0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
	0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
	0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
	0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

const INITIAL_STATE = new Uint32Array([
	0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
]);

const rotateRight = (value: number, shift: number): number =>
	((value >>> shift) | (value << (32 - shift))) >>> 0;

export const sha256Hex = (message: string): string => {
	const data = new TextEncoder().encode(message);
	const paddedLength = Math.ceil((data.length + 9) / 64) * 64;
	const padded = new Uint8Array(paddedLength);
	padded.set(data);
	padded[data.length] = 0x80;

	const view = new DataView(padded.buffer);
	const bitLength = data.length * 8;
	view.setUint32(paddedLength - 8, Math.floor(bitLength / 0x100000000), false);
	view.setUint32(paddedLength - 4, bitLength >>> 0, false);

	const state = INITIAL_STATE.slice();
	const schedule = new Uint32Array(64);

	for (let offset = 0; offset < paddedLength; offset += 64) {
		for (let i = 0; i < 16; i += 1) schedule[i] = view.getUint32(offset + i * 4, false);
		for (let i = 16; i < 64; i += 1) {
			const w15 = schedule[i - 15] as number;
			const w2 = schedule[i - 2] as number;
			const s0 = rotateRight(w15, 7) ^ rotateRight(w15, 18) ^ (w15 >>> 3);
			const s1 = rotateRight(w2, 17) ^ rotateRight(w2, 19) ^ (w2 >>> 10);
			schedule[i] = ((schedule[i - 16] as number) + s0 + (schedule[i - 7] as number) + s1) >>> 0;
		}

		let a = state[0] as number;
		let b = state[1] as number;
		let c = state[2] as number;
		let d = state[3] as number;
		let e = state[4] as number;
		let f = state[5] as number;
		let g = state[6] as number;
		let h = state[7] as number;

		for (let i = 0; i < 64; i += 1) {
			const sigma1 = rotateRight(e, 6) ^ rotateRight(e, 11) ^ rotateRight(e, 25);
			const choice = (e & f) ^ (~e & g);
			const temp1 = (h + sigma1 + choice + (ROUND_CONSTANTS[i] as number) + (schedule[i] as number)) >>> 0;
			const sigma0 = rotateRight(a, 2) ^ rotateRight(a, 13) ^ rotateRight(a, 22);
			const majority = (a & b) ^ (a & c) ^ (b & c);
			const temp2 = (sigma0 + majority) >>> 0;

			h = g;
			g = f;
			f = e;
			e = (d + temp1) >>> 0;
			d = c;
			c = b;
			b = a;
			a = (temp1 + temp2) >>> 0;
		}

		state[0] = ((state[0] as number) + a) >>> 0;
		state[1] = ((state[1] as number) + b) >>> 0;
		state[2] = ((state[2] as number) + c) >>> 0;
		state[3] = ((state[3] as number) + d) >>> 0;
		state[4] = ((state[4] as number) + e) >>> 0;
		state[5] = ((state[5] as number) + f) >>> 0;
		state[6] = ((state[6] as number) + g) >>> 0;
		state[7] = ((state[7] as number) + h) >>> 0;
	}

	let hex = '';
	for (const word of state) hex += word.toString(16).padStart(8, '0');
	return hex;
};
