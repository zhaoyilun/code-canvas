import { createRequire } from 'node:module';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import type { RobotCatalog } from './catalog';
import { SO101_CATALOG_SNAPSHOT } from './catalog';
import { compileRobotWorkspace } from './compiler';
import type { RobotPlanDraft } from './generator';
import { generateRobotPlanWorkspace } from './generator';
import { parseRobotPlanPayload, serializeRobotPlanPayload } from './payload';

type BlocklyWorkspace = { dispose(): void };
type BlocklyRuntime = {
	VERSION: string;
	// eslint-disable-next-line @typescript-eslint/naming-convention -- Blockly public API
	Blocks: Record<string, unknown>;
	// eslint-disable-next-line @typescript-eslint/naming-convention -- Blockly public API
	Workspace: new () => BlocklyWorkspace;
	common: { defineBlocksWithJsonArray(definitions: Array<Record<string, unknown>>): void };
	serialization: {
		workspaces: {
			load(state: Record<string, unknown>, workspace: BlocklyWorkspace): void;
			save(workspace: BlocklyWorkspace): Record<string, unknown>;
		};
	};
};

const repositoryRequire = createRequire(
	path.resolve(__dirname, '../../../frontend/editor-ui/package.json'),
);
const Blockly = repositoryRequire('blockly') as BlocklyRuntime;
registerRoundTripBlocks();

function draftOf(steps: RobotPlanDraft['steps']): RobotPlanDraft {
	return {
		schemaVersion: 1,
		planRef: 'plan.demo',
		label: 'Demo robot plan',
		robotProfileRef: SO101_CATALOG_SNAPSHOT.robotName,
		catalogDigest: SO101_CATALOG_SNAPSHOT.configDigest,
		budgetSec: 180,
		steps,
	};
}

describe('generateRobotPlanWorkspace', () => {
	it('deterministically generates, recompiles, and maps a mixed robot plan', () => {
		const draft = draftOf([
			{
				stepRef: 'inspect',
				kind: 'skill',
				name: 'inspect_scene',
				when: { field: 'last.success', op: 'eq', value: true },
				teaching: {
					what: 'Inspect the table',
					why: 'Acquire the latest scene state',
					editable: ['timeoutSec'],
					expectedEffect: 'A new observation is available',
				},
			},
			{
				stepRef: 'move-forward',
				kind: 'skill',
				name: 'move_relative_ee',
				params: { motion_distance: 0.03, motion_direction: 'forward' },
				timeoutSec: 20,
			},
			{ stepRef: 'pause', kind: 'wait', durationMs: 1500 },
			{ stepRef: 'home', kind: 'namedPose', pose: 'home', timeoutSec: 15 },
		]);

		const first = generateRobotPlanWorkspace(draft, SO101_CATALOG_SNAPSHOT, {
			designId: 'design.lesson-1',
		});
		const second = generateRobotPlanWorkspace(draft, SO101_CATALOG_SNAPSHOT, {
			designId: 'design.lesson-1',
		});
		expect(first.ok).toBe(true);
		expect(second).toEqual(first);
		if (!first.ok) return;

		expect(first.sourceMap).toHaveLength(4);
		expect(new Set(first.sourceMap.map((entry) => entry.blockId)).size).toBe(4);
		for (const entry of first.sourceMap) {
			expect(entry.planStepId).toBe(`step:${entry.blockId}`);
			const action = findBlockById(first.workspace, entry.blockId);
			expect(parseBlockData(action)).toMatchObject({ intentStepId: entry.stepRef });
		}
		expect(first.sourceMap[0]?.guardBlockId).toBeDefined();
		const inspectAction = findBlockById(first.workspace, first.sourceMap[0]?.blockId ?? '');
		expect(parseBlockData(inspectAction)).toEqual({
			intentStepId: 'inspect',
			teaching: draft.steps[0]?.teaching,
		});
		const inspectGuard = findBlockById(first.workspace, first.sourceMap[0]?.guardBlockId ?? '');
		expect(parseBlockData(inspectGuard)).toEqual({
			intentStepId: 'inspect',
			teaching: draft.steps[0]?.teaching,
		});
		expect(first.plan.plan[0]).toMatchObject({
			step: 'skill',
			skill: 'inspect_scene',
			timeoutSec: 30,
			skipIf: { field: 'last.success', op: '!=', value: true },
			blockId: first.sourceMap[0]?.blockId,
			planStepId: first.sourceMap[0]?.planStepId,
		});
		expect(first.plan.plan[1]).toMatchObject({
			step: 'skill',
			skill: 'move_relative_ee',
			params: { motion_direction: 'forward', motion_distance: 0.03 },
			timeoutSec: 20,
		});
		expect(first.plan.plan[2]).toMatchObject({ step: 'wait', seconds: 1.5 });
		expect(first.plan.plan[3]).toMatchObject({
			step: 'primitive',
			primitive: 'move_to_named_pose',
			params: { target_name: 'home' },
			timeoutSec: 15,
		});

		const recompiled = compileRobotWorkspace(first.workspace, SO101_CATALOG_SNAPSHOT);
		expect(recompiled).toMatchObject({ ok: true, plan: first.plan });
	});

	it('preserves teaching data and source identities through Blockly 12.3.1 load/save', () => {
		const teaching = {
			what: 'Inspect the teaching table',
			why: 'Explain how the skill maps to robot execution',
			editable: ['skill timeout'],
			expectedEffect: 'The latest scene state is available',
		};
		const draft = draftOf([
			{ stepRef: 'inspect-taught', kind: 'skill', name: 'inspect_scene', teaching },
			{ stepRef: 'pause-plain', kind: 'wait', durationMs: 500 },
			{
				stepRef: 'wave-guarded-plain',
				kind: 'skill',
				name: 'wave_hello',
				when: { field: 'last.success', op: 'eq', value: true },
			},
		]);
		const generated = generateRobotPlanWorkspace(draft, SO101_CATALOG_SNAPSHOT, {
			designId: 'design.round-trip',
		});
		expect(Blockly.VERSION).toBe('12.3.1');
		expect(generated.ok).toBe(true);
		if (!generated.ok) return;

		const workspace = new Blockly.Workspace();
		let saved: Record<string, unknown>;
		try {
			Blockly.serialization.workspaces.load(generated.workspace, workspace);
			saved = Blockly.serialization.workspaces.save(workspace);
		} finally {
			workspace.dispose();
		}

		const payload = serializeRobotPlanPayload({
			catalog: SO101_CATALOG_SNAPSHOT,
			workspace: saved,
		});
		const parsedPayload = parseRobotPlanPayload(payload);
		expect(parsedPayload.ok).toBe(true);
		if (!parsedPayload.ok) return;
		const recompiled = compileRobotWorkspace(
			parsedPayload.payload.workspace,
			SO101_CATALOG_SNAPSHOT,
		);
		expect(recompiled).toMatchObject({ ok: true, plan: generated.plan });

		for (const entry of generated.sourceMap) {
			const action = findBlockById(parsedPayload.payload.workspace, entry.blockId);
			expect(action).toBeDefined();
			expect(parseBlockData(action)).toMatchObject({ intentStepId: entry.stepRef });
			if (entry.guardBlockId !== undefined) {
				const guard = findBlockById(parsedPayload.payload.workspace, entry.guardBlockId);
				expect(guard?.type).toBe('robot_condition');
				expect(parseBlockData(guard)).toEqual({ intentStepId: entry.stepRef });
			}
		}
		const taughtEntry = generated.sourceMap.find((entry) => entry.stepRef === 'inspect-taught');
		expect(parseBlockData(findBlockById(saved, taughtEntry?.blockId ?? ''))).toEqual({
			intentStepId: 'inspect-taught',
			teaching,
		});
		const waitEntry = generated.sourceMap.find((entry) => entry.stepRef === 'pause-plain');
		expect(parseBlockData(findBlockById(saved, waitEntry?.blockId ?? ''))).toEqual({
			intentStepId: 'pause-plain',
		});
		if (recompiled.ok) {
			expect(recompiled.plan.plan.map((step) => step.blockId)).toEqual(
				generated.sourceMap.map((entry) => entry.blockId),
			);
			expect(recompiled.plan.plan.map((step) => step.planStepId)).toEqual(
				generated.sourceMap.map((entry) => entry.planStepId),
			);
		}
	});

	it('keeps block identities stable across parameter edits and step reordering', () => {
		const original = draftOf([
			{ stepRef: 'inspect', kind: 'skill', name: 'inspect_scene' },
			{
				stepRef: 'move',
				kind: 'skill',
				name: 'move_relative_ee',
				params: { motion_direction: 'forward', motion_distance: 0.02 },
			},
		]);
		const revised = draftOf([
			{
				stepRef: 'move',
				kind: 'skill',
				name: 'move_relative_ee',
				params: { motion_distance: 0.04, motion_direction: 'forward' },
			},
			{ stepRef: 'inspect', kind: 'skill', name: 'inspect_scene' },
		]);
		const first = generateRobotPlanWorkspace(original, SO101_CATALOG_SNAPSHOT, {
			designId: 'design.stability',
		});
		const second = generateRobotPlanWorkspace(revised, SO101_CATALOG_SNAPSHOT, {
			designId: 'design.stability',
		});
		expect(first.ok).toBe(true);
		expect(second.ok).toBe(true);
		if (!first.ok || !second.ok) return;
		const idsByRef = new Map(first.sourceMap.map((entry) => [entry.stepRef, entry.blockId]));
		for (const entry of second.sourceMap) expect(entry.blockId).toBe(idsByRef.get(entry.stepRef));
	});

	it('uses primitive parameter schemas supplied by the catalog', () => {
		const catalog: RobotCatalog = {
			...SO101_CATALOG_SNAPSHOT,
			primitiveDetails: [
				{
					name: 'move_to_pose',
					parameters: {
						type: 'object',
						properties: { frame: { type: 'string', enum: ['base', 'tool'] } },
						required: ['frame'],
						additionalProperties: false,
					},
					timeoutSec: 25,
				},
			],
		};
		const draft = {
			...draftOf([
				{ stepRef: 'pose', kind: 'primitive', name: 'move_to_pose', params: { frame: 'base' } },
			]),
			catalogDigest: catalog.configDigest,
		};
		const result = generateRobotPlanWorkspace(draft, catalog, { designId: 'design.primitive' });
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.plan.plan[0]).toMatchObject({
			step: 'primitive',
			primitive: 'move_to_pose',
			params: { frame: 'base' },
			timeoutSec: 25,
		});
	});

	it('rejects names and parameters absent from the supplied catalog', () => {
		const unknownSkill = generateRobotPlanWorkspace(
			draftOf([{ stepRef: 'unknown', kind: 'skill', name: 'invented_skill' }]),
			SO101_CATALOG_SNAPSHOT,
			{ designId: 'design.invalid' },
		);
		expect(unknownSkill).toMatchObject({
			ok: false,
			error: { code: 'SKILL_UNKNOWN', path: 'steps[0].name' },
		});

		const unknownParam = generateRobotPlanWorkspace(
			draftOf([
				{ stepRef: 'inspect', kind: 'skill', name: 'inspect_scene', params: { invented: 1 } },
			]),
			SO101_CATALOG_SNAPSHOT,
			{ designId: 'design.invalid' },
		);
		expect(unknownParam).toMatchObject({
			ok: false,
			error: { code: 'PARAMS_INVALID', path: 'steps[0].params.invented' },
		});

		const primitiveParamWithoutSchema = generateRobotPlanWorkspace(
			draftOf([
				{ stepRef: 'pose', kind: 'primitive', name: 'move_to_pose', params: { frame: 'base' } },
			]),
			SO101_CATALOG_SNAPSHOT,
			{ designId: 'design.invalid' },
		);
		expect(primitiveParamWithoutSchema).toMatchObject({
			ok: false,
			error: { code: 'PARAMS_INVALID', path: 'steps[0].params.frame' },
		});
	});

	it('returns explicit errors for malformed identity, digest, and plan structure', () => {
		expect(
			generateRobotPlanWorkspace(draftOf([]), SO101_CATALOG_SNAPSHOT, {
				designId: 'design.errors',
			}),
		).toMatchObject({ ok: false, error: { code: 'EMPTY_PLAN', path: 'steps' } });

		const duplicate = draftOf([
			{ stepRef: 'same', kind: 'skill', name: 'inspect_scene' },
			{ stepRef: 'same', kind: 'skill', name: 'recover_safe_pose' },
		]);
		expect(
			generateRobotPlanWorkspace(duplicate, SO101_CATALOG_SNAPSHOT, {
				designId: 'design.errors',
			}),
		).toMatchObject({
			ok: false,
			error: { code: 'DUPLICATE_STEP_REF', path: 'steps[1].stepRef' },
		});

		const stale = {
			...draftOf([{ stepRef: 'inspect', kind: 'skill', name: 'inspect_scene' }]),
			catalogDigest: 'stale',
		};
		expect(
			generateRobotPlanWorkspace(stale, SO101_CATALOG_SNAPSHOT, {
				designId: 'design.errors',
			}),
		).toMatchObject({ ok: false, error: { code: 'CATALOG_DIGEST_MISMATCH' } });

		expect(
			generateRobotPlanWorkspace(
				{ ...draftOf([{ stepRef: 'inspect', kind: 'skill', name: 'inspect_scene' }]), extra: true },
				SO101_CATALOG_SNAPSHOT,
				{ designId: 'design.errors' },
			),
		).toMatchObject({
			ok: false,
			error: { code: 'DRAFT_MALFORMED', path: 'draft.extra' },
		});

		const firstSkill = SO101_CATALOG_SNAPSHOT.skills[0];
		expect(firstSkill).toBeDefined();
		if (firstSkill === undefined) return;
		const invalidCatalog: RobotCatalog = {
			...SO101_CATALOG_SNAPSHOT,
			skills: [{ ...firstSkill, timeoutSec: 0 }],
		};
		expect(
			generateRobotPlanWorkspace(
				draftOf([{ stepRef: 'inspect', kind: 'skill', name: 'inspect_scene' }]),
				invalidCatalog,
				{ designId: 'design.errors' },
			),
		).toMatchObject({ ok: false, error: { code: 'CATALOG_INVALID', path: 'catalog' } });
	});

	it('validates guard, wait, timeout, and declared budget limits', () => {
		const badGuard: unknown = {
			...draftOf([{ stepRef: 'inspect', kind: 'skill', name: 'inspect_scene' }]),
			steps: [
				{
					stepRef: 'inspect',
					kind: 'skill',
					name: 'inspect_scene',
					when: { field: 'last.success', op: 'eq', value: 'yes' },
				},
			],
		};
		expect(
			generateRobotPlanWorkspace(badGuard, SO101_CATALOG_SNAPSHOT, {
				designId: 'design.bounds',
			}),
		).toMatchObject({ ok: false, error: { code: 'GUARD_INVALID' } });

		const badWait = draftOf([{ stepRef: 'wait', kind: 'wait', durationMs: 60001 }]);
		expect(
			generateRobotPlanWorkspace(badWait, SO101_CATALOG_SNAPSHOT, {
				designId: 'design.bounds',
			}),
		).toMatchObject({ ok: false, error: { code: 'WAIT_INVALID' } });

		const badTimeout = draftOf([
			{ stepRef: 'inspect', kind: 'skill', name: 'inspect_scene', timeoutSec: 601 },
		]);
		expect(
			generateRobotPlanWorkspace(badTimeout, SO101_CATALOG_SNAPSHOT, {
				designId: 'design.bounds',
			}),
		).toMatchObject({ ok: false, error: { code: 'TIMEOUT_INVALID' } });

		const smallBudget = {
			...draftOf([{ stepRef: 'inspect', kind: 'skill', name: 'inspect_scene' }]),
			budgetSec: 20,
		};
		expect(
			generateRobotPlanWorkspace(smallBudget, SO101_CATALOG_SNAPSHOT, {
				designId: 'design.bounds',
			}),
		).toMatchObject({ ok: false, error: { code: 'PLAN_BUDGET_EXCEEDED', path: 'budgetSec' } });

		const deepGuardChain = draftOf(
			Array.from({ length: 21 }, (_, index) => ({
				stepRef: `guarded-${index}`,
				kind: 'skill' as const,
				name: 'inspect_scene',
				when: { field: 'last.success' as const, op: 'eq' as const, value: true },
			})),
		);
		expect(
			generateRobotPlanWorkspace(deepGuardChain, SO101_CATALOG_SNAPSHOT, {
				designId: 'design.bounds',
			}),
		).toMatchObject({ ok: false, error: { code: 'TOO_MANY_STEPS', path: 'steps' } });
	});
});

function findBlockById(value: unknown, blockId: string): Record<string, unknown> | undefined {
	if (Array.isArray(value)) {
		for (const entry of value) {
			const found = findBlockById(entry, blockId);
			if (found !== undefined) return found;
		}
		return undefined;
	}
	if (typeof value !== 'object' || value === null) return undefined;
	const record = value as Record<string, unknown>;
	if (record.id === blockId) return record;
	for (const entry of Object.values(record)) {
		const found = findBlockById(entry, blockId);
		if (found !== undefined) return found;
	}
	return undefined;
}

function parseBlockData(block: Record<string, unknown> | undefined): unknown {
	if (block === undefined || typeof block.data !== 'string') return undefined;
	try {
		return JSON.parse(block.data);
	} catch {
		throw new Error('Expected robot block data to be valid JSON');
	}
}

function registerRoundTripBlocks(): void {
	if (Blockly.Blocks.robot_task_plan !== undefined) return;
	const skillOptions = SO101_CATALOG_SNAPSHOT.skills.map((skill): [string, string] => [
		skill.name,
		skill.name,
	]);
	Blockly.common.defineBlocksWithJsonArray([
		{
			type: 'robot_task_plan',
			message0: 'robot plan %1',
			args0: [{ type: 'input_statement', name: 'DO' }],
			colour: 30,
		},
		{
			type: 'robot_execute_skill',
			message0: 'execute skill %1',
			args0: [{ type: 'field_dropdown', name: 'SKILL', options: skillOptions }],
			previousStatement: null,
			nextStatement: null,
			colour: 30,
		},
		{
			type: 'robot_wait',
			message0: 'wait %1 seconds',
			args0: [{ type: 'input_value', name: 'SECONDS', check: 'Number' }],
			previousStatement: null,
			nextStatement: null,
			colour: 30,
		},
		{
			type: 'robot_condition',
			message0: 'condition %1 %2 %3',
			args0: [
				{
					type: 'field_dropdown',
					name: 'FIELD',
					options: [
						['last.success', 'last.success'],
						['last.state', 'last.state'],
					],
				},
				{
					type: 'field_dropdown',
					name: 'OP',
					options: [
						['==', '=='],
						['!=', '!='],
					],
				},
				{ type: 'input_value', name: 'VALUE', check: 'String' },
			],
			previousStatement: null,
			nextStatement: null,
			colour: 30,
		},
	]);
}
