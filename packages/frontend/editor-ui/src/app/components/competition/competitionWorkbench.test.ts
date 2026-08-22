import {
	getCompetitionRunStatus,
	isCompetitionNodeType,
	isCompetitionWorkbenchWorkflow,
	resolveCompetitionStage,
	stageForNodeType,
} from './competitionWorkbench';

describe('competitionWorkbench', () => {
	it.each(['CUSTOM.blocklyCode', 'CUSTOM.robotSkillPlan', 'CUSTOM.robotStatus'])(
		'identifies %s as a competition node',
		(type) => {
			expect(isCompetitionNodeType(type)).toBe(true);
		},
	);

	it('leaves ordinary workflows on the default n8n presentation', () => {
		expect(
			isCompetitionWorkbenchWorkflow([
				{ type: 'n8n-nodes-base.manualTrigger' },
				{ type: 'n8n-nodes-base.if' },
			]),
		).toBe(false);
	});

	it('maps custom teaching nodes to their matching classroom stages', () => {
		expect(stageForNodeType('n8n-nodes-base.manualTrigger')).toBe('intent');
		expect(stageForNodeType('CUSTOM.blocklyCode')).toBe('logic');
		expect(stageForNodeType('CUSTOM.robotSkillPlan')).toBe('robot');
		expect(stageForNodeType('CUSTOM.robotValidate')).toBe('safety');
		expect(stageForNodeType('n8n-nodes-base.wait')).toBe('approval');
	});

	it('prioritizes the execution review stage while viewing execution data', () => {
		expect(
			resolveCompetitionStage({ activeNodeType: 'CUSTOM.blocklyCode', isExecutionView: true }),
		).toBe('execution');
	});

	it('uses teacher-facing labels for execution states', () => {
		expect(getCompetitionRunStatus('success')).toMatchObject({
			label: '最近运行成功',
			tone: 'success',
		});
		expect(getCompetitionRunStatus('waiting')).toMatchObject({
			label: '等待教师确认',
			tone: 'waiting',
		});
	});
});
