import { z } from 'zod';

import { jsonObjectSchema, stableReferenceSchema } from './primitives';

export const diagnosticV1Schema = z
	.object({
		apiVersion: z.literal(1),
		code: stableReferenceSchema,
		severity: z.enum(['error', 'warning', 'info']),
		message: z.string().trim().min(1).max(2000),
		path: z.string().trim().min(1).max(512).optional(),
		ref: stableReferenceSchema.optional(),
		details: jsonObjectSchema.optional(),
	})
	.strict();

export type DiagnosticV1 = z.infer<typeof diagnosticV1Schema>;

export type ResultV1<T> = { ok: true; value: T } | { ok: false; diagnostics: DiagnosticV1[] };

export function resultOk<T>(value: T): ResultV1<T> {
	return { ok: true, value };
}

export function resultError<T = never>(...diagnostics: DiagnosticV1[]): ResultV1<T> {
	return { ok: false, diagnostics };
}
