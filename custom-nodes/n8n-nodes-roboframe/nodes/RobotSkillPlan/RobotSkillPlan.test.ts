import type { RobotCatalog } from '@n8n/blockly-robot-skills';
import {
	SO101_CATALOG_SNAPSHOT,
	compileRobotWorkspace,
	createDefaultRobotWorkspace,
	serializeRobotPlanPayload,
} from '@n8n/blockly-robot-skills';
import type { IExecuteFunctions, INode, INodeExecutionData } from 'n8n-workflow';
import { describe, expect, it, vi } from 'vitest';

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
		getInputData: (): INodeExecutionData[] => [
			{ json: { lessonId: 'lesson-1' }, pairedItem: { item: 0 } },
		],
		getCredentials: vi.fn(async () => ({ baseUrl: 'http://bridge', token: 't' })),
	} as unknown as IExecuteFunctions;
}

function payloadCatalog(digest = 'payload-catalog-digest'): RobotCatalog {
	return { ...structuredClone(SO101_CATALOG_SNAPSHOT), configDigest: digest };
}

describe('RobotSkillPlan node', () => {
	it('recompiles exclusively against the catalog embedded in payload v2', async () => {
		const catalog = payloadCatalog();
		const workspace = createDefaultRobotWorkspace();
		const compiled = compileRobotWorkspace(workspace, catalog);
		expect(compiled.ok).toBe(true);
		if (!compiled.ok) return;
		const payload = serializeRobotPlanPayload({ catalog, workspace });

		const instance = new RobotSkillPlan();
		const result = await instance.execute.call(makeContext({ blocklyPayload: payload }));
		expect(result[0][0].json).toEqual({
			lessonId: 'lesson-1',
			plan: compiled.plan,
			compilation: {
				valid: true,
				blockCount: compiled.blockCount,
				catalogDigest: {
					source: 'payloadCatalog',
					value: 'payload-catalog-digest',
				},
			},
		});
	});

	it('rejects workspaces that do not compile against their payload catalog', async () => {
		const payload = serializeRobotPlanPayload({
			catalog: payloadCatalog(),
			workspace: { blocks: { blocks: [] } },
		});
		const instance = new RobotSkillPlan();
		await expect(
			instance.execute.call(makeContext({ blocklyPayload: payload })),
		).rejects.toThrow('workspace has no root block');
	});

	it('rejects malformed payloads and payloads carrying the retired plan preview', async () => {
		const instance = new RobotSkillPlan();
		await expect(
			instance.execute.call(makeContext({ blocklyPayload: 'not-json' })),
		).rejects.toThrow('invalid Blockly payload');
		const withPreview = JSON.stringify({
			schemaVersion: 2,
			catalog: payloadCatalog(),
			workspace: createDefaultRobotWorkspace(),
			plan: { schemaVersion: 1, plan: [] },
		});
		await expect(
			instance.execute.call(makeContext({ blocklyPayload: withPreview })),
		).rejects.toThrow('invalid Blockly payload');
	});

	it('default payload compiles with its embedded catalog', async () => {
		const instance = new RobotSkillPlan();
		const result = await instance.execute.call(makeContext({}));
		const json = result[0][0].json as {
			plan: { plan: unknown[]; configDigest: string };
			compilation: { catalogDigest: { source: string; value: string } };
		};
		expect(json.plan.plan.length).toBe(2);
		expect(json.plan.configDigest).toBe(SO101_CATALOG_SNAPSHOT.configDigest);
		expect(json.compilation.catalogDigest).toEqual({
			source: 'payloadCatalog',
			value: SO101_CATALOG_SNAPSHOT.configDigest,
		});
	});
});
