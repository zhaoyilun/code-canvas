import type { WorkflowJSON } from '@n8n/workflow-sdk';
import type { IConnections } from 'n8n-workflow';
import { getParentNodes, mapConnectionsByDestination, NodeConnectionTypes } from 'n8n-workflow';

import type { CompetitionDiagnostic } from './contracts';
import { COMPETITION_NODE_TYPES, ROBOT_BRIDGE_PATH_PATTERN } from './node-types';

function nodeTypeByName(workflow: WorkflowJSON): Map<string, string> {
	return new Map(
		workflow.nodes
			.filter((candidate) => candidate.name !== undefined)
			.map((candidate) => [candidate.name ?? candidate.id, candidate.type]),
	);
}

function parentTypes(workflow: WorkflowJSON, nodeName: string): Set<string> {
	const typesByName = nodeTypeByName(workflow);
	return new Set(
		parentNames(workflow, nodeName)
			.map((name) => typesByName.get(name))
			.filter((type): type is string => type !== undefined),
	);
}

function parentNames(workflow: WorkflowJSON, nodeName: string): string[] {
	const connectionsByDestination = mapConnectionsByDestination(runtimeMainConnections(workflow));
	return getParentNodes(connectionsByDestination, nodeName);
}

function runtimeMainConnections(workflow: WorkflowJSON): IConnections {
	const result: IConnections = {};
	for (const [sourceName, nodeConnections] of Object.entries(workflow.connections)) {
		const mainOutputs = nodeConnections.main;
		if (mainOutputs === undefined) continue;
		result[sourceName] = {
			[NodeConnectionTypes.Main]: mainOutputs.map((output) =>
				output === null
					? null
					: output.map((connection) => ({
							node: connection.node,
							type: NodeConnectionTypes.Main,
							index: connection.index,
						})),
			),
		};
	}
	return result;
}

function parametersOf(node: WorkflowJSON['nodes'][number]): Record<string, unknown> {
	return node.parameters ?? {};
}

export function validateCompetitionWorkflow(workflow: WorkflowJSON): CompetitionDiagnostic[] {
	const diagnostics: CompetitionDiagnostic[] = [];
	const robotTasks = workflow.nodes.filter(
		(candidate) => candidate.type === COMPETITION_NODE_TYPES.robotTask,
	);

	for (const task of robotTasks) {
		const taskName = task.name ?? task.id;
		const taskParents = new Set(parentNames(workflow, taskName));
		const parents = parentTypes(workflow, taskName);
		if (!parents.has(COMPETITION_NODE_TYPES.robotSkillPlan)) {
			diagnostics.push({
				code: 'ROBOT_PLAN_BINDING_MISSING',
				severity: 'error',
				ref: taskName,
				message: 'Robot Task requires an upstream Robot Skill Plan.',
			});
		}
		const statusNodes = workflow.nodes.filter(
			(candidate) =>
				candidate.type === COMPETITION_NODE_TYPES.robotStatus &&
				taskParents.has(candidate.name ?? candidate.id),
		);
		const readinessDecisions = statusNodes.flatMap((status) =>
			directChildren(workflow, status.name ?? status.id).flatMap((childName) => {
				if (!taskParents.has(childName)) return [];
				const child = workflow.nodes.find(
					(candidate) => (candidate.name ?? candidate.id) === childName,
				);
				return child?.type === COMPETITION_NODE_TYPES.if ? [child] : [];
			}),
		);
		const readinessBranchExists = readinessDecisions.some((candidate) =>
			hasFalseBranch(workflow, candidate.name ?? candidate.id),
		);
		const validReadinessDecision = readinessDecisions.find(
			(candidate) =>
				hasFalseBranch(workflow, candidate.name ?? candidate.id) &&
				hasExactReadinessConditions(candidate),
		);
		if (!readinessBranchExists) {
			diagnostics.push({
				code: 'ROBOT_READINESS_BRANCH_MISSING',
				severity: 'error',
				ref: taskName,
				message: 'Robot Status requires ready and not-ready branches before plan compilation.',
			});
		} else if (validReadinessDecision === undefined) {
			const readinessDecision = readinessDecisions.find((candidate) =>
				hasFalseBranch(workflow, candidate.name ?? candidate.id),
			);
			diagnostics.push({
				code: 'ROBOT_READINESS_CONDITION_INVALID',
				severity: 'error',
				ref: readinessDecision?.name ?? readinessDecision?.id ?? taskName,
				message:
					'Robot readiness must require motionAuthorized=true and busy=false with an AND condition.',
			});
		}
		if (
			!parents.has(COMPETITION_NODE_TYPES.robotStatus) ||
			!parents.has(COMPETITION_NODE_TYPES.robotValidate) ||
			!parents.has(COMPETITION_NODE_TYPES.wait) ||
			!parents.has(COMPETITION_NODE_TYPES.merge)
		) {
			diagnostics.push({
				code: 'MOTION_REVIEW_PATH_MISSING',
				severity: 'error',
				ref: taskName,
				message:
					'Robot Task requires status, plan validation, approval, and plan/form merge upstream.',
			});
		}
		const approvalNodes = workflow.nodes.filter(
			(candidate) =>
				candidate.type === COMPETITION_NODE_TYPES.wait &&
				taskParents.has(candidate.name ?? candidate.id),
		);
		for (const approval of approvalNodes) {
			const parameters = parametersOf(approval);
			if (parameters.resume !== 'form' || parameters.limitWaitTime === true) {
				diagnostics.push({
					code: 'MOTION_REVIEW_PATH_INVALID',
					severity: 'error',
					ref: approval.name ?? approval.id,
					message: 'Human approval uses an explicit decision form without auto-release.',
				});
			}
		}
		const approvalDecisions = workflow.nodes.filter(
			(candidate) =>
				candidate.type === COMPETITION_NODE_TYPES.if &&
				taskParents.has(candidate.name ?? candidate.id) &&
				approvalNodes.some((approval) =>
					directChildren(workflow, approval.name ?? approval.id).includes(
						candidate.name ?? candidate.id,
					),
				),
		);
		const approvalBranchExists = approvalDecisions.some((candidate) =>
			hasFalseBranch(workflow, candidate.name ?? candidate.id),
		);
		const validApprovalDecision = approvalDecisions.find(
			(candidate) =>
				hasFalseBranch(workflow, candidate.name ?? candidate.id) &&
				hasExactApprovalCondition(candidate),
		);
		if (!approvalBranchExists) {
			diagnostics.push({
				code: 'APPROVAL_DECISION_MISSING',
				severity: 'error',
				ref: taskName,
				message: 'Human approval requires separate approved and rejected branches.',
			});
		} else if (validApprovalDecision === undefined) {
			const approvalDecision = approvalDecisions.find((candidate) =>
				hasFalseBranch(workflow, candidate.name ?? candidate.id),
			);
			diagnostics.push({
				code: 'APPROVAL_DECISION_INVALID',
				severity: 'error',
				ref: approvalDecision?.name ?? approvalDecision?.id ?? taskName,
				message:
					'Human approval must require Approval Decision to equal Approve with an AND condition.',
			});
		}
		const taskOutputs = workflow.connections[taskName]?.main ?? [];
		const resultDecisionName = taskOutputs[0]?.[0]?.node;
		const resultDecision = workflow.nodes.find(
			(candidate) =>
				(candidate.name ?? candidate.id) === resultDecisionName &&
				candidate.type === COMPETITION_NODE_TYPES.if,
		);
		if (
			resultDecision === undefined ||
			!hasFalseBranch(workflow, resultDecision.name ?? resultDecision.id)
		) {
			diagnostics.push({
				code: 'TASK_RESULT_BRANCH_MISSING',
				severity: 'error',
				ref: taskName,
				message: 'Robot Task result requires completed and inspection branches.',
			});
		}
	}

	for (const validate of workflow.nodes.filter(
		(candidate) => candidate.type === COMPETITION_NODE_TYPES.robotValidate,
	)) {
		if (parametersOf(validate).operation !== 'plan') {
			diagnostics.push({
				code: 'ROBOT_VALIDATION_MODE_INVALID',
				severity: 'error',
				ref: validate.name ?? validate.id,
				message: 'Competition execution requires Robot Validate in plan mode.',
			});
		}
	}

	for (const plan of workflow.nodes.filter(
		(candidate) => candidate.type === COMPETITION_NODE_TYPES.robotSkillPlan,
	)) {
		const planName = plan.name ?? plan.id;
		if (typeof parametersOf(plan).blocklyPayload !== 'string') {
			diagnostics.push({
				code: 'ROBOT_PLAN_BINDING_MISSING',
				severity: 'error',
				ref: planName,
				message: 'Robot Skill Plan requires a serialized Blockly payload.',
			});
		}
	}

	for (const candidate of workflow.nodes) {
		if (candidate.type !== COMPETITION_NODE_TYPES.httpRequest) continue;
		const url = parametersOf(candidate).url;
		if (typeof url === 'string' && ROBOT_BRIDGE_PATH_PATTERN.test(url)) {
			diagnostics.push({
				code: 'ROBOT_DIRECT_HTTP_FORBIDDEN',
				severity: 'error',
				ref: candidate.name ?? candidate.id,
				message: 'Robot bridge actions use RoboFrame nodes instead of HTTP Request.',
			});
		}
	}

	return diagnostics;
}

function hasFalseBranch(workflow: WorkflowJSON, nodeName: string): boolean {
	const outputs = workflow.connections[nodeName]?.main;
	return (outputs?.[0]?.length ?? 0) > 0 && (outputs?.[1]?.length ?? 0) > 0;
}

function directChildren(workflow: WorkflowJSON, nodeName: string): string[] {
	const outputs = workflow.connections[nodeName]?.main ?? [];
	return outputs.flatMap((output) => output?.map((connection) => connection.node) ?? []);
}

function hasExactReadinessConditions(node: WorkflowJSON['nodes'][number]): boolean {
	const group = conditionGroup(node);
	return (
		group !== null &&
		group.combinator === 'and' &&
		group.conditions.length === 2 &&
		group.conditions.some((condition) =>
			matchesBooleanCondition(condition, '={{ $json.motionAuthorized }}', 'true'),
		) &&
		group.conditions.some((condition) =>
			matchesBooleanCondition(condition, '={{ $json.busy }}', 'false'),
		)
	);
}

function hasExactApprovalCondition(node: WorkflowJSON['nodes'][number]): boolean {
	const group = conditionGroup(node);
	if (group === null || group.combinator !== 'and' || group.conditions.length !== 1) {
		return false;
	}
	const condition = group.conditions[0];
	if (!isRecord(condition) || !isRecord(condition.operator)) return false;
	return (
		condition.leftValue === '={{ $json["Approval Decision"] }}' &&
		condition.rightValue === 'Approve' &&
		condition.operator.type === 'string' &&
		condition.operator.operation === 'equals'
	);
}

function matchesBooleanCondition(
	condition: unknown,
	leftValue: string,
	operation: 'true' | 'false',
): boolean {
	if (!isRecord(condition) || !isRecord(condition.operator)) return false;
	return (
		condition.leftValue === leftValue &&
		condition.operator.type === 'boolean' &&
		condition.operator.operation === operation
	);
}

function conditionGroup(
	node: WorkflowJSON['nodes'][number],
): { combinator: unknown; conditions: unknown[] } | null {
	const value = parametersOf(node).conditions;
	if (!isRecord(value) || !Array.isArray(value.conditions)) return null;
	return { combinator: value.combinator, conditions: value.conditions };
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}
