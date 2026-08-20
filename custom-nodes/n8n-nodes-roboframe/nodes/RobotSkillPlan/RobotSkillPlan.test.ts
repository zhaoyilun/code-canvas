import { describe, expect, it, vi } from 'vitest';

import type { IExecuteFunctions, INode, INodeExecutionData } from 'n8n-workflow';
import {
	createDefaultRobotWorkspace,
	serializeRobotPlanPayload,
	compileRobotWorkspace,
	SO101_CATALOG_SNAPSHOT,
} from '@n8n/blockly-robot-skills';
import { RobotSkillPlan } from './RobotSkillPlan.node';

function makeContext(params: Record<string, unknown>) {
	const node = { name: 'Robot Skill Plan' } as INode;
	const values = new Map<string, unknown>(Object.entries(params));
	return {
		node,
		getNode: () => node,
		getNodeParameter: vi.fn((_name: string, _index: number, fallback: unknown) => {
			const value = values.get(_name);
			return value === undefined ? fallback : value;
		}),
		getInputData: (): INodeExecutionData[] => [{ json: {}, pairedItem: { item: 0 } }],
		getCredentials: vi.fn(async () => ({ baseUrl: 'http://bridge', token: 't' })),
	} as unknown as IExecuteFunctions;
}

describe('RobotSkillPlan node', () => {
	it('compile mode outputs the recompiled plan and ignores the payload preview', async () => {
		const compiled = compileRobotWorkspace(createDefaultRobotWorkspace(), SO101_CATALOG_SNAPSHOT);
		expect(compiled.ok).toBe(true);
		if (!compiled.ok) return;

		// Tamper the preview plan the runtime must never trust.
		const tampered = structuredClone(compiled.plan);
		tampered.plan = [{ step: 'skill', skill: 'dance_basic' }, { step: 'skill', skill: 'dance_basic' }, { step: 'skill', skill: 'dance_basic' }, { step: 'skill', skill: 'dance_basic' }, { step: 'skill', skill: 'dance_basic' }, { step: 'skill', skill: 'dance_basic' }, { step: 'skill', skill: 'dance_basic' }];
		const payload = serializeRobotPlanPayload(
			{ ...createDefaultRobotWorkspace() },
			tampered,
		);

		const instance = new RobotSkillPlan();
		const result = await instance.execute.call(
			makeContext({ blocklyPayload: payload, mode: 'compile' }),
		);
		expect(result[0][0].json).toEqual({ plan: compiled.plan }); // workspace is the truth
	});

	it('rejects workspaces that do not compile', async () => {
		const payload = serializeRobotPlanPayload({ blocks: { blocks: [] } }, undefined);
		const instance = new RobotSkillPlan();
		await expect(
			instance.execute.call(makeContext({ blocklyPayload: payload, mode: 'compile' })),
		).rejects.toThrow('workspace has no root block');
	});

	it('rejects malformed payloads', async () => {
		const instance = new RobotSkillPlan();
		await expect(
			instance.execute.call(makeContext({ blocklyPayload: 'not-json', mode: 'compile' })),
		).rejects.toThrow('invalid Blockly payload');
	});

	it('default payload compiles', async () => {
		const instance = new RobotSkillPlan();
		const result = await instance.execute.call(makeContext({ mode: 'compile' }));
		const json = result[0][0].json as { plan: { plan: unknown[] } };
		expect(json.plan.plan.length).toBe(2);
	});
});
