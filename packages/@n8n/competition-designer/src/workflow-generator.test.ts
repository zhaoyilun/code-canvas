import { validateWorkflow } from '@n8n/workflow-sdk';
import { describe, expect, it } from 'vitest';

import { generateCompetitionWorkflow, type CompetitionWorkflowJSON } from './workflow-generator';
import { validateCompetitionWorkflow } from './workflow-policy';

type MutableCondition = {
	leftValue: unknown;
	rightValue?: unknown;
	operator: Record<string, unknown>;
};

type MutableConditionGroup = {
	combinator: unknown;
	conditions: MutableCondition[];
};

const draft = {
	schemaVersion: '1.0' as const,
	designId: 'lesson.pick-and-place',
	revisionId: 'revision.1',
	name: 'Pick and Place Lesson',
	planRef: 'plan.pick-and-place',
	blocklyPayload: '{"schemaVersion":2,"workspace":{}}',
	robotCredential: {
		id: 'credential-id',
		name: 'RoboFrame Classroom',
	},
};

describe('generateCompetitionWorkflow', () => {
	it('builds the reviewed Robot Skill Plan execution chain', () => {
		const generated = generateCompetitionWorkflow(draft);

		expect(generated.workflow.nodes.map((candidate) => candidate.type)).toEqual([
			'n8n-nodes-base.manualTrigger',
			'CUSTOM.robotStatus',
			'n8n-nodes-base.if',
			'CUSTOM.robotSkillPlan',
			'CUSTOM.robotValidate',
			'n8n-nodes-base.wait',
			'n8n-nodes-base.if',
			'n8n-nodes-base.merge',
			'CUSTOM.robotTask',
			'n8n-nodes-base.if',
			'n8n-nodes-base.noOp',
			'n8n-nodes-base.noOp',
			'n8n-nodes-base.noOp',
			'n8n-nodes-base.noOp',
		]);
		expect(validateCompetitionWorkflow(generated.workflow)).toEqual([]);
		expect(validateWorkflow(generated.workflow).errors).toEqual([]);
		const approval = generated.workflow.nodes.find(
			(candidate) => candidate.type === 'n8n-nodes-base.wait',
		);
		expect(approval?.parameters).toMatchObject({
			resume: 'form',
			incomingAuthentication: 'none',
		});
		expect(approval?.parameters).not.toHaveProperty('limitWaitTime');
		expect(generated.workflow.connections['03 Robot Ready?']?.main).toHaveLength(2);
		expect(generated.workflow.connections['07 Approved?']?.main[1]).toHaveLength(1);
		expect(generated.workflow.connections['10 Task Completed?']?.main).toHaveLength(2);
		expect(generated.meta).toEqual({
			schemaVersion: '1.0',
			designId: draft.designId,
			revisionId: draft.revisionId,
			planRef: draft.planRef,
			reviewState: 'review_required',
		});
	});

	it('keeps node IDs stable for the same design', () => {
		const first = generateCompetitionWorkflow(draft);
		const second = generateCompetitionWorkflow(draft);

		expect(first.workflow.nodes.map((candidate) => candidate.id)).toEqual(
			second.workflow.nodes.map((candidate) => candidate.id),
		);
	});

	it('rejects a task graph after the approval node is removed', () => {
		const generated = generateCompetitionWorkflow(draft);
		const approval = generated.workflow.nodes.find(
			(candidate) => candidate.type === 'n8n-nodes-base.wait',
		);
		expect(approval).toBeDefined();
		if (!approval) return;

		generated.workflow.nodes = generated.workflow.nodes.filter(
			(candidate) => candidate.id !== approval.id,
		);
		generated.workflow.connections = Object.fromEntries(
			Object.entries(generated.workflow.connections).filter(([name]) => name !== approval.name),
		);

		expect(validateCompetitionWorkflow(generated.workflow)).toContainEqual(
			expect.objectContaining({ code: 'MOTION_REVIEW_PATH_MISSING' }),
		);
	});

	it('rejects an approval gate that releases automatically', () => {
		const generated = generateCompetitionWorkflow(draft);
		const approval = generated.workflow.nodes.find(
			(candidate) => candidate.type === 'n8n-nodes-base.wait',
		);
		expect(approval).toBeDefined();
		if (!approval) return;
		approval.parameters = { ...approval.parameters, limitWaitTime: true };

		expect(validateCompetitionWorkflow(generated.workflow)).toContainEqual(
			expect.objectContaining({ code: 'MOTION_REVIEW_PATH_INVALID' }),
		);
	});

	it('rejects action-only validation and a missing rejection branch', () => {
		const generated = generateCompetitionWorkflow(draft);
		const validate = generated.workflow.nodes.find(
			(candidate) => candidate.type === 'CUSTOM.robotValidate',
		);
		expect(validate).toBeDefined();
		if (!validate) return;
		validate.parameters = { operation: 'action' };
		const approvalConnections = generated.workflow.connections['07 Approved?'];
		expect(approvalConnections).toBeDefined();
		if (!approvalConnections) return;
		approvalConnections.main[1] = [];

		const diagnostics = validateCompetitionWorkflow(generated.workflow);
		expect(diagnostics).toContainEqual(
			expect.objectContaining({ code: 'ROBOT_VALIDATION_MODE_INVALID' }),
		);
		expect(diagnostics).toContainEqual(
			expect.objectContaining({ code: 'APPROVAL_DECISION_MISSING' }),
		);
	});

	it.each([
		[
			'busy=true',
			(group: MutableConditionGroup) => {
				const busy = group.conditions.find(
					(condition) => condition.leftValue === '={{ $json.busy }}',
				);
				if (busy === undefined) throw new Error('generated readiness condition is missing busy');
				busy.operator.operation = 'true';
			},
		],
		[
			'OR combinator',
			(group: MutableConditionGroup) => {
				group.combinator = 'or';
			},
		],
	])('rejects a tampered readiness gate: %s', (_name, mutate) => {
		const generated = generateCompetitionWorkflow(draft);
		mutate(mutableConditions(generated.workflow, '03 Robot Ready?'));

		expect(validateCompetitionWorkflow(generated.workflow)).toContainEqual({
			code: 'ROBOT_READINESS_CONDITION_INVALID',
			severity: 'error',
			ref: '03 Robot Ready?',
			message:
				'Robot readiness must require motionAuthorized=true and busy=false with an AND condition.',
		});
	});

	it.each([
		[
			'Reject decision',
			(group: MutableConditionGroup) => {
				const approval = group.conditions[0];
				if (approval === undefined) throw new Error('generated approval condition is missing');
				approval.rightValue = 'Reject';
			},
		],
		[
			'OR combinator',
			(group: MutableConditionGroup) => {
				group.combinator = 'or';
			},
		],
	])('rejects a tampered approval gate: %s', (_name, mutate) => {
		const generated = generateCompetitionWorkflow(draft);
		mutate(mutableConditions(generated.workflow, '07 Approved?'));

		expect(validateCompetitionWorkflow(generated.workflow)).toContainEqual({
			code: 'APPROVAL_DECISION_INVALID',
			severity: 'error',
			ref: '07 Approved?',
			message:
				'Human approval must require Approval Decision to equal Approve with an AND condition.',
		});
	});
});

function mutableConditions(
	workflow: CompetitionWorkflowJSON,
	nodeName: string,
): MutableConditionGroup {
	const node = workflow.nodes.find((candidate) => candidate.name === nodeName);
	if (node === undefined) throw new Error(`generated workflow is missing ${nodeName}`);
	const group: unknown = node.parameters?.conditions;
	if (typeof group !== 'object' || group === null || !('conditions' in group)) {
		throw new Error(`generated workflow node ${nodeName} has no conditions`);
	}
	return group as MutableConditionGroup;
}
