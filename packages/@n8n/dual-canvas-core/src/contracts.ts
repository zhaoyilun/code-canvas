import { z } from 'zod';

import { workflowFragmentV1Schema } from './data-plane';
import type { ResultV1 } from './diagnostics';
import { createLogicStatementBlockRef } from './logic-block-refs';
import { flattenLogicStatements, logicNodeDraftV1Schema } from './logic-ir';
import { sourceMapEntryV1Schema, type SourceMapEntryV1 } from './mapping';
import { canvasArtifactV1Schema } from './plugin-sdk';
import {
	canvasPositionSchema,
	jsonObjectSchema,
	stableReferenceSchema,
	timestampSchema,
} from './primitives';

export const sourceSnapshotV1Schema = z
	.object({
		apiVersion: z.literal(1),
		sourceRef: stableReferenceSchema,
		language: stableReferenceSchema,
		content: z.string().max(2_097_152),
		uri: z.string().trim().min(1).max(2048).optional(),
		sha256: z
			.string()
			.regex(/^[a-f0-9]{64}$/)
			.optional(),
		capturedAt: timestampSchema.optional(),
	})
	.strict();

const visualProgramNodeV1Schema = z
	.object({
		nodeRef: stableReferenceSchema,
		operationRef: stableReferenceSchema,
		label: z.string().trim().min(1).max(128),
		position: canvasPositionSchema,
		parameters: jsonObjectSchema,
		logic: logicNodeDraftV1Schema.optional(),
		metadata: jsonObjectSchema.optional(),
	})
	.strict()
	.superRefine((node, context) => {
		if (node.logic !== undefined && node.logic.nodeRef !== node.nodeRef) {
			context.addIssue({
				code: 'custom',
				path: ['logic', 'nodeRef'],
				message: 'embedded logic must use its owner node reference',
			});
		}
	});

const visualProgramEndpointV1Schema = z
	.object({
		nodeRef: stableReferenceSchema,
		portRef: stableReferenceSchema,
	})
	.strict();

const visualProgramEdgeV1Schema = z
	.object({
		edgeRef: stableReferenceSchema,
		from: visualProgramEndpointV1Schema,
		to: visualProgramEndpointV1Schema,
	})
	.strict();

export const visualProgramIRV1Schema = z
	.object({
		apiVersion: z.literal(1),
		documentRef: stableReferenceSchema,
		revisionRef: stableReferenceSchema,
		title: z.string().trim().min(1).max(128),
		profileRef: stableReferenceSchema,
		sources: z.array(sourceSnapshotV1Schema).max(32),
		nodes: z.array(visualProgramNodeV1Schema).min(1).max(1000),
		edges: z.array(visualProgramEdgeV1Schema).max(4000),
		sourceMap: z.array(sourceMapEntryV1Schema).max(8000),
		metadata: jsonObjectSchema.optional(),
	})
	.strict()
	.superRefine((program, context) => {
		addDuplicateIssues(
			program.sources.map((source) => source.sourceRef),
			context,
			'sources',
			'sourceRef',
		);
		addDuplicateIssues(
			program.nodes.map((node) => node.nodeRef),
			context,
			'nodes',
			'nodeRef',
		);
		addDuplicateIssues(
			program.edges.map((edge) => edge.edgeRef),
			context,
			'edges',
			'edgeRef',
		);
		addDuplicateIssues(
			program.sourceMap.map((entry) => entry.mappingRef),
			context,
			'sourceMap',
			'mappingRef',
		);
		const nodeRefs = new Set(program.nodes.map((node) => node.nodeRef));
		const sourceRefs = new Set(program.sources.map((source) => source.sourceRef));
		const canvasRefs = new Set(
			program.nodes.flatMap((node) => {
				const canvasRef = node.metadata?.canvasRef;
				return typeof canvasRef === 'string' ? [canvasRef] : [];
			}),
		);
		const logicNodeRefs = new Set(
			program.nodes.filter((node) => node.logic !== undefined).map((node) => node.nodeRef),
		);
		const logicStepRefsByNode = new Map(
			program.nodes.flatMap((node) =>
				node.logic === undefined
					? []
					: [
							[
								node.nodeRef,
								new Set(
									flattenLogicStatements(node.logic.statements).map(
										(statement) => statement.stepRef,
									),
								),
							] as const,
						],
			),
		);
		validateSourceMapReferences(program.sourceMap, context, 'sourceMap', {
			sourceRefs,
			workflowNodeRefs: nodeRefs,
			canvasRefs,
			logicNodeRefs,
			logicStepRefsByNode,
			logicDocumentRef: program.documentRef,
		});
		for (const [index, edge] of program.edges.entries()) {
			if (!nodeRefs.has(edge.from.nodeRef)) {
				context.addIssue({
					code: 'custom',
					path: ['edges', index, 'from', 'nodeRef'],
					message: `unknown source node "${edge.from.nodeRef}"`,
				});
			}
			if (!nodeRefs.has(edge.to.nodeRef)) {
				context.addIssue({
					code: 'custom',
					path: ['edges', index, 'to', 'nodeRef'],
					message: `unknown target node "${edge.to.nodeRef}"`,
				});
			}
		}
	});

export const sourceImportRequestV1Schema = z
	.object({
		apiVersion: z.literal(1),
		documentRef: stableReferenceSchema,
		revisionRef: stableReferenceSchema,
		profileRef: stableReferenceSchema,
		source: sourceSnapshotV1Schema,
		options: jsonObjectSchema.optional(),
	})
	.strict();

export const dualCanvasDocumentV1Schema = z
	.object({
		apiVersion: z.literal(1),
		documentRef: stableReferenceSchema,
		revisionRef: stableReferenceSchema,
		title: z.string().trim().min(1).max(128),
		profileRef: stableReferenceSchema,
		workflow: workflowFragmentV1Schema,
		canvases: z.array(canvasArtifactV1Schema).max(256),
		sources: z.array(sourceSnapshotV1Schema).max(32),
		sourceMap: z.array(sourceMapEntryV1Schema).max(8000),
		metadata: jsonObjectSchema.optional(),
	})
	.strict()
	.superRefine((document, context) => {
		addDuplicateIssues(
			document.canvases.map((canvas) => canvas.canvasRef),
			context,
			'canvases',
			'canvasRef',
		);
		addDuplicateIssues(
			document.sources.map((source) => source.sourceRef),
			context,
			'sources',
			'sourceRef',
		);
		addDuplicateIssues(
			document.sourceMap.map((entry) => entry.mappingRef),
			context,
			'sourceMap',
			'mappingRef',
		);
		addTreeMappingRefIssues(document.sourceMap, document.canvases, context);
		const sourceRefs = new Set(document.sources.map((source) => source.sourceRef));
		const workflowNodeRefs = new Set(document.workflow.nodes.map((node) => node.nodeRef));
		const canvasRefs = new Set(document.canvases.map((canvas) => canvas.canvasRef));
		const canvasBlockRefs = new Set(document.canvases.flatMap((canvas) => canvas.blockRefs));
		for (const [index, canvas] of document.canvases.entries()) {
			if (canvas.ownerNodeRef !== undefined && !workflowNodeRefs.has(canvas.ownerNodeRef)) {
				context.addIssue({
					code: 'custom',
					path: ['canvases', index, 'ownerNodeRef'],
					message: `unknown canvas owner node "${canvas.ownerNodeRef}"`,
				});
			}
			validateSourceMapReferences(canvas.sourceMap, context, `canvases.${index}.sourceMap`, {
				sourceRefs,
				workflowNodeRefs,
				canvasRefs,
				canvasBlockRefs: new Set(canvas.blockRefs),
			});
		}
		validateSourceMapReferences(document.sourceMap, context, 'sourceMap', {
			sourceRefs,
			workflowNodeRefs,
			canvasRefs,
			canvasBlockRefs,
		});
	});

export type SourceSnapshotV1 = z.infer<typeof sourceSnapshotV1Schema>;
export type VisualProgramIRV1 = z.infer<typeof visualProgramIRV1Schema>;
export type SourceImportRequestV1 = z.infer<typeof sourceImportRequestV1Schema>;
export type DualCanvasDocumentV1 = z.infer<typeof dualCanvasDocumentV1Schema>;

export interface SourceImporterV1 {
	apiVersion: 1;
	importerRef: string;
	supportedLanguages: string[];
	importSource(request: SourceImportRequestV1): ResultV1<VisualProgramIRV1>;
}

function addDuplicateIssues(
	values: string[],
	context: z.RefinementCtx,
	collection: string,
	field: string,
): void {
	const seen = new Set<string>();
	for (const [index, value] of values.entries()) {
		if (seen.has(value)) {
			context.addIssue({
				code: 'custom',
				path: [collection, index, field],
				message: `duplicate ${field} "${value}"`,
			});
		}
		seen.add(value);
	}
}

type SourceMapReferenceSets = {
	sourceRefs: Set<string>;
	workflowNodeRefs: Set<string>;
	canvasRefs: Set<string>;
	canvasBlockRefs?: Set<string>;
	logicNodeRefs?: Set<string>;
	logicStepRefsByNode?: Map<string, Set<string>>;
	logicDocumentRef?: string;
};

function validateSourceMapReferences(
	entries: SourceMapEntryV1[],
	context: z.RefinementCtx,
	collectionPath: string,
	refs: SourceMapReferenceSets,
): void {
	const pathPrefix = collectionPath
		.split('.')
		.map((part) => (/^\d+$/.test(part) ? Number(part) : part));
	for (const [index, entry] of entries.entries()) {
		const entryPath = [...pathPrefix, index];
		if (entry.source !== undefined && !refs.sourceRefs.has(entry.source.sourceRef)) {
			context.addIssue({
				code: 'custom',
				path: [...entryPath, 'source', 'sourceRef'],
				message: `unknown source "${entry.source.sourceRef}"`,
			});
		}
		switch (entry.artifact.kind) {
			case 'workflowNode':
				if (!refs.workflowNodeRefs.has(entry.artifact.ref)) {
					addUnknownArtifactIssue(context, entryPath, entry);
				}
				break;
			case 'canvas':
				if (!refs.canvasRefs.has(entry.artifact.ref)) {
					addUnknownArtifactIssue(context, entryPath, entry);
				}
				break;
			case 'canvasBlock': {
				const contextNodeRef = entry.context?.nodeRef;
				if (refs.canvasBlockRefs !== undefined && !refs.canvasBlockRefs.has(entry.artifact.ref)) {
					addUnknownArtifactIssue(context, entryPath, entry);
				}
				if (refs.logicStepRefsByNode === undefined) break;
				if (
					typeof contextNodeRef !== 'string' ||
					!(refs.logicNodeRefs?.has(contextNodeRef) ?? false)
				) {
					context.addIssue({
						code: 'custom',
						path: [...entryPath, 'context', 'nodeRef'],
						message: 'canvasBlock mapping requires a known logic owner node',
					});
					break;
				}
				if (!refs.logicStepRefsByNode.get(contextNodeRef)?.has(entry.semanticRef)) {
					context.addIssue({
						code: 'custom',
						path: [...entryPath, 'semanticRef'],
						message: `unknown logic step "${entry.semanticRef}" for owner "${contextNodeRef}"`,
					});
					break;
				}
				if (refs.logicDocumentRef !== undefined) {
					const expectedBlockRef = createLogicStatementBlockRef(
						refs.logicDocumentRef,
						contextNodeRef,
						entry.semanticRef,
					);
					if (entry.artifact.ref !== expectedBlockRef) {
						context.addIssue({
							code: 'custom',
							path: [...entryPath, 'artifact', 'ref'],
							message: `canvasBlock artifact must be "${expectedBlockRef}" for its logic owner and step`,
						});
					}
				}
				break;
			}
			case 'planStep':
				break;
			case 'other':
				break;
		}
	}
}

function addTreeMappingRefIssues(
	rootEntries: SourceMapEntryV1[],
	canvases: Array<z.infer<typeof canvasArtifactV1Schema>>,
	context: z.RefinementCtx,
): void {
	const seen = new Map<string, { entry: SourceMapEntryV1; path: Array<string | number> }>();
	const groups = [
		{ entries: rootEntries, path: ['sourceMap'] as Array<string | number> },
		...canvases.map((canvas, index) => ({
			entries: canvas.sourceMap,
			path: ['canvases', index, 'sourceMap'] as Array<string | number>,
		})),
	];
	for (const group of groups) {
		for (const [index, entry] of group.entries.entries()) {
			const existing = seen.get(entry.mappingRef);
			if (existing !== undefined && JSON.stringify(existing.entry) !== JSON.stringify(entry)) {
				context.addIssue({
					code: 'custom',
					path: [...group.path, index, 'mappingRef'],
					message: `mappingRef "${entry.mappingRef}" conflicts with ${existing.path.map(String).join('.')}`,
				});
				continue;
			}
			seen.set(entry.mappingRef, { entry, path: [...group.path, index, 'mappingRef'] });
		}
	}
}

function addUnknownArtifactIssue(
	context: z.RefinementCtx,
	entryPath: Array<string | number>,
	entry: SourceMapEntryV1,
): void {
	context.addIssue({
		code: 'custom',
		path: [...entryPath, 'artifact', 'ref'],
		message: `unknown ${entry.artifact.kind} artifact "${entry.artifact.ref}"`,
	});
}
