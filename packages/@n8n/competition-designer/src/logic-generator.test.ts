import { compileBlocklyWorkspace, parseBlocklyDataPayload } from '@n8n/blockly-data-transform';
import { createRequire } from 'node:module';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import {
	generateBlocklyLogicNode,
	type BlocklyLogicExpressionDraft,
	type BlocklyLogicNodeDraft,
} from './logic-generator';

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

const draft: BlocklyLogicNodeDraft = {
	nodeRef: 'prepare-course-input',
	label: 'Prepare Course Input',
	outputMode: 'copyInput',
	statements: [
		{
			kind: 'set',
			intentStepId: 'calculate-total',
			targetField: 'total',
			value: {
				kind: 'arithmetic',
				op: 'multiply',
				left: { kind: 'input', path: 'price' },
				right: { kind: 'number', value: 1.2 },
			},
			teaching: {
				what: 'Calculate the normalized total',
				why: 'Keep the next node independent from the source unit',
				editable: ['multiplier'],
				expectedEffect: 'total is added to the current item',
			},
		},
		{
			kind: 'set',
			intentStepId: 'assign-grade',
			targetField: 'grade',
			value: {
				kind: 'conditional',
				condition: {
					kind: 'booleanOperation',
					op: 'and',
					left: {
						kind: 'compare',
						op: 'gte',
						left: { kind: 'input', path: 'score' },
						right: { kind: 'number', value: 60 },
					},
					right: { kind: 'not', value: { kind: 'boolean', value: false } },
				},
				whenTrue: {
					kind: 'join',
					values: [
						{ kind: 'text', value: 'pass-' },
						{ kind: 'input', path: 'student.id' },
					],
				},
				whenFalse: { kind: 'text', value: 'retry' },
			},
		},
	],
};

describe('generateBlocklyLogicNode', () => {
	it('generates a canonical schema-2 payload for the constrained expression grammar', () => {
		const result = generateBlocklyLogicNode(draft, 'lesson.logic');

		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(parseBlocklyDataPayload(result.generated.blocklyPayload)).toMatchObject({ ok: true });
		expect(result.generated.javascript).toContain(
			'output["total"] = (($json?.["price"] ?? null) * 1.2);',
		);
		expect(result.generated.javascript).toContain('? ["pass-"');
		expect(result.generated.sourceMap).toEqual([
			expect.objectContaining({
				logicNodeRef: 'prepare-course-input',
				intentStepId: 'calculate-total',
				targetField: 'total',
			}),
			expect.objectContaining({
				logicNodeRef: 'prepare-course-input',
				intentStepId: 'assign-grade',
				targetField: 'grade',
			}),
		]);
		const firstTrace = result.generated.sourceMap[0];
		expect(firstTrace).toBeDefined();
		if (firstTrace === undefined) return;
		const statementBlock = findBlockById(result.generated.workspace, firstTrace.blockId);
		expect(statementBlock).toBeDefined();
		expect(parseJson(String(statementBlock?.data))).toEqual({
			intentStepId: 'calculate-total',
			teaching: draft.statements[0].teaching,
		});
		expect(result.generated.blocklyPayload).toContain('calculate-total');
	});

	it('is byte-stable for the same design and changes IDs for a different design', () => {
		const first = generateBlocklyLogicNode(draft, 'lesson.logic');
		const second = generateBlocklyLogicNode(draft, 'lesson.logic');
		const other = generateBlocklyLogicNode(draft, 'lesson.other');

		expect(first).toEqual(second);
		expect(first.ok).toBe(true);
		expect(other.ok).toBe(true);
		if (!first.ok || !other.ok) return;
		expect(first.generated.blocklyPayload).not.toBe(other.generated.blocklyPayload);
	});

	it('generates arrays, objects, conversions, assertions, branches, and deletes', () => {
		const result = generateBlocklyLogicNode(
			{
				nodeRef: 'advanced-local-logic',
				label: 'Advanced Local Logic',
				outputMode: 'empty',
				statements: [
					{
						kind: 'assert',
						intentStepId: 'require-items',
						condition: {
							kind: 'compare',
							op: 'gt',
							left: { kind: 'arrayLength', array: { kind: 'input', path: 'items' } },
							right: { kind: 'number', value: 0 },
						},
						message: { kind: 'text', value: 'items are required' },
					},
					{
						kind: 'if',
						intentStepId: 'classify-items',
						condition: { kind: 'input', path: 'enabled' },
						then: [
							{
								kind: 'set',
								intentStepId: 'build-summary',
								targetField: 'summary',
								value: {
									kind: 'object',
									properties: [
										{
											key: 'ids',
											value: {
												kind: 'arrayMapPath',
												array: {
													kind: 'arrayFilterPath',
													array: { kind: 'input', path: 'items' },
													path: 'score',
													op: 'gte',
													value: { kind: 'number', value: 60 },
												},
												path: 'id',
											},
										},
										{
											key: 'firstName',
											value: {
												kind: 'convert',
												to: 'text',
												value: {
													kind: 'getPath',
													path: 'name',
													value: {
														kind: 'arrayAt',
														array: { kind: 'input', path: 'items' },
														index: { kind: 'number', value: 0 },
													},
												},
											},
										},
									],
								},
							},
						],
						else: [
							{
								kind: 'delete',
								intentStepId: 'remove-legacy-summary',
								targetField: 'legacySummary',
							},
						],
					},
					{
						kind: 'set',
						intentStepId: 'create-flags',
						targetField: 'flags',
						value: {
							kind: 'array',
							values: [
								{ kind: 'boolean', value: true },
								{ kind: 'convert', to: 'boolean', value: { kind: 'input', path: 'enabled' } },
							],
						},
					},
				],
			},
			'lesson.logic',
		);

		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.generated.javascript).toContain('throw new Error');
		expect(result.generated.javascript).toContain('items.filter');
		expect(result.generated.javascript).toContain('items.map');
		expect(result.generated.javascript).toContain('delete output["legacySummary"]');
		expect(result.generated.blocklyPayload).toContain('"extraState":{"itemCount":2}');
		expect(result.generated.sourceMap.map((entry) => entry.intentStepId)).toEqual([
			'require-items',
			'classify-items',
			'build-summary',
			'remove-legacy-summary',
			'create-flags',
		]);
		for (const trace of result.generated.sourceMap) {
			const block = findBlockById(result.generated.workspace, trace.blockId);
			expect(parseJson(String(block?.data))).toMatchObject({
				intentStepId: trace.intentStepId,
			});
		}
	});

	it('emits a zero-slot official list block for an empty semantic array', () => {
		const result = generateBlocklyLogicNode(
			{
				...draft,
				statements: [
					{
						kind: 'set',
						intentStepId: 'empty-list',
						targetField: 'values',
						value: { kind: 'array', values: [] },
					},
				],
			},
			'lesson.logic',
		);

		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.generated.javascript).toContain('output["values"] = [];');
		expect(result.generated.blocklyPayload).toContain('"extraState":{"itemCount":0}');
	});

	it.each([1, 3, 32])(
		'round-trips a %i-item text join through the repository Blockly 12.3.1 serializer',
		(itemCount) => {
			const result = generateBlocklyLogicNode(
				{
					...draft,
					statements: [
						{
							kind: 'set',
							intentStepId: `join-${itemCount}`,
							targetField: 'joined',
							value: {
								kind: 'join',
								values: Array.from({ length: itemCount }, (_, index) => ({
									kind: 'text' as const,
									value: `part-${index}`,
								})),
							},
						},
					],
				},
				'lesson.logic',
			);

			expect(Blockly.VERSION).toBe('12.3.1');
			expect(result.ok).toBe(true);
			if (!result.ok) return;
			const parsed = parseBlocklyDataPayload(result.generated.blocklyPayload);
			expect(parsed.ok).toBe(true);
			if (!parsed.ok) return;
			const generatedJoin = findBlockByType(parsed.payload.workspace, 'text_join');
			expect(generatedJoin?.extraState).toEqual({ itemCount });

			const workspace = new Blockly.Workspace();
			let saved: Record<string, unknown>;
			try {
				Blockly.serialization.workspaces.load(parsed.payload.workspace, workspace);
				saved = Blockly.serialization.workspaces.save(workspace);
			} finally {
				workspace.dispose();
			}
			const savedJoin = findBlockByType(saved, 'text_join');
			expect(savedJoin?.extraState).toEqual({ itemCount });
			expect(addInputNames(savedJoin)).toEqual(
				Array.from({ length: itemCount }, (_, index) => `ADD${index}`),
			);
			const recompiled = compileBlocklyWorkspace(saved);
			expect(recompiled).toMatchObject({ ok: true });
			if (recompiled.ok) expect(recompiled.javascript).toBe(result.generated.javascript);
		},
	);

	it.each([
		[
			'unknown expression kind',
			{
				...draft,
				statements: [{ ...draft.statements[0], value: { kind: 'eval', code: '1 + 1' } }],
			},
		],
		[
			'dangerous path',
			{ ...draft, statements: [{ ...draft.statements[0], targetField: '__proto__.polluted' }] },
		],
		[
			'dotted object key',
			{
				...draft,
				statements: [
					{
						...draft.statements[0],
						value: {
							kind: 'object',
							properties: [{ key: 'profile.name', value: { kind: 'text', value: 'Ada' } }],
						},
					},
				],
			},
		],
		['unknown field', { ...draft, arbitraryCode: 'return $json' }],
		[
			'duplicate intent',
			{
				...draft,
				statements: [
					draft.statements[0],
					{ ...draft.statements[1], intentStepId: 'calculate-total' },
				],
			},
		],
	])('rejects %s', (_name, invalidDraft) => {
		const result = generateBlocklyLogicNode(invalidDraft, 'lesson.logic');

		expect(result).toMatchObject({ ok: false, error: { code: 'LOGIC_DRAFT_INVALID' } });
	});

	it('reports generated workspace limits without emitting a partial payload', () => {
		let expression: BlocklyLogicExpressionDraft = { kind: 'boolean', value: true };
		for (let index = 0; index < 45; index += 1) expression = { kind: 'not', value: expression };

		const result = generateBlocklyLogicNode(
			{
				...draft,
				statements: [{ ...draft.statements[0], value: expression }],
			},
			'lesson.logic',
		);

		expect(result).toMatchObject({
			ok: false,
			error: { code: 'LOGIC_WORKSPACE_COMPILE_FAILED' },
		});
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

function findBlockByType(value: unknown, blockType: string): Record<string, unknown> | undefined {
	if (Array.isArray(value)) {
		for (const entry of value) {
			const found = findBlockByType(entry, blockType);
			if (found !== undefined) return found;
		}
		return undefined;
	}
	if (typeof value !== 'object' || value === null) return undefined;
	const record = value as Record<string, unknown>;
	if (record.type === blockType) return record;
	for (const entry of Object.values(record)) {
		const found = findBlockByType(entry, blockType);
		if (found !== undefined) return found;
	}
	return undefined;
}

function addInputNames(block: Record<string, unknown> | undefined): string[] {
	if (block === undefined || typeof block.inputs !== 'object' || block.inputs === null) return [];
	return Object.keys(block.inputs)
		.filter((name) => /^ADD\d+$/.test(name))
		.sort((left, right) => Number(left.slice(3)) - Number(right.slice(3)));
}

function registerRoundTripBlocks(): void {
	if (Blockly.Blocks.n8n_transform_item !== undefined) return;
	Blockly.common.defineBlocksWithJsonArray([
		{
			type: 'n8n_transform_item',
			message0: 'transform %1 %2',
			args0: [
				{
					type: 'field_dropdown',
					name: 'MODE',
					options: [
						['copy', 'COPY'],
						['empty', 'EMPTY'],
					],
				},
				{ type: 'input_statement', name: 'STATEMENTS', check: 'N8nLogicStatement' },
			],
			colour: 230,
		},
		{
			type: 'n8n_set_field',
			message0: 'set %1 to %2',
			args0: [
				{ type: 'field_input', name: 'KEY', text: '' },
				{ type: 'input_value', name: 'VALUE' },
			],
			previousStatement: 'N8nLogicStatement',
			nextStatement: 'N8nLogicStatement',
			colour: 230,
		},
	]);
}

function parseJson(value: string): unknown {
	try {
		return JSON.parse(value);
	} catch {
		throw new Error('Expected Blockly block data to be valid JSON');
	}
}
