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
import {
	blocklyLogicNodeDraftSchema,
	generateBlocklyLogicNode,
	type BlocklyLogicGenerationError,
	type BlocklyLogicNodeDraft,
	type BlocklyLogicSourceMapEntry,
	type GeneratedBlocklyLogicNode,
} from './logic-generator';
import { COMPETITION_NODE_TYPES } from './node-types';
import { stableCompetitionId } from './stable-ids';
import { generateCompetitionWorkflow, type CompetitionWorkflowJSON } from './workflow-generator';
import { validateCompetitionWorkflow } from './workflow-policy';

export type CompetitionDesignDraft = {
	schemaVersion: '2.0';
	designId: string;
	revisionId: string;
	name: string;
	logicNodes: BlocklyLogicNodeDraft[];
	robotPlan: RobotPlanDraft;
};

export const competitionDesignDraftSchema = z
	.object({
		schemaVersion: z.literal('2.0'),
		designId: stableReference,
		revisionId: stableReference,
		name: z.string().trim().min(1).max(128),
		logicNodes: z.array(blocklyLogicNodeDraftSchema).max(32),
		robotPlan: z.record(z.unknown()),
	})
	.strict()
	.superRefine((draft, context) => {
		const nodeRefs = new Set<string>();
		const intentStepIds = new Set<string>();
		for (const [nodeIndex, logicNode] of draft.logicNodes.entries()) {
			if (nodeRefs.has(logicNode.nodeRef)) {
				context.addIssue({
					code: 'custom',
					path: ['logicNodes', nodeIndex, 'nodeRef'],
					message: `duplicate nodeRef "${logicNode.nodeRef}"`,
				});
			}
			nodeRefs.add(logicNode.nodeRef);
			for (const [statementIndex, statement] of logicNode.statements.entries()) {
				if (intentStepIds.has(statement.intentStepId)) {
					context.addIssue({
						code: 'custom',
						path: ['logicNodes', nodeIndex, 'statements', statementIndex, 'intentStepId'],
						message: `duplicate intentStepId "${statement.intentStepId}"`,
					});
				}
				intentStepIds.add(statement.intentStepId);
			}
		}
	});

export type CompetitionGenerationContext = {
	catalog: RobotCatalog;
	robotCredential: {
		id: string;
		name: string;
	};
};

export type CompetitionRobotTraceMapEntry = RobotPlanSourceMapEntry & {
	surface: 'robotPlan';
	intentStepId: string;
	n8nNodeId: string;
	n8nExecutionNodeId: string;
};

export type CompetitionLogicTraceMapEntry = BlocklyLogicSourceMapEntry & {
	surface: 'blocklyLogic';
	n8nNodeId: string;
};

export type CompetitionTraceMapEntry =
	| CompetitionRobotTraceMapEntry
	| CompetitionLogicTraceMapEntry;

export type CompetitionLogicNodeArtifact = GeneratedBlocklyLogicNode & {
	n8nNodeId: string;
};

export type CompetitionDesignArtifact = {
	schemaVersion: '2.0';
	designId: string;
	revisionId: string;
	catalogDigest: string;
	logicNodes: CompetitionLogicNodeArtifact[];
	blocklyWorkspace: Record<string, unknown>;
	blocklyPayload: string;
	semanticDraft: CompetitionDesignDraft;
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
			stage: 'blockly-logic';
			logicNodeRef: string;
			error: BlocklyLogicGenerationError;
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
 * Compile one constrained semantic draft into the n8n macro graph and both
 * embedded Blockly surfaces. Local data logic becomes CUSTOM.blocklyCode;
 * physical robot detail remains inside CUSTOM.robotSkillPlan.
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
	const generatedLogicNodes: GeneratedBlocklyLogicNode[] = [];
	for (const logicNodeDraft of draft.logicNodes) {
		const logicResult = generateBlocklyLogicNode(logicNodeDraft, draft.designId);
		if (!logicResult.ok) {
			return {
				ok: false,
				stage: 'blockly-logic',
				logicNodeRef: logicNodeDraft.nodeRef,
				error: logicResult.error,
			};
		}
		generatedLogicNodes.push(logicResult.generated);
	}

	const robotResult = generateRobotPlanWorkspace(draft.robotPlan, context.catalog, {
		designId: draft.designId,
	});
	if (!robotResult.ok) {
		return { ok: false, stage: 'robot-plan', error: robotResult.error };
	}
	const duplicateIntentId = findDuplicateIntentStepId(generatedLogicNodes, robotResult.sourceMap);
	if (duplicateIntentId !== null) {
		return {
			ok: false,
			stage: 'design-draft',
			diagnostics: [
				{
					code: 'WORKFLOW_DRAFT_INVALID',
					severity: 'error',
					ref: duplicateIntentId,
					message: `intentStepId "${duplicateIntentId}" must be unique across logic and robot steps`,
				},
			],
		};
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
		logicNodes: generatedLogicNodes.map(({ nodeRef, label, blocklyPayload: payload }) => ({
			nodeRef,
			label,
			blocklyPayload: payload,
		})),
		robotCredential: context.robotCredential,
	});
	const diagnostics = validateCompetitionWorkflow(generatedWorkflow.workflow);
	const errors = diagnostics.filter((diagnostic) => diagnostic.severity === 'error');
	if (errors.length > 0) {
		return { ok: false, stage: 'workflow-policy', diagnostics };
	}

	const planNodeId = findNodeId(generatedWorkflow.workflow, COMPETITION_NODE_TYPES.robotSkillPlan);
	const executionNodeId = findNodeId(generatedWorkflow.workflow, COMPETITION_NODE_TYPES.robotTask);
	const logicNodeArtifacts: CompetitionLogicNodeArtifact[] = generatedLogicNodes.map(
		(logicNode) => ({
			...logicNode,
			n8nNodeId: expectedLogicNodeId(draft.designId, logicNode.nodeRef),
		}),
	);
	const logicTraceMap: CompetitionLogicTraceMapEntry[] = logicNodeArtifacts.flatMap((logicNode) =>
		logicNode.sourceMap.map((entry) => ({
			...entry,
			surface: 'blocklyLogic',
			n8nNodeId: logicNode.n8nNodeId,
		})),
	);
	const robotTraceMap: CompetitionRobotTraceMapEntry[] = robotResult.sourceMap.map((entry) => ({
		...entry,
		surface: 'robotPlan',
		intentStepId: entry.stepRef,
		n8nNodeId: planNodeId,
		n8nExecutionNodeId: executionNodeId,
	}));

	return {
		ok: true,
		artifact: {
			schemaVersion: '2.0',
			designId: draft.designId,
			revisionId: draft.revisionId,
			catalogDigest: context.catalog.configDigest,
			logicNodes: logicNodeArtifacts,
			blocklyWorkspace: robotResult.workspace,
			blocklyPayload,
			semanticDraft: {
				...draft,
				logicNodes: [...draft.logicNodes],
				robotPlan: robotResult.normalizedDraft,
			},
			robotPlan: robotResult.plan,
			n8nWorkflow: generatedWorkflow.workflow,
			traceMap: [...logicTraceMap, ...robotTraceMap],
		},
	};
}

function expectedLogicNodeId(designId: string, nodeRef: string): string {
	return stableCompetitionId(designId, `node:logic:${nodeRef}`);
}

function findDuplicateIntentStepId(
	logicNodes: GeneratedBlocklyLogicNode[],
	robotEntries: RobotPlanSourceMapEntry[],
): string | null {
	const ids = new Set<string>();
	for (const entry of logicNodes.flatMap((node) => node.sourceMap)) {
		if (ids.has(entry.intentStepId)) return entry.intentStepId;
		ids.add(entry.intentStepId);
	}
	for (const entry of robotEntries) {
		if (ids.has(entry.stepRef)) return entry.stepRef;
		ids.add(entry.stepRef);
	}
	return null;
}

function findNodeId(workflow: CompetitionWorkflowJSON, nodeType: string): string {
	const candidate = workflow.nodes.find((node) => node.type === nodeType);
	if (candidate === undefined) {
		throw new Error(`generated workflow is missing required node type ${nodeType}`);
	}
	return candidate.id;
}
