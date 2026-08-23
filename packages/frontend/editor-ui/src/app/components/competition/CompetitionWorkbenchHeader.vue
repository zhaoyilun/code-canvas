<script setup lang="ts">
import { N8nBadge, N8nIcon } from '@n8n/design-system';
import { computed, onBeforeUnmount, onMounted, useCssModule } from 'vue';
import {
	COMPETITION_STAGES,
	getCompetitionRunStatus,
	resolveCompetitionStage,
	stageIsPresent,
	type CompetitionStageId,
} from './competitionWorkbench';

type NodeTypeCarrier = {
	type?: string | null;
};

const props = defineProps<{
	workflowName: string;
	nodes: readonly NodeTypeCarrier[];
	activeNodeType?: string | null;
	executionStatus?: string | null;
	isExecutionView: boolean;
}>();
const $style = useCssModule();

const taskTitle = computed(() => props.workflowName || '人工智能可解释机器人课程');
const activeStage = computed(() =>
	resolveCompetitionStage({
		activeNodeType: props.activeNodeType,
		isExecutionView: props.isExecutionView,
	}),
);
const runStatus = computed(() => getCompetitionRunStatus(props.executionStatus));
const teachingNodeCount = computed(
	() => props.nodes.filter((node) => node.type === 'CUSTOM.blocklyCode').length,
);
const robotNodeCount = computed(
	() => props.nodes.filter((node) => node.type?.startsWith('CUSTOM.robot') === true).length,
);

function stageClass(stageId: CompetitionStageId): Record<string, boolean> {
	return {
		[$style.stageActive]: activeStage.value === stageId,
		[$style.stagePresent]: stageIsPresent(stageId, props.nodes),
	};
}

let previousCompetitionWorkbench: string | undefined;

onMounted(() => {
	if (typeof document === 'undefined') return;
	previousCompetitionWorkbench = document.documentElement.dataset.competitionWorkbench;
	document.documentElement.dataset.competitionWorkbench = 'true';
});

onBeforeUnmount(() => {
	if (typeof document === 'undefined') return;
	if (previousCompetitionWorkbench === undefined) {
		delete document.documentElement.dataset.competitionWorkbench;
		return;
	}
	document.documentElement.dataset.competitionWorkbench = previousCompetitionWorkbench;
});
</script>

<template>
	<section
		:class="$style.workbenchShell"
		aria-label="RoboTeach Studio｜人工智能代码理解实验室"
		data-test-id="competition-workbench-header"
	>
		<div :class="$style.workbench">
			<div :class="$style.brand">
				<div :class="$style.brandMark" aria-hidden="true">
					<N8nIcon icon="sparkles" size="medium" />
				</div>
				<div :class="$style.brandCopy">
					<p :class="$style.eyebrow">RoboTeach Studio</p>
					<p :class="$style.title">人工智能代码理解实验室</p>
					<p :class="$style.subtitle">{{ taskTitle }}</p>
				</div>
			</div>

			<div :class="$style.stageRail" aria-label="课堂任务阶段">
				<div
					v-for="stage in COMPETITION_STAGES"
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
					<span>{{ runStatus.label }}</span>
				</div>
				<div :class="$style.capabilities" aria-label="课堂任务能力">
					<N8nBadge v-if="teachingNodeCount" theme="tertiary" :show-border="false">
						{{ teachingNodeCount }} 个可视化逻辑节点
					</N8nBadge>
					<N8nBadge v-if="robotNodeCount" theme="tertiary" :show-border="false">
						{{ robotNodeCount }} 个机器人任务节点
					</N8nBadge>
				</div>
			</div>
		</div>
	</section>
</template>

<style lang="scss" module>
.workbenchShell {
	display: block;
	width: 100%;
	min-width: 0;
	container-name: competition-workbench;
	container-type: inline-size;
}

.workbench {
	--n8n--competition-background: light-dark(
		color-mix(in oklab, var(--color--blue-500) 10%, var(--background--surface)),
		color-mix(in oklab, var(--color--blue-500) 18%, var(--background--surface))
	);
	--n8n--competition-border: light-dark(
		color-mix(in oklab, var(--color--blue-500) 24%, var(--border-color--subtle)),
		color-mix(in oklab, var(--color--blue-400) 35%, var(--border-color--subtle))
	);

	display: grid;
	min-width: 0;
	grid-template-columns: minmax(12.5rem, 17rem) minmax(0, 1fr) minmax(10.5rem, 15rem);
	align-items: center;
	gap: var(--spacing--sm);
	padding: var(--spacing--2xs) var(--spacing--sm);
	border-top: var(--border-width) var(--border-style) var(--n8n--competition-border);
	border-bottom: var(--border-width) var(--border-style) var(--n8n--competition-border);
	background:
		radial-gradient(
			circle at 16% 0%,
			color-mix(in oklab, var(--color--purple-500) 14%, transparent),
			transparent 31%
		),
		var(--n8n--competition-background);
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
	color: var(--text-color--inverse);
	background: linear-gradient(135deg, var(--color--blue-600), var(--color--purple-600));
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
	color: var(--color--blue-700);
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
	justify-self: center;
	justify-content: space-between;
	gap: var(--spacing--4xs);
	min-width: 0;
}

.stage {
	--n8n--competition-stage-color: var(--text-color--subtler);

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
	color: var(--n8n--competition-stage-color);
}

.stageActive {
	color: var(--n8n--competition-stage-color);
	font-weight: var(--font-weight--bold);

	.stageIcon {
		color: var(--text-color--inverse);
		background-color: var(--n8n--competition-stage-color);
		border-color: var(--n8n--competition-stage-color);
		box-shadow: 0 0 0 var(--spacing--4xs)
			color-mix(in oklab, var(--n8n--competition-stage-color) 18%, transparent);
	}
}

.accent-blue {
	--n8n--competition-stage-color: var(--color--blue-600);
}

.accent-purple {
	--n8n--competition-stage-color: var(--color--purple-600);
}

.accent-orange {
	--n8n--competition-stage-color: var(--color--orange-600);
}

.accent-amber {
	--n8n--competition-stage-color: var(--color--yellow-700);
}

.accent-green {
	--n8n--competition-stage-color: var(--color--green-600);
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
	color: var(--color--blue-700);
	background-color: color-mix(in oklab, var(--color--blue-500) 10%, transparent);
}

.run-running {
	color: var(--color--purple-700);
	background-color: color-mix(in oklab, var(--color--purple-500) 10%, transparent);
}

.run-waiting {
	color: var(--color--yellow-800);
	background-color: color-mix(in oklab, var(--color--yellow-500) 12%, transparent);
}

.run-success {
	color: var(--color--green-700);
	background-color: color-mix(in oklab, var(--color--green-500) 10%, transparent);
}

.run-danger {
	color: var(--color--red-700);
	background-color: color-mix(in oklab, var(--color--red-500) 10%, transparent);
}

.capabilities {
	min-width: 0;
	justify-content: flex-end;
	gap: var(--spacing--5xs);
	max-width: 100%;
	flex-wrap: wrap;
}

@container competition-workbench (max-width: 1180px) {
	.workbench {
		grid-template-columns: minmax(12rem, 0.85fr) minmax(0, 2.15fr);
	}

	.statusArea {
		grid-column: 1 / -1;
		flex-direction: row;
		justify-content: space-between;
		align-items: center;
	}

	.capabilities {
		justify-content: flex-end;
	}
}

@container competition-workbench (max-width: 840px) {
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
		justify-content: flex-start;
		align-items: flex-start;
	}

	.capabilities {
		justify-content: flex-start;
	}
}

@container competition-workbench (max-width: 540px) {
	.workbench {
		padding-inline: var(--spacing--2xs);
	}

	.subtitle {
		white-space: normal;
		display: -webkit-box;
		-webkit-box-orient: vertical;
		-webkit-line-clamp: 2;
	}
}
</style>
