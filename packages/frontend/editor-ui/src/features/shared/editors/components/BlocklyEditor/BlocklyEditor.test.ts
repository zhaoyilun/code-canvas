import { flushPromises, mount } from '@vue/test-utils';

import BlocklyEditor from './BlocklyEditor.vue';
import { createDefaultWorkspace, serializeBlocklyDataPayload } from './payload';

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
	Events: events,
	inject: vi.fn(() => workspace),
	svgResize: vi.fn(),
	serialization: {
		workspaces: {
			load: vi.fn((_state: Record<string, unknown>, _workspace: typeof workspace) => {
				notifyProgrammaticChange();
			}),
			save: vi.fn(() => createDefaultWorkspace()),
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
		vi.clearAllMocks();
		vi.stubGlobal(
			'ResizeObserver',
			class {
				observe() {}
				disconnect() {}
			},
		);
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
