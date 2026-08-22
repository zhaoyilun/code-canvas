import { SO101_CATALOG_SNAPSHOT, parseRobotPlanPayload } from '@n8n/blockly-robot-skills';
import { describe, expect, it } from 'vitest';

import { generateCompetitionDesign, type CompetitionDesignDraft } from './design-generator';
import { validateCompetitionWorkflow } from './workflow-policy';

const draft: CompetitionDesignDraft = {
	schemaVersion: '1.0',
	designId: 'lesson.pick-and-place',
	revisionId: 'revision-1',
	name: 'AI 可解释机器人课程',
	robotPlan: {
		schemaVersion: 1,
		planRef: 'plan.pick-and-place',
		label: '观察并问候',
		robotProfileRef: SO101_CATALOG_SNAPSHOT.robotName,
		catalogDigest: SO101_CATALOG_SNAPSHOT.configDigest,
		budgetSec: 90,
		steps: [
			{
				stepRef: 'observe',
				kind: 'skill',
				name: 'inspect_scene',
				teaching: {
					what: '观察场景',
					why: '先获得环境信息',
					editable: [],
					expectedEffect: '形成场景状态',
				},
			},
			{ stepRef: 'pause', kind: 'wait', durationMs: 500 },
			{
				stepRef: 'wave',
				kind: 'skill',
				name: 'wave_hello',
				when: { field: 'last.success', op: 'eq', value: true },
			},
		],
	},
};

describe('generateCompetitionDesign', () => {
	it('generates linked Blockly and n8n diagrams from one semantic draft', () => {
		const result = generateCompetitionDesign(draft, {
			catalog: SO101_CATALOG_SNAPSHOT,
			robotCredential: { id: 'credential-1', name: 'Classroom Robot' },
		});

		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(parseRobotPlanPayload(result.artifact.blocklyPayload).ok).toBe(true);
		expect(result.artifact.robotPlan.plan).toHaveLength(3);
		expect(result.artifact.semanticDraft.steps[0]?.teaching?.why).toBe('先获得环境信息');
		expect(result.artifact.traceMap.map((entry) => entry.intentStepId)).toEqual([
			'observe',
			'pause',
			'wave',
		]);
		expect(validateCompetitionWorkflow(result.artifact.n8nWorkflow)).toEqual([]);
	});

	it('is byte-stable for the same design revision', () => {
		const context = {
			catalog: SO101_CATALOG_SNAPSHOT,
			robotCredential: { id: 'credential-1', name: 'Classroom Robot' },
		};
		const first = generateCompetitionDesign(draft, context);
		const second = generateCompetitionDesign(draft, context);

		expect(first).toEqual(second);
	});

	it('returns robot plan validation errors before producing either graph', () => {
		const result = generateCompetitionDesign(
			{
				...draft,
				robotPlan: { ...draft.robotPlan, catalogDigest: 'stale-catalog' },
			},
			{
				catalog: SO101_CATALOG_SNAPSHOT,
				robotCredential: { id: 'credential-1', name: 'Classroom Robot' },
			},
		);

		expect(result).toMatchObject({
			ok: false,
			stage: 'robot-plan',
			error: { code: 'CATALOG_DIGEST_MISMATCH' },
		});
	});

	it('rejects malformed design envelopes before plan generation', () => {
		const result = generateCompetitionDesign(
			{ ...draft, designId: 'contains spaces' },
			{
				catalog: SO101_CATALOG_SNAPSHOT,
				robotCredential: { id: 'credential-1', name: 'Classroom Robot' },
			},
		);

		expect(result).toMatchObject({
			ok: false,
			stage: 'design-draft',
			diagnostics: [{ code: 'WORKFLOW_DRAFT_INVALID', ref: 'designId' }],
		});
	});
});
