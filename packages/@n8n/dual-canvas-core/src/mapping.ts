import { z } from 'zod';

import { jsonObjectSchema, stableReferenceSchema, timestampSchema } from './primitives';

export const sourcePointV1Schema = z
	.object({
		line: z.number().int().positive(),
		column: z.number().int().nonnegative(),
		offset: z.number().int().nonnegative(),
	})
	.strict();

export const sourceSpanV1Schema = z
	.object({
		sourceRef: stableReferenceSchema,
		start: sourcePointV1Schema,
		end: sourcePointV1Schema,
	})
	.strict()
	.superRefine((span, context) => {
		if (span.end.offset < span.start.offset) {
			context.addIssue({
				code: 'custom',
				path: ['end', 'offset'],
				message: 'source span end must not precede its start',
			});
		}
	});

export const sourceMapEntryV1Schema = z
	.object({
		apiVersion: z.literal(1),
		mappingRef: stableReferenceSchema,
		semanticRef: stableReferenceSchema,
		artifact: z
			.object({
				kind: z.enum(['workflowNode', 'canvasBlock', 'planStep', 'canvas', 'other']),
				ref: z.string().trim().min(1).max(256),
			})
			.strict(),
		source: sourceSpanV1Schema.optional(),
		context: jsonObjectSchema.optional(),
	})
	.strict();

export const traceEntryV1Schema = z
	.object({
		apiVersion: z.literal(1),
		traceRef: stableReferenceSchema,
		runRef: stableReferenceSchema,
		sequence: z.number().int().nonnegative(),
		occurredAt: timestampSchema,
		state: z.enum(['queued', 'running', 'succeeded', 'failed', 'cancelled', 'skipped']),
		location: z
			.object({
				nodeRef: stableReferenceSchema.optional(),
				canvasRef: stableReferenceSchema.optional(),
				blockRef: z.string().trim().min(1).max(256).optional(),
				stepRef: stableReferenceSchema.optional(),
			})
			.strict()
			.optional(),
		message: z.string().trim().min(1).max(2000).optional(),
		input: jsonObjectSchema.optional(),
		output: jsonObjectSchema.optional(),
		error: z
			.object({
				code: stableReferenceSchema,
				message: z.string().trim().min(1).max(2000),
				details: jsonObjectSchema.optional(),
			})
			.strict()
			.optional(),
	})
	.strict()
	.superRefine((entry, context) => {
		if (entry.state === 'failed' && entry.error === undefined) {
			context.addIssue({
				code: 'custom',
				path: ['error'],
				message: 'a failed trace entry requires error details',
			});
		}
	});

export const executionEventV1Schema = z
	.object({
		apiVersion: z.literal(1),
		eventRef: stableReferenceSchema,
		runRef: stableReferenceSchema,
		occurredAt: timestampSchema,
		kind: z.enum([
			'accepted',
			'validationStarted',
			'validationFailed',
			'executionStarted',
			'traceAppended',
			'cancelRequested',
			'succeeded',
			'failed',
			'cancelled',
		]),
		trace: traceEntryV1Schema.optional(),
		data: jsonObjectSchema.optional(),
	})
	.strict()
	.superRefine((event, context) => {
		if (event.kind === 'traceAppended' && event.trace === undefined) {
			context.addIssue({
				code: 'custom',
				path: ['trace'],
				message: 'traceAppended requires a trace entry',
			});
		}
		if (event.trace !== undefined && event.trace.runRef !== event.runRef) {
			context.addIssue({
				code: 'custom',
				path: ['trace', 'runRef'],
				message: 'event and trace run references must match',
			});
		}
	});

export type SourcePointV1 = z.infer<typeof sourcePointV1Schema>;
export type SourceSpanV1 = z.infer<typeof sourceSpanV1Schema>;
export type SourceMapEntryV1 = z.infer<typeof sourceMapEntryV1Schema>;
export type TraceEntryV1 = z.infer<typeof traceEntryV1Schema>;
export type ExecutionEventV1 = z.infer<typeof executionEventV1Schema>;
