import {
	generateCapabilityPlanWorkspace,
	parseCapabilityPlanPayload,
	serializeCapabilityPlanPayload,
} from './capabilityPlan';
import {
	createDefaultWorkspace,
	parseBlocklyDataPayload,
	serializeBlocklyDataPayload,
} from './payload';
import { createBlocklyEditorAdapter, getBlocklyEditorProfile } from './profiles';

const catalog = {
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

const executionPlan = {
	apiVersion: 1,
	planRef: 'lesson.content.prepare',
	catalogRef: catalog.catalogRef,
	catalogRevisionRef: catalog.revisionRef,
	steps: [
		{
			stepRef: 'prepare',
			capabilityRef: 'content.prepare',
			arguments: { title: '初始标题' },
			dependsOn: [],
		},
	],
} as const;

describe('Blockly editor profile registry', () => {
	it.each([
		['data-transform', 'data-transform', 'logic'],
		['capability-plan', 'capability-plan', 'capability'],
	] as const)('resolves %s to its adapter and presentation', (profileId, adapterId, appearance) => {
		expect(getBlocklyEditorProfile(profileId)).toEqual(
			expect.objectContaining({ id: profileId, adapterId, appearance }),
		);
	});

	it('keeps the data-transform payload contract behind its adapter', () => {
		const workspace = createDefaultWorkspace();
		const adapter = createBlocklyEditorAdapter('data-transform');
		const parsed = adapter.parsePayload(serializeBlocklyDataPayload(workspace));

		expect(parsed).toEqual({ ok: true, workspace });
		const serialized = adapter.serializePayload(workspace);
		const reparsed = parseBlocklyDataPayload(serialized);
		expect(reparsed.ok && reparsed.payload.workspace).toEqual(workspace);
	});

	it('preserves the catalog, plan reference, metadata, and edited workspace on reload', () => {
		const generated = generateCapabilityPlanWorkspace(executionPlan, catalog);
		expect(generated.ok).toBe(true);
		if (!generated.ok) return;

		const initialPayload = serializeCapabilityPlanPayload({
			schemaVersion: 1,
			catalog,
			planRef: executionPlan.planRef,
			workspace: generated.value.workspace,
			metadata: { courseRef: 'course.synthetic' },
		});
		const firstAdapter = createBlocklyEditorAdapter('capability-plan');
		const parsed = firstAdapter.parsePayload(initialPayload);
		expect(parsed.ok).toBe(true);
		if (!parsed.ok) return;

		const editedWorkspace = structuredClone(parsed.workspace);
		const fields = getFirstStepFields(editedWorkspace);
		fields.ARGUMENTS_JSON = '{"title":"调整后的标题"}';
		const savedPayload = firstAdapter.serializePayload(editedWorkspace);
		const reparsedPayload = parseCapabilityPlanPayload(savedPayload);
		expect(reparsedPayload.ok).toBe(true);
		if (!reparsedPayload.ok) return;
		expect(reparsedPayload.payload).toEqual(
			expect.objectContaining({
				catalog,
				planRef: executionPlan.planRef,
				metadata: { courseRef: 'course.synthetic' },
				workspace: editedWorkspace,
			}),
		);

		const reloadedAdapter = createBlocklyEditorAdapter('capability-plan');
		const reloaded = reloadedAdapter.parsePayload(savedPayload);
		expect(reloaded).toEqual({ ok: true, workspace: editedWorkspace });
		const preview = reloadedAdapter.compileWorkspace(editedWorkspace);
		expect(preview.ok).toBe(true);
		if (!preview.ok) return;
		expect(JSON.parse(preview.preview)).toEqual({
			...executionPlan,
			metadata: { courseRef: 'course.synthetic' },
			steps: [{ ...executionPlan.steps[0], arguments: { title: '调整后的标题' } }],
		});
	});

	it.each(['missing-profile', ''])(
		'rejects unregistered profile %j without selecting a grammar',
		(id) => {
			expect(() => createBlocklyEditorAdapter(id)).toThrow(`Unknown Blockly editor profile: ${id}`);
		},
	);
});

function getFirstStepFields(workspace: Record<string, unknown>): Record<string, unknown> {
	const blocksState = workspace.blocks as { blocks: Array<{ inputs?: Record<string, unknown> }> };
	const root = blocksState.blocks[0];
	const steps = root?.inputs?.STEPS as { block?: { fields?: Record<string, unknown> } };
	if (!steps.block?.fields) throw new Error('Synthetic capability plan is missing its first step');
	return steps.block.fields;
}
