import { describe, expect, it } from 'vitest';

import { executionEventV1Schema, sourceSpanV1Schema, traceEntryV1Schema } from './mapping';

const trace = {
	apiVersion: 1,
	traceRef: 'trace.1',
	runRef: 'run.1',
	sequence: 0,
	occurredAt: '2026-08-24T08:00:00.000Z',
	state: 'running',
	location: { nodeRef: 'publish.1', stepRef: 'prepare' },
} as const;

describe('mapping and execution contracts', () => {
	it('rejects reversed source spans', () => {
		expect(
			sourceSpanV1Schema.safeParse({
				sourceRef: 'source.1',
				start: { line: 2, column: 4, offset: 20 },
				end: { line: 1, column: 0, offset: 10 },
			}).success,
		).toBe(false);
	});

	it('requires structured error details for failed trace entries', () => {
		expect(traceEntryV1Schema.safeParse(trace).success).toBe(true);
		expect(traceEntryV1Schema.safeParse({ ...trace, state: 'failed' }).success).toBe(false);
		expect(
			traceEntryV1Schema.safeParse({
				...trace,
				state: 'failed',
				error: { code: 'PUBLISH_FAILED', message: 'Publishing failed' },
			}).success,
		).toBe(true);
	});

	it('keeps lifecycle events and attached traces on the same run', () => {
		const event = {
			apiVersion: 1,
			eventRef: 'event.1',
			runRef: 'run.1',
			occurredAt: '2026-08-24T08:00:00.000Z',
			kind: 'traceAppended',
			trace,
		} as const;
		expect(executionEventV1Schema.safeParse(event).success).toBe(true);
		expect(
			executionEventV1Schema.safeParse({
				...event,
				trace: { ...trace, runRef: 'run.2' },
			}).success,
		).toBe(false);
		expect(executionEventV1Schema.safeParse({ ...event, trace: undefined }).success).toBe(false);
	});
});
