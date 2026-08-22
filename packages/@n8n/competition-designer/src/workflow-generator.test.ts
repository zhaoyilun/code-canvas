import { createDefaultWorkspace, serializeBlocklyDataPayload } from '@n8n/blockly-data-transform';
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

type MutableApprovalField = {
	fieldLabel: unknown;
	fieldType: unknown;
	requiredField: unknown;
	fieldOptions: { values: Array<{ option: unknown }> };
};

const draft = {
	schemaVersion: '2.0' as const,
	designId: 'lesson.pick-and-place',
	revisionId: 'revision.1',
	name: 'Pick and Place Lesson',
	planRef: 'plan.pick-and-place',
	blocklyPayload: '{"schemaVersion":2,"workspace":{}}',
	logicNodes: [
		{
			nodeRef: 'normalize-input',
			label: 'Normalize Input',
			blocklyPayload: serializeBlocklyDataPayload(createDefaultWorkspace()),
		},
	],
	robotCredential: {
		id: 'credential-id',
		name: 'RoboFrame Classroom',
	},
};

describe('generateCompetitionWorkflow', () => {
	it('builds the reviewed Robot Plan execution chain', () => {
		const generated = generateCompetitionWorkflow(draft);

		expect(generated.workflow.nodes.map((candidate) => candidate.type)).toEqual([
			'n8n-nodes-base.manualTrigger',
			'CUSTOM.blocklyCode',
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
			schemaVersion: '2.0',
			designId: draft.designId,
			revisionId: draft.revisionId,
			planRef: draft.planRef,
			reviewState: 'review_required',
		});
	});

	it('rejects malformed Blockly Logic payloads and arbitrary Code nodes', () => {
		const generated = generateCompetitionWorkflow(draft);
		const logicNode = generated.workflow.nodes.find(
			(candidate) => candidate.type === 'CUSTOM.blocklyCode',
		);
		expect(logicNode).toBeDefined();
		if (logicNode === undefined) return;
		logicNode.parameters = {
			blocklyPayload: JSON.stringify({
				schemaVersion: 2,
				workspace: { blocks: { languageVersion: 0, blocks: [] } },
				javascript: '',
			}),
		};
		generated.workflow.nodes.push({
			id: 'code-node',
			name: 'Arbitrary Code',
			type: 'n8n-nodes-base.code',
			typeVersion: 2,
			position: [0, 0],
			parameters: { jsCode: 'return items' },
		});

		const diagnostics = validateCompetitionWorkflow(generated.workflow);
		expect(diagnostics).toContainEqual(
			expect.objectContaining({ code: 'BLOCKLY_LOGIC_PAYLOAD_INVALID' }),
		);
		expect(diagnostics).toContainEqual(
			expect.objectContaining({ code: 'ARBITRARY_CODE_NODE_FORBIDDEN' }),
		);
	});

	it('keeps node IDs stable for the same design', () => {
		const first = generateCompetitionWorkflow(draft);
		const second = generateCompetitionWorkflow(draft);

		expect(first.workflow.nodes.map((candidate) => candidate.id)).toEqual(
			second.workflow.nodes.map((candidate) => candidate.id),
		);
	});

	it('allows an empty logic list and connects Start directly to Robot Status', () => {
		const generated = generateCompetitionWorkflow({ ...draft, logicNodes: [] });

		expect(generated.workflow.nodes).not.toContainEqual(
			expect.objectContaining({ type: 'CUSTOM.blocklyCode' }),
		);
		expect(generated.workflow.connections['01 Start']?.main[0]?.[0]?.node).toBe('02 Robot Status');
		expect(validateCompetitionWorkflow(generated.workflow)).toEqual([]);
	});

	it('rejects duplicate Blockly Logic node references before graph generation', () => {
		expect(() =>
			generateCompetitionWorkflow({
				...draft,
				logicNodes: [draft.logicNodes[0], { ...draft.logicNodes[0], label: 'Second' }],
			}),
		).toThrow('duplicate nodeRef');
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

	it('rejects a readiness false-output path that reaches Robot Plan and Robot Task', () => {
		const generated = generateCompetitionWorkflow(draft);
		const readiness = generated.workflow.connections['03 Robot Ready?'];
		expect(readiness).toBeDefined();
		const planConnection = readiness?.main[0]?.[0];
		expect(planConnection).toBeDefined();
		if (readiness === undefined || planConnection === undefined) return;
		readiness.main[1]?.push({ ...planConnection });

		expect(validateCompetitionWorkflow(generated.workflow)).toContainEqual({
			code: 'ROBOT_READINESS_BRANCH_MISSING',
			severity: 'error',
			ref: '09 Execute Robot Plan',
			message:
				'Robot readiness true output must pass through Robot Plan before Robot Task, and its false output must reach neither.',
		});
	});

	it('rejects an approval false-output path that reaches Merge and Robot Task', () => {
		const generated = generateCompetitionWorkflow(draft);
		const approval = generated.workflow.connections['07 Approved?'];
		expect(approval).toBeDefined();
		const mergeConnection = approval?.main[0]?.[0];
		expect(mergeConnection).toBeDefined();
		if (approval === undefined || mergeConnection === undefined) return;
		approval.main[1]?.push({ ...mergeConnection });

		expect(validateCompetitionWorkflow(generated.workflow)).toContainEqual({
			code: 'MOTION_REVIEW_PATH_INVALID',
			severity: 'error',
			ref: '09 Execute Robot Plan',
			message:
				'Robot Validate must enter Merge input 0 and only the approval true output may enter Merge input 1 and reach Robot Task.',
		});
	});

	it.each([
		[
			'optional decision',
			(field: MutableApprovalField) => {
				field.requiredField = false;
			},
		],
		[
			'non-radio decision',
			(field: MutableApprovalField) => {
				field.fieldType = 'text';
			},
		],
		[
			'missing Reject option',
			(field: MutableApprovalField) => {
				field.fieldOptions.values = [{ option: 'Approve' }];
			},
		],
	])('rejects a tampered approval form: %s', (_name, mutate) => {
		const generated = generateCompetitionWorkflow(draft);
		mutate(mutableApprovalField(generated.workflow));

		expect(validateCompetitionWorkflow(generated.workflow)).toContainEqual({
			code: 'MOTION_REVIEW_PATH_INVALID',
			severity: 'error',
			ref: '06 Human Approval',
			message:
				'Human approval requires a non-expiring form with one required Approval Decision radio field containing exactly Approve and Reject.',
		});
	});

	it.each([
		[
			'Robot Validate uses Merge input 1',
			(workflow: CompetitionWorkflowJSON) => {
				const connection = workflow.connections['05 Validate Plan']?.main[0]?.find(
					(candidate) => candidate.node === '08 Merge Approved Plan',
				);
				if (connection === undefined) throw new Error('generated validation merge edge is missing');
				connection.index = 1;
			},
		],
		[
			'approval true uses Merge input 0',
			(workflow: CompetitionWorkflowJSON) => {
				const connection = workflow.connections['07 Approved?']?.main[0]?.find(
					(candidate) => candidate.node === '08 Merge Approved Plan',
				);
				if (connection === undefined) throw new Error('generated approval merge edge is missing');
				connection.index = 0;
			},
		],
	])('rejects invalid review merge wiring: %s', (_name, mutate) => {
		const generated = generateCompetitionWorkflow(draft);
		mutate(generated.workflow);

		expect(validateCompetitionWorkflow(generated.workflow)).toContainEqual({
			code: 'MOTION_REVIEW_PATH_INVALID',
			severity: 'error',
			ref: '09 Execute Robot Plan',
			message:
				'Robot Validate must enter Merge input 0 and only the approval true output may enter Merge input 1 and reach Robot Task.',
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

function mutableApprovalField(workflow: CompetitionWorkflowJSON): MutableApprovalField {
	const node = workflow.nodes.find((candidate) => candidate.name === '06 Human Approval');
	if (node === undefined) throw new Error('generated workflow is missing 06 Human Approval');
	const formFields: unknown = node.parameters?.formFields;
	if (
		typeof formFields !== 'object' ||
		formFields === null ||
		!('values' in formFields) ||
		!Array.isArray(formFields.values)
	) {
		throw new Error('generated approval node has no form fields');
	}
	const fields = formFields.values as unknown[];
	const field = fields.find(
		(candidate: unknown) =>
			typeof candidate === 'object' &&
			candidate !== null &&
			'fieldLabel' in candidate &&
			candidate.fieldLabel === 'Approval Decision',
	);
	if (field === undefined) throw new Error('generated approval decision field is missing');
	return field as MutableApprovalField;
}
