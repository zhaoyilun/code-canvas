<script setup lang="ts">
import { N8nNotice, N8nText } from '@n8n/design-system';
import { useI18n } from '@n8n/i18n';
import { nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { createToolbox, loadWorkspaceOrDefault, registerN8nBlocks } from './blockly';
import {
	compileBlocklyWorkspace,
	createDefaultWorkspace,
	parseBlocklyDataPayload,
	serializeBlocklyDataPayload,
} from './payload';

type Props = { modelValue: string; isReadOnly?: boolean };
const props = withDefaults(defineProps<Props>(), { isReadOnly: false });
const emit = defineEmits<{ 'update:modelValue': [value: string] }>();
const i18n = useI18n();
const editorContainer = ref<HTMLDivElement>();
const javascriptPreview = ref('');
const compileError = ref('');
let workspace: BlocklyWorkspace | undefined;
let blockly: Awaited<ReturnType<typeof loadBlocklyModule>> | undefined;
let isSynchronizing = false;
let resizeObserver: ResizeObserver | undefined;

onMounted(async () => {
	await nextTick();
	if (!editorContainer.value) return;
	const loadedBlockly = await loadBlocklyModule();
	const container = editorContainer.value;
	if (!container) return;
	blockly = loadedBlockly;
	registerN8nBlocks(blockly, {
		transformItem: i18n.baseText('blocklyEditor.blocks.transformItem'),
		copyInput: i18n.baseText('blocklyEditor.blocks.copyInput'),
		emptyOutput: i18n.baseText('blocklyEditor.blocks.emptyOutput'),
		setField: i18n.baseText('blocklyEditor.blocks.setField'),
		to: i18n.baseText('blocklyEditor.blocks.to'),
		getField: i18n.baseText('blocklyEditor.blocks.getField'),
		path: i18n.baseText('blocklyEditor.blocks.path'),
	});
	workspace = blockly.inject(container, {
		toolbox: createToolbox({
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
	const result = compileBlocklyWorkspace(blockly.serialization.workspaces.save(workspace));
	javascriptPreview.value = result.ok ? result.javascript : '';
	compileError.value = result.ok ? '' : result.error;
}
function serializeWorkspace(): string {
	if (!workspace || !blockly) return '';
	return serializeBlocklyDataPayload(blockly.serialization.workspaces.save(workspace));
}
async function loadBlocklyModule(): Promise<typeof import('blockly')> {
	return await import('blockly');
}
type BlocklyWorkspace = import('blockly').WorkspaceSvg;
type BlocklyEvent = import('blockly').Events.Abstract;
type BlocklyRuntime = Awaited<ReturnType<typeof loadBlocklyModule>>;
</script>

<template>
	<section :class="$style.editor" :aria-label="i18n.baseText('blocklyEditor.ariaLabel')">
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
			<N8nText tag="h3" size="small" bold>{{
				i18n.baseText('blocklyEditor.preview.title')
			}}</N8nText>
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
