import type { RobotTaskPlan } from '@n8n/blockly-robot-skills';
import { describe, expect, it } from 'vitest';

import { computePlanDigest } from './planDigest';

describe('computePlanDigest', () => {
	it('is stable across object key insertion order', () => {
		const left: RobotTaskPlan = {
			schemaVersion: 1,
			robot: 'so101_single_arm',
			configDigest: 'digest-1',
			plan: [
				{
					step: 'skill',
					skill: 'move_relative_ee',
					params: { motion_direction: 'forward', motion_distance: 0.03 },
				},
			],
		};
		const right: RobotTaskPlan = {
			plan: [
				{
					params: { motion_distance: 0.03, motion_direction: 'forward' },
					skill: 'move_relative_ee',
					step: 'skill',
				},
			],
			configDigest: 'digest-1',
			robot: 'so101_single_arm',
			schemaVersion: 1,
		};

		expect(computePlanDigest(left)).toBe(computePlanDigest(right));
		expect(computePlanDigest(left)).toMatch(/^sha256:[a-f0-9]{64}$/);
	});

	it('changes when a reviewed action parameter changes', () => {
		const plan: RobotTaskPlan = {
			schemaVersion: 1,
			robot: 'so101_single_arm',
			configDigest: 'digest-1',
			plan: [{ step: 'wait', seconds: 1 }],
		};
		const edited: RobotTaskPlan = {
			...plan,
			plan: [{ step: 'wait', seconds: 2 }],
		};

		expect(computePlanDigest(plan)).not.toBe(computePlanDigest(edited));
	});
});
