export const COMPETITION_NODE_TYPES = {
	manualTrigger: 'n8n-nodes-base.manualTrigger',
	wait: 'n8n-nodes-base.wait',
	if: 'n8n-nodes-base.if',
	merge: 'n8n-nodes-base.merge',
	noOp: 'n8n-nodes-base.noOp',
	httpRequest: 'n8n-nodes-base.httpRequest',
	robotStatus: 'CUSTOM.robotStatus',
	robotSkillPlan: 'CUSTOM.robotSkillPlan',
	robotValidate: 'CUSTOM.robotValidate',
	robotTask: 'CUSTOM.robotTask',
} as const;

export const ROBOT_BRIDGE_PATH_PATTERN = /\/(?:v1\/)?(?:actions|skills|tasks)(?:\/|$)/i;
