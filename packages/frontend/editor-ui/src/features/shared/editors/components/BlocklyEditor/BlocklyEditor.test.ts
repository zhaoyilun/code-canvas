import { flushPromises, mount } from '@vue/test-utils';

import BlocklyEditor from './BlocklyEditor.vue';
import { createToolbox, registerN8nBlocks } from './blockly';
import {
	CAPABILITY_PLAN_ROOT_BLOCK_TYPE,
	CAPABILITY_PLAN_STEP_BLOCK_TYPE,
	generateCapabilityPlanWorkspace,
	parseCapabilityPlanPayload,
	serializeCapabilityPlanPayload,
} from './capabilityPlan';
import { createDefaultWorkspace, serializeBlocklyDataPayload } from './payload';

type ChangeListener = (event: { isUiEvent: boolean }) => void;

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
	N8nNotice: { template: '<div><slot /></div>' },
	N8nText: { template: '<div><slot /></div>' },
}));

vi.mock('@n8n/i18n', () => ({
	useI18n: () => ({ baseText: (key: string) => key }),
}));

vi.mock('blockly', () => blockly);

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
				modelValue: serializeBlocklyDataPayload(createDefaultWorkspace()),
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
			wrapper.unmount();
		},
	);

	it('uses Chinese Blockly messages, toolbox categories, and custom block labels', async () => {
		const wrapper = mount(BlocklyEditor, {
			props: {
				modelValue: serializeBlocklyDataPayload(createDefaultWorkspace()),
				profileId: 'data-transform',
			},
		});

		await flushPromises();

		expect(blockly.setLocale).toHaveBeenCalledWith(
			expect.objectContaining({ LOGIC_BOOLEAN_TRUE: '真' }),
		);
		expect(createToolbox).toHaveBeenCalledWith({
			transform: '数据处理',
			logic: '条件判断',
			math: '数值运算',
			text: '文本处理',
			arrays: '数组操作',
			objects: '对象操作',
			types: '类型转换',
		});
		expect(registerN8nBlocks).toHaveBeenCalledWith(
			blockly,
			expect.objectContaining({
				transformItem: '数据处理',
				setField: '设置字段',
				filterArrayPath: '筛选数组路径',
			}),
		);
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
			modelValue: serializeBlocklyDataPayload(createDefaultWorkspace()),
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
				modelValue: serializeBlocklyDataPayload(createDefaultWorkspace()),
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
				modelValue: serializeBlocklyDataPayload(createDefaultWorkspace()),
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
			'an initial schema 2 payload that loads the workspace',
			serializeBlocklyDataPayload(createDefaultWorkspace()),
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
