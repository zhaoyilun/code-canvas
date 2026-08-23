import * as Blockly from 'blockly';

import {
	CAPABILITY_PLAN_ROOT_BLOCK_TYPE,
	CAPABILITY_PLAN_STEP_BLOCK_TYPE,
	compileCapabilityPlanWorkspace,
	createCapabilityPlanToolbox,
	generateCapabilityPlanWorkspace,
	parseCapabilityPlanPayload,
	registerCapabilityPlanBlocks,
	serializeCapabilityPlanPayload,
} from './capabilityPlan';
import type { CapabilityCatalogV1 } from './capabilityPlan';

const catalog: CapabilityCatalogV1 = {
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
		{
			capabilityRef: 'content.publish',
			displayName: '发布内容',
			inputs: [
				{
					parameterRef: 'draftId',
					displayName: '草稿标识',
					valueType: 'string',
					required: true,
				},
			],
			outputs: [{ outputRef: 'publicationId', displayName: '发布标识', valueType: 'string' }],
		},
	],
};

const labels = {
	plan: '能力执行计划',
	step: '执行能力',
	stepRef: '步骤标识',
	capability: '能力',
	argumentsJson: '参数 JSON',
	label: '标签（可选）',
	timeoutMs: '超时毫秒（可选）',
	guardJson: '条件 JSON（可选）',
};

const executionPlan = {
	apiVersion: 1,
	planRef: 'lesson.content.publish',
	catalogRef: catalog.catalogRef,
	catalogRevisionRef: catalog.revisionRef,
	steps: [
		{
			stepRef: 'prepare',
			capabilityRef: 'content.prepare',
			arguments: { title: '通用教学内容' },
			dependsOn: [],
		},
		{
			stepRef: 'publish',
			capabilityRef: 'content.publish',
			label: '确认草稿后发布',
			arguments: { draftId: 'draft.synthetic' },
			dependsOn: ['prepare'],
			timeoutMs: 45_000,
			guard: {
				source: { stepRef: 'prepare', outputPath: ['draftId'] },
				operator: 'neq',
				value: '',
				effect: 'run',
			},
		},
	],
} as const;

describe('capability-plan editor configuration', () => {
	it('exposes exactly the two shared grammar blocks', () => {
		const toolbox = createCapabilityPlanToolbox({ plan: '能力计划' });

		expect(toolbox.contents).toMatchObject([
			{
				contents: [
					{ type: CAPABILITY_PLAN_ROOT_BLOCK_TYPE },
					{ type: CAPABILITY_PLAN_STEP_BLOCK_TYPE },
				],
			},
		]);
		expect(JSON.stringify(toolbox)).not.toContain('controls_');
	});

	it('builds the capability dropdown exclusively from the payload catalog', () => {
		registerCapabilityPlanBlocks(Blockly, labels, catalog);
		const workspace = new Blockly.Workspace();
		try {
			const block = workspace.newBlock(CAPABILITY_PLAN_STEP_BLOCK_TYPE);
			const field = block.getField('CAPABILITY_REF') as Blockly.FieldDropdown;

			expect(field.getOptions(false)).toEqual([
				['准备内容', 'content.prepare'],
				['发布内容', 'content.publish'],
			]);
			expect(block.getFieldValue('ARGUMENTS_JSON')).toBe('{}');
		} finally {
			workspace.dispose();
		}
	});

	it('preserves optional step semantics across generate, UI save, and compile', () => {
		const generated = generateCapabilityPlanWorkspace(executionPlan, catalog);
		expect(generated.ok).toBe(true);
		if (!generated.ok) return;

		const payload = {
			schemaVersion: 1 as const,
			catalog,
			planRef: executionPlan.planRef,
			workspace: generated.value.workspace,
			metadata: { lesson: 'content' },
		};
		const parsed = parseCapabilityPlanPayload(serializeCapabilityPlanPayload(payload));
		expect(parsed.ok).toBe(true);
		if (!parsed.ok) return;

		registerCapabilityPlanBlocks(Blockly, labels, parsed.payload.catalog);
		const workspace = new Blockly.Workspace();
		try {
			Blockly.serialization.workspaces.load(parsed.payload.workspace, workspace);
			const savedWorkspace = Blockly.serialization.workspaces.save(workspace);
			const savedJson = JSON.stringify(savedWorkspace);
			expect(savedJson).toContain('"LABEL":"确认草稿后发布"');
			expect(savedJson).toContain('"TIMEOUT_MS":45000');
			expect(savedJson).toContain('"GUARD_JSON":');
			const compiled = compileCapabilityPlanWorkspace(
				savedWorkspace,
				parsed.payload.catalog,
				parsed.payload.planRef,
				parsed.payload.metadata,
			);

			expect(compiled.ok, compiled.ok ? '' : JSON.stringify(compiled.error)).toBe(true);
			if (!compiled.ok) return;
			expect(compiled.value.plan).toEqual({ ...executionPlan, metadata: { lesson: 'content' } });
			expect(compiled.value.sourceMap).toEqual(generated.value.sourceMap);
		} finally {
			workspace.dispose();
		}
	});
});
