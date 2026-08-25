import { flushPromises, mount } from '@vue/test-utils';
import type { WorkflowFragmentV1 } from '@n8n/dual-canvas-core';

import BlocklyEditor from './BlocklyEditor.vue';
import { createToolbox, registerN8nBlocks } from './blockly';
import { convertBlocklySource } from './blocklyImport.api';
import {
	CAPABILITY_PLAN_ROOT_BLOCK_TYPE,
	CAPABILITY_PLAN_STEP_BLOCK_TYPE,
	generateCapabilityPlanWorkspace,
	parseCapabilityPlanPayload,
	serializeCapabilityPlanPayload,
} from './capabilityPlan';
import {
	createDefaultWorkspace,
	createOperationModuleCatalogV1,
	finalizeOperationModuleSpecV1,
	serializeBlocklyDataPayload,
} from './payload';

type ChangeListener = (event: { isUiEvent: boolean }) => void;

const workflowDocumentStoreMock = vi.hoisted(() => ({
	getSnapshot: vi.fn<() => Record<string, unknown>>(),
	hydrate: vi.fn(),
}));
const uiStoreMock = vi.hoisted(() => ({ markStateDirty: vi.fn() }));

const capabilityCatalog = {
	apiVersion: 1,
	catalogRef: 'education.content',
	revisionRef: 'revision.synthetic.1',
	capabilities: [
		{
			capabilityRef: 'content.prepare',
			displayName: '准备内容',
			inputs: [
				{
					parameterRef: 'title',
					displayName: '标题',
					valueType: 'string',
					required: true,
				},
			],
			outputs: [{ outputRef: 'draftId', displayName: '草稿标识', valueType: 'string' }],
		},
	],
} as const;

const capabilityExecutionPlan = {
	apiVersion: 1,
	planRef: 'lesson.content.prepare',
	catalogRef: capabilityCatalog.catalogRef,
	catalogRevisionRef: capabilityCatalog.revisionRef,
	steps: [
		{
			stepRef: 'prepare',
			capabilityRef: 'content.prepare',
			arguments: { title: '通用教学内容' },
			dependsOn: [],
		},
	],
} as const;

const EMPTY_OPERATION_CATALOG = createOperationModuleCatalogV1({ apiVersion: 1, modules: [] });
const BOOLEAN_OPERATION_CATALOG = createOperationModuleCatalogV1({
	apiVersion: 1,
	modules: [
		finalizeOperationModuleSpecV1({
			apiVersion: 1,
			requestRef: 'request.always-ready',
			operationRef: 'operation.always-ready',
			implementationRef: null,
			qualifiedName: 'alwaysReady',
			arity: 0,
			version: '1.0.0',
			behaviorSummary: 'Return true.',
			execution: 'synchronous',
			determinism: 'deterministic',
			effects: 'none',
			dataFlow: 'json-to-json',
			parameters: [],
			output: { type: 'boolean', nullPolicy: 'reject' },
			expression: { kind: 'literal', value: true },
			testVectors: [
				{ name: 'first', arguments: [], expected: true },
				{ name: 'second', arguments: [], expected: true },
				{ name: 'third', arguments: [], expected: true },
			],
		}),
	],
});
function createWorkflowFragment(blocklyPayload: string): WorkflowFragmentV1 {
	return {
		apiVersion: 1,
		fragmentRef: 'workflow.synthetic',
		nodes: [
			{
				nodeRef: 'node.start',
				bindingRef: 'binding.start',
				nodeType: 'n8n-nodes-base.manualTrigger',
				typeVersion: 1,
				label: 'Start',
				position: { x: 0, y: 0 },
				parameters: {},
			},
			{
				nodeRef: 'node.blockly',
				bindingRef: 'binding.blockly',
				nodeType: 'n8n-nodes-blockly-code.blocklyCode',
				typeVersion: 1,
				label: 'Blockly Logic',
				position: { x: 280, y: 0 },
				parameters: { blocklyPayload },
			},
		],
		connections: [
			{
				connectionRef: 'connection.start-to-blockly',
				from: { nodeRef: 'node.start', port: 'main', index: 0 },
				to: { nodeRef: 'node.blockly', port: 'main', index: 0 },
			},
		],
		entryNodeRefs: ['node.start'],
		exitNodeRefs: ['node.blockly'],
	};
}

function createFixtureWorkflowSnapshot() {
	return {
		id: 'workflow.current',
		versionId: 'version.current',
		name: 'Current teaching workflow',
		nodes: [
			{
				id: 'fixture-start',
				name: 'Start',
				type: 'n8n-nodes-base.manualTrigger',
				typeVersion: 1,
				position: [0, 0],
				parameters: {},
			},
			{
				id: 'fixture-input',
				name: 'Seed numeric input',
				type: 'n8n-nodes-base.set',
				typeVersion: 3.4,
				position: [280, 0],
				parameters: { assignments: { assignments: [{ name: 'price', value: 12.5 }] } },
			},
			{
				id: 'fixture-blockly',
				name: 'Numeric calculation',
				type: 'n8n-nodes-blockly-code.blocklyCode',
				typeVersion: 1,
				position: [560, 0],
				parameters: { blocklyPayload: 'fixture-payload' },
			},
		],
		connections: {
			Start: { main: [[{ node: 'Seed numeric input', type: 'main', index: 0 }]] },
			'Seed numeric input': {
				main: [[{ node: 'Numeric calculation', type: 'main', index: 0 }]],
			},
		},
		pinData: {},
		nodeGroups: [],
		meta: { visualProgramming: { displayName: '通用代码双画布课堂' } },
	};
}

function createSingleBlocklyShellSnapshot() {
	return {
		...createFixtureWorkflowSnapshot(),
		nodes: [
			{
				id: 'shell-blockly',
				name: 'Blockly shell',
				type: 'n8n-nodes-blockly-code.blocklyCode',
				typeVersion: 1,
				position: [0, 0],
				parameters: { blocklyPayload: 'shell-payload' },
			},
		],
		connections: {},
	};
}

function createImportedFragmentSnapshot(blocklyPayload: string) {
	return {
		...createFixtureWorkflowSnapshot(),
		nodes: [
			{
				id: 'node.start',
				name: 'Start',
				type: 'n8n-nodes-base.manualTrigger',
				typeVersion: 1,
				position: [0, 0],
				parameters: {},
			},
			{
				id: 'node.blockly',
				name: 'Blockly Logic',
				type: 'n8n-nodes-blockly-code.blocklyCode',
				typeVersion: 1,
				position: [280, 0],
				parameters: { blocklyPayload },
			},
		],
		connections: {
			Start: { main: [[{ node: 'Blockly Logic', type: 'main', index: 0 }]] },
		},
	};
}

const events = {
	disabled: false,
	disable: vi.fn(() => {
		events.disabled = true;
	}),
	enable: vi.fn(() => {
		events.disabled = false;
	}),
};
let changeListener: ChangeListener | undefined;
let savedWorkspace: Record<string, unknown> = createDefaultWorkspace();
let selectedBlockData: string | undefined;

function notifyProgrammaticChange() {
	if (events.disabled) return;
	queueMicrotask(() => changeListener?.({ isUiEvent: false }));
}

const workspace = {
	addChangeListener: vi.fn((listener: ChangeListener) => {
		changeListener = listener;
	}),
	removeChangeListener: vi.fn(() => {
		changeListener = undefined;
	}),
	clear: vi.fn(notifyProgrammaticChange),
	updateToolbox: vi.fn(),
	dispose: vi.fn(),
};

const blockly = {
	Blocks: {},
	setLocale: vi.fn(),
	Theme: {
		defineTheme: vi.fn((name: string, configuration: { name: string }) => ({
			...configuration,
			name,
		})),
	},
	Themes: {
		Classic: { name: 'Classic' },
	},
	Events: events,
	FieldDropdown: class {
		constructor(_options: Array<[string, string]>) {}
	},
	FieldTextInput: class {
		constructor(_value: string) {}
		saveState(): unknown {
			return undefined;
		}
	},
	defineBlocksWithJsonArray: vi.fn(),
	getSelected: vi.fn(() => (selectedBlockData === undefined ? null : { data: selectedBlockData })),
	inject: vi.fn(() => workspace),
	svgResize: vi.fn(),
	serialization: {
		workspaces: {
			load: vi.fn((state: Record<string, unknown>, _workspace: typeof workspace) => {
				savedWorkspace = state;
				notifyProgrammaticChange();
			}),
			save: vi.fn(() => savedWorkspace),
		},
	},
};

vi.mock('@n8n/design-system', () => ({
	N8nButton: {
		props: ['disabled', 'loading', 'type'],
		template:
			'<button :type="type ?? \'button\'" :disabled="disabled || loading"><slot /></button>',
	},
	N8nInput: {
		props: ['disabled', 'modelValue', 'rows', 'type'],
		emits: ['update:modelValue'],
		template: `<textarea
			v-if="type === 'textarea'"
			:value="modelValue"
			:disabled="disabled"
			:rows="rows"
			@input="$emit('update:modelValue', $event.target.value)"
		/>
		<input
			v-else
			:value="modelValue"
			:disabled="disabled"
			@input="$emit('update:modelValue', $event.target.value)"
		/>`,
	},
	N8nNotice: { template: '<div><slot /></div>' },
	N8nOption: {
		props: ['label', 'value'],
		template: '<option :value="value">{{ label }}</option>',
	},
	N8nSelect: {
		props: ['disabled', 'modelValue'],
		emits: ['update:modelValue'],
		template:
			'<select :value="modelValue" :disabled="disabled" @change="$emit(\'update:modelValue\', $event.target.value)"><slot /></select>',
	},
	N8nText: { template: '<div><slot /></div>' },
}));

vi.mock('@n8n/i18n', () => ({
	useI18n: () => ({ baseText: (key: string) => key }),
}));

vi.mock('blockly', () => blockly);

vi.mock('@n8n/stores/useRootStore', () => ({
	useRootStore: () => ({
		restApiContext: { baseUrl: '/rest', pushRef: 'test' },
	}),
}));

vi.mock('@/app/stores/ui.store', () => ({
	useUIStore: () => uiStoreMock,
}));

vi.mock('@/app/stores/workflowDocument.store', () => ({
	injectWorkflowDocumentStore: () => ({ value: workflowDocumentStoreMock }),
}));

vi.mock('./blocklyImport.api', () => ({
	convertBlocklySource: vi.fn(),
}));

vi.mock('blockly/msg/zh-hans', () => ({
	LOGIC_BOOLEAN_TRUE: '真',
	LOGIC_BOOLEAN_FALSE: '假',
	MATH_ADDITION_SYMBOL: '+',
}));

vi.mock('./blockly', () => ({
	createToolbox: vi.fn(() => ({ contents: [] })),
	loadWorkspaceOrDefault: vi.fn(
		(
			loadedBlockly: typeof blockly,
			loadedWorkspace: typeof workspace,
			state: Record<string, unknown>,
		) => {
			loadedWorkspace.clear();
			loadedBlockly.serialization.workspaces.load(state, loadedWorkspace);
			return true;
		},
	),
	registerN8nBlocks: vi.fn(),
}));

describe('BlocklyEditor.vue', () => {
	beforeEach(() => {
		events.disabled = false;
		changeListener = undefined;
		savedWorkspace = createDefaultWorkspace();
		selectedBlockData = undefined;
		vi.clearAllMocks();
		workflowDocumentStoreMock.getSnapshot.mockReturnValue(createFixtureWorkflowSnapshot());
		vi.stubGlobal(
			'ResizeObserver',
			class {
				observe() {}
				disconnect() {}
			},
		);
	});

	it('uses the payload catalog to preview and save an imported capability plan', async () => {
		const modelValue = createCapabilityPayload({ courseRef: 'course.synthetic' });
		const wrapper = mount(BlocklyEditor, {
			props: { modelValue, profileId: 'capability-plan' },
		});

		await flushPromises();

		const preview = wrapper.get('[data-test-id="blockly-javascript-preview"]').text();
		expect(JSON.parse(preview)).toEqual({
			...capabilityExecutionPlan,
			metadata: { courseRef: 'course.synthetic' },
		});
		expect(wrapper.emitted('update:modelValue')).toBeUndefined();

		savedWorkspace = structuredClone(savedWorkspace);
		const fields = getFirstStepFields(savedWorkspace);
		fields.ARGUMENTS_JSON = '{"title":"调整后的标题"}';
		changeListener?.({ isUiEvent: false });
		const emitted = wrapper.emitted('update:modelValue')?.at(-1)?.[0];
		expect(typeof emitted).toBe('string');
		const parsed = parseCapabilityPlanPayload(String(emitted));
		expect(parsed.ok).toBe(true);
		if (parsed.ok) {
			expect(parsed.payload.catalog).toEqual(capabilityCatalog);
			expect(parsed.payload.planRef).toBe(capabilityExecutionPlan.planRef);
			expect(parsed.payload.metadata).toEqual({ courseRef: 'course.synthetic' });
			expect(parsed.payload.workspace).toEqual(savedWorkspace);
		}
		wrapper.unmount();
	});

	it('emits a capability payload while the workspace is temporarily semantically invalid', async () => {
		const wrapper = mount(BlocklyEditor, {
			props: { modelValue: createCapabilityPayload(), profileId: 'capability-plan' },
		});
		await flushPromises();

		savedWorkspace = structuredClone(savedWorkspace);
		getFirstStepFields(savedWorkspace).ARGUMENTS_JSON = '[]';
		changeListener?.({ isUiEvent: false });
		await flushPromises();

		expect(wrapper.get('[data-test-id="blockly-compile-error"]').text()).toContain(
			'ARGUMENTS_INVALID',
		);
		expect(wrapper.get('[data-test-id="blockly-javascript-preview"]').text()).toBe('');
		const emitted = wrapper.emitted('update:modelValue')?.at(-1)?.[0];
		expect(typeof emitted).toBe('string');
		const parsed = parseCapabilityPlanPayload(String(emitted));
		expect(parsed.ok).toBe(true);
		if (parsed.ok) {
			expect(getFirstStepFields(parsed.payload.workspace).ARGUMENTS_JSON).toBe('[]');
		}
		wrapper.unmount();
	});

	it.each([
		{
			name: 'logic',
			props: {
				modelValue: serializeBlocklyDataPayload(createDefaultWorkspace(), EMPTY_OPERATION_CATALOG),
				profileId: 'data-transform' as const,
			},
			title: '逻辑积木工作台',
		},
		{
			name: 'capability plan',
			props: {
				modelValue: createCapabilityPayload(),
				profileId: 'capability-plan' as const,
			},
			title: '能力计划工作台',
		},
	])(
		'identifies the $name Blockly editor as a Chinese n8n teaching workspace',
		async ({ props, title }) => {
			const editorProps: { modelValue: string; profileId: string } = props;
			const wrapper = mount(BlocklyEditor, { props: editorProps });

			await flushPromises();

			expect(wrapper.text()).toContain(title);
			expect(wrapper.text()).toContain('当前节点');
			expect(wrapper.text()).toContain('n8n 流程节点');
			expect(wrapper.attributes('data-editor-profile')).toBe(props.profileId);
			expect(wrapper.find('[data-test-id="blockly-source-importer"]').exists()).toBe(
				props.profileId === 'data-transform',
			);
			wrapper.unmount();
		},
	);

	it('uses Chinese Blockly messages, toolbox categories, and custom block labels', async () => {
		const wrapper = mount(BlocklyEditor, {
			props: {
				modelValue: serializeBlocklyDataPayload(createDefaultWorkspace(), EMPTY_OPERATION_CATALOG),
				profileId: 'data-transform',
			},
		});

		await flushPromises();

		expect(blockly.setLocale).toHaveBeenCalledWith(
			expect.objectContaining({ LOGIC_BOOLEAN_TRUE: '真' }),
		);
		expect(createToolbox).toHaveBeenCalledWith(
			{
				transform: '数据处理',
				logic: '条件判断',
				math: '数值运算',
				text: '文本处理',
				arrays: '数组操作',
				objects: '对象操作',
				types: '类型转换',
				operations: '函数模块',
			},
			EMPTY_OPERATION_CATALOG,
		);
		expect(registerN8nBlocks).toHaveBeenCalledWith(
			blockly,
			expect.objectContaining({
				transformItem: '数据处理',
				setField: '设置字段',
				filterArrayPath: '筛选数组路径',
			}),
			EMPTY_OPERATION_CATALOG,
		);
		wrapper.unmount();
	});

	it('refreshes dynamic operation blocks and the toolbox when the payload catalog changes', async () => {
		const workspaceState = createDefaultWorkspace();
		const wrapper = mount(BlocklyEditor, {
			props: {
				modelValue: serializeBlocklyDataPayload(workspaceState, EMPTY_OPERATION_CATALOG),
				profileId: 'data-transform',
			},
		});
		await flushPromises();

		await wrapper.setProps({
			modelValue: serializeBlocklyDataPayload(workspaceState, BOOLEAN_OPERATION_CATALOG),
		});
		await flushPromises();

		expect(registerN8nBlocks).toHaveBeenLastCalledWith(
			blockly,
			expect.any(Object),
			BOOLEAN_OPERATION_CATALOG,
		);
		expect(workspace.updateToolbox).toHaveBeenCalledWith({ contents: [] });
		wrapper.unmount();
	});

	it('converts the numeric TypeScript example without replacing the existing input graph', async () => {
		const fixtureWorkflow = createFixtureWorkflowSnapshot();
		workflowDocumentStoreMock.getSnapshot.mockReturnValue(fixtureWorkflow);
		const initialPayload = serializeBlocklyDataPayload(
			createDefaultWorkspace(),
			EMPTY_OPERATION_CATALOG,
		);
		const convertedPayload = serializeBlocklyDataPayload(
			createDefaultWorkspace(),
			BOOLEAN_OPERATION_CATALOG,
		);
		vi.mocked(convertBlocklySource).mockResolvedValue({
			status: 'ready',
			blocklyPayload: convertedPayload,
			workflowFragment: createWorkflowFragment(convertedPayload),
		});
		const wrapper = mount(BlocklyEditor, {
			props: { modelValue: initialPayload, profileId: 'data-transform' },
		});
		await flushPromises();

		await wrapper.get('[data-test-id="blockly-source-importer"]').trigger('submit');
		await flushPromises();

		expect(convertBlocklySource).toHaveBeenCalledWith(
			{ baseUrl: '/rest', pushRef: 'test' },
			expect.objectContaining({
				source: expect.stringContaining('output.total'),
				currentBlocklyPayload: initialPayload,
				generateMissingOperation: false,
				teacherIntent: expect.stringContaining('订单总额'),
			}),
		);
		expect(wrapper.emitted('update:modelValue')?.at(-1)?.[0]).toBe(convertedPayload);
		expect(workflowDocumentStoreMock.hydrate).not.toHaveBeenCalled();
		expect(fixtureWorkflow.nodes.map((node) => node.name)).toEqual([
			'Start',
			'Seed numeric input',
			'Numeric calculation',
		]);
		expect(fixtureWorkflow.connections['Seed numeric input']).toEqual({
			main: [[{ node: 'Numeric calculation', type: 'main', index: 0 }]],
		});
		expect(uiStoreMock.markStateDirty).toHaveBeenCalledOnce();

		await wrapper.setProps({ modelValue: convertedPayload });
		await flushPromises();

		expect(registerN8nBlocks).toHaveBeenLastCalledWith(
			blockly,
			expect.any(Object),
			BOOLEAN_OPERATION_CATALOG,
		);
		expect(workspace.updateToolbox).toHaveBeenCalledWith({ contents: [] });
		wrapper.unmount();
	});

	it('replaces a single Blockly shell with the returned workflow fragment', async () => {
		workflowDocumentStoreMock.getSnapshot.mockReturnValue(createSingleBlocklyShellSnapshot());
		const initialPayload = serializeBlocklyDataPayload(
			createDefaultWorkspace(),
			EMPTY_OPERATION_CATALOG,
		);
		const convertedPayload = serializeBlocklyDataPayload(
			createDefaultWorkspace(),
			BOOLEAN_OPERATION_CATALOG,
		);
		vi.mocked(convertBlocklySource).mockResolvedValue({
			status: 'ready',
			blocklyPayload: convertedPayload,
			workflowFragment: createWorkflowFragment(convertedPayload),
		});
		const wrapper = mount(BlocklyEditor, {
			props: { modelValue: initialPayload, profileId: 'data-transform' },
		});
		await flushPromises();

		await wrapper.get('[data-test-id="blockly-source-importer"]').trigger('submit');
		await flushPromises();

		const importedWorkflow = workflowDocumentStoreMock.hydrate.mock.calls[0]?.[0];
		expect(importedWorkflow).toEqual(
			expect.objectContaining({
				name: 'Current teaching workflow',
				meta: { visualProgramming: { displayName: '通用代码双画布课堂' } },
				nodes: [
					expect.objectContaining({ id: 'node.start', name: 'Start' }),
					expect.objectContaining({
						id: 'node.blockly',
						name: 'Blockly Logic',
						parameters: { blocklyPayload: convertedPayload },
					}),
				],
				connections: {
					Start: { main: [[{ node: 'Blockly Logic', type: 'main', index: 0 }]] },
				},
			}),
		);
		expect(importedWorkflow?.nodes).toHaveLength(2);
		wrapper.unmount();
	});

	it('replaces an already imported fragment instead of stacking another copy', async () => {
		workflowDocumentStoreMock.getSnapshot.mockReturnValue(
			createImportedFragmentSnapshot('previous-payload'),
		);
		const initialPayload = serializeBlocklyDataPayload(
			createDefaultWorkspace(),
			EMPTY_OPERATION_CATALOG,
		);
		const convertedPayload = serializeBlocklyDataPayload(
			createDefaultWorkspace(),
			BOOLEAN_OPERATION_CATALOG,
		);
		vi.mocked(convertBlocklySource).mockResolvedValue({
			status: 'ready',
			blocklyPayload: convertedPayload,
			workflowFragment: createWorkflowFragment(convertedPayload),
		});
		const wrapper = mount(BlocklyEditor, {
			props: { modelValue: initialPayload, profileId: 'data-transform' },
		});
		await flushPromises();

		await wrapper.get('[data-test-id="blockly-source-importer"]').trigger('submit');
		await flushPromises();

		const importedWorkflow = workflowDocumentStoreMock.hydrate.mock.calls[0]?.[0];
		expect(importedWorkflow?.nodes).toHaveLength(2);
		expect(importedWorkflow?.nodes).toEqual([
			expect.objectContaining({ id: 'node.start' }),
			expect.objectContaining({
				id: 'node.blockly',
				parameters: { blocklyPayload: convertedPayload },
			}),
		]);
		expect(importedWorkflow?.connections).toEqual({
			Start: { main: [[{ node: 'Blockly Logic', type: 'main', index: 0 }]] },
		});
		wrapper.unmount();
	});

	it('generates a missing operation and refreshes its dynamic block toolbox', async () => {
		const workspaceState = createDefaultWorkspace();
		const initialPayload = serializeBlocklyDataPayload(workspaceState, EMPTY_OPERATION_CATALOG);
		const generatedPayload = serializeBlocklyDataPayload(workspaceState, BOOLEAN_OPERATION_CATALOG);
		vi.mocked(convertBlocklySource)
			.mockResolvedValueOnce({
				status: 'missing-operation',
				qualifiedName: 'clampScore',
				arity: 3,
				message: 'Operation module clampScore/3 is missing.',
			})
			.mockResolvedValueOnce({
				status: 'ready',
				blocklyPayload: generatedPayload,
				workflowFragment: createWorkflowFragment(generatedPayload),
			});
		const wrapper = mount(BlocklyEditor, {
			props: { modelValue: initialPayload, profileId: 'data-transform' },
		});
		await flushPromises();

		await wrapper.get('[data-test-id="blockly-source-example"]').setValue('clamp-score');
		await wrapper.get('[data-test-id="blockly-source-importer"]').trigger('submit');
		await flushPromises();

		const missing = wrapper.get('[data-test-id="blockly-missing-operation"]');
		expect(missing.text()).toContain('clampScore / 3 个参数');
		expect(convertBlocklySource).toHaveBeenNthCalledWith(
			1,
			{ baseUrl: '/rest', pushRef: 'test' },
			expect.objectContaining({
				source: expect.stringContaining('clampScore'),
				generateMissingOperation: false,
			}),
		);

		await wrapper.get('[data-test-id="blockly-ai-generate"]').trigger('click');
		await flushPromises();

		expect(convertBlocklySource).toHaveBeenNthCalledWith(
			2,
			{ baseUrl: '/rest', pushRef: 'test' },
			expect.objectContaining({
				source: expect.stringContaining('clampScore'),
				currentBlocklyPayload: initialPayload,
				generateMissingOperation: true,
				teacherIntent: expect.stringContaining('0 到 100'),
			}),
		);
		expect(wrapper.emitted('update:modelValue')?.at(-1)?.[0]).toBe(generatedPayload);
		expect(workflowDocumentStoreMock.hydrate).not.toHaveBeenCalled();
		expect(uiStoreMock.markStateDirty).toHaveBeenCalledOnce();

		await wrapper.setProps({ modelValue: generatedPayload });
		await flushPromises();

		expect(registerN8nBlocks).toHaveBeenLastCalledWith(
			blockly,
			expect.any(Object),
			BOOLEAN_OPERATION_CATALOG,
		);
		expect(workspace.updateToolbox).toHaveBeenCalledWith({ contents: [] });
		expect(wrapper.find('[data-test-id="blockly-missing-operation"]').exists()).toBe(false);
		wrapper.unmount();
	});

	it('exposes only the generic capability-plan grammar in its toolbox', async () => {
		const wrapper = mount(BlocklyEditor, {
			props: { profileId: 'capability-plan', modelValue: createCapabilityPayload() },
		});

		await flushPromises();

		expect(blockly.inject).toHaveBeenLastCalledWith(
			expect.any(HTMLDivElement),
			expect.objectContaining({
				toolbox: {
					kind: 'categoryToolbox',
					contents: [
						{
							kind: 'category',
							name: '能力计划',
							colour: '160',
							contents: [
								{ kind: 'block', type: CAPABILITY_PLAN_ROOT_BLOCK_TYPE },
								{ kind: 'block', type: CAPABILITY_PLAN_STEP_BLOCK_TYPE },
							],
						},
					],
				},
			}),
		);
		wrapper.unmount();
	});

	it.each([
		{
			profileId: 'data-transform' as const,
			modelValue: serializeBlocklyDataPayload(createDefaultWorkspace(), EMPTY_OPERATION_CATALOG),
			themeName: 'n8n-teaching-logic',
		},
		{
			profileId: 'capability-plan' as const,
			modelValue: createCapabilityPayload(),
			themeName: 'n8n-teaching-capability',
		},
	])(
		'injects a native teaching theme for $profileId',
		async ({ profileId, modelValue, themeName }) => {
			const wrapper = mount(BlocklyEditor, { props: { profileId, modelValue } });

			await flushPromises();

			expect(blockly.Theme.defineTheme).toHaveBeenCalledWith(
				themeName,
				expect.objectContaining({ name: themeName, componentStyles: expect.any(Object) }),
			);
			expect(blockly.inject).toHaveBeenLastCalledWith(
				expect.any(HTMLDivElement),
				expect.objectContaining({ theme: expect.objectContaining({ name: themeName }) }),
			);
			wrapper.unmount();
		},
	);

	it('disposes and rebuilds its workspace when profileId changes directly', async () => {
		const wrapper = mount(BlocklyEditor, {
			props: {
				profileId: 'data-transform',
				modelValue: serializeBlocklyDataPayload(createDefaultWorkspace(), EMPTY_OPERATION_CATALOG),
			},
		});
		await flushPromises();

		expect(blockly.inject).toHaveBeenCalledTimes(1);
		expect(workspace.dispose).not.toHaveBeenCalled();

		await wrapper.setProps({
			profileId: 'capability-plan',
			modelValue: createCapabilityPayload(),
		});
		await flushPromises();

		expect(workspace.removeChangeListener).toHaveBeenCalledTimes(1);
		expect(workspace.dispose).toHaveBeenCalledTimes(1);
		expect(blockly.inject).toHaveBeenCalledTimes(2);
		expect(wrapper.attributes('data-editor-profile')).toBe('capability-plan');
		expect(wrapper.text()).toContain('能力计划工作台');
		expect(JSON.parse(wrapper.get('[data-test-id="blockly-javascript-preview"]').text())).toEqual(
			capabilityExecutionPlan,
		);
		wrapper.unmount();
	});

	it('shows the AI teaching annotation for the selected generated block', async () => {
		const wrapper = mount(BlocklyEditor, {
			props: {
				modelValue: serializeBlocklyDataPayload(createDefaultWorkspace(), EMPTY_OPERATION_CATALOG),
				profileId: 'data-transform',
			},
		});
		await flushPromises();
		selectedBlockData = JSON.stringify({
			stepRef: 'logic.normalize.amount',
			teaching: {
				what: 'Normalize the amount',
				why: 'The next node expects a number',
				editable: ['input path', 'default value'],
				expectedEffect: 'amount is numeric',
			},
		});

		changeListener?.({ isUiEvent: true });
		await flushPromises();

		const annotation = wrapper.get('[data-test-id="blockly-teaching-annotation"]');
		expect(annotation.text()).toContain('Normalize the amount');
		expect(annotation.text()).toContain('The next node expects a number');
		expect(annotation.text()).toContain('input path · default value');
		expect(annotation.text()).toContain('logic.normalize.amount');
		wrapper.unmount();
	});

	it('throws for an unknown profile instead of loading another grammar', () => {
		expect(() =>
			mount(BlocklyEditor, {
				props: { profileId: 'unknown-profile', modelValue: '{}' },
			}),
		).toThrow('Unknown Blockly editor profile: unknown-profile');
	});

	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it.each([
		[
			'a schema 1 payload that clears the workspace',
			'{"schemaVersion":1,"workspace":{},"javascript":""}',
		],
		[
			'an initial schema 3 payload that loads the workspace',
			serializeBlocklyDataPayload(createDefaultWorkspace(), EMPTY_OPERATION_CATALOG),
		],
	])('does not emit while loading %s', async (_name, modelValue) => {
		const wrapper = mount(BlocklyEditor, {
			props: { modelValue, profileId: 'data-transform' },
		});

		await flushPromises();

		expect(wrapper.emitted('update:modelValue')).toBeUndefined();
		expect(events.disable).toHaveBeenCalledTimes(1);
		expect(events.enable).toHaveBeenCalledTimes(1);
		wrapper.unmount();
	});
});

function createCapabilityPayload(metadata?: Record<string, string>): string {
	const generated = generateCapabilityPlanWorkspace(capabilityExecutionPlan, capabilityCatalog);
	if (!generated.ok) throw new Error(generated.error.message);
	return serializeCapabilityPlanPayload({
		schemaVersion: 1,
		catalog: capabilityCatalog,
		planRef: capabilityExecutionPlan.planRef,
		workspace: generated.value.workspace,
		...(metadata === undefined ? {} : { metadata }),
	});
}

function getFirstStepFields(workspaceState: Record<string, unknown>): Record<string, unknown> {
	const blocksState = workspaceState.blocks as {
		blocks: Array<{ inputs?: Record<string, unknown> }>;
	};
	const root = blocksState.blocks[0];
	const steps = root?.inputs?.STEPS as { block?: { fields?: Record<string, unknown> } };
	if (!steps.block?.fields) throw new Error('Synthetic capability plan is missing its first step');
	return steps.block.fields;
}
