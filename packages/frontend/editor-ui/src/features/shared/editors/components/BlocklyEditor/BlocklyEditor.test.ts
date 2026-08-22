import { flushPromises, mount } from '@vue/test-utils';

import BlocklyEditor from './BlocklyEditor.vue';
import { createDefaultWorkspace, serializeBlocklyDataPayload } from './payload';
import {
	ROBOT_EXECUTE_SKILL_BLOCK,
	ROBOT_TASK_PLAN_BLOCK,
	parseRobotPlanPayload,
	serializeRobotPlanPayload,
} from './robotSkills';

type ChangeListener = (event: { isUiEvent: boolean }) => void;

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

	it('uses the payload catalog to compile and save an imported robot workspace', async () => {
		const catalog = {
			robotName: 'rk3588_lab_arm',
			configDigest: 'rk3588-live-digest',
			skills: [{ name: 'teach_ai_code', summary: 'Explain an AI-generated robot step.' }],
			primitives: [],
			namedPoses: [],
		};
		const robotWorkspace = {
			blocks: {
				blocks: [
					{
						type: ROBOT_TASK_PLAN_BLOCK,
						inputs: {
							DO: {
								block: {
									id: 'teaching-step',
									type: ROBOT_EXECUTE_SKILL_BLOCK,
									fields: { SKILL: 'teach_ai_code' },
								},
							},
						},
					},
				],
			},
		};
		const wrapper = mount(BlocklyEditor, {
			props: {
				modelValue: serializeRobotPlanPayload({ catalog, workspace: robotWorkspace }),
				editorMode: 'robot-skills',
			},
		});

		await flushPromises();

		expect(wrapper.get('[data-test-id="blockly-javascript-preview"]').text()).toContain(
			'rk3588_lab_arm',
		);
		expect(wrapper.emitted('update:modelValue')).toBeUndefined();

		savedWorkspace = JSON.parse(
			JSON.stringify(robotWorkspace).replace('teaching-step', 'teaching-step-edited'),
		) as Record<string, unknown>;
		changeListener?.({ isUiEvent: false });
		const emitted = wrapper.emitted('update:modelValue')?.at(-1)?.[0];
		expect(typeof emitted).toBe('string');
		const parsed = parseRobotPlanPayload(String(emitted));
		expect(parsed.ok && parsed.payload.catalog.configDigest).toBe('rk3588-live-digest');
		wrapper.unmount();
	});

	it.each([
		{
			name: 'logic',
			props: { modelValue: serializeBlocklyDataPayload(createDefaultWorkspace()) },
			title: 'blocklyEditor.title',
		},
		{
			name: 'robot plan',
			props: {
				modelValue: serializeRobotPlanPayload({
					catalog: {
						robotName: 'rk3588_lab_arm',
						configDigest: 'rk3588-live-digest',
						skills: [],
						primitives: [],
						namedPoses: [],
					},
					workspace: { blocks: { blocks: [] } },
				}),
				editorMode: 'robot-skills' as const,
			},
			title: 'robotSkillEditor.title',
		},
	])(
		'identifies the $name Blockly editor as part of the current n8n node',
		async ({ props, title }) => {
			const editorProps: {
				modelValue: string;
				editorMode?: 'data-transform' | 'robot-skills';
			} = props;
			const wrapper = mount(BlocklyEditor, { props: editorProps });

			await flushPromises();

			expect(wrapper.text()).toContain(title);
			expect(wrapper.text()).toContain('blocklyEditor.location.node');
			wrapper.unmount();
		},
	);

	it.each([
		{
			editorMode: 'data-transform' as const,
			modelValue: serializeBlocklyDataPayload(createDefaultWorkspace()),
			themeName: 'n8n-competition-data-transform',
		},
		{
			editorMode: 'robot-skills' as const,
			modelValue: serializeRobotPlanPayload({
				catalog: {
					robotName: 'rk3588_lab_arm',
					configDigest: 'rk3588-live-digest',
					skills: [],
					primitives: [],
					namedPoses: [],
				},
				workspace: { blocks: { blocks: [] } },
			}),
			themeName: 'n8n-competition-robot-skills',
		},
	])(
		'injects a native Blockly competition theme for $editorMode',
		async ({ editorMode, modelValue, themeName }) => {
			const wrapper = mount(BlocklyEditor, { props: { editorMode, modelValue } });

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

	it('shows the AI teaching annotation for the selected generated block', async () => {
		const wrapper = mount(BlocklyEditor, {
			props: { modelValue: serializeBlocklyDataPayload(createDefaultWorkspace()) },
		});
		await flushPromises();
		selectedBlockData = JSON.stringify({
			intentStepId: 'logic.normalize.amount',
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
		const wrapper = mount(BlocklyEditor, { props: { modelValue } });

		await flushPromises();

		expect(wrapper.emitted('update:modelValue')).toBeUndefined();
		expect(events.disable).toHaveBeenCalledTimes(1);
		expect(events.enable).toHaveBeenCalledTimes(1);
		wrapper.unmount();
	});
});
