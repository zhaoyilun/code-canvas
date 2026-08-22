import { createHash } from 'node:crypto';

import type { RobotTaskPlan } from '@n8n/blockly-robot-skills';
import { UnexpectedError } from 'n8n-workflow';

/** Bind a validation verdict to the exact canonical plan that was reviewed. */
export function computePlanDigest(plan: RobotTaskPlan): string {
	const canonical = canonicalJson(plan);
	return `sha256:${createHash('sha256').update(canonical, 'utf8').digest('hex')}`;
}

function canonicalJson(value: unknown): string {
	if (value === null) return 'null';
	if (typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
	if (typeof value === 'number') {
		if (!Number.isFinite(value)) throw new UnexpectedError('plan contains a non-finite number');
		return JSON.stringify(value);
	}
	if (Array.isArray(value)) return `[${value.map((entry) => canonicalJson(entry)).join(',')}]`;
	if (typeof value === 'object') {
		const fields = Object.entries(value)
			.filter((entry) => entry[1] !== undefined)
			.sort(([left], [right]) => compareJsonKeys(left, right))
			.map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`);
		return `{${fields.join(',')}}`;
	}
	throw new UnexpectedError('plan contains a non-JSON value');
}

function compareJsonKeys(left: string, right: string): number {
	if (left < right) return -1;
	if (left > right) return 1;
	return 0;
}
