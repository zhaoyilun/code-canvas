import { describe, expect, it } from 'vitest';

import { createStableArtifactRef, createStableId } from './stable-ids';

describe('stable identifiers', () => {
	it('is deterministic within a scope and distinct across scopes', () => {
		expect(createStableId('lesson.alpha', 'node:prepare/value')).toBe(
			createStableId('lesson.alpha', 'node:prepare/value'),
		);
		expect(createStableId('lesson.alpha', 'node:prepare/value')).not.toBe(
			createStableId('lesson.beta', 'node:prepare/value'),
		);
	});

	it('creates typed artifact references', () => {
		expect(createStableArtifactRef('block', 'lesson.alpha', 'prepare:value')).toMatch(
			/^block-[a-f0-9-]{36}$/,
		);
	});

	it('rejects invalid scopes and empty local identities', () => {
		expect(() => createStableId('invalid scope', 'node')).toThrow();
		expect(() => createStableId('lesson.alpha', '')).toThrow();
	});
});
