<script setup lang="ts">
import { useI18n } from '@n8n/i18n';
import { nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';

import { createToolbox, loadWorkspaceOrDefault, registerReturnOutputBlock } from './blockly';
import {
	createDefaultWorkspace,
	parseBlocklyEditorPayload,
	serializeBlocklyEditorPayload,
} from './payload';

type Props = {
	modelValue: string;
	isReadOnly?: boolean;
};

const props = withDefaults(defineProps<Props>(), { isReadOnly: false });
const emit = defineEmits<{
	'update:modelValue': [value: string];
}>();

const i18n = useI18n();
const editorContainer = ref<HTMLDivElement>();
let workspace: BlocklyWorkspace | undefined;
let blockly: Awaited<ReturnType<typeof loadBlocklyModules>>['blockly'] | undefined;
let javascriptGenerator:
	| Awaited<ReturnType<typeof loadBlocklyModules>>['javascriptGenerator']
	| undefined;
let isSynchronizing = false;

onMounted(async () => {
	await nextTick();
	if (!editorContainer.value) return;

	const modules = await loadBlocklyModules();
	blockly = modules.blockly;
	javascriptGenerator = modules.javascriptGenerator;
	registerReturnOutputBlock(
		blockly,
		javascriptGenerator,
		modules.orderNone,
		i18n.baseText('blocklyEditor.blocks.returnOutput'),
	);

	workspace = blockly.inject(editorContainer.value, {
		toolbox: createToolbox({
			logic: i18n.baseText('blocklyEditor.categories.logic'),
			math: i18n.baseText('blocklyEditor.categories.math'),
			text: i18n.baseText('blocklyEditor.categories.text'),
			variables: i18n.baseText('blocklyEditor.categories.variables'),
			output: i18n.baseText('blocklyEditor.categories.output'),
		}),
		readOnly: props.isReadOnly,
	});
	workspace.addChangeListener(handleWorkspaceChange);

	loadModelValue(props.modelValue);
});

onBeforeUnmount(() => {
	workspace?.dispose();
});

watch(
	() => props.modelValue,
	(value) => {
		if (!workspace || value === serializeWorkspace()) return;
		loadModelValue(value);
	},
);

function loadModelValue(value: string) {
	if (!workspace || !blockly) return;

	const payload = parseBlocklyEditorPayload(value);
	isSynchronizing = true;
	const loadedModel = loadWorkspaceOrDefault(
		blockly,
		workspace,
		payload?.workspace ?? createDefaultWorkspace(),
	);
	isSynchronizing = false;

	if (payload && loadedModel) emitWorkspaceValue();
}

function handleWorkspaceChange(event: BlocklyEvent) {
	if (!isSynchronizing && !event.isUiEvent) emitWorkspaceValue();
}

function emitWorkspaceValue() {
	const value = serializeWorkspace();
	if (value !== props.modelValue) emit('update:modelValue', value);
}

function serializeWorkspace(): string {
	if (!workspace || !blockly || !javascriptGenerator) return '';

	return serializeBlocklyEditorPayload(
		blockly.serialization.workspaces.save(workspace),
		javascriptGenerator.workspaceToCode(workspace),
	);
}

async function loadBlocklyModules(): Promise<{
	blockly: typeof import('blockly');
	javascriptGenerator: (typeof import('blockly/javascript'))['javascriptGenerator'];
	orderNone: number;
}> {
	const [blocklyModule, javascriptModule] = await Promise.all([
		import('blockly'),
		import('blockly/javascript'),
	]);

	return {
		blockly: blocklyModule,
		javascriptGenerator: javascriptModule.javascriptGenerator,
		orderNone: javascriptModule.Order.NONE,
	};
}

type BlocklyWorkspace = import('blockly').WorkspaceSvg;
type BlocklyEvent = import('blockly').Events.Abstract;
</script>

<template>
	<div
		ref="editorContainer"
		:class="$style.editor"
		role="region"
		:aria-label="i18n.baseText('blocklyEditor.ariaLabel')"
	/>
</template>

<style lang="scss" module>
.editor {
	height: 24rem;
	background: var(--background--surface);
	border: 1px solid var(--border-color--subtle);
	border-radius: var(--radius--md);
}
</style>
