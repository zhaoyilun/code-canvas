import type { IconName } from '@n8n/design-system';

type NodeTypeCarrier = {
	type?: string | null;
};

export const COMPETITION_STAGE_IDS = [
	'intent',
	'logic',
	'device',
	'robot',
	'safety',
	'approval',
	'execution',
] as const;

export type CompetitionStageId = (typeof COMPETITION_STAGE_IDS)[number];

export type CompetitionStage = {
	id: CompetitionStageId;
	label: string;
	icon: IconName;
	accent: 'blue' | 'purple' | 'orange' | 'amber' | 'green';
};

export const COMPETITION_STAGES: readonly CompetitionStage[] = [
	{ id: 'intent', label: '任务意图', icon: 'brain', accent: 'blue' },
	{ id: 'logic', label: '代码理解', icon: 'blocks', accent: 'purple' },
	{ id: 'device', label: '设备就绪', icon: 'network', accent: 'orange' },
	{ id: 'robot', label: '动作编排', icon: 'robot', accent: 'orange' },
	{ id: 'safety', label: '安全校验', icon: 'shield', accent: 'amber' },
	{ id: 'approval', label: '教师确认', icon: 'graduation-cap', accent: 'amber' },
	{ id: 'execution', label: '运行回看', icon: 'circle-check', accent: 'green' },
];

export function isCompetitionNodeType(type: string | null | undefined): boolean {
	return (
		type === 'CUSTOM.blocklyCode' ||
		type === 'CUSTOM.robotSkillPlan' ||
		type?.startsWith('CUSTOM.robot') === true
	);
}

export function isCompetitionWorkbenchWorkflow(nodes: readonly NodeTypeCarrier[]): boolean {
	return nodes.some((node) => isCompetitionNodeType(node.type));
}

export function stageForNodeType(type: string | null | undefined): CompetitionStageId | null {
	switch (type) {
		case 'CUSTOM.competitionDesign':
		case 'n8n-nodes-base.manualTrigger':
			return 'intent';
		case 'CUSTOM.blocklyCode':
			return 'logic';
		case 'CUSTOM.robotStatus':
		case 'CUSTOM.robotCatalog':
			return 'device';
		case 'CUSTOM.robotSkillPlan':
		case 'CUSTOM.robotSkill':
			return 'robot';
		case 'CUSTOM.robotValidate':
			return 'safety';
		case 'CUSTOM.robotTask':
			return 'execution';
		case 'n8n-nodes-base.wait':
			return 'approval';
		default:
			return null;
	}
}

export function stageIsPresent(
	stage: CompetitionStageId,
	nodes: readonly NodeTypeCarrier[],
): boolean {
	return nodes.some((node) => stageForNodeType(node.type) === stage);
}

export function resolveCompetitionStage({
	activeNodeType,
	isExecutionView,
}: {
	activeNodeType?: string | null;
	isExecutionView: boolean;
}): CompetitionStageId {
	if (isExecutionView) return 'execution';
	return stageForNodeType(activeNodeType) ?? 'intent';
}

export type CompetitionRunStatus = {
	label: string;
	tone: 'ready' | 'running' | 'waiting' | 'success' | 'danger';
	icon: IconName;
};

export function getCompetitionRunStatus(status: string | null | undefined): CompetitionRunStatus {
	switch (status) {
		case 'success':
			return { label: '最近运行成功', tone: 'success', icon: 'circle-check' };
		case 'running':
		case 'new':
			return { label: '课堂任务运行中', tone: 'running', icon: 'circle-play' };
		case 'waiting':
			return { label: '等待教师确认', tone: 'waiting', icon: 'graduation-cap' };
		case 'error':
		case 'crashed':
		case 'failed':
		case 'canceled':
			return { label: '等待查看运行结果', tone: 'danger', icon: 'shield' };
		default:
			return { label: '课堂流程已就绪', tone: 'ready', icon: 'circle-play' };
	}
}
