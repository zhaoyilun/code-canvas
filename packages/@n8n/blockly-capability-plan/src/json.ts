const reservedKeys = new Set(['__proto__', 'prototype', 'constructor']);

export type JsonInspection = { ok: true } | { ok: false; message: string; path: string };

export function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function firstUnknownKey(
	value: Record<string, unknown>,
	allowedKeys: ReadonlySet<string>,
): string | undefined {
	return Object.keys(value).find((key) => !allowedKeys.has(key));
}

export function inspectJsonValue(
	value: unknown,
	maxDepth: number,
	maxEntries: number,
): JsonInspection {
	const pending: Array<{ value: unknown; depth: number; path: string }> = [
		{ value, depth: 0, path: '$' },
	];
	const visited = new WeakSet<object>();
	let entries = 0;

	while (pending.length > 0) {
		const current = pending.pop();
		if (current === undefined) break;
		if (current.depth > maxDepth) {
			return { ok: false, message: `JSON depth exceeds ${maxDepth}`, path: current.path };
		}
		if (current.value === null) continue;
		if (
			typeof current.value === 'string' ||
			typeof current.value === 'boolean' ||
			(typeof current.value === 'number' && Number.isFinite(current.value))
		) {
			continue;
		}
		if (typeof current.value !== 'object') {
			return { ok: false, message: 'value is not JSON-compatible', path: current.path };
		}
		if (visited.has(current.value)) {
			return {
				ok: false,
				message: 'JSON value contains a cycle or shared reference',
				path: current.path,
			};
		}
		visited.add(current.value);

		if (Array.isArray(current.value)) {
			entries += current.value.length;
			for (let index = current.value.length - 1; index >= 0; index -= 1) {
				pending.push({
					value: current.value[index],
					depth: current.depth + 1,
					path: `${current.path}[${index}]`,
				});
			}
		} else {
			if (!isRecord(current.value)) {
				return { ok: false, message: 'value is not a JSON object', path: current.path };
			}
			const record = current.value;
			const keys = Object.keys(record);
			entries += keys.length;
			for (let index = keys.length - 1; index >= 0; index -= 1) {
				const key = keys[index];
				if (key === undefined) continue;
				if (reservedKeys.has(key.toLowerCase())) {
					return {
						ok: false,
						message: `object key "${key}" is reserved`,
						path: `${current.path}.${key}`,
					};
				}
				pending.push({
					value: record[key],
					depth: current.depth + 1,
					path: `${current.path}.${key}`,
				});
			}
		}

		if (entries > maxEntries) {
			return { ok: false, message: `JSON entries exceed ${maxEntries}`, path: current.path };
		}
	}

	return { ok: true };
}

export function canonicalJson(value: unknown): string {
	if (value === null || typeof value === 'boolean' || typeof value === 'string') {
		return JSON.stringify(value);
	}
	if (typeof value === 'number') return Number.isFinite(value) ? JSON.stringify(value) : 'null';
	if (Array.isArray(value)) return `[${value.map((entry) => canonicalJson(entry)).join(',')}]`;
	if (isRecord(value)) {
		const properties = Object.keys(value)
			.filter((key) => value[key] !== undefined)
			.sort()
			.map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`);
		return `{${properties.join(',')}}`;
	}
	return 'null';
}

export function utf8ByteLength(value: string): number {
	return new TextEncoder().encode(value).length;
}

export function jsonByteLength(value: unknown): number | undefined {
	try {
		const serialized = JSON.stringify(value);
		return serialized === undefined ? undefined : utf8ByteLength(serialized);
	} catch {
		return undefined;
	}
}
