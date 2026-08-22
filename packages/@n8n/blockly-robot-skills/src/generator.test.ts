import { describe, expect, it } from 'vitest';

import type { RobotCatalog } from './catalog';
import { SO101_CATALOG_SNAPSHOT } from './catalog';
import { compileRobotWorkspace } from './compiler';
import type { RobotPlanDraft } from './generator';
import { generateRobotPlanWorkspace } from './generator';

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
		}
		expect(first.sourceMap[0]?.guardBlockId).toBeDefined();
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
