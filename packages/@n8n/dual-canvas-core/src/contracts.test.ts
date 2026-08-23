import { describe, expect, it } from 'vitest';

import {
	dualCanvasDocumentV1Schema,
	sourceImportRequestV1Schema,
	visualProgramIRV1Schema,
} from './contracts';
import { createLogicStatementBlockRef } from './logic-block-refs';

const logic = {
	nodeRef: 'transform.1',
	label: 'Prepare fields',
	outputMode: 'copyInput',
	statements: [
		{
			kind: 'set',
			stepRef: 'set.title',
			targetField: 'title',
			value: { kind: 'input', path: 'name' },
		},
	],
} as const;

const program = {
	apiVersion: 1,
	documentRef: 'lesson.alpha',
	revisionRef: 'revision.1',
	title: 'Prepare and publish',
	profileRef: 'teaching.general',
	sources: [],
	nodes: [
		{
			nodeRef: 'transform.1',
			operationRef: 'data.transform',
			label: 'Prepare fields',
			position: { x: 100, y: 100 },
			parameters: {},
			logic,
		},
		{
			nodeRef: 'publish.1',
			operationRef: 'document.publish',
			label: 'Publish',
			position: { x: 320, y: 100 },
			parameters: {},
		},
	],
	edges: [
		{
			edgeRef: 'edge.1',
			from: { nodeRef: 'transform.1', portRef: 'output' },
			to: { nodeRef: 'publish.1', portRef: 'input' },
		},
	],
	sourceMap: [],
} as const;

describe('visual program contracts', () => {
	it('validates a domain-independent visual program IR', () => {
		expect(visualProgramIRV1Schema.safeParse(program).success).toBe(true);
	});

	it('requires graph edges and embedded logic to reference their owning nodes', () => {
		expect(
			visualProgramIRV1Schema.safeParse({
				...program,
				edges: [
					{
						...program.edges[0],
						to: { nodeRef: 'missing', portRef: 'input' },
					},
				],
			}).success,
		).toBe(false);
		expect(
			visualProgramIRV1Schema.safeParse({
				...program,
				nodes: [
					{
						...program.nodes[0],
						logic: { ...logic, nodeRef: 'other' },
					},
					program.nodes[1],
				],
			}).success,
		).toBe(false);
	});

	it('keeps imported source content in a versioned request', () => {
		expect(
			sourceImportRequestV1Schema.safeParse({
				apiVersion: 1,
				documentRef: 'lesson.alpha',
				revisionRef: 'revision.1',
				profileRef: 'teaching.general',
				source: {
					apiVersion: 1,
					sourceRef: 'source.main',
					language: 'typescript',
					content: 'const title = input.name;',
				},
			}).success,
		).toBe(true);
	});

	it('rejects duplicate, dangling-source, and dangling-artifact mappings', () => {
		const source = {
			apiVersion: 1,
			sourceRef: 'source.main',
			language: 'typescript',
			content: 'return input;',
		} as const;
		const mapping = {
			apiVersion: 1,
			mappingRef: 'mapping.return',
			semanticRef: 'return.output',
			artifact: { kind: 'workflowNode', ref: 'transform.1' },
			source: {
				sourceRef: source.sourceRef,
				start: { line: 1, column: 0, offset: 0 },
				end: { line: 1, column: 6, offset: 6 },
			},
		} as const;
		expect(
			visualProgramIRV1Schema.safeParse({ ...program, sources: [source], sourceMap: [mapping] })
				.success,
		).toBe(true);
		expect(
			visualProgramIRV1Schema.safeParse({
				...program,
				sources: [source],
				sourceMap: [mapping, mapping],
			}).success,
		).toBe(false);
		expect(
			visualProgramIRV1Schema.safeParse({
				...program,
				sources: [source],
				sourceMap: [{ ...mapping, source: { ...mapping.source, sourceRef: 'source.missing' } }],
			}).success,
		).toBe(false);
		expect(
			visualProgramIRV1Schema.safeParse({
				...program,
				sources: [source],
				sourceMap: [{ ...mapping, artifact: { kind: 'workflowNode', ref: 'node.missing' } }],
			}).success,
		).toBe(false);
	});

	it('scopes identical logic step references to their owner node', () => {
		const sharedLogic = (nodeRef: string, extraStepRef?: string) => ({
			nodeRef,
			label: `Logic for ${nodeRef}`,
			outputMode: 'copyInput' as const,
			statements: [
				{
					kind: 'set' as const,
					stepRef: 'shared.step',
					targetField: 'shared',
					value: { kind: 'boolean' as const, value: true },
				},
				...(extraStepRef === undefined
					? []
					: [
							{
								kind: 'set' as const,
								stepRef: extraStepRef,
								targetField: 'extra',
								value: { kind: 'boolean' as const, value: true },
							},
						]),
			],
		});
		const firstBlockRef = createLogicStatementBlockRef(
			program.documentRef,
			'logic.first',
			'shared.step',
		);
		const secondBlockRef = createLogicStatementBlockRef(
			program.documentRef,
			'logic.second',
			'shared.step',
		);
		expect(firstBlockRef).not.toBe(secondBlockRef);
		const programWithTwoOwners = {
			...program,
			nodes: [
				{ ...program.nodes[0], nodeRef: 'logic.first', logic: sharedLogic('logic.first') },
				{
					...program.nodes[1],
					nodeRef: 'logic.second',
					logic: sharedLogic('logic.second', 'second.only'),
				},
			],
			edges: [],
			sourceMap: [
				{
					apiVersion: 1,
					mappingRef: 'mapping.shared.first',
					semanticRef: 'shared.step',
					artifact: { kind: 'canvasBlock', ref: firstBlockRef },
					context: { nodeRef: 'logic.first' },
				},
				{
					apiVersion: 1,
					mappingRef: 'mapping.shared.second',
					semanticRef: 'shared.step',
					artifact: { kind: 'canvasBlock', ref: secondBlockRef },
					context: { nodeRef: 'logic.second' },
				},
			],
		};
		expect(visualProgramIRV1Schema.safeParse(programWithTwoOwners).success).toBe(true);
		expect(
			visualProgramIRV1Schema.safeParse({
				...programWithTwoOwners,
				sourceMap: [
					{
						...programWithTwoOwners.sourceMap[1],
						mappingRef: 'mapping.missing.block',
						artifact: { kind: 'canvasBlock', ref: 'totally-missing-block' },
					},
				],
			}).success,
		).toBe(false);
		expect(
			visualProgramIRV1Schema.safeParse({
				...programWithTwoOwners,
				sourceMap: [
					{
						...programWithTwoOwners.sourceMap[1],
						mappingRef: 'mapping.borrowed.block',
						artifact: { kind: 'canvasBlock', ref: secondBlockRef },
						context: { nodeRef: 'logic.first' },
					},
				],
			}).success,
		).toBe(false);
	});

	it('rejects conflicting mapping identities across document canvases', () => {
		const mapping = {
			apiVersion: 1,
			mappingRef: 'mapping.cross-canvas',
			semanticRef: 'step.first',
			artifact: { kind: 'canvasBlock', ref: 'block.first' },
		} as const;
		const canvas = {
			apiVersion: 1,
			canvasRef: 'canvas.first',
			adapterRef: 'adapter.logic',
			ownerNodeRef: 'transform.1',
			payloadMediaType: 'application/json',
			payload: '{}',
			blockRefs: ['block.first'],
			sourceMap: [mapping],
		} as const;
		const document = {
			apiVersion: 1,
			documentRef: 'document.mapping-test',
			revisionRef: 'revision.1',
			title: 'Mapping test',
			profileRef: 'teaching.general',
			workflow: {
				apiVersion: 1,
				fragmentRef: 'fragment.mapping-test',
				nodes: [
					{
						nodeRef: 'transform.1',
						bindingRef: 'transform',
						nodeType: 'n8n-nodes-sample.transform',
						typeVersion: 1,
						label: 'Transform',
						position: { x: 0, y: 0 },
						parameters: {},
					},
				],
				connections: [],
				entryNodeRefs: ['transform.1'],
				exitNodeRefs: ['transform.1'],
			},
			canvases: [
				canvas,
				{
					...canvas,
					canvasRef: 'canvas.second',
					blockRefs: ['block.second'],
					sourceMap: [
						{
							...mapping,
							semanticRef: 'step.second',
							artifact: { kind: 'canvasBlock', ref: 'block.second' },
						},
					],
				},
			],
			sources: [],
			sourceMap: [],
		} as const;
		expect(dualCanvasDocumentV1Schema.safeParse(document).success).toBe(false);
	});
});
