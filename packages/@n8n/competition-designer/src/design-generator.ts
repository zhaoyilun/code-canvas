import {
	generateRobotPlanWorkspace,
	serializeRobotPlanPayload,
	type RobotCatalog,
	type RobotPlanDraft,
	type RobotPlanGenerationError,
	type RobotPlanSourceMapEntry,
	type RobotTaskPlan,
} from '@n8n/blockly-robot-skills';
import { z } from 'zod';

import { stableReference, type CompetitionDiagnostic } from './contracts';
import { COMPETITION_NODE_TYPES } from './node-types';
import { generateCompetitionWorkflow, type CompetitionWorkflowJSON } from './workflow-generator';
import { validateCompetitionWorkflow } from './workflow-policy';

export type CompetitionDesignDraft = {
	schemaVersion: '1.0';
	designId: string;
	revisionId: string;
	name: string;
	robotPlan: RobotPlanDraft;
};

export const competitionDesignDraftSchema = z
	.object({
		schemaVersion: z.literal('1.0'),
		designId: stableReference,
		revisionId: stableReference,
		name: z.string().trim().min(1).max(128),
		robotPlan: z.record(z.unknown()),
	})
	.strict();

export type CompetitionGenerationContext = {
	catalog: RobotCatalog;
	robotCredential: {
		id: string;
		name: string;
	};
};

export type CompetitionTraceMapEntry = RobotPlanSourceMapEntry & {
	intentStepId: string;
	n8nPlanNodeId: string;
	n8nExecutionNodeId: string;
};

export type CompetitionDesignArtifact = {
	schemaVersion: '1.0';
	designId: string;
	revisionId: string;
	catalogDigest: string;
	blocklyWorkspace: Record<string, unknown>;
	blocklyPayload: string;
	semanticDraft: RobotPlanDraft;
	robotPlan: RobotTaskPlan;
	n8nWorkflow: CompetitionWorkflowJSON;
	traceMap: CompetitionTraceMapEntry[];
};

export type CompetitionDesignGenerationResult =
	| { ok: true; artifact: CompetitionDesignArtifact }
	| {
			ok: false;
			stage: 'design-draft';
			diagnostics: CompetitionDiagnostic[];
	  }
	| {
			ok: false;
			stage: 'robot-plan';
			error: RobotPlanGenerationError;
	  }
	| {
			ok: false;
			stage: 'workflow-policy';
			diagnostics: CompetitionDiagnostic[];
	  };

/**
 * Compile one constrained semantic draft into both visual artifacts.
 *
 * The AI-facing draft is never copied into either canvas. The Blockly package
 * validates and recompiles the robot plan, while the workflow SDK creates the
 * outer orchestration graph. This keeps both diagrams deterministic and tied
 * together by stable source references.
 */
export function generateCompetitionDesign(
	draftInput: unknown,
	context: CompetitionGenerationContext,
): CompetitionDesignGenerationResult {
	const parsedDraft = competitionDesignDraftSchema.safeParse(draftInput);
	if (!parsedDraft.success) {
		return {
			ok: false,
			stage: 'design-draft',
			diagnostics: parsedDraft.error.issues.map((issue) => ({
				code: 'WORKFLOW_DRAFT_INVALID',
				severity: 'error',
				ref: issue.path.join('.'),
				message: issue.message,
			})),
		};
	}
	const draft = parsedDraft.data;
	const robotResult = generateRobotPlanWorkspace(draft.robotPlan, context.catalog, {
		designId: draft.designId,
	});
	if (!robotResult.ok) {
		return { ok: false, stage: 'robot-plan', error: robotResult.error };
	}

	const blocklyPayload = serializeRobotPlanPayload({
		catalog: context.catalog,
		workspace: robotResult.workspace,
	});
	const generatedWorkflow = generateCompetitionWorkflow({
		schemaVersion: draft.schemaVersion,
		designId: draft.designId,
		revisionId: draft.revisionId,
		name: draft.name,
		planRef: robotResult.normalizedDraft.planRef,
		blocklyPayload,
		robotCredential: context.robotCredential,
	});
	const diagnostics = validateCompetitionWorkflow(generatedWorkflow.workflow);
	const errors = diagnostics.filter((diagnostic) => diagnostic.severity === 'error');
	if (errors.length > 0) {
		return { ok: false, stage: 'workflow-policy', diagnostics };
	}

	const planNodeId = findNodeId(generatedWorkflow.workflow, COMPETITION_NODE_TYPES.robotSkillPlan);
	const executionNodeId = findNodeId(generatedWorkflow.workflow, COMPETITION_NODE_TYPES.robotTask);
	const traceMap = robotResult.sourceMap.map((entry) => ({
		...entry,
		intentStepId: entry.stepRef,
		n8nPlanNodeId: planNodeId,
		n8nExecutionNodeId: executionNodeId,
	}));

	return {
		ok: true,
		artifact: {
			schemaVersion: '1.0',
			designId: draft.designId,
			revisionId: draft.revisionId,
			catalogDigest: context.catalog.configDigest,
			blocklyWorkspace: robotResult.workspace,
			blocklyPayload,
			semanticDraft: robotResult.normalizedDraft,
			robotPlan: robotResult.plan,
			n8nWorkflow: generatedWorkflow.workflow,
			traceMap,
		},
	};
}

function findNodeId(workflow: CompetitionWorkflowJSON, nodeType: string): string {
	const candidate = workflow.nodes.find((node) => node.type === nodeType);
	if (candidate === undefined) {
		throw new Error(`generated workflow is missing required node type ${nodeType}`);
	}
	return candidate.id;
}
