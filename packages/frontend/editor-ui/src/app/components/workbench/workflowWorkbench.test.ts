import type { WorkflowFEMeta } from 'n8n-workflow';

import {
	resolveWorkflowWorkbenchCapabilities,
	resolveWorkflowWorkbenchProfile,
	resolveWorkflowWorkbenchRunStatus,
	resolveWorkflowWorkbenchStage,
	stageForWorkflowNodeType,
} from './workflowWorkbench';

const educationMeta = {
	visualProgramming: {
		schemaVersion: 1,
		profileId: 'education-code-lab',
		displayName: 'Visual Code Lab',
		brand: 'Learning Studio',
		stages: [
			{
				id: 'explore',
				label: 'Explore',
				nodeTypes: ['n8n-nodes-example.lessonInput'],
			},
			{
				id: 'build',
				label: 'Build',
				nodeTypes: ['n8n-nodes-blockly-code.blocklyCode'],
			},
			{
				id: 'review',
				label: 'Review',
				nodeTypes: ['n8n-nodes-example.lessonReview'],
			},
		],
		capabilities: [
			{
				id: 'visual-code',
				label: 'Visual code',
				nodeTypes: ['n8n-nodes-blockly-code.blocklyCode'],
			},
		],
	},
} satisfies WorkflowFEMeta;

const educationNodes = [
	{ type: 'n8n-nodes-example.lessonInput' },
	{ type: 'n8n-nodes-blockly-code.blocklyCode' },
	{ type: 'n8n-nodes-example.lessonReview' },
];

describe('workflowWorkbench', () => {
	it('resolves a V1 profile from workflow metadata and installed node types', () => {
		const profile = resolveWorkflowWorkbenchProfile(educationMeta, educationNodes);

		expect(profile).toMatchObject({
			id: 'education-code-lab',
			displayName: 'Visual Code Lab',
			brand: 'Learning Studio',
		});
		expect(profile?.stages.map(({ id }) => id)).toEqual(['explore', 'build', 'review']);
	});

	it('keeps workflows without visual-programming metadata on the standard presentation', () => {
		expect(
			resolveWorkflowWorkbenchProfile(undefined, [{ type: 'n8n-nodes-blockly-code.blocklyCode' }]),
		).toBeNull();
	});

	it('ignores metadata that does not describe any workflow node', () => {
		expect(
			resolveWorkflowWorkbenchProfile(educationMeta, [{ type: 'n8n-nodes-base.manualTrigger' }]),
		).toBeNull();
	});

	it('rejects malformed and unsupported metadata', () => {
		expect(
			resolveWorkflowWorkbenchProfile(
				{
					visualProgramming: {
						...educationMeta.visualProgramming,
						schemaVersion: 2,
					},
				},
				educationNodes,
			),
		).toBeNull();
		expect(
			resolveWorkflowWorkbenchProfile(
				{
					visualProgramming: {
						...educationMeta.visualProgramming,
						stages: [
							educationMeta.visualProgramming.stages[0],
							educationMeta.visualProgramming.stages[0],
						],
					},
				},
				educationNodes,
			),
		).toBeNull();
	});

	it('maps active nodes and execution view to declared stages', () => {
		const profile = resolveWorkflowWorkbenchProfile(educationMeta, educationNodes);
		expect(profile).not.toBeNull();
		if (!profile) return;

		expect(stageForWorkflowNodeType(profile, 'n8n-nodes-blockly-code.blocklyCode')).toBe('build');
		expect(
			resolveWorkflowWorkbenchStage(profile, {
				activeNodeType: 'n8n-nodes-blockly-code.blocklyCode',
				isExecutionView: false,
			}),
		).toBe('build');
		expect(
			resolveWorkflowWorkbenchStage(profile, {
				activeNodeType: 'n8n-nodes-blockly-code.blocklyCode',
				isExecutionView: true,
			}),
		).toBe('review');
	});

	it('uses generic execution states and serialized capability labels', () => {
		const profile = resolveWorkflowWorkbenchProfile(educationMeta, educationNodes);
		expect(profile).not.toBeNull();
		if (!profile) return;

		expect(resolveWorkflowWorkbenchRunStatus('success')).toMatchObject({
			translationKey: 'executionsList.success',
			tone: 'success',
		});
		expect(resolveWorkflowWorkbenchRunStatus('waiting')).toMatchObject({
			translationKey: 'executionsList.waiting',
			tone: 'waiting',
		});
		expect(resolveWorkflowWorkbenchCapabilities(profile, educationNodes)).toEqual([
			{ id: 'visual-code', count: 1, label: 'Visual code' },
		]);
	});
});
