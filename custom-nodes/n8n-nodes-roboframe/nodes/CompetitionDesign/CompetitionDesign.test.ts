import { parseBlocklyDataPayload } from '@n8n/blockly-data-transform';
import { parseRobotPlanPayload } from '@n8n/blockly-robot-skills';
import type { IExecuteFunctions, INode, INodeExecutionData } from 'n8n-workflow';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { clientFromCredentialsMock } = vi.hoisted(() => ({
	clientFromCredentialsMock: vi.fn(),
}));

vi.mock('../shared/context', () => ({ clientFromCredentials: clientFromCredentialsMock }));

import { CompetitionDesign } from './CompetitionDesign.node';

const liveCatalog = {
	robot_name: 'rk3588_training_arm',
	config_digest: 'sha256:live-catalog',
	skills: [
		{
			kind: 'skill',
			name: 'inspect_scene',
			summary: 'Inspect the workspace',
			domain: 'perception',
			moves_robot: false,
			required_control_mode: 'moveit_planning',
			parameters: { type: 'object', properties: {}, additionalProperties: false },
			recovery_policy: 'never_retry',
			timeout_policy: {},
		},
	],
	primitives: [
		{
			kind: 'primitive',
			name: 'open_gripper',
			summary: 'Open the gripper',
			domain: 'manipulation',
			moves_robot: true,
			required_control_mode: 'moveit_planning',
			parameters: { type: 'object', properties: {}, additionalProperties: false },
			recovery_policy: '',
			timeout_policy: {},
		},
	],
};

const livePoses = {
	robot_name: 'rk3588_training_arm',
	config_digest: 'sha256:live-catalog',
	poses: ['home'],
};

function designDraft(catalogDigest = 'sha256:live-catalog') {
	return {
		schemaVersion: '2.0',
		designId: 'lesson.inspect-and-open',
		revisionId: 'revision-1',
		name: 'AI 可解释机器人课程',
		logicNodes: [
			{
				nodeRef: 'logic.normalize-input',
				label: 'Normalize lesson input',
				outputMode: 'copyInput',
				statements: [
					{
						kind: 'set',
						intentStepId: 'logic.normalize.amount',
						targetField: 'normalizedAmount',
						value: {
							kind: 'convert',
							to: 'number',
							value: { kind: 'input', path: 'amount' },
						},
						teaching: {
							what: '把输入金额转换为数字',
							why: '机器人判断节点需要稳定的数值类型',
							editable: ['输入路径', '输出字段'],
							expectedEffect: 'normalizedAmount 是数字或 null',
						},
					},
				],
			},
		],
		robotPlan: {
			schemaVersion: 1,
			planRef: 'plan.inspect-and-open',
			label: '观察并张开夹爪',
			robotProfileRef: 'rk3588_training_arm',
			catalogDigest,
			budgetSec: 60,
			steps: [
				{
					stepRef: 'observe',
					kind: 'skill',
					name: 'inspect_scene',
					teaching: {
						what: '观察场景',
						why: '先理解环境再动作',
						editable: [],
						expectedEffect: '形成场景状态',
					},
				},
				{ stepRef: 'open', kind: 'primitive', name: 'open_gripper' },
			],
		},
	};
}

function makeContext(params: Record<string, unknown>) {
	const node = { name: 'Competition Design' } as INode;
	const values = new Map<string, unknown>(Object.entries(params));
	return {
		getNode: () => node,
		getNodeParameter: vi.fn((name: string, _index: number, fallback: unknown) => {
			const value = values.get(name);
			return value === undefined ? fallback : value;
		}),
		getInputData: (): INodeExecutionData[] => [
			{ json: { lessonId: 'lesson-1' }, pairedItem: { item: 0 } },
		],
		getCredentials: vi.fn(async () => ({ baseUrl: 'http://bridge', token: 'test' })),
	} as unknown as IExecuteFunctions;
}

describe('CompetitionDesign node', () => {
	beforeEach(() => {
		clientFromCredentialsMock.mockReset();
		clientFromCredentialsMock.mockResolvedValue({
			catalog: vi.fn(async () => liveCatalog),
			poseCatalog: vi.fn(async () => livePoses),
		});
	});

	it('generates importable linked n8n and Blockly artifacts with actual custom node types', async () => {
		const instance = new CompetitionDesign();
		const result = await instance.execute.call(
			makeContext({
				designDraft: JSON.stringify(designDraft()),
				targetCredentialId: 'credential-rk3588',
				targetCredentialName: 'RK3588 Classroom Robot',
			}),
		);
		const json = result[0][0].json as {
			ok: boolean;
			stage: string;
			blocklyPayload: string;
			blocklyWorkspace: Record<string, unknown>;
			logicNodes: Array<{
				blocklyPayload: string;
				javascript: string;
				sourceMap: Array<{ intentStepId: string; blockId: string }>;
			}>;
			semanticDraft: { robotPlan: { steps: Array<{ teaching?: { why: string } }> } };
			robotTaskPlan: { plan: unknown[] };
			traceMap: unknown[];
			n8nWorkflow: {
				nodes: Array<{
					type: string;
					credentials?: { robframeBridgeApi?: { id: string; name: string } };
				}>;
			};
		};

		expect(json.ok).toBe(true);
		expect(json.stage).toBe('complete');
		expect(parseRobotPlanPayload(json.blocklyPayload).ok).toBe(true);
		expect(json.blocklyWorkspace).toHaveProperty('blocks');
		expect(json.logicNodes).toHaveLength(1);
		expect(parseBlocklyDataPayload(json.logicNodes[0].blocklyPayload).ok).toBe(true);
		expect(json.logicNodes[0].javascript).toContain('normalizedAmount');
		expect(json.logicNodes[0].sourceMap[0]?.intentStepId).toBe('logic.normalize.amount');
		expect(json.robotTaskPlan.plan).toHaveLength(2);
		expect(json.traceMap).toHaveLength(3);
		expect(json.semanticDraft.robotPlan.steps[0]?.teaching?.why).toBe('先理解环境再动作');
		expect(json.n8nWorkflow.nodes.map((nodeEntry) => nodeEntry.type)).toEqual([
			'n8n-nodes-base.manualTrigger',
			'CUSTOM.blocklyCode',
			'CUSTOM.robotStatus',
			'n8n-nodes-base.if',
			'CUSTOM.robotSkillPlan',
			'CUSTOM.robotValidate',
			'n8n-nodes-base.wait',
			'n8n-nodes-base.if',
			'n8n-nodes-base.merge',
			'CUSTOM.robotTask',
			'n8n-nodes-base.if',
			'n8n-nodes-base.noOp',
			'n8n-nodes-base.noOp',
			'n8n-nodes-base.noOp',
			'n8n-nodes-base.noOp',
		]);
		const robotNodes = json.n8nWorkflow.nodes.filter((nodeEntry) =>
			nodeEntry.type.startsWith('CUSTOM.robot'),
		);
		expect(robotNodes.filter((nodeEntry) => nodeEntry.credentials !== undefined)).toHaveLength(3);
		for (const nodeEntry of robotNodes) {
			if (nodeEntry.credentials === undefined) continue;
			expect(nodeEntry.credentials.robframeBridgeApi).toEqual({
				id: 'credential-rk3588',
				name: 'RK3588 Classroom Robot',
			});
		}
	});

	it('returns robot-plan diagnostics that an AI can revise', async () => {
		const instance = new CompetitionDesign();
		const result = await instance.execute.call(
			makeContext({
				designDraft: designDraft('sha256:stale-catalog'),
				targetCredentialId: 'credential-rk3588',
				targetCredentialName: 'RK3588 Classroom Robot',
			}),
		);

		expect(result[0][0].json).toMatchObject({
			lessonId: 'lesson-1',
			ok: false,
			stage: 'robot-plan',
			diagnostics: [
				{
					code: 'CATALOG_DIGEST_MISMATCH',
					severity: 'error',
					ref: 'catalogDigest',
				},
			],
		});
	});

	it('returns structured diagnostics for malformed draft JSON', async () => {
		const instance = new CompetitionDesign();
		const result = await instance.execute.call(
			makeContext({
				designDraft: '{bad json',
				targetCredentialId: 'credential-rk3588',
				targetCredentialName: 'RK3588 Classroom Robot',
			}),
		);

		expect(result[0][0].json).toMatchObject({
			ok: false,
			stage: 'design-draft',
			diagnostics: [
				{
					code: 'DESIGN_DRAFT_JSON_INVALID',
					severity: 'error',
					ref: 'designDraft',
				},
			],
		});
	});
});
