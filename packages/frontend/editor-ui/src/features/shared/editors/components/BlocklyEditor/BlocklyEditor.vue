<script setup lang="ts">
import type { BlocklySourceMissingOperationResponse } from '@n8n/api-types';
import { N8nButton, N8nInput, N8nNotice, N8nOption, N8nSelect, N8nText } from '@n8n/design-system';
import { useRootStore } from '@n8n/stores/useRootStore';
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { useUIStore } from '@/app/stores/ui.store';
import { injectWorkflowDocumentStore } from '@/app/stores/workflowDocument.store';
import { loadWorkspaceOrDefault } from './blockly';
import { convertBlocklySource } from './blocklyImport.api';
import { replaceWorkflowWithFragment } from './blocklyWorkflowFragment';
import { createBlocklyEditorAdapter, getBlocklyEditorProfile } from './profiles';
import type { BlocklyEditorAdapter, BlocklyPayloadParseResult } from './profiles';

const CHINESE_BLOCKLY_MESSAGE_OVERRIDES = {
	LOGIC_BOOLEAN_TRUE: '真',
	LOGIC_BOOLEAN_FALSE: '假',
};

const SOURCE_EXAMPLES = [
	{
		id: 'numeric-calculation',
		label: '数值计算（直接转换）',
		teacherIntent: '计算订单总额，并在商品金额上增加固定费用。',
		source: `function transform(input) {
	const output = {};
	output.total = (input?.price ?? null) * (input?.quantity ?? null) + 2;
	return output;
}`,
	},
	{
		id: 'clamp-score',
		label: '成绩限幅（AI 生成函数）',
		teacherIntent: '把成绩限制在 0 到 100 之间，空值继续保持为空。',
		source: `function transform(input) {
	const output = {};
	output.score = clampScore(input?.score ?? null, 0, 100);
	return output;
}`,
	},
] as const;

type SourceImportState = 'idle' | 'converting' | 'generating';
type SourceExampleId = (typeof SOURCE_EXAMPLES)[number]['id'];

type Props = {
	modelValue: string;
	profileId: string;
	isReadOnly?: boolean;
};
const props = withDefaults(defineProps<Props>(), {
	isReadOnly: false,
});
const emit = defineEmits<{ 'update:modelValue': [value: string] }>();
const rootStore = useRootStore();
const uiStore = useUIStore();
const workflowDocumentStore = injectWorkflowDocumentStore();
const profile = computed(() => getBlocklyEditorProfile(props.profileId));
const editorContainer = ref<HTMLDivElement>();
const javascriptPreview = ref('');
const compileError = ref('');
const selectedTeaching = ref<TeachingAnnotation>();
const selectedSourceExample = ref<SourceExampleId>(SOURCE_EXAMPLES[0].id);
const sourceCode = ref<string>(SOURCE_EXAMPLES[0].source);
const teacherIntent = ref<string>(SOURCE_EXAMPLES[0].teacherIntent);
const sourceImportState = ref<SourceImportState>('idle');
const sourceImportError = ref('');
const missingOperation = ref<BlocklySourceMissingOperationResponse>();
let workspace: BlocklyWorkspace | undefined;
let blockly: Awaited<ReturnType<typeof loadBlocklyModule>> | undefined;
let adapter: BlocklyEditorAdapter | undefined;
let isSynchronizing = false;
let resizeObserver: ResizeObserver | undefined;
let editorRevision = 0;
let isComponentMounted = false;
let previousWorkflowFragmentNodeRefs: ReadonlySet<string> | undefined;

const isCapabilityAppearance = computed(() => profile.value.appearance === 'capability');
const supportsSourceImport = computed(() => profile.value.id === 'data-transform');
const isSourceImporting = computed(() => sourceImportState.value !== 'idle');
const modeVisual = computed(() => profile.value.copy);
const compileStatus = computed(() =>
	compileError.value ? '等待修正' : javascriptPreview.value ? '实时同步' : '准备就绪',
);

onMounted(async () => {
	isComponentMounted = true;
	await rebuildEditor();
});

onBeforeUnmount(() => {
	isComponentMounted = false;
	editorRevision += 1;
	disposeEditor();
});

watch(
	() => props.profileId,
	async () => {
		if (isComponentMounted) await rebuildEditor();
	},
);

watch(
	() => props.modelValue,
	(value) => {
		if (!workspace || value === serializeWorkspace()) return;
		loadModelValue(value);
	},
);

async function rebuildEditor() {
	const revision = ++editorRevision;
	disposeEditor();
	javascriptPreview.value = '';
	compileError.value = '';
	selectedTeaching.value = undefined;

	const nextProfile = getBlocklyEditorProfile(props.profileId);
	const nextAdapter = createBlocklyEditorAdapter(nextProfile.id);
	await nextTick();
	const container = editorContainer.value;
	if (!container || !isComponentMounted || revision !== editorRevision) return;
	const loadedBlockly = blockly ?? (await loadBlocklyModule());
	if (!isComponentMounted || revision !== editorRevision) return;

	blockly = loadedBlockly;
	const initialPayload = nextAdapter.parsePayload(props.modelValue);
	nextAdapter.registerBlocks(loadedBlockly);
	const nextWorkspace = loadedBlockly.inject(container, {
		theme: nextProfile.createTheme(loadedBlockly),
		toolbox: nextAdapter.createToolbox(),
		readOnly: props.isReadOnly,
	});
	adapter = nextAdapter;
	workspace = nextWorkspace;
	nextWorkspace.addChangeListener(handleWorkspaceChange);
	resizeObserver = new ResizeObserver(() => loadedBlockly.svgResize(nextWorkspace));
	resizeObserver.observe(container);
	loadParsedPayload(initialPayload);
}

function disposeEditor() {
	resizeObserver?.disconnect();
	resizeObserver = undefined;
	const currentWorkspace = workspace;
	workspace = undefined;
	adapter = undefined;
	if (!currentWorkspace) return;
	currentWorkspace.removeChangeListener(handleWorkspaceChange);
	currentWorkspace.dispose();
}

function selectSourceExample(value: unknown) {
	if (typeof value !== 'string') return;
	const example = SOURCE_EXAMPLES.find((candidate) => candidate.id === value);
	if (!example) return;
	selectedSourceExample.value = example.id;
	sourceCode.value = example.source;
	teacherIntent.value = example.teacherIntent;
	missingOperation.value = undefined;
	sourceImportError.value = '';
}

async function requestSourceConversion(generateMissingOperation: boolean) {
	if (!supportsSourceImport.value || isSourceImporting.value) return;
	if (!sourceCode.value.trim()) {
		sourceImportError.value = '请先输入需要转换的 TypeScript。';
		return;
	}

	sourceImportState.value = generateMissingOperation ? 'generating' : 'converting';
	sourceImportError.value = '';
	if (!generateMissingOperation) missingOperation.value = undefined;

	try {
		const trimmedTeacherIntent = teacherIntent.value.trim();
		const response = await convertBlocklySource(rootStore.restApiContext, {
			source: sourceCode.value,
			currentBlocklyPayload: props.modelValue,
			generateMissingOperation,
			...(trimmedTeacherIntent ? { teacherIntent: trimmedTeacherIntent } : {}),
		});
		if (response.status === 'missing-operation') {
			missingOperation.value = response;
			return;
		}

		missingOperation.value = undefined;
		emit('update:modelValue', response.blocklyPayload);
		replaceWorkflowWithFragment(
			workflowDocumentStore.value,
			response.workflowFragment,
			previousWorkflowFragmentNodeRefs,
		);
		previousWorkflowFragmentNodeRefs = new Set(
			response.workflowFragment.nodes.map((node) => node.nodeRef),
		);
		uiStore.markStateDirty();
	} catch (error) {
		sourceImportError.value = getSourceImportError(error);
	} finally {
		sourceImportState.value = 'idle';
	}
}

function getSourceImportError(error: unknown): string {
	if (error instanceof Error && error.message.trim()) return error.message;
	if (typeof error === 'string' && error.trim()) return error;
	return '转换失败，请重新操作。';
}

function loadModelValue(value: string) {
	const currentWorkspace = workspace;
	const currentBlockly = blockly;
	const currentAdapter = adapter;
	if (!currentWorkspace || !currentBlockly || !currentAdapter) return;
	const payload = currentAdapter.parsePayload(value);
	if (payload.ok) {
		currentAdapter.registerBlocks(currentBlockly);
		currentWorkspace.updateToolbox(currentAdapter.createToolbox());
	}
	loadParsedPayload(payload);
}
function loadParsedPayload(payload: BlocklyPayloadParseResult) {
	const currentWorkspace = workspace;
	const currentBlockly = blockly;
	const currentAdapter = adapter;
	if (!currentWorkspace || !currentBlockly || !currentAdapter) return;
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
			payload.workspace,
			currentAdapter.createDefaultWorkspace(),
		),
	);
	if (!loadedWorkspace) {
		javascriptPreview.value = '';
		compileError.value = currentAdapter.workspaceLoadError(payload.workspace);
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
	if (!workspace || !blockly || !adapter) return;
	const state = blockly.serialization.workspaces.save(workspace);
	const result = adapter.compileWorkspace(state);
	javascriptPreview.value = result.ok ? result.preview : '';
	compileError.value = result.ok ? '' : result.error;
}
function serializeWorkspace(): string {
	if (!workspace || !blockly || !adapter) return '';
	const state = blockly.serialization.workspaces.save(workspace);
	return adapter.serializePayload(state);
}
async function loadBlocklyModule(): Promise<typeof import('blockly')> {
	const [loadedBlockly, chineseMessages] = await Promise.all([
		import('blockly'),
		import('blockly/msg/zh-hans'),
	]);
	const localeMessages: Record<string, string> = {};
	for (const [key, value] of Object.entries(chineseMessages)) {
		if (typeof value === 'string') localeMessages[key] = value;
	}
	Object.assign(localeMessages, CHINESE_BLOCKLY_MESSAGE_OVERRIDES);
	loadedBlockly.setLocale(localeMessages);
	return loadedBlockly;
}
type TeachingAnnotation = {
	stepRef: string;
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
			typeof record.stepRef !== 'string' ||
			typeof annotation.what !== 'string' ||
			typeof annotation.why !== 'string' ||
			!Array.isArray(annotation.editable) ||
			!annotation.editable.every((item) => typeof item === 'string') ||
			typeof annotation.expectedEffect !== 'string'
		) {
			return undefined;
		}
		return {
			stepRef: record.stepRef,
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
		:class="[$style.editor, isCapabilityAppearance ? $style.capability : $style.logic]"
		:data-editor-profile="profile.id"
		:aria-label="modeVisual.ariaLabel"
	>
		<header :class="$style.header">
			<div :class="$style.heading">
				<div :class="$style.modeLine">
					<span :class="$style.modeBadge">{{ modeVisual.badge }}</span>
					<span :class="$style.modeRule" aria-hidden="true" />
					<span :class="$style.modeCaption">{{ modeVisual.nodeCaption }}</span>
				</div>
				<N8nText tag="h3" size="medium" bold>{{ modeVisual.title }}</N8nText>
				<N8nText tag="p" size="small">{{ modeVisual.description }}</N8nText>
			</div>
			<div :class="$style.headerStatus">
				<span
					:class="[$style.statusBadge, compileError ? $style.statusWarning : $style.statusReady]"
				>
					<span :class="$style.statusDot" aria-hidden="true" />
					{{ compileStatus }}
				</span>
				<span :class="$style.locationBadge">{{ modeVisual.nodeBadge }}</span>
			</div>
		</header>

		<ol :class="$style.learningPath" aria-label="教学路径">
			<li v-for="step in modeVisual.path" :key="step.id" :class="$style.pathStep">
				<span :class="$style.pathIndex">{{ step.id }}</span>
				<span :class="$style.pathCopy">
					<strong>{{ step.label }}</strong>
					<small>{{ step.detail }}</small>
				</span>
			</li>
		</ol>

		<form
			v-if="supportsSourceImport"
			:class="$style.sourceImporter"
			data-test-id="blockly-source-importer"
			@submit.prevent="requestSourceConversion(false)"
		>
			<div :class="$style.importHeading">
				<div>
					<N8nText tag="h4" size="small" bold>TypeScript 转双画布</N8nText>
					<N8nText tag="p" size="small">
						选择示例或粘贴代码；普通语句直接转换，未知函数可现场生成积木。
					</N8nText>
				</div>
				<span :class="$style.panelState">源码入口</span>
			</div>
			<div :class="$style.importGrid">
				<label :class="$style.importField">
					<span :class="$style.fieldLabel">示例程序</span>
					<N8nSelect
						:model-value="selectedSourceExample"
						:disabled="isReadOnly || isSourceImporting"
						:teleported="false"
						data-test-id="blockly-source-example"
						@update:model-value="selectSourceExample"
					>
						<N8nOption
							v-for="example in SOURCE_EXAMPLES"
							:key="example.id"
							:value="example.id"
							:label="example.label"
						/>
					</N8nSelect>
				</label>
				<label :class="$style.importField">
					<span :class="$style.fieldLabel">教师意图（选填）</span>
					<N8nInput
						v-model="teacherIntent"
						:disabled="isReadOnly || isSourceImporting"
						autocomplete="off"
						placeholder="例如：将成绩限制在 0 到 100 之间"
						data-test-id="blockly-teacher-intent"
					/>
				</label>
			</div>
			<label :class="[$style.importField, $style.sourceField]">
				<span :class="$style.fieldLabel">TypeScript 源码</span>
				<N8nInput
					v-model="sourceCode"
					type="textarea"
					:rows="8"
					:disabled="isReadOnly || isSourceImporting"
					autocomplete="off"
					:spellcheck="false"
					data-test-id="blockly-source-input"
				/>
			</label>
			<div :class="$style.importActions">
				<N8nButton
					type="submit"
					variant="solid"
					size="medium"
					:loading="sourceImportState === 'converting'"
					:disabled="isReadOnly || !sourceCode.trim() || sourceImportState === 'generating'"
					data-test-id="blockly-source-convert"
				>
					转换为双画布
				</N8nButton>
				<N8nText tag="span" size="small"> 转换完成后，下方积木工作区会自动加载最新结果。 </N8nText>
			</div>
		</form>

		<section
			v-if="missingOperation"
			:class="$style.missingOperation"
			data-test-id="blockly-missing-operation"
		>
			<div :class="$style.missingCopy">
				<N8nText tag="h4" size="small" bold>发现缺少函数模块</N8nText>
				<N8nText tag="p" size="small">{{ missingOperation.message }}</N8nText>
				<span :class="$style.operationSignature">
					{{ `${missingOperation.qualifiedName} / ${missingOperation.arity} 个参数` }}
				</span>
			</div>
			<N8nButton
				type="button"
				variant="solid"
				size="medium"
				:loading="sourceImportState === 'generating'"
				:disabled="isReadOnly || sourceImportState === 'converting'"
				data-test-id="blockly-ai-generate"
				@click="requestSourceConversion(true)"
			>
				AI 生成模块
			</N8nButton>
		</section>
		<N8nNotice v-if="sourceImportError" type="warning" data-test-id="blockly-source-error">
			{{ sourceImportError }}
		</N8nNotice>

		<div :class="$style.editorGrid">
			<section :class="$style.blockPanel">
				<div :class="$style.panelHeading">
					<div :class="$style.panelTitle">
						<span :class="$style.panelIndex">01</span>
						<N8nText tag="h4" size="small" bold>
							{{ modeVisual.workspaceTitle }}
						</N8nText>
					</div>
					<span :class="$style.panelState">{{ modeVisual.workspaceState }}</span>
				</div>
				<div :class="$style.workspaceShell">
					<div ref="editorContainer" :class="$style.workspace" data-test-id="blockly-workspace" />
					<div :class="$style.workspaceGuide" aria-hidden="true">
						<span :class="$style.guideDot" />
						{{ modeVisual.workspaceHint }}
					</div>
				</div>
			</section>
			<section :class="$style.preview">
				<div :class="$style.panelHeading">
					<div :class="$style.panelTitle">
						<span :class="$style.panelIndex">02</span>
						<N8nText tag="h4" size="small" bold>{{ modeVisual.previewTitle }}</N8nText>
					</div>
					<span :class="$style.panelState">{{ modeVisual.previewHint }}</span>
				</div>
				<pre
					:class="$style.code"
					data-test-id="blockly-javascript-preview"
				><code>{{ javascriptPreview }}</code></pre>
			</section>
		</div>
		<N8nNotice
			v-if="compileError"
			type="warning"
			:class="$style.compileError"
			data-test-id="blockly-compile-error"
		>
			{{ `编译提示：${compileError}` }}
		</N8nNotice>
		<aside
			v-if="selectedTeaching"
			:class="$style.teaching"
			data-test-id="blockly-teaching-annotation"
		>
			<div :class="$style.teachingKicker">
				<span :class="$style.teachingSignal" aria-hidden="true" />
				<span>AI 教学解释</span>
			</div>
			<div :class="$style.teachingHeading">
				<N8nText tag="h4" size="small" bold>{{ selectedTeaching.what }}</N8nText>
				<span :class="$style.stepRef">{{ selectedTeaching.stepRef }}</span>
			</div>
			<dl :class="$style.teachingDetails">
				<div>
					<dt>为什么这样做</dt>
					<dd>{{ selectedTeaching.why }}</dd>
				</div>
				<div>
					<dt>预期效果</dt>
					<dd>{{ selectedTeaching.expectedEffect }}</dd>
				</div>
				<div v-if="selectedTeaching.editable.length > 0">
					<dt>可调整项</dt>
					<dd>{{ selectedTeaching.editable.join(' · ') }}</dd>
				</div>
			</dl>
		</aside>
	</section>
</template>

<style lang="scss" module>
.editor {
	--blockly-editor--accent: var(--color--blue-600);
	--blockly-editor--accent-strong: var(--color--blue-800);
	--blockly-editor--accent-soft: var(--background--info);
	--blockly-editor--accent-text: var(--text-color--info);
	--blockly-editor--stage-height: clamp(22rem, 48vh, 34rem);

	display: flex;
	flex-direction: column;
	gap: var(--spacing--md);
	min-width: 0;
	max-width: 100%;
	padding: var(--spacing--md);
	border: var(--border-width) var(--border-style) var(--border-color--subtle);
	border-radius: var(--radius--lg);
	background:
		radial-gradient(circle at top right, var(--blockly-editor--accent-soft), transparent 42%),
		var(--background--surface);
	box-shadow: 0 var(--spacing--2xs) var(--spacing--xl) var(--color--black-alpha-100);
	container-type: inline-size;
}

.capability {
	--blockly-editor--accent: var(--color--mint-600);
	--blockly-editor--accent-strong: var(--color--mint-800);
	--blockly-editor--accent-soft: var(--background--success);
	--blockly-editor--accent-text: var(--text-color--success);
}
.header {
	display: flex;
	align-items: flex-start;
	justify-content: space-between;
	flex-wrap: wrap;
	gap: var(--spacing--md);
}
.heading {
	display: flex;
	flex: 1 1 22rem;
	flex-direction: column;
	gap: var(--spacing--3xs);
	min-width: 0;
}
.heading p {
	margin: 0;
	color: var(--text-color--subtle);
	line-height: var(--line-height--lg);
}

.modeLine,
.headerStatus,
.panelHeading,
.panelTitle,
.teachingKicker {
	display: flex;
	align-items: center;
}

.modeLine {
	gap: var(--spacing--2xs);
	min-width: 0;
}

.modeBadge,
.locationBadge,
.statusBadge,
.panelState {
	white-space: nowrap;
	font-size: var(--font-size--2xs);
	font-weight: var(--font-weight--bold);
	line-height: var(--line-height--md);
}

.modeBadge {
	padding: var(--spacing--4xs) var(--spacing--2xs);
	border: var(--border-width) var(--border-style) var(--blockly-editor--accent);
	border-radius: var(--radius--xl);
	color: var(--blockly-editor--accent-strong);
	background: var(--background--surface);
	letter-spacing: var(--letter-spacing--tighter);
}

.modeRule {
	width: var(--spacing--sm);
	height: var(--border-width);
	background: var(--border-color--strong);
}

.modeCaption {
	color: var(--text-color--subtler);
	font-size: var(--font-size--2xs);
}

.headerStatus {
	flex: 0 0 auto;
	justify-content: flex-end;
	gap: var(--spacing--2xs);
	flex-wrap: wrap;
}
.locationBadge {
	padding: var(--spacing--3xs) var(--spacing--2xs);
	color: var(--text-color--subtle);
	background: var(--background--surface);
	border: var(--border-width) var(--border-style) var(--border-color--subtle);
	border-radius: var(--radius--xl);
}

.statusBadge {
	display: inline-flex;
	align-items: center;
	gap: var(--spacing--4xs);
	padding: var(--spacing--3xs) var(--spacing--2xs);
	border: var(--border-width) var(--border-style) var(--border-color--success);
	border-radius: var(--radius--xl);
	color: var(--text-color--success);
	background: var(--background--success);
}

.statusWarning {
	border-color: var(--border-color--warning);
	color: var(--text-color--warning);
	background: var(--background--warning);
}

.statusReady .statusDot {
	background: var(--color--green-600);
}

.statusWarning .statusDot {
	background: var(--color--yellow-600);
}

.statusDot,
.guideDot,
.teachingSignal {
	flex: 0 0 auto;
	width: var(--spacing--3xs);
	height: var(--spacing--3xs);
	border-radius: var(--radius--xl);
}

.learningPath {
	display: grid;
	grid-template-columns: repeat(3, minmax(0, 1fr));
	gap: var(--spacing--2xs);
	padding: 0;
	margin: 0;
	list-style: none;
}

.pathStep {
	position: relative;
	display: flex;
	align-items: center;
	gap: var(--spacing--2xs);
	min-width: 0;
	padding: var(--spacing--2xs);
	border: var(--border-width) var(--border-style) var(--border-color--subtle);
	border-radius: var(--radius--md);
	background: var(--background--surface);
	transition:
		border-color var(--duration--base) var(--easing--ease-out),
		transform var(--duration--base) var(--easing--ease-out);
}

@media (hover: hover) {
	.pathStep:hover {
		border-color: var(--blockly-editor--accent);
		transform: translateY(calc(-1 * var(--spacing--5xs)));
	}
}

.pathIndex,
.panelIndex {
	display: inline-flex;
	align-items: center;
	justify-content: center;
	flex: 0 0 auto;
	width: var(--spacing--lg);
	height: var(--spacing--lg);
	border-radius: var(--radius--sm);
	color: var(--text-color--inverse);
	background: var(--blockly-editor--accent);
	font-size: var(--font-size--3xs);
	font-weight: var(--font-weight--bold);
	font-variant-numeric: tabular-nums;
}

.pathCopy {
	display: flex;
	min-width: 0;
	flex-direction: column;
	gap: var(--spacing--5xs);
}

.pathCopy strong {
	color: var(--text-color);
	font-size: var(--font-size--xs);
	font-weight: var(--font-weight--bold);
	line-height: var(--line-height--sm);
}

.pathCopy small {
	overflow: hidden;
	color: var(--text-color--subtler);
	font-size: var(--font-size--2xs);
	line-height: var(--line-height--sm);
	text-overflow: ellipsis;
	white-space: nowrap;
}

.sourceImporter {
	display: flex;
	flex-direction: column;
	gap: var(--spacing--sm);
	padding: var(--spacing--sm);
	border: var(--border-width) var(--border-style) var(--border-color--subtle);
	border-radius: var(--radius--lg);
	background: var(--background--surface);
	box-shadow: var(--shadow--2xs);
}

.importHeading,
.importActions,
.missingOperation {
	display: flex;
	align-items: center;
	justify-content: space-between;
	gap: var(--spacing--sm);
}

.importHeading > div,
.missingCopy {
	display: flex;
	min-width: 0;
	flex-direction: column;
	gap: var(--spacing--3xs);
}

.importHeading p,
.missingCopy p {
	margin: 0;
	color: var(--text-color--subtle);
}

.importGrid {
	display: grid;
	grid-template-columns: minmax(12rem, 0.4fr) minmax(0, 1fr);
	gap: var(--spacing--sm);
}

.importField {
	display: flex;
	min-width: 0;
	flex-direction: column;
	gap: var(--spacing--3xs);
}

.fieldLabel {
	color: var(--text-color);
	font-size: var(--font-size--xs);
	font-weight: var(--font-weight--bold);
}

.sourceField :global(textarea) {
	font-family: var(--font-family--monospace);
	line-height: var(--line-height--lg);
}

.importActions {
	justify-content: flex-start;
	flex-wrap: wrap;
}

.importActions span {
	color: var(--text-color--subtle);
}

.missingOperation {
	padding: var(--spacing--sm);
	border: var(--border-width) var(--border-style) var(--blockly-editor--accent);
	border-radius: var(--radius--lg);
	background: var(--blockly-editor--accent-soft);
}

.operationSignature {
	align-self: flex-start;
	padding: var(--spacing--4xs) var(--spacing--2xs);
	border-radius: var(--radius--sm);
	color: var(--blockly-editor--accent-text);
	background: var(--background--surface);
	font-family: var(--font-family--monospace);
	font-size: var(--font-size--xs);
}

.editorGrid {
	display: grid;
	grid-template-columns: minmax(0, 1.65fr) minmax(20rem, 0.85fr);
	align-items: stretch;
	gap: var(--spacing--sm);
}
.blockPanel,
.preview {
	display: flex;
	min-width: 0;
	max-width: 100%;
	flex-direction: column;
	gap: var(--spacing--2xs);
	padding: var(--spacing--sm);
	border: var(--border-width) var(--border-style) var(--border-color--subtle);
	border-radius: var(--radius--lg);
	background: var(--background--surface);
	box-shadow: 0 var(--spacing--4xs) var(--spacing--md) var(--color--black-alpha-50);
}

.panelHeading {
	justify-content: space-between;
	flex-wrap: wrap;
	gap: var(--spacing--sm);
}

.panelTitle {
	min-width: 0;
	gap: var(--spacing--2xs);
}

.panelIndex {
	width: var(--spacing--md);
	height: var(--spacing--md);
	border-radius: var(--radius--sm);
}

.panelState {
	padding: var(--spacing--4xs) var(--spacing--2xs);
	border-radius: var(--radius--xl);
	color: var(--blockly-editor--accent-text);
	background: var(--blockly-editor--accent-soft);
}

.workspaceShell {
	position: relative;
	min-width: 0;
	min-height: var(--blockly-editor--stage-height);
	height: var(--blockly-editor--stage-height);
	overflow: hidden;
	border: var(--border-width) var(--border-style) var(--border-color--strong);
	border-radius: var(--radius--md);
	background:
		linear-gradient(var(--background--subtle) var(--background--subtle)),
		linear-gradient(
			90deg,
			var(--border-color--subtle) var(--border-width),
			transparent var(--border-width)
		),
		linear-gradient(
			var(--border-color--subtle) var(--border-width),
			transparent var(--border-width)
		);
	background-size:
		auto,
		var(--spacing--lg) var(--spacing--lg),
		var(--spacing--lg) var(--spacing--lg);
}

.workspace {
	min-width: 0;
	width: 100%;
	height: 100%;
	background: transparent;

	:global(.blocklySvg) {
		background: transparent;
	}

	:global(.blocklyToolboxDiv) {
		max-inline-size: min(11rem, 46%);
		border-right: var(--border-width) var(--border-style) var(--border-color--subtle);
		box-shadow: var(--shadow--light);
	}

	:global(.blocklyToolboxCategory) {
		margin: var(--spacing--4xs);
		min-width: 0;
		border-radius: var(--radius--sm);
	}

	:global(.blocklyToolboxCategory:not(.blocklyToolboxSelected):hover) {
		background: var(--background--hover);
	}

	:global(.blocklyToolboxSelected) {
		background: var(--blockly-editor--accent-soft);
	}

	:global(.blocklyTreeLabel) {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		font-family: var(--font-family);
		font-size: var(--font-size--xs);
		font-weight: var(--font-weight--medium);
	}

	:global(.blocklyFlyout) {
		border-right: var(--border-width) var(--border-style) var(--border-color--subtle);
	}

	:global(.blocklyScrollbarHandle) {
		fill: var(--blockly-editor--accent);
	}

	:global(.blocklyMainBackground) {
		stroke: transparent;
	}
}

.workspaceGuide {
	position: absolute;
	right: var(--spacing--sm);
	bottom: var(--spacing--sm);
	display: inline-flex;
	align-items: center;
	gap: var(--spacing--4xs);
	max-width: min(78%, var(--spacing--5xl));
	padding: var(--spacing--4xs) var(--spacing--2xs);
	border: var(--border-width) var(--border-style) var(--border-color--subtle);
	border-radius: var(--radius--xl);
	color: var(--text-color--subtle);
	background: var(--background--surface);
	box-shadow: var(--shadow--light);
	pointer-events: none;
	font-size: var(--font-size--2xs);
	line-height: var(--line-height--sm);
}

.guideDot,
.teachingSignal {
	background: var(--blockly-editor--accent);
}
.compileError {
	margin: 0;
}
.teaching {
	display: flex;
	flex-direction: column;
	gap: var(--spacing--xs);
	padding: var(--spacing--sm);
	border: var(--border-width) var(--border-style) var(--blockly-editor--accent);
	border-radius: var(--radius--lg);
	background: var(--blockly-editor--accent-soft);
	box-shadow: 0 var(--spacing--4xs) var(--spacing--md) var(--color--black-alpha-50);
}

.teachingKicker {
	gap: var(--spacing--4xs);
	color: var(--blockly-editor--accent-text);
	font-size: var(--font-size--2xs);
	font-weight: var(--font-weight--bold);
	letter-spacing: var(--letter-spacing--tighter);
}
.teachingHeading {
	display: flex;
	align-items: center;
	justify-content: space-between;
	gap: var(--spacing--sm);
}
.stepRef {
	padding: var(--spacing--4xs) var(--spacing--2xs);
	border-radius: var(--radius--sm);
	color: var(--blockly-editor--accent-text);
	background: var(--background--surface);
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
	font-size: var(--font-size--2xs);
	font-weight: var(--font-weight--bold);
	text-transform: uppercase;
}
.teachingDetails dd {
	margin: 0;
	color: var(--text-color);
	font-size: var(--font-size--xs);
}
.code {
	min-width: 0;
	min-height: var(--blockly-editor--stage-height);
	height: var(--blockly-editor--stage-height);
	margin: 0;
	padding: var(--spacing--sm);
	color: var(--color--neutral-white);
	background:
		linear-gradient(135deg, var(--color--slate-900), var(--color--slate-800)),
		var(--color--slate-900);
	border: var(--border-width) var(--border-style) var(--color--slate-700);
	border-radius: var(--radius--md);
	overflow: auto;
	white-space: pre;
	font-family: var(--font-family--monospace);
	font-size: var(--font-size--xs);
	line-height: var(--line-height--xl);
}

@container (max-width: 62rem) {
	.editor {
		--blockly-editor--stage-height: clamp(20rem, 42vh, 28rem);
	}

	.editorGrid {
		grid-template-columns: minmax(0, 1fr);
	}

	.code {
		min-height: clamp(15rem, 32vh, 20rem);
		height: clamp(15rem, 32vh, 20rem);
	}
}

@container (max-width: 42rem) {
	.editor {
		--blockly-editor--stage-height: clamp(20rem, 48vh, 25rem);

		padding: var(--spacing--sm);
		gap: var(--spacing--sm);
	}

	.header {
		gap: var(--spacing--sm);
	}

	.headerStatus {
		justify-content: flex-start;
	}

	.modeLine,
	.panelHeading,
	.importHeading,
	.missingOperation {
		align-items: flex-start;
	}

	.importGrid {
		grid-template-columns: minmax(0, 1fr);
	}

	.missingOperation {
		flex-direction: column;
	}

	.learningPath {
		grid-template-columns: minmax(0, 1fr);
	}

	.pathCopy small {
		white-space: normal;
	}

	.workspaceGuide {
		max-width: calc(100% - var(--spacing--lg));
		font-size: var(--font-size--3xs);
	}

	.teachingDetails {
		grid-template-columns: minmax(0, 1fr);
	}

	.code {
		min-height: 14rem;
		height: 14rem;
		font-size: var(--font-size--2xs);
	}
}
</style>
