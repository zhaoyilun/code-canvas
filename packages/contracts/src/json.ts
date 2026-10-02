/**
 * JSON 值域与稳定键序序列化。
 *
 * 摘要（digest）要求「同一份声明永远算出同一个字符串」，所以这里不用
 * `JSON.stringify` 的原始键序（它跟着对象字面量写法走），而是先递归排序键再序列化。
 */
import { z } from 'zod';

export type JsonPrimitive = null | boolean | number | string;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };

export const jsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
	z.union([
		z.null(),
		z.boolean(),
		z.number(),
		z.string(),
		z.array(jsonValueSchema),
		z.record(z.string(), jsonValueSchema),
	]),
);

export const jsonObjectSchema: z.ZodType<JsonObject> = z.record(z.string(), jsonValueSchema);

export const isJsonObject = (value: unknown): value is JsonObject =>
	typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * 把任意 JS 值收敛成 JSON 值：`undefined`（以及函数、symbol）表示「不可表示」，调用方丢弃该键；
 * 非有限数字按 JSON 语义落成 `null`。
 */
export const canonicalizeJson = (value: unknown): JsonValue | undefined => {
	if (value === undefined) return undefined;
	if (value === null || typeof value === 'boolean' || typeof value === 'string') return value;
	if (typeof value === 'number') return Number.isFinite(value) ? value : null;
	if (Array.isArray(value)) return value.map((item) => canonicalizeJson(item) ?? null);
	if (typeof value === 'object') {
		const source = value as Record<string, unknown>;
		const sorted: JsonObject = {};
		for (const key of Object.keys(source).sort()) {
			const child = canonicalizeJson(source[key]);
			if (child !== undefined) sorted[key] = child;
		}
		return sorted;
	}
	return undefined;
};

/** 稳定键序（UTF-16 码元序，ASCII 键下与 Python `sort_keys=True` 一致）+ 无空白序列化。 */
export const canonicalJsonString = (value: unknown): string => JSON.stringify(canonicalizeJson(value) ?? null);

/** 放进诊断 details 的载荷：保证一定是 JSON 值。 */
export const jsonDetail = (value: unknown): JsonValue => canonicalizeJson(value) ?? null;
