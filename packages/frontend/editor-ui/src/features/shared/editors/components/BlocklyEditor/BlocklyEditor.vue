<script setup lang="ts">
import { N8nNotice, N8nText } from '@n8n/design-system';
import { useI18n } from '@n8n/i18n';
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { createToolbox, loadWorkspaceOrDefault, registerN8nBlocks } from './blockly';
import {
	compileBlocklyWorkspace,
	createDefaultWorkspace,
	parseBlocklyDataPayload,
	serializeBlocklyDataPayload,
} from './payload';
import {
	compileRobotWorkspace,
	createDefaultRobotWorkspace,
	createRobotToolbox,
	parseRobotPlanPayload,
	registerRobotBlocks,
	serializeRobotPlanPayload,
	SO101_CATALOG_SNAPSHOT,
} from './robotSkills';
import type { RobotBlockLabels, RobotCatalog } from './robotSkills';

type Props = {
	modelValue: string;
	isReadOnly?: boolean;
	/** 'data-transform' keeps the v1 editor; 'robot-skills' swaps the grammar. */
	editorMode?: 'data-transform' | 'robot-skills';
};
const props = withDefaults(defineProps<Props>(), {
	isReadOnly: false,
	editorMode: 'data-transform',
});
const emit = defineEmits<{ 'update:modelValue': [value: string] }>();
const i18n = useI18n();
const editorContainer = ref<HTMLDivElement>();
const javascriptPreview = ref('');
const compileError = ref('');
let workspace: BlocklyWorkspace | undefined;
let blockly: Awaited<ReturnType<typeof loadBlocklyModule>> | undefined;
let robotCatalog: RobotCatalog = SO101_CATALOG_SNAPSHOT;
let isSynchronizing = false;
let resizeObserver: ResizeObserver | undefined;

const isRobotMode = computed(() => props.editorMode === 'robot-skills');
const previewTitle = computed(() =>
	isRobotMode.value
		? i18n.baseText('robotSkillEditor.preview.title')
		: i18n.baseText('blocklyEditor.preview.title'),
);

onMounted(async () => {
	await nextTick();
	if (!editorContainer.value) return;
	const loadedBlockly = await loadBlocklyModule();
	const container = editorContainer.value;
	if (!container) return;
	blockly = loadedBlockly;
	if (isRobotMode.value) {
		const initialPayload = parseRobotPlanPayload(props.modelValue);
		if (initialPayload.ok) robotCatalog = initialPayload.payload.catalog;
		registerRobotBlocks(blockly, createRobotBlockLabels(), robotCatalog);
	} else {
		registerN8nBlocks(blockly, {
			transformItem: i18n.baseText('blocklyEditor.blocks.transformItem'),
			copyInput: i18n.baseText('blocklyEditor.blocks.copyInput'),
			emptyOutput: i18n.baseText('blocklyEditor.blocks.emptyOutput'),
			setField: i18n.baseText('blocklyEditor.blocks.setField'),
			to: i18n.baseText('blocklyEditor.blocks.to'),
			getField: i18n.baseText('blocklyEditor.blocks.getField'),
			path: i18n.baseText('blocklyEditor.blocks.path'),
		});
	}
	workspace = blockly.inject(container, {
		toolbox: isRobotMode.value
			? createRobotToolbox({
					robot: i18n.baseText('robotSkillEditor.categories.robot'),
					primitives: i18n.baseText('robotSkillEditor.categories.primitives'),
					math: i18n.baseText('blocklyEditor.categories.math'),
					text: i18n.baseText('blocklyEditor.categories.text'),
				})
			: createToolbox({
					transform: i18n.baseText('blocklyEditor.categories.transform'),
					logic: i18n.baseText('blocklyEditor.categories.logic'),
					math: i18n.baseText('blocklyEditor.categories.math'),
					text: i18n.baseText('blocklyEditor.categories.text'),
				}),
		readOnly: props.isReadOnly,
	});
	workspace.addChangeListener(handleWorkspaceChange);
	resizeObserver = new ResizeObserver(() => {
		if (workspace && blockly) blockly.svgResize(workspace);
	});
	resizeObserver.observe(container);
	loadModelValue(props.modelValue);
});

onBeforeUnmount(() => {
	resizeObserver?.disconnect();
	if (workspace) {
		workspace.removeChangeListener(handleWorkspaceChange);
		workspace.dispose();
	}
});

watch(
	() => props.modelValue,
	(value) => {
		if (!workspace || value === serializeWorkspace()) return;
		loadModelValue(value);
	},
);

function loadModelValue(value: string) {
	const currentWorkspace = workspace;
	const currentBlockly = blockly;
	if (!currentWorkspace || !currentBlockly) return;
	if (isRobotMode.value) {
		const payload = parseRobotPlanPayload(value);
		if (!payload.ok) {
			withWorkspaceEventsDisabled(currentBlockly, () => currentWorkspace.clear());
			javascriptPreview.value = '';
			compileError.value = payload.error;
			return;
		}
		robotCatalog = payload.payload.catalog;
		registerRobotBlocks(currentBlockly, createRobotBlockLabels(), robotCatalog);
		const loadedWorkspace = withWorkspaceEventsDisabled(currentBlockly, () =>
			loadWorkspaceOrDefault(
				currentBlockly,
				currentWorkspace,
				payload.payload.workspace,
				createDefaultRobotWorkspace(),
			),
		);
		if (!loadedWorkspace) {
			compileError.value = i18n.baseText('blocklyEditor.loadError');
			javascriptPreview.value = '';
			return;
		}
		updateCompileState();
		return;
	}

	const payload = parseBlocklyDataPayload(value);
	if (!payload.ok) {
		withWorkspaceEventsDisabled(currentBlockly, () => currentWorkspace.clear());
		javascriptPreview.value = '';
		compileError.value = payload.error;
		return;
	}
	const loadedWorkspace = withWorkspaceEventsDisabled(currentBlockly, () =>
		loadWorkspaceOrDefault(
			currentBlockly,
			currentWorkspace,
			payload.payload.workspace,
			createDefaultWorkspace(),
		),
	);
	if (!loadedWorkspace) {
		const result = compileBlocklyWorkspace(payload.payload.workspace);
		javascriptPreview.value = '';
		compileError.value = result.ok ? i18n.baseText('blocklyEditor.loadError') : result.error;
		return;
	}
	updateCompileState();
}
function withWorkspaceEventsDisabled<T>(runtime: BlocklyRuntime, callback: () => T): T {
	isSynchronizing = true;
	runtime.Events.disable();
	try {
		return callback();
	} finally {
		runtime.Events.enable();
		isSynchronizing = false;
	}
}
function handleWorkspaceChange(event: BlocklyEvent) {
	if (!isSynchronizing && !event.isUiEvent) emitWorkspaceValue();
}
function emitWorkspaceValue() {
	updateCompileState();
	const value = serializeWorkspace();
	if (value !== props.modelValue) emit('update:modelValue', value);
}
function updateCompileState() {
	if (!workspace || !blockly) return;
	const state = blockly.serialization.workspaces.save(workspace);
	if (isRobotMode.value) {
		const result = compileRobotWorkspace(state, robotCatalog);
		javascriptPreview.value = result.ok ? JSON.stringify(result.plan, null, 2) : '';
		compileError.value = result.ok ? '' : result.error;
		return;
	}
	const result = compileBlocklyWorkspace(state);
	javascriptPreview.value = result.ok ? result.javascript : '';
	compileError.value = result.ok ? '' : result.error;
}
function serializeWorkspace(): string {
	if (!workspace || !blockly) return '';
	const state = blockly.serialization.workspaces.save(workspace);
	return isRobotMode.value
		? serializeRobotPlanPayload({ catalog: robotCatalog, workspace: state })
		: serializeBlocklyDataPayload(state);
}
function createRobotBlockLabels(): RobotBlockLabels {
	return {
		taskPlan: i18n.baseText('robotSkillEditor.blocks.taskPlan'),
		executeSkill: i18n.baseText('robotSkillEditor.blocks.executeSkill'),
		skill: i18n.baseText('robotSkillEditor.blocks.skill'),
		executePrimitive: i18n.baseText('robotSkillEditor.blocks.executePrimitive'),
		primitive: i18n.baseText('robotSkillEditor.blocks.primitive'),
		wait: i18n.baseText('robotSkillEditor.blocks.wait'),
		seconds: i18n.baseText('robotSkillEditor.blocks.seconds'),
		gripper: i18n.baseText('robotSkillEditor.blocks.gripper'),
		gripperOpen: i18n.baseText('robotSkillEditor.blocks.gripperOpen'),
		gripperClose: i18n.baseText('robotSkillEditor.blocks.gripperClose'),
		gripperRotateCw: i18n.baseText('robotSkillEditor.blocks.gripperRotateCw'),
		gripperRotateCcw: i18n.baseText('robotSkillEditor.blocks.gripperRotateCcw'),
		condition: i18n.baseText('robotSkillEditor.blocks.condition'),
		conditionField: i18n.baseText('robotSkillEditor.blocks.conditionField'),
		conditionOp: i18n.baseText('robotSkillEditor.blocks.conditionOp'),
		target: i18n.baseText('robotSkillEditor.blocks.target'),
		place: i18n.baseText('robotSkillEditor.blocks.place'),
		direction: i18n.baseText('robotSkillEditor.blocks.direction'),
		directionNone: i18n.baseText('robotSkillEditor.blocks.directionNone'),
		distance: i18n.baseText('robotSkillEditor.blocks.distance'),
		timeout: i18n.baseText('robotSkillEditor.blocks.timeout'),
		extraParams: i18n.baseText('robotSkillEditor.blocks.extraParams'),
	};
}
async function loadBlocklyModule(): Promise<typeof import('blockly')> {
	return await import('blockly');
}
type BlocklyWorkspace = import('blockly').WorkspaceSvg;
type BlocklyEvent = import('blockly').Events.Abstract;
type BlocklyRuntime = Awaited<ReturnType<typeof loadBlocklyModule>>;
</script>

<template>
	<section
		:class="$style.editor"
		:aria-label="
			isRobotMode
				? i18n.baseText('robotSkillEditor.ariaLabel')
				: i18n.baseText('blocklyEditor.ariaLabel')
		"
	>
		<div ref="editorContainer" :class="$style.workspace" data-test-id="blockly-workspace" />
		<N8nNotice
			v-if="compileError"
			type="warning"
			:class="$style.compileError"
			data-test-id="blockly-compile-error"
		>
			{{ i18n.baseText('blocklyEditor.compileError', { interpolate: { error: compileError } }) }}
		</N8nNotice>
		<div :class="$style.preview">
			<N8nText tag="h3" size="small" bold>{{ previewTitle }}</N8nText>
			<pre
				:class="$style.code"
				data-test-id="blockly-javascript-preview"
			><code>{{ javascriptPreview }}</code></pre>
		</div>
	</section>
</template>

<style lang="scss" module>
.editor {
	display: flex;
	flex-direction: column;
	gap: var(--spacing--sm);
}
.workspace {
	min-height: var(--spacing--5xl);
	height: calc(var(--spacing--5xl) + var(--spacing--4xl));
	background: var(--background--surface);
	border: var(--border-width) var(--border-style) var(--border-color--subtle);
	border-radius: var(--radius--md);
}
.compileError {
	margin: 0;
}
.preview {
	display: flex;
	flex-direction: column;
	gap: var(--spacing--2xs);
}
.code {
	margin: 0;
	padding: var(--spacing--sm);
	color: var(--text-color);
	background: var(--background--surface);
	border: var(--border-width) var(--border-style) var(--border-color--subtle);
	border-radius: var(--radius--md);
	overflow: auto;
	white-space: pre-wrap;
}
</style>
