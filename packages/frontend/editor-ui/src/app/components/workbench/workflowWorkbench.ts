import type { IconName } from '@n8n/design-system';
import { workflowVisualProgrammingProfileV1Schema } from '@n8n/dual-canvas-core';
import type {
	WorkflowVisualProgrammingCapabilityV1,
	WorkflowVisualProgrammingProfileV1,
	WorkflowVisualProgrammingStageV1,
} from 'n8n-workflow';

export type WorkflowWorkbenchNode = Readonly<{
	type?: string | null;
}>;

export type WorkflowWorkbenchStageAccent = 'blue' | 'purple' | 'orange' | 'amber' | 'green';

export type WorkflowWorkbenchStage = Readonly<
	WorkflowVisualProgrammingStageV1 & {
		icon: IconName;
		accent: WorkflowWorkbenchStageAccent;
	}
>;

export type WorkflowWorkbenchProfile = Readonly<{
	id: string;
	displayName: string;
	brand?: string;
	stages: readonly WorkflowWorkbenchStage[];
	capabilities: readonly WorkflowVisualProgrammingCapabilityV1[];
}>;

export type WorkflowWorkbenchRunStatus = Readonly<{
	translationKey:
		| 'experiments.instanceAiSplitEmptyState.canvas.ready'
		| 'executionsList.success'
		| 'executionsList.running'
		| 'executionsList.waiting'
		| 'executionsList.canceled'
		| 'executionsList.error';
	tone: 'ready' | 'running' | 'waiting' | 'success' | 'danger';
	icon: IconName;
}>;

export type ResolvedWorkflowWorkbenchCapability = Readonly<{
	id: string;
	count: number;
	label: string;
}>;

const STAGE_ACCENTS: readonly WorkflowWorkbenchStageAccent[] = [
	'blue',
	'purple',
	'orange',
	'amber',
	'green',
];

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseVisualProgrammingProfile(value: unknown): WorkflowVisualProgrammingProfileV1 | null {
	const parsed = workflowVisualProgrammingProfileV1Schema.safeParse(value);
	return parsed.success ? parsed.data : null;
}

function nodeTypeMatches(nodeTypes: readonly string[], type: string | null | undefined): boolean {
	return Boolean(type && nodeTypes.includes(type));
}

export function resolveWorkflowWorkbenchProfile(
	meta: unknown,
	nodes: readonly WorkflowWorkbenchNode[],
): WorkflowWorkbenchProfile | null {
	if (!isRecord(meta)) return null;

	const profile = parseVisualProgrammingProfile(meta.visualProgramming);
	if (!profile) return null;

	const hasProfileNode = profile.stages.some((stage) =>
		nodes.some((node) => nodeTypeMatches(stage.nodeTypes, node.type)),
	);
	if (!hasProfileNode) return null;

	return {
		id: profile.profileId,
		displayName: profile.displayName,
		...(profile.brand ? { brand: profile.brand } : {}),
		stages: profile.stages.map((stage, index) => ({
			...stage,
			icon: 'circle-dot',
			accent: STAGE_ACCENTS[index % STAGE_ACCENTS.length] ?? 'blue',
		})),
		capabilities: profile.capabilities ?? [],
	};
}

export function stageForWorkflowNodeType(
	profile: WorkflowWorkbenchProfile,
	type: string | null | undefined,
): string | null {
	return profile.stages.find((stage) => nodeTypeMatches(stage.nodeTypes, type))?.id ?? null;
}

export function workflowWorkbenchStageIsPresent(
	profile: WorkflowWorkbenchProfile,
	stageId: string,
	nodes: readonly WorkflowWorkbenchNode[],
): boolean {
	const stage = profile.stages.find(({ id }) => id === stageId);
	if (!stage) return false;

	return nodes.some((node) => nodeTypeMatches(stage.nodeTypes, node.type));
}

export function resolveWorkflowWorkbenchStage(
	profile: WorkflowWorkbenchProfile,
	{ activeNodeType, isExecutionView }: { activeNodeType?: string | null; isExecutionView: boolean },
): string {
	if (isExecutionView) return profile.stages.at(-1)?.id ?? '';
	return stageForWorkflowNodeType(profile, activeNodeType) ?? profile.stages[0]?.id ?? '';
}

export function resolveWorkflowWorkbenchRunStatus(
	executionStatus: string | null | undefined,
): WorkflowWorkbenchRunStatus {
	switch (executionStatus) {
		case 'success':
			return {
				translationKey: 'executionsList.success',
				tone: 'success',
				icon: 'circle-check',
			};
		case 'running':
		case 'new':
			return {
				translationKey: 'executionsList.running',
				tone: 'running',
				icon: 'circle-play',
			};
		case 'waiting':
			return {
				translationKey: 'executionsList.waiting',
				tone: 'waiting',
				icon: 'circle-dot',
			};
		case 'canceled':
			return {
				translationKey: 'executionsList.canceled',
				tone: 'danger',
				icon: 'circle-x',
			};
		case 'error':
		case 'crashed':
		case 'failed':
			return { translationKey: 'executionsList.error', tone: 'danger', icon: 'triangle-alert' };
		default:
			return {
				translationKey: 'experiments.instanceAiSplitEmptyState.canvas.ready',
				tone: 'ready',
				icon: 'circle-play',
			};
	}
}

export function resolveWorkflowWorkbenchCapabilities(
	profile: WorkflowWorkbenchProfile,
	nodes: readonly WorkflowWorkbenchNode[],
): ResolvedWorkflowWorkbenchCapability[] {
	return profile.capabilities.flatMap((capability) => {
		const count = nodes.filter((node) => nodeTypeMatches(capability.nodeTypes, node.type)).length;
		return count > 0 ? [{ id: capability.id, count, label: capability.label }] : [];
	});
}
