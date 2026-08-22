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
const selectedTeaching = ref<TeachingAnnotation>();
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
const editorTitle = computed(() =>
	isRobotMode.value
		? i18n.baseText('robotSkillEditor.title')
		: i18n.baseText('blocklyEditor.title'),
);
const editorDescription = computed(() =>
	isRobotMode.value
		? i18n.baseText('robotSkillEditor.description')
		: i18n.baseText('blocklyEditor.description'),
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
			deleteField: i18n.baseText('blocklyEditor.blocks.deleteField'),
			if: i18n.baseText('blocklyEditor.blocks.if'),
			do: i18n.baseText('blocklyEditor.blocks.do'),
			else: i18n.baseText('blocklyEditor.blocks.else'),
			assert: i18n.baseText('blocklyEditor.blocks.assert'),
			message: i18n.baseText('blocklyEditor.blocks.message'),
			getPath: i18n.baseText('blocklyEditor.blocks.getPath'),
			from: i18n.baseText('blocklyEditor.blocks.from'),
			convert: i18n.baseText('blocklyEditor.blocks.convert'),
			as: i18n.baseText('blocklyEditor.blocks.as'),
			convertText: i18n.baseText('blocklyEditor.blocks.convertText'),
			convertNumber: i18n.baseText('blocklyEditor.blocks.convertNumber'),
			convertBoolean: i18n.baseText('blocklyEditor.blocks.convertBoolean'),
			arrayItemAt: i18n.baseText('blocklyEditor.blocks.arrayItemAt'),
			index: i18n.baseText('blocklyEditor.blocks.index'),
			mapArrayPath: i18n.baseText('blocklyEditor.blocks.mapArrayPath'),
			filterArrayPath: i18n.baseText('blocklyEditor.blocks.filterArrayPath'),
			operatorEqual: i18n.baseText('blocklyEditor.blocks.operatorEqual'),
			operatorNotEqual: i18n.baseText('blocklyEditor.blocks.operatorNotEqual'),
			operatorLess: i18n.baseText('blocklyEditor.blocks.operatorLess'),
			operatorLessEqual: i18n.baseText('blocklyEditor.blocks.operatorLessEqual'),
			operatorGreater: i18n.baseText('blocklyEditor.blocks.operatorGreater'),
			operatorGreaterEqual: i18n.baseText('blocklyEditor.blocks.operatorGreaterEqual'),
			objectCreate: i18n.baseText('blocklyEditor.blocks.objectCreate'),
			objectProperty: i18n.baseText('blocklyEditor.blocks.objectProperty'),
			key: i18n.baseText('blocklyEditor.blocks.key'),
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
					arrays: i18n.baseText('blocklyEditor.categories.arrays'),
					objects: i18n.baseText('blocklyEditor.categories.objects'),
					types: i18n.baseText('blocklyEditor.categories.types'),
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
	if (event.isUiEvent) {
		updateSelectedTeaching();
		return;
	}
	if (!isSynchronizing) emitWorkspaceValue();
}
function updateSelectedTeaching() {
	const selected = blockly?.getSelected() as { data?: unknown } | null | undefined;
	selectedTeaching.value = parseTeachingAnnotation(selected?.data);
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
type TeachingAnnotation = {
	intentStepId: string;
	what: string;
	why: string;
	editable: string[];
	expectedEffect: string;
};
function parseTeachingAnnotation(value: unknown): TeachingAnnotation | undefined {
	if (typeof value !== 'string') return undefined;
	try {
		const parsed = JSON.parse(value) as unknown;
		if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return undefined;
		const record = parsed as Record<string, unknown>;
		const teaching = record.teaching;
		if (typeof teaching !== 'object' || teaching === null || Array.isArray(teaching))
			return undefined;
		const annotation = teaching as Record<string, unknown>;
		if (
			typeof record.intentStepId !== 'string' ||
			typeof annotation.what !== 'string' ||
			typeof annotation.why !== 'string' ||
			!Array.isArray(annotation.editable) ||
			!annotation.editable.every((item) => typeof item === 'string') ||
			typeof annotation.expectedEffect !== 'string'
		) {
			return undefined;
		}
		return {
			intentStepId: record.intentStepId,
			what: annotation.what,
			why: annotation.why,
			editable: annotation.editable,
			expectedEffect: annotation.expectedEffect,
		};
	} catch {
		return undefined;
	}
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
		<header :class="$style.header">
			<div :class="$style.heading">
				<N8nText tag="h3" size="medium" bold>{{ editorTitle }}</N8nText>
				<N8nText tag="p" size="small">{{ editorDescription }}</N8nText>
			</div>
			<span :class="$style.locationBadge">
				{{ i18n.baseText('blocklyEditor.location.node') }}
			</span>
		</header>
		<div :class="$style.editorGrid">
			<div :class="$style.blockPanel">
				<N8nText tag="h4" size="small" bold>
					{{ i18n.baseText('blocklyEditor.workspace.title') }}
				</N8nText>
				<div ref="editorContainer" :class="$style.workspace" data-test-id="blockly-workspace" />
			</div>
			<div :class="$style.preview">
				<N8nText tag="h4" size="small" bold>{{ previewTitle }}</N8nText>
				<pre
					:class="$style.code"
					data-test-id="blockly-javascript-preview"
				><code>{{ javascriptPreview }}</code></pre>
			</div>
		</div>
		<N8nNotice
			v-if="compileError"
			type="warning"
			:class="$style.compileError"
			data-test-id="blockly-compile-error"
		>
			{{ i18n.baseText('blocklyEditor.compileError', { interpolate: { error: compileError } }) }}
		</N8nNotice>
		<aside
			v-if="selectedTeaching"
			:class="$style.teaching"
			data-test-id="blockly-teaching-annotation"
		>
			<div :class="$style.teachingHeading">
				<N8nText tag="h4" size="small" bold>{{ selectedTeaching.what }}</N8nText>
				<span :class="$style.intentStep">{{ selectedTeaching.intentStepId }}</span>
			</div>
			<dl :class="$style.teachingDetails">
				<div>
					<dt>{{ i18n.baseText('blocklyEditor.teaching.why') }}</dt>
					<dd>{{ selectedTeaching.why }}</dd>
				</div>
				<div>
					<dt>{{ i18n.baseText('blocklyEditor.teaching.expectedEffect') }}</dt>
					<dd>{{ selectedTeaching.expectedEffect }}</dd>
				</div>
				<div v-if="selectedTeaching.editable.length > 0">
					<dt>{{ i18n.baseText('blocklyEditor.teaching.editable') }}</dt>
					<dd>{{ selectedTeaching.editable.join(' · ') }}</dd>
				</div>
			</dl>
		</aside>
	</section>
</template>

<style lang="scss" module>
.editor {
	display: flex;
	flex-direction: column;
	gap: var(--spacing--md);
}
.header {
	display: flex;
	align-items: flex-start;
	justify-content: space-between;
	gap: var(--spacing--md);
}
.heading {
	display: flex;
	flex-direction: column;
	gap: var(--spacing--3xs);
}
.heading p {
	margin: 0;
	color: var(--text-color--subtle);
}
.locationBadge {
	flex: 0 0 auto;
	padding: var(--spacing--3xs) var(--spacing--2xs);
	color: var(--text-color--subtle);
	background: var(--background--surface);
	border: var(--border-width) var(--border-style) var(--border-color--subtle);
	border-radius: var(--radius--xl);
	font-size: var(--font-size--3xs);
	font-weight: var(--font-weight--bold);
}
.editorGrid {
	display: grid;
	grid-template-columns: minmax(0, 3fr) minmax(16rem, 2fr);
	gap: var(--spacing--sm);
}
.blockPanel,
.preview {
	display: flex;
	min-width: 0;
	flex-direction: column;
	gap: var(--spacing--2xs);
}
.workspace {
	min-height: var(--spacing--5xl);
	height: calc(var(--spacing--5xl) + var(--spacing--5xl));
	background: var(--background--surface);
	border: var(--border-width) var(--border-style) var(--border-color--subtle);
	border-radius: var(--radius--md);
}
.compileError {
	margin: 0;
}
.teaching {
	display: flex;
	flex-direction: column;
	gap: var(--spacing--xs);
	padding: var(--spacing--sm);
	background: var(--background--surface);
	border: var(--border-width) var(--border-style) var(--border-color--subtle);
	border-radius: var(--radius--md);
}
.teachingHeading {
	display: flex;
	align-items: center;
	justify-content: space-between;
	gap: var(--spacing--sm);
}
.intentStep {
	color: var(--text-color--subtler);
	font-family: var(--font-family--monospace);
	font-size: var(--font-size--3xs);
}
.teachingDetails {
	display: grid;
	grid-template-columns: repeat(3, minmax(0, 1fr));
	gap: var(--spacing--sm);
	margin: 0;
}
.teachingDetails div {
	min-width: 0;
}
.teachingDetails dt {
	margin-bottom: var(--spacing--3xs);
	color: var(--text-color--subtler);
	font-size: var(--font-size--3xs);
	font-weight: var(--font-weight--bold);
	text-transform: uppercase;
}
.teachingDetails dd {
	margin: 0;
	color: var(--text-color);
	font-size: var(--font-size--2xs);
}
.code {
	min-height: var(--spacing--5xl);
	height: calc(var(--spacing--5xl) + var(--spacing--5xl));
	margin: 0;
	padding: var(--spacing--sm);
	color: var(--text-color);
	background: var(--background--surface);
	border: var(--border-width) var(--border-style) var(--border-color--subtle);
	border-radius: var(--radius--md);
	overflow: auto;
	white-space: pre-wrap;
}

@media (max-width: 900px) {
	.header {
		flex-direction: column;
	}
	.editorGrid {
		grid-template-columns: minmax(0, 1fr);
	}
	.teachingDetails {
		grid-template-columns: minmax(0, 1fr);
	}
	.code {
		height: auto;
		max-height: calc(var(--spacing--5xl) + var(--spacing--5xl));
	}
}
</style>
