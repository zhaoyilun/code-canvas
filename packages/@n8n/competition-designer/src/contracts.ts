import { z } from 'zod';

export const stableReference = z
	.string()
	.min(1)
	.max(128)
	.regex(/^[a-zA-Z0-9][a-zA-Z0-9._:-]*$/);

export const competitionWorkflowDraftSchema = z.object({
	schemaVersion: z.literal('1.0'),
	designId: stableReference,
	revisionId: stableReference,
	name: z.string().trim().min(1).max(128),
	planRef: stableReference,
	blocklyPayload: z.string().min(1),
	robotCredential: z.object({
		id: z.string().trim().min(1),
		name: z.string().trim().min(1),
	}),
});

export type CompetitionWorkflowDraft = z.infer<typeof competitionWorkflowDraftSchema>;

export type CompetitionDesignMeta = {
	schemaVersion: '1.0';
	designId: string;
	revisionId: string;
	planRef: string;
	reviewState: 'review_required';
};

export type CompetitionDiagnosticCode =
	| 'WORKFLOW_DRAFT_INVALID'
	| 'N8N_GRAPH_DISCONNECTED'
	| 'MOTION_REVIEW_PATH_MISSING'
	| 'MOTION_REVIEW_PATH_INVALID'
	| 'ROBOT_VALIDATION_MODE_INVALID'
	| 'ROBOT_READINESS_BRANCH_MISSING'
	| 'ROBOT_READINESS_CONDITION_INVALID'
	| 'APPROVAL_DECISION_MISSING'
	| 'APPROVAL_DECISION_INVALID'
	| 'TASK_RESULT_BRANCH_MISSING'
	| 'ROBOT_PLAN_BINDING_MISSING'
	| 'ROBOT_DIRECT_HTTP_FORBIDDEN'
	| 'ROBOT_CREDENTIAL_REFERENCE_INVALID';

export type CompetitionDiagnostic = {
	code: CompetitionDiagnosticCode;
	severity: 'error' | 'warning';
	ref?: string;
	message: string;
};
