import type * as Blockly from 'blockly';

import { createToolbox, registerN8nBlocks } from './blockly';
import {
	compileCapabilityPlanWorkspace,
	createCapabilityPlanToolbox,
	createEmptyCapabilityPlanWorkspace,
	formatCapabilityPlanError,
	parseCapabilityPlanPayload,
	registerCapabilityPlanBlocks,
	serializeCapabilityPlanPayload,
} from './capabilityPlan';
import type { CapabilityPlanBlockLabels, CapabilityPlanPayloadV1 } from './capabilityPlan';
import { createTeachingBlocklyTheme } from './teachingTheme';
import {
	compileBlocklyWorkspace,
	createDefaultWorkspace,
	parseBlocklyDataPayload,
	serializeBlocklyDataPayload,
} from './payload';

export type BlocklyRuntime = Pick<
	typeof Blockly,
	'Blocks' | 'FieldDropdown' | 'FieldTextInput' | 'serialization' | 'Theme' | 'Themes'
>;
export type BlocklyWorkspaceState = Record<string, unknown>;
export type BlocklyEditorProfileId = string;

export type BlocklyPayloadParseResult =
	| { ok: true; workspace: BlocklyWorkspaceState }
	| { ok: false; error: string };

export type BlocklyPreviewResult = { ok: true; preview: string } | { ok: false; error: string };

export type BlocklyWorkbenchCopy = {
	ariaLabel: string;
	badge: string;
	title: string;
	description: string;
	nodeCaption: string;
	nodeBadge: string;
	workspaceTitle: string;
	workspaceState: string;
	workspaceHint: string;
	previewTitle: string;
	previewHint: string;
	path: ReadonlyArray<{ id: string; label: string; detail: string }>;
};

export type BlocklyEditorAdapter = {
	registerBlocks: (blockly: BlocklyRuntime) => void;
	createToolbox: () => Blockly.utils.toolbox.ToolboxInfo;
	parsePayload: (value: string) => BlocklyPayloadParseResult;
	createDefaultWorkspace: () => BlocklyWorkspaceState;
	compileWorkspace: (workspace: BlocklyWorkspaceState) => BlocklyPreviewResult;
	serializePayload: (workspace: BlocklyWorkspaceState) => string;
	workspaceLoadError: (workspace: BlocklyWorkspaceState) => string;
};

export type BlocklyEditorAdapterFactory = () => BlocklyEditorAdapter;

export type BlocklyEditorProfile = {
	id: BlocklyEditorProfileId;
	adapterId: string;
	appearance: 'logic' | 'capability';
	copy: BlocklyWorkbenchCopy;
	createTheme: (blockly: BlocklyRuntime) => Blockly.Theme;
};

const WORKSPACE_LOAD_ERROR = '工作区内容加载失败，请检查积木结构。';
const CAPABILITY_PAYLOAD_REQUIRED = '能力计划需要包含 catalog 和 planRef 的有效 payload。';

const LOGIC_TOOLBOX_LABELS = {
	transform: '数据处理',
	logic: '条件判断',
	math: '数值运算',
	text: '文本处理',
	arrays: '数组操作',
	objects: '对象操作',
	types: '类型转换',
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

const CAPABILITY_PLAN_BLOCK_LABELS: CapabilityPlanBlockLabels = {
	plan: '能力执行计划',
	step: '执行能力',
	stepRef: '步骤标识',
	capability: '能力',
	argumentsJson: '参数 JSON',
	label: '标签（可选）',
	timeoutMs: '超时毫秒（可选）',
	guardJson: '条件 JSON（可选）',
};

const adapterFactories = new Map<string, BlocklyEditorAdapterFactory>();
const profiles = new Map<string, BlocklyEditorProfile>();

export function registerBlocklyEditorAdapter(id: string, factory: BlocklyEditorAdapterFactory) {
	if (adapterFactories.has(id)) throw new Error(`Blockly adapter already registered: ${id}`);
	adapterFactories.set(id, factory);
}

export function registerBlocklyEditorProfile(profile: BlocklyEditorProfile) {
	if (profiles.has(profile.id))
		throw new Error(`Blockly editor profile already registered: ${profile.id}`);
	profiles.set(profile.id, profile);
}

export function getBlocklyEditorProfile(profileId: BlocklyEditorProfileId): BlocklyEditorProfile {
	const profile = profiles.get(profileId);
	if (!profile) throw new Error(`Unknown Blockly editor profile: ${profileId}`);
	return profile;
}

export function createBlocklyEditorAdapter(
	profileId: BlocklyEditorProfileId,
): BlocklyEditorAdapter {
	const profile = getBlocklyEditorProfile(profileId);
	const factory = adapterFactories.get(profile.adapterId);
	if (!factory) throw new Error(`Unknown Blockly adapter: ${profile.adapterId}`);
	return factory();
}

registerBlocklyEditorAdapter('data-transform', createDataTransformAdapter);
registerBlocklyEditorAdapter('capability-plan', createCapabilityPlanAdapter);

registerBlocklyEditorProfile({
	id: 'data-transform',
	adapterId: 'data-transform',
	appearance: 'logic',
	copy: {
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
	createTheme: (blockly) => createTeachingBlocklyTheme(blockly, 'logic'),
});

registerBlocklyEditorProfile({
	id: 'capability-plan',
	adapterId: 'capability-plan',
	appearance: 'capability',
	copy: {
		ariaLabel: '能力计划积木教学工作台',
		badge: '通用能力编排',
		title: '能力计划工作台',
		description: '根据当前节点提供的能力目录，用积木组织可执行步骤与 JSON 参数。',
		nodeCaption: '当前节点',
		nodeBadge: 'n8n 流程节点',
		workspaceTitle: '能力步骤',
		workspaceState: '拖拽编排',
		workspaceHint: '从能力目录选择操作，为每个步骤配置 JSON 对象参数',
		previewTitle: 'ExecutionPlanV1 预览',
		previewHint: '结构化执行计划',
		path: [
			{ id: '01', label: '选择能力', detail: '从目录确定操作' },
			{ id: '02', label: '配置参数', detail: '使用 JSON 表达输入' },
			{ id: '03', label: '生成计划', detail: '检查执行步骤' },
		],
	},
	createTheme: (blockly) => createTeachingBlocklyTheme(blockly, 'capability'),
});

function createDataTransformAdapter(): BlocklyEditorAdapter {
	return {
		registerBlocks: (blockly) => registerN8nBlocks(blockly, LOGIC_BLOCK_LABELS),
		createToolbox: () => createToolbox(LOGIC_TOOLBOX_LABELS),
		parsePayload: (value) => {
			const result = parseBlocklyDataPayload(value);
			return result.ok ? { ok: true, workspace: result.payload.workspace } : result;
		},
		createDefaultWorkspace,
		compileWorkspace: (workspace) => {
			const result = compileBlocklyWorkspace(workspace);
			return result.ok ? { ok: true, preview: result.javascript } : result;
		},
		serializePayload: serializeBlocklyDataPayload,
		workspaceLoadError: (workspace) => {
			const result = compileBlocklyWorkspace(workspace);
			return result.ok ? WORKSPACE_LOAD_ERROR : result.error;
		},
	};
}

function createCapabilityPlanAdapter(): BlocklyEditorAdapter {
	let payload: CapabilityPlanPayloadV1 | undefined;
	return {
		registerBlocks: (blockly) =>
			registerCapabilityPlanBlocks(blockly, CAPABILITY_PLAN_BLOCK_LABELS, payload?.catalog),
		createToolbox: () => createCapabilityPlanToolbox({ plan: '能力计划' }),
		parsePayload: (value) => {
			const result = parseCapabilityPlanPayload(value);
			if (!result.ok) return { ok: false, error: formatCapabilityPlanError(result.error) };
			payload = result.payload;
			return { ok: true, workspace: result.payload.workspace };
		},
		createDefaultWorkspace: () => {
			if (!payload) throw new Error(CAPABILITY_PAYLOAD_REQUIRED);
			return createEmptyCapabilityPlanWorkspace(payload.planRef);
		},
		compileWorkspace: (workspace) => {
			if (!payload) return { ok: false, error: CAPABILITY_PAYLOAD_REQUIRED };
			const result = compileCapabilityPlanWorkspace(
				workspace,
				payload.catalog,
				payload.planRef,
				payload.metadata,
			);
			return result.ok
				? { ok: true, preview: JSON.stringify(result.value.plan, null, 2) }
				: { ok: false, error: formatCapabilityPlanError(result.error) };
		},
		serializePayload: (workspace) => {
			if (!payload) throw new Error(CAPABILITY_PAYLOAD_REQUIRED);
			return serializeCapabilityPlanPayload({ ...payload, workspace });
		},
		workspaceLoadError: (workspace) => {
			if (!payload) return CAPABILITY_PAYLOAD_REQUIRED;
			const result = compileCapabilityPlanWorkspace(
				workspace,
				payload.catalog,
				payload.planRef,
				payload.metadata,
			);
			return result.ok ? WORKSPACE_LOAD_ERROR : formatCapabilityPlanError(result.error);
		},
	};
}
