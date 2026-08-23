import { renderComponent } from '@/__tests__/render';
import CompetitionWorkbenchHeader from './CompetitionWorkbenchHeader.vue';

const props = {
	workflowName: '人工智能可解释机器人课程',
	nodes: [
		{ type: 'CUSTOM.blocklyCode' },
		{ type: 'CUSTOM.robotStatus' },
		{ type: 'CUSTOM.robotSkillPlan' },
		{ type: 'CUSTOM.robotValidate' },
		{ type: 'CUSTOM.robotTask' },
		{ type: 'n8n-nodes-base.wait' },
	],
	activeNodeType: 'CUSTOM.blocklyCode',
	executionStatus: 'success',
	isExecutionView: false,
};

describe('CompetitionWorkbenchHeader', () => {
	afterEach(() => {
		delete document.documentElement.dataset.competitionWorkbench;
	});

	it('renders a teacher-facing task rail and scopes the document theme while mounted', () => {
		const { getByTestId, getByText, unmount } = renderComponent(CompetitionWorkbenchHeader, {
			props,
		});

		expect(getByTestId('competition-workbench-header')).toBeInTheDocument();
		expect(getByText('人工智能代码理解实验室')).toBeInTheDocument();
		expect(getByText('最近运行成功')).toBeInTheDocument();
		expect(getByText('1 个可视化逻辑节点')).toBeInTheDocument();
		expect(getByText('4 个机器人任务节点')).toBeInTheDocument();
		expect(document.documentElement.dataset.competitionWorkbench).toBe('true');

		unmount();

		expect(document.documentElement.dataset.competitionWorkbench).toBeUndefined();
	});

	it('moves the visible stage to execution review when execution data is open', () => {
		const { getByText } = renderComponent(CompetitionWorkbenchHeader, {
			props: { ...props, isExecutionView: true },
		});

		expect(getByText('运行回看').parentElement).toHaveClass(/stageActive/);
	});
});
