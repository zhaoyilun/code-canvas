<script setup lang="ts">
// 状态条：整条流水线 + 右下 RUN / STOP 占位。
// 本阶段不执行任何东西——两个按钮只在控制台打日志。
import { FIRST_REACHABLE_STAGE } from './stages';
import StagePipeline from './StagePipeline.vue';

const props = defineProps<{ currentStage?: string; context?: string }>();
const emit = defineEmits<{ (e: 'select-stage', id: string): void }>();

function run(): void {
	console.log('[CodeCanvas] RUN clicked — 占位：执行器未实现，本阶段不运行任何东西', {
		context: props.context ?? 'unknown',
	});
}

function stop(): void {
	console.log('[CodeCanvas] STOP clicked — 占位：没有正在运行的任务（执行器未实现）', {
		context: props.context ?? 'unknown',
	});
}
</script>

<template>
	<footer class="statusbar">
		<StagePipeline
			:current="currentStage ?? FIRST_REACHABLE_STAGE"
			@select="emit('select-stage', $event)"
		/>
		<div class="actions">
			<button type="button" class="btn run" data-testid="run-button" @click="run">RUN</button>
			<button type="button" class="btn stop" data-testid="stop-button" @click="stop">STOP</button>
		</div>
	</footer>
</template>

<style scoped>
.statusbar {
	display: flex;
	align-items: center;
	justify-content: space-between;
	gap: var(--cc-space-4);
	flex: 0 0 auto;
	height: var(--cc-statusbar-h);
	padding: 0 var(--cc-space-3);
	background: var(--cc-surface);
	border-top: 1px solid var(--cc-line);
}

.actions {
	display: flex;
	align-items: center;
	gap: var(--cc-space-2);
	flex: 0 0 auto;
}

.btn {
	min-width: 74px;
	padding: 7px var(--cc-space-4);
	font-size: var(--cc-fs-md);
	font-weight: 650;
	letter-spacing: 0.08em;
	border: 1px solid transparent;
	border-radius: var(--cc-radius-sm);
	cursor: pointer;
	transition:
		filter 0.15s ease,
		box-shadow 0.15s ease,
		transform 0.05s ease;
}

.btn:active {
	transform: translateY(1px);
}

.run {
	color: var(--cc-surface-sunken);
	background: var(--cc-accent);
	border-color: var(--cc-accent-strong);
	box-shadow: 0 0 14px var(--cc-accent-glow);
}

.run:hover {
	filter: brightness(1.1);
}

.stop {
	color: var(--cc-danger-strong);
	background: var(--cc-danger-veil);
	border-color: var(--cc-danger);
}

.stop:hover {
	color: var(--cc-text-inverse);
	background: var(--cc-danger);
}

@media (max-width: 1100px) {
	.btn {
		min-width: 60px;
		padding: 7px var(--cc-space-3);
	}
}
</style>
