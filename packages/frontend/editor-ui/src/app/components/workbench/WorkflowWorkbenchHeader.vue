<script setup lang="ts">
import { N8nBadge, N8nIcon } from '@n8n/design-system';
import { useI18n } from '@n8n/i18n';
import { computed, onBeforeUnmount, onMounted, useCssModule, watch } from 'vue';

import type { WorkflowWorkbenchNode, WorkflowWorkbenchProfile } from './workflowWorkbench';
import {
	resolveWorkflowWorkbenchCapabilities,
	resolveWorkflowWorkbenchRunStatus,
	resolveWorkflowWorkbenchStage,
	workflowWorkbenchStageIsPresent,
} from './workflowWorkbench';

const props = defineProps<{
	profile: WorkflowWorkbenchProfile;
	workflowName: string;
	nodes: readonly WorkflowWorkbenchNode[];
	activeNodeType?: string | null;
	executionStatus?: string | null;
	isExecutionView: boolean;
}>();
const $style = useCssModule();
const locale = useI18n();

const taskTitle = computed(() => props.workflowName || props.profile.displayName);
const activeStage = computed(() =>
	resolveWorkflowWorkbenchStage(props.profile, {
		activeNodeType: props.activeNodeType,
		isExecutionView: props.isExecutionView,
	}),
);
const runStatus = computed(() => resolveWorkflowWorkbenchRunStatus(props.executionStatus));
const runStatusLabel = computed(() => locale.baseText(runStatus.value.translationKey));
const capabilities = computed(() =>
	resolveWorkflowWorkbenchCapabilities(props.profile, props.nodes),
);

function stageClass(stageId: string): Record<string, boolean> {
	return {
		[$style.stageActive]: activeStage.value === stageId,
		[$style.stagePresent]: workflowWorkbenchStageIsPresent(props.profile, stageId, props.nodes),
	};
}

let previousWorkbenchProfile: string | undefined;
let themeMounted = false;

watch(
	() => props.profile.id,
	(profileId) => {
		if (themeMounted && typeof document !== 'undefined') {
			document.documentElement.dataset.workbenchProfile = profileId;
		}
	},
);

onMounted(() => {
	if (typeof document === 'undefined') return;
	previousWorkbenchProfile = document.documentElement.dataset.workbenchProfile;
	themeMounted = true;
	document.documentElement.dataset.workbenchProfile = props.profile.id;
});

onBeforeUnmount(() => {
	themeMounted = false;
	if (typeof document === 'undefined') return;
	if (previousWorkbenchProfile === undefined) {
		delete document.documentElement.dataset.workbenchProfile;
		return;
	}
	document.documentElement.dataset.workbenchProfile = previousWorkbenchProfile;
});
</script>

<template>
	<section
		:class="$style.workbenchShell"
		:aria-label="profile.displayName"
		:data-workbench-profile="profile.id"
		data-test-id="workflow-workbench-header"
	>
		<div :class="$style.workbench">
			<div :class="$style.brand">
				<div :class="$style.brandMark" aria-hidden="true">
					<N8nIcon icon="blocks" size="medium" />
				</div>
				<div :class="$style.brandCopy">
					<p v-if="profile.brand" :class="$style.eyebrow">{{ profile.brand }}</p>
					<p :class="$style.title">{{ profile.displayName }}</p>
					<p :class="$style.subtitle">{{ taskTitle }}</p>
				</div>
			</div>

			<div :class="$style.stageRail">
				<div
					v-for="stage in profile.stages"
					:key="stage.id"
					:class="[$style.stage, $style[`accent-${stage.accent}`], stageClass(stage.id)]"
				>
					<span :class="$style.stageIcon" aria-hidden="true">
						<N8nIcon :icon="stage.icon" size="small" />
					</span>
					<span :class="$style.stageLabel">{{ stage.label }}</span>
				</div>
			</div>

			<div :class="$style.statusArea">
				<div :class="[$style.runStatus, $style[`run-${runStatus.tone}`]]">
					<N8nIcon :icon="runStatus.icon" size="small" />
					<span>{{ runStatusLabel }}</span>
				</div>
				<div v-if="capabilities.length" :class="$style.capabilities">
					<N8nBadge
						v-for="capability in capabilities"
						:key="capability.id"
						theme="tertiary"
						:show-border="false"
					>
						{{ capability.label }} · {{ capability.count }}
					</N8nBadge>
				</div>
			</div>
		</div>
	</section>
</template>

<style lang="scss" module>
.workbenchShell {
	--n8n--workbench--color--background: light-dark(
		color-mix(in oklab, var(--color--blue-500) 10%, var(--background--surface)),
		color-mix(in oklab, var(--color--blue-500) 18%, var(--background--surface))
	);
	--n8n--workbench--border-color: light-dark(
		color-mix(in oklab, var(--color--blue-500) 24%, var(--border-color--subtle)),
		color-mix(in oklab, var(--color--blue-400) 35%, var(--border-color--subtle))
	);
	--n8n--workbench--brand-color: var(--text-color--inverse);
	--n8n--workbench--brand-background: linear-gradient(
		135deg,
		var(--color--blue-600),
		var(--color--purple-600)
	);

	display: block;
	width: 100%;
	min-width: 0;
	container-name: workflow-workbench;
	container-type: inline-size;
}

.workbench {
	display: grid;
	min-width: 0;
	grid-template-columns: minmax(12.5rem, 17rem) minmax(0, 1fr) minmax(10.5rem, 15rem);
	align-items: center;
	gap: var(--spacing--sm);
	padding: var(--spacing--2xs) var(--spacing--sm);
	border-top: var(--border-width) var(--border-style) var(--n8n--workbench--border-color);
	border-bottom: var(--border-width) var(--border-style) var(--n8n--workbench--border-color);
	background:
		radial-gradient(
			circle at 16% 0%,
			color-mix(in oklab, var(--color--purple-500) 14%, transparent),
			transparent 31%
		),
		var(--n8n--workbench--color--background);
}

.brand,
.stageRail,
.statusArea,
.runStatus,
.capabilities,
.stage,
.stageIcon {
	display: flex;
	align-items: center;
}

.brand {
	min-width: 0;
	gap: var(--spacing--2xs);
}

.brandMark {
	display: grid;
	width: var(--height--2xl);
	height: var(--height--2xl);
	flex: 0 0 auto;
	place-items: center;
	color: var(--n8n--workbench--brand-color);
	background: var(--n8n--workbench--brand-background);
	border-radius: var(--radius--md);
	box-shadow: var(--shadow--sm);
}

.brandCopy {
	min-width: 0;
}

.eyebrow,
.subtitle {
	margin: 0;
}

.eyebrow {
	color: var(--text-color--info);
	font-size: var(--font-size--4xs);
	font-weight: var(--font-weight--bold);
	letter-spacing: var(--letter-spacing--wide);
	line-height: var(--line-height--xs);
	text-transform: uppercase;
}

.title {
	margin: var(--spacing--5xs) 0 0;
	color: var(--text-color);
	font-size: var(--font-size--sm);
	font-weight: var(--font-weight--bold);
	line-height: var(--line-height--md);
}

.subtitle {
	max-width: 20rem;
	overflow: hidden;
	color: var(--text-color--subtle);
	font-size: var(--font-size--3xs);
	line-height: var(--line-height--sm);
	text-overflow: ellipsis;
	white-space: nowrap;
}

.stageRail {
	width: 100%;
	max-width: 72rem;
	min-width: 0;
	justify-self: center;
	justify-content: space-between;
	gap: var(--spacing--4xs);
}

.stage {
	--n8n--workbench--stage-color: var(--text-color--subtler);

	position: relative;
	min-width: 0;
	flex: 1 1 0;
	justify-content: center;
	gap: var(--spacing--5xs);
	color: var(--text-color--subtler);
	font-size: var(--font-size--4xs);
	font-weight: var(--font-weight--medium);
	white-space: nowrap;

	&::after {
		position: absolute;
		top: 50%;
		right: calc(var(--spacing--4xs) * -1);
		width: var(--spacing--4xs);
		height: var(--border-width);
		background-color: var(--border-color--subtle);
		content: '';
	}

	&:last-child::after {
		display: none;
	}
}

.stageIcon {
	width: var(--height--xs);
	height: var(--height--xs);
	flex: 0 0 auto;
	justify-content: center;
	border: var(--border-width) var(--border-style) currentColor;
	border-radius: var(--radius--full);
}

.stageLabel {
	min-width: 0;
	overflow: hidden;
	text-overflow: ellipsis;
}

.stagePresent {
	color: var(--n8n--workbench--stage-color);
}

.stageActive {
	color: var(--n8n--workbench--stage-color);
	font-weight: var(--font-weight--bold);

	.stageIcon {
		color: var(--text-color--inverse);
		background-color: var(--n8n--workbench--stage-color);
		border-color: var(--n8n--workbench--stage-color);
		box-shadow: 0 0 0 var(--spacing--4xs)
			color-mix(in oklab, var(--n8n--workbench--stage-color) 18%, transparent);
	}
}

.accent-blue {
	--n8n--workbench--stage-color: light-dark(var(--color--blue-600), var(--color--blue-300));
}

.accent-purple {
	--n8n--workbench--stage-color: light-dark(var(--color--purple-600), var(--color--purple-300));
}

.accent-orange {
	--n8n--workbench--stage-color: light-dark(var(--color--orange-600), var(--color--orange-300));
}

.accent-amber {
	--n8n--workbench--stage-color: light-dark(var(--color--yellow-700), var(--color--yellow-300));
}

.accent-green {
	--n8n--workbench--stage-color: light-dark(var(--color--green-600), var(--color--green-300));
}

.statusArea {
	min-width: 0;
	flex-direction: column;
	align-items: flex-end;
	gap: var(--spacing--5xs);
}

.runStatus {
	min-width: 0;
	max-width: 100%;
	gap: var(--spacing--5xs);
	padding: var(--spacing--5xs) var(--spacing--2xs);
	border: var(--border-width) var(--border-style) currentColor;
	border-radius: var(--radius--xl);
	font-size: var(--font-size--4xs);
	font-weight: var(--font-weight--bold);
	line-height: var(--line-height--sm);
	white-space: nowrap;
}

.runStatus > span {
	min-width: 0;
	overflow: hidden;
	text-overflow: ellipsis;
}

.run-ready {
	color: var(--text-color--info);
	background-color: var(--background--info);
}

.run-running {
	color: light-dark(var(--color--purple-700), var(--color--purple-100));
	background-color: light-dark(
		color-mix(in oklab, var(--color--purple-500) 10%, transparent),
		color-mix(in oklab, var(--color--purple-500) 24%, var(--background--surface))
	);
}

.run-waiting {
	color: var(--text-color--warning);
	background-color: var(--background--warning);
}

.run-success {
	color: var(--text-color--success);
	background-color: var(--background--success);
}

.run-danger {
	color: var(--text-color--danger);
	background-color: var(--background--danger);
}

.capabilities {
	min-width: 0;
	max-width: 100%;
	flex-wrap: wrap;
	justify-content: flex-end;
	gap: var(--spacing--5xs);
}

@container workflow-workbench (max-width: 1180px) {
	.workbench {
		grid-template-columns: minmax(12rem, 0.85fr) minmax(0, 2.15fr);
	}

	.statusArea {
		grid-column: 1 / -1;
		flex-direction: row;
		align-items: center;
		justify-content: space-between;
	}

	.capabilities {
		justify-content: flex-end;
	}
}

@container workflow-workbench (max-width: 840px) {
	.workbench {
		grid-template-columns: 1fr;
		gap: var(--spacing--2xs);
	}

	.stageRail {
		justify-content: flex-start;
		overflow-x: auto;
		overscroll-behavior-x: contain;
		scrollbar-width: thin;
		padding-bottom: var(--spacing--5xs);
	}

	.stage {
		flex: 0 0 auto;
		padding-inline: var(--spacing--5xs);
	}

	.statusArea {
		grid-column: auto;
		flex-wrap: wrap;
		align-items: flex-start;
		justify-content: flex-start;
	}

	.capabilities {
		justify-content: flex-start;
	}
}

@container workflow-workbench (max-width: 540px) {
	.workbench {
		padding-inline: var(--spacing--2xs);
	}

	.subtitle {
		display: -webkit-box;
		-webkit-box-orient: vertical;
		-webkit-line-clamp: 2;
		white-space: normal;
	}
}
</style>
