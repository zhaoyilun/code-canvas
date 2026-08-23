<script setup lang="ts">
import { N8nNotice, N8nText } from '@n8n/design-system';
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
import { createCompetitionBlocklyTheme } from './competitionTheme';

const LOGIC_TOOLBOX_LABELS = {
	transform: '数据处理',
	logic: '条件判断',
	math: '数值运算',
	text: '文本处理',
	arrays: '数组操作',
	objects: '对象操作',
	types: '类型转换',
};

const ROBOT_TOOLBOX_LABELS = {
	robot: '动作编排',
	primitives: '基础动作',
	math: '数值',
	text: '文本',
};

const LOGIC_BLOCK_LABELS = {
	transformItem: '数据处理',
	copyInput: '复制输入',
	emptyOutput: '清空输出',
	setField: '设置字段',
	to: '设为',
	getField: '读取字段',
	path: '路径',
	deleteField: '删除字段',
	if: '如果',
	do: '执行',
	else: '否则',
	assert: '断言',
	message: '提示',
	getPath: '读取路径',
	from: '来源',
	convert: '转换',
	as: '为',
	convertText: '文本',
	convertNumber: '数值',
	convertBoolean: '布尔值',
	arrayItemAt: '读取数组项',
	index: '下标',
	mapArrayPath: '映射数组路径',
	filterArrayPath: '筛选数组路径',
	operatorEqual: '等于',
	operatorNotEqual: '不等于',
	operatorLess: '小于',
	operatorLessEqual: '小于等于',
	operatorGreater: '大于',
	operatorGreaterEqual: '大于等于',
	objectCreate: '创建对象',
	objectProperty: '添加属性',
	key: '键名',
};

const WORKBENCH_COPY = {
	logic: {
		ariaLabel: '逻辑积木教学工作台',
		badge: 'AI 代码理解',
		title: '逻辑积木工作台',
		description: '用积木描述数据处理步骤，右侧实时呈现对应的 JavaScript 代码。',
		nodeCaption: '当前节点',
		nodeBadge: 'n8n 流程节点',
		workspaceTitle: '逻辑积木',
		workspaceState: '拖拽编排',
		workspaceHint: '从输入字段开始，用积木搭出每一步数据逻辑',
		previewTitle: '生成代码预览',
		previewHint: '实时同步生成',
		path: [
			{ id: '01', label: '理解输入', detail: '识别数据与目标' },
			{ id: '02', label: '拼接逻辑', detail: '用积木表达步骤' },
			{ id: '03', label: '解释代码', detail: '同步查看结果' },
		],
	},
	robot: {
		ariaLabel: '机器人动作编排教学工作台',
		badge: 'RoboFrame · 动作编排',
		title: '机器人任务工作台',
		description: '用积木编排动作与条件，右侧实时生成结构化任务计划。',
		nodeCaption: '当前节点',
		nodeBadge: 'n8n 流程节点',
		workspaceTitle: '动作积木',
		workspaceState: '拖拽编排',
		workspaceHint: '从技能积木开始，把任务拆成可执行的机器人步骤',
		previewTitle: '任务计划预览',
		previewHint: '结构化计划',
		path: [
			{ id: '01', label: '任务意图', detail: '明确目标与约束' },
			{ id: '02', label: '技能编排', detail: '用积木组织动作' },
			{ id: '03', label: '执行计划', detail: '交给 RoboFrame' },
		],
	},
} as const;

const WORKSPACE_LOAD_ERROR = '工作区内容加载失败，请检查积木结构。';

const CHINESE_BLOCKLY_MESSAGE_OVERRIDES = {
	LOGIC_BOOLEAN_TRUE: '真',
	LOGIC_BOOLEAN_FALSE: '假',
};

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
const modeVisual = computed(() =>
	isRobotMode.value ? WORKBENCH_COPY.robot : WORKBENCH_COPY.logic,
);
const compileStatus = computed(() =>
	compileError.value ? '等待修正' : javascriptPreview.value ? '实时同步' : '准备就绪',
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
		registerN8nBlocks(blockly, LOGIC_BLOCK_LABELS);
	}
	workspace = blockly.inject(container, {
		theme: createCompetitionBlocklyTheme(loadedBlockly, props.editorMode),
		toolbox: isRobotMode.value
			? createRobotToolbox(ROBOT_TOOLBOX_LABELS)
			: createToolbox(LOGIC_TOOLBOX_LABELS),
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
			compileError.value = WORKSPACE_LOAD_ERROR;
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
		compileError.value = result.ok ? WORKSPACE_LOAD_ERROR : result.error;
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
		taskPlan: '机器人任务计划',
		executeSkill: '执行技能',
		skill: '技能',
		executePrimitive: '执行基础动作',
		primitive: '基础动作',
		wait: '等待',
		seconds: '秒',
		gripper: '夹爪动作',
		gripperOpen: '打开',
		gripperClose: '闭合',
		gripperRotateCw: '顺时针旋转',
		gripperRotateCcw: '逆时针旋转',
		condition: '当',
		conditionField: '状态字段',
		conditionOp: '条件值',
		target: '目标',
		place: '位置',
		direction: '方向',
		directionNone: '默认方向',
		distance: '距离',
		timeout: '超时',
		extraParams: '补充参数',
	};
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
		:class="[$style.editor, isRobotMode ? $style.robot : $style.logic]"
		:data-editor-mode="props.editorMode"
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
				<span :class="$style.intentStep">{{ selectedTeaching.intentStepId }}</span>
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

.robot {
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
.intentStep {
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
	.panelHeading {
		align-items: flex-start;
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
