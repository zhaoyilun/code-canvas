import { z } from 'zod';

const forbiddenObjectKeys = new Set(['__proto__', 'prototype', 'constructor']);

export type JsonPrimitive = boolean | number | string | null;
export type JsonValue = JsonPrimitive | JsonValue[] | JsonObject;
export type JsonObject = { [key: string]: JsonValue };

export const jsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
	z.union([
		z.string(),
		z.number().finite(),
		z.boolean(),
		z.null(),
		z.array(jsonValueSchema),
		jsonObjectSchema,
	]),
);

export const jsonObjectSchema: z.ZodType<JsonObject> = z.lazy(() =>
	z.record(jsonValueSchema).superRefine((value, context) => {
		for (const key of Object.keys(value)) {
			if (forbiddenObjectKeys.has(key)) {
				context.addIssue({
					code: 'custom',
					path: [key],
					message: `object key "${key}" is reserved`,
				});
			}
		}
	}),
);

export const stableReferenceSchema = z
	.string()
	.min(1)
	.max(128)
	.regex(/^[a-zA-Z0-9][a-zA-Z0-9._:-]*$/);

export const versionStringSchema = z
	.string()
	.min(1)
	.max(64)
	.regex(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/);

export const packageNameSchema = z
	.string()
	.min(1)
	.max(214)
	.regex(/^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/);

export const installedNodeTypeSchema = z
	.string()
	.trim()
	.min(1)
	.max(256)
	.refine((value) => !/\s/.test(value), 'installed node type must not contain whitespace');

export const timestampSchema = z.string().datetime({ offset: true });

export const canvasPositionSchema = z
	.object({
		x: z.number().finite(),
		y: z.number().finite(),
	})
	.strict();

export type StableReference = z.infer<typeof stableReferenceSchema>;
export type CanvasPosition = z.infer<typeof canvasPositionSchema>;
