<script setup lang="ts">
// 底部状态流水线：前三段可达（可点选当前段），后三段灰置。
// 灰置段不是「等待中」——本阶段不执行任何东西，所以点不动、也不给状态文案。
import { STAGES } from './stages';

defineProps<{ current: string }>();
const emit = defineEmits<{ (e: 'select', id: string): void }>();
</script>

<template>
	<div class="pipeline" data-testid="pipeline">
		<span class="pipeline-title">PIPELINE</span>
		<ol class="stages">
			<li
				v-for="(stage, index) in STAGES"
				:key="stage.id"
				class="stage-item"
				:class="{ disabled: !stage.reachable }"
			>
				<span v-if="index > 0" class="stage-arrow" aria-hidden="true">→</span>
				<button
					type="button"
					class="stage"
					:class="{ active: stage.id === current, unreachable: !stage.reachable }"
					:disabled="!stage.reachable"
					:aria-current="stage.id === current ? 'step' : undefined"
					:title="stage.hint"
					:data-testid="`stage-${stage.id}`"
					@click="emit('select', stage.id)"
				>
					<span class="stage-dot" aria-hidden="true"></span>
					<span class="stage-label">{{ stage.label }}</span>
				</button>
			</li>
		</ol>
		<span class="pipeline-note">本阶段只到前三段</span>
	</div>
</template>

<style scoped>
.pipeline {
	display: flex;
	align-items: center;
	gap: var(--cc-space-3);
	min-width: 0;
	overflow: hidden;
}

.pipeline-title {
	flex: 0 0 auto;
	font-size: var(--cc-fs-xs);
	letter-spacing: 0.18em;
	color: var(--cc-text-faint);
}

.stages {
	display: flex;
	align-items: center;
	gap: var(--cc-space-1);
	min-width: 0;
	margin: 0;
	padding: 0;
	list-style: none;
	overflow-x: auto;
}

.stage-item {
	display: flex;
	align-items: center;
	gap: var(--cc-space-1);
}

.stage-arrow {
	color: var(--cc-line-strong);
	font-size: var(--cc-fs-sm);
}

.stage {
	display: flex;
	align-items: center;
	gap: var(--cc-space-2);
	padding: 3px var(--cc-space-2);
	color: var(--cc-text-dim);
	background: transparent;
	border: 1px solid transparent;
	border-radius: 999px;
	white-space: nowrap;
	cursor: pointer;
	transition:
		color 0.15s ease,
		background 0.15s ease,
		border-color 0.15s ease;
}

.stage:hover:not(:disabled) {
	color: var(--cc-text);
	background: var(--cc-surface-raised);
}

.stage.active {
	color: var(--cc-accent);
	background: var(--cc-accent-veil);
	border-color: var(--cc-accent-dim);
	box-shadow: 0 0 0 1px var(--cc-accent-glow) inset;
}

.stage-dot {
	width: 6px;
	height: 6px;
	border-radius: 50%;
	background: currentColor;
	opacity: 0.55;
}

.stage.active .stage-dot {
	opacity: 1;
	box-shadow: 0 0 8px var(--cc-accent-glow);
}

/* 灰置：低对比 + 禁用手型，明确「不可达」而不是「等待中」 */
.stage.unreachable {
	color: var(--cc-disabled-text);
	background: var(--cc-disabled-surface);
	border-color: transparent;
	cursor: not-allowed;
}

.stage.unreachable .stage-dot {
	background: var(--cc-disabled);
	opacity: 1;
	box-shadow: none;
}

.pipeline-note {
	flex: 0 0 auto;
	font-size: var(--cc-fs-xs);
	color: var(--cc-text-faint);
}

@media (max-width: 1400px) {
	.pipeline-note {
		display: none;
	}
}
</style>
