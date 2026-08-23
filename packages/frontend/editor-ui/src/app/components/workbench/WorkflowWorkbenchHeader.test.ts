import { renderComponent } from '@/__tests__/render';
import type { WorkflowFEMeta } from 'n8n-workflow';

import WorkflowWorkbenchHeader from './WorkflowWorkbenchHeader.vue';
import { resolveWorkflowWorkbenchProfile } from './workflowWorkbench';

const nodes = [
	{ type: 'n8n-nodes-example.lessonInput' },
	{ type: 'n8n-nodes-blockly-code.blocklyCode' },
	{ type: 'n8n-nodes-example.lessonReview' },
];
const meta = {
	visualProgramming: {
		schemaVersion: 1,
		profileId: 'education-code-lab',
		displayName: 'Visual Code Lab',
		brand: 'Learning Studio',
		stages: [
			{ id: 'explore', label: 'Explore', nodeTypes: ['n8n-nodes-example.lessonInput'] },
			{ id: 'build', label: 'Build', nodeTypes: ['n8n-nodes-blockly-code.blocklyCode'] },
			{ id: 'review', label: 'Review', nodeTypes: ['n8n-nodes-example.lessonReview'] },
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
const profile = resolveWorkflowWorkbenchProfile(meta, nodes);
if (!profile) throw new Error('Expected the synthetic profile fixture to resolve');

const props = {
	profile,
	workflowName: 'Introduction to functions',
	nodes,
	activeNodeType: 'n8n-nodes-blockly-code.blocklyCode',
	executionStatus: 'success',
	isExecutionView: false,
};

describe('WorkflowWorkbenchHeader', () => {
	afterEach(() => {
		delete document.documentElement.dataset.workbenchProfile;
	});

	it('renders serialized profile copy and scopes the document theme while mounted', () => {
		const { getByTestId, getByText, unmount } = renderComponent(WorkflowWorkbenchHeader, {
			props,
		});

		expect(getByTestId('workflow-workbench-header')).toHaveAttribute(
			'data-workbench-profile',
			'education-code-lab',
		);
		expect(getByText('Learning Studio')).toBeInTheDocument();
		expect(getByText('Visual Code Lab')).toBeInTheDocument();
		expect(getByText('Success')).toBeInTheDocument();
		expect(getByText('Visual code · 1')).toBeInTheDocument();
		expect(document.documentElement.dataset.workbenchProfile).toBe('education-code-lab');

		unmount();

		expect(document.documentElement.dataset.workbenchProfile).toBeUndefined();
	});

	it('uses the final declared stage for execution review', () => {
		const { getByText } = renderComponent(WorkflowWorkbenchHeader, {
			props: { ...props, isExecutionView: true },
		});

		expect(getByText('Review').parentElement).toHaveClass(/stageActive/);
	});

	it('restores a pre-existing workbench theme when unmounted', () => {
		document.documentElement.dataset.workbenchProfile = 'existing-profile';
		const { unmount } = renderComponent(WorkflowWorkbenchHeader, { props });

		expect(document.documentElement.dataset.workbenchProfile).toBe('education-code-lab');
		unmount();
		expect(document.documentElement.dataset.workbenchProfile).toBe('existing-profile');
	});
});
