import type { RobotTaskPlan } from '@n8n/blockly-robot-skills';
import { describe, expect, it } from 'vitest';

import type { RobotAction } from '../shared/bridge';
import type { ActionClient } from '../shared/engine';
import { validatePlan } from './RobotValidate.node';

function planOf(...plan: RobotTaskPlan['plan']): RobotTaskPlan {
	return { schemaVersion: 1, robot: 'so101_single_arm', configDigest: 'digest-1', plan };
}

function makeClient(
	validate: (action: RobotAction) => Promise<{ valid: boolean; message?: string }>,
	liveDigest = 'digest-1',
): ActionClient {
	return {
		catalog: async () => ({ config_digest: liveDigest }),
		execute: async () => ({}),
		validate: async (action) => await validate(action),
		task: async () => null,
		cancel: async () => ({}),
	};
}

describe('validatePlan', () => {
	it('validates every skill and primitive while retaining wait step results', async () => {
		const actions: RobotAction[] = [];
		const result = await validatePlan(
			makeClient(async (action) => {
				actions.push(action);
				return { valid: true };
			}),
			planOf(
				{
					step: 'skill',
					skill: 'inspect_scene',
					blockId: 'block-1',
					planStepId: 'step:block-1',
				},
				{ step: 'wait', seconds: 1 },
				{ step: 'primitive', primitive: 'open_gripper' },
			),
		);
		expect(actions).toEqual([
			{ kind: 'skill', name: 'inspect_scene' },
			{ kind: 'primitive', name: 'open_gripper' },
		]);
		expect(result).toMatchObject({
			mode: 'plan',
			valid: true,
			planDigest: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
			checkedActionCount: 2,
			catalogDigest: { valid: true, plan: 'digest-1', live: 'digest-1' },
			steps: [
				expect.objectContaining({
					index: 0,
					blockId: 'block-1',
					planStepId: 'step:block-1',
					action: { kind: 'skill', name: 'inspect_scene' },
					valid: true,
				}),
				expect.objectContaining({ index: 1, type: 'wait', valid: true, seconds: 1 }),
				expect.objectContaining({
					index: 2,
					action: { kind: 'primitive', name: 'open_gripper' },
					valid: true,
				}),
			],
		});
	});

	it('summarizes action rejection and catalog mismatch in one plan verdict', async () => {
		const result = await validatePlan(
			makeClient(
				async (action) =>
					action.kind === 'primitive'
						? { valid: false, message: 'primitive is not exposed' }
						: { valid: true },
				'digest-2',
			),
			planOf(
				{ step: 'skill', skill: 'inspect_scene' },
				{ step: 'primitive', primitive: 'open_gripper' },
			),
		);
		expect(result).toMatchObject({
			valid: false,
			catalogDigest: {
				valid: false,
				plan: 'digest-1',
				live: 'digest-2',
			},
			steps: [
				expect.objectContaining({ valid: true }),
				expect.objectContaining({ valid: false, message: 'primitive is not exposed' }),
			],
		});
	});
});
