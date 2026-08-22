import { node, trigger, workflow, type WorkflowJSON } from '@n8n/workflow-sdk';

import {
	competitionWorkflowDraftSchema,
	type CompetitionDesignMeta,
	type CompetitionWorkflowDraft,
} from './contracts';
import { COMPETITION_NODE_TYPES } from './node-types';
import { stableCompetitionId } from './stable-ids';

export type GeneratedCompetitionWorkflow = {
	workflow: CompetitionWorkflowJSON;
	meta: CompetitionDesignMeta;
};

export type CompetitionWorkflowJSON = Omit<WorkflowJSON, 'meta'> & {
	meta: NonNullable<WorkflowJSON['meta']> & {
		competitionDesign: CompetitionDesignMeta;
	};
};

export function generateCompetitionWorkflow(
	input: CompetitionWorkflowDraft,
): GeneratedCompetitionWorkflow {
	const draft = competitionWorkflowDraftSchema.parse(input);
	const credential = {
		robframeBridgeApi: {
			id: draft.robotCredential.id,
			name: draft.robotCredential.name,
		},
	};

	const start = trigger({
		type: COMPETITION_NODE_TYPES.manualTrigger,
		version: 1,
		config: {
			name: '01 Start',
			parameters: {},
		},
	});
	const logicNodes = draft.logicNodes.map((logicNode, index) =>
		node({
			type: COMPETITION_NODE_TYPES.blocklyCode,
			version: 1,
			config: {
				name: `01.${index + 1} Blockly Logic · ${logicNode.label}`,
				parameters: { blocklyPayload: logicNode.blocklyPayload },
			},
		}),
	);
	const status = node({
		type: COMPETITION_NODE_TYPES.robotStatus,
		version: 1,
		config: {
			name: '02 Robot Status',
			parameters: {},
			credentials: credential,
		},
	});
	const ready = node({
		type: COMPETITION_NODE_TYPES.if,
		version: 2.2,
		config: {
			name: '03 Robot Ready?',
			parameters: {
				conditions: {
					options: { caseSensitive: true, leftValue: '', typeValidation: 'strict' },
					conditions: [
						{
							id: stableCompetitionId(draft.designId, 'condition:motion-authorized'),
							leftValue: '={{ $json.motionAuthorized }}',
							operator: { type: 'boolean', operation: 'true' },
						},
						{
							id: stableCompetitionId(draft.designId, 'condition:robot-idle'),
							leftValue: '={{ $json.busy }}',
							operator: { type: 'boolean', operation: 'false' },
						},
					],
					combinator: 'and',
				},
				options: {},
			},
		},
	});
	const plan = node({
		type: COMPETITION_NODE_TYPES.robotSkillPlan,
		version: 1,
		config: {
			name: `04 Robot Plan · ${draft.planRef}`,
			parameters: {
				blocklyPayload: draft.blocklyPayload,
			},
		},
	});
	const validate = node({
		type: COMPETITION_NODE_TYPES.robotValidate,
		version: 1,
		config: {
			name: '05 Validate Plan',
			parameters: {
				operation: 'plan',
			},
			credentials: credential,
		},
	});
	const approval = node({
		type: COMPETITION_NODE_TYPES.wait,
		version: 1.1,
		config: {
			name: '06 Human Approval',
			webhookId: stableCompetitionId(draft.designId, 'approval-webhook'),
			parameters: {
				resume: 'form',
				incomingAuthentication: 'none',
				responseMode: 'onReceived',
				formTitle: 'Review Robot Plan',
				formDescription: 'Choose Approve only after reviewing the Blockly plan and validation.',
				formFields: {
					values: [
						{
							fieldLabel: 'Approval Decision',
							fieldType: 'radio',
							fieldOptions: {
								values: [{ option: 'Approve' }, { option: 'Reject' }],
							},
							requiredField: true,
						},
					],
				},
				options: {},
			},
		},
	});
	const approvalDecision = node({
		type: COMPETITION_NODE_TYPES.if,
		version: 2.2,
		config: {
			name: '07 Approved?',
			parameters: {
				conditions: {
					options: { caseSensitive: true, leftValue: '', typeValidation: 'strict' },
					conditions: [
						{
							id: stableCompetitionId(draft.designId, 'condition:approval'),
							leftValue: '={{ $json["Approval Decision"] }}',
							rightValue: 'Approve',
							operator: { type: 'string', operation: 'equals' },
						},
					],
					combinator: 'and',
				},
				options: {},
			},
		},
	});
	const mergeApprovedPlan = node({
		type: COMPETITION_NODE_TYPES.merge,
		version: 3.2,
		config: {
			name: '08 Merge Approved Plan',
			parameters: {
				mode: 'combine',
				combineBy: 'combineByPosition',
				options: {},
			},
		},
	});
	const task = node({
		type: COMPETITION_NODE_TYPES.robotTask,
		version: 1,
		config: {
			name: '09 Execute Robot Plan',
			parameters: {},
			credentials: credential,
		},
	});
	const taskCompleted = node({
		type: COMPETITION_NODE_TYPES.if,
		version: 2.2,
		config: {
			name: '10 Task Completed?',
			parameters: {
				conditions: {
					options: { caseSensitive: true, leftValue: '', typeValidation: 'strict' },
					conditions: [
						{
							id: stableCompetitionId(draft.designId, 'condition:task-completed'),
							leftValue: '={{ $json.finalStatus }}',
							rightValue: 'completed',
							operator: { type: 'string', operation: 'equals' },
						},
					],
					combinator: 'and',
				},
				options: {},
			},
		},
	});
	const completed = terminalNode('11 Completed', 'Robot task completed.');
	const needsInspection = terminalNode(
		'12 Needs Inspection',
		'Robot task ended failed, canceled, or unknown. Inspect the structured result.',
	);
	const rejected = terminalNode('13 Rejected', 'The reviewer rejected this robot plan.');
	const notReady = terminalNode(
		'14 Robot Not Ready',
		'Robot motion is not authorized or another task is active.',
	);

	if (logicNodes.length === 0) {
		start.to(status);
	} else {
		start.to(logicNodes[0]);
		for (let index = 0; index < logicNodes.length - 1; index += 1) {
			logicNodes[index].to(logicNodes[index + 1]);
		}
		logicNodes[logicNodes.length - 1].to(status);
	}
	status.to(ready);
	ready.to(plan, 0);
	ready.to(notReady, 1);
	plan.to(validate);
	validate.to(approval);
	validate.to(mergeApprovedPlan.input(0));
	approval.to(approvalDecision);
	approvalDecision.to(mergeApprovedPlan.input(1), 0);
	approvalDecision.to(rejected, 1);
	mergeApprovedPlan.to(task).to(taskCompleted);
	taskCompleted.to(completed, 0);
	taskCompleted.to(needsInspection, 1);

	const builder = workflow(draft.designId, draft.name).add(start);
	for (const logicNode of logicNodes) builder.add(logicNode);
	builder
		.add(status)
		.add(ready)
		.add(plan)
		.add(validate)
		.add(approval)
		.add(approvalDecision)
		.add(mergeApprovedPlan)
		.add(task)
		.add(taskCompleted)
		.add(completed)
		.add(needsInspection)
		.add(rejected)
		.add(notReady);
	const generatedJson = builder.toJSON({ tidyUp: true });
	const logicNodeRefByName = new Map(
		draft.logicNodes.map((logicNode, index) => [logicNodes[index].name, logicNode.nodeRef]),
	);
	const json: WorkflowJSON = {
		...generatedJson,
		nodes: generatedJson.nodes.map((candidate) => ({
			...candidate,
			id: stableCompetitionId(
				draft.designId,
				logicNodeRefByName.has(candidate.name ?? '')
					? `node:logic:${logicNodeRefByName.get(candidate.name ?? '')}`
					: `node:${candidate.name ?? candidate.type}`,
			),
		})),
	};
	const meta: CompetitionDesignMeta = {
		schemaVersion: '2.0',
		designId: draft.designId,
		revisionId: draft.revisionId,
		planRef: draft.planRef,
		reviewState: 'review_required',
	};

	const competitionWorkflow: CompetitionWorkflowJSON = {
		...json,
		meta: {
			...json.meta,
			competitionDesign: meta,
		},
	};

	return {
		workflow: competitionWorkflow,
		meta,
	};
}

function terminalNode(name: string, notes: string) {
	return node({
		type: COMPETITION_NODE_TYPES.noOp,
		version: 1,
		config: {
			name,
			parameters: {},
			notes,
			notesInFlow: true,
		},
	});
}
