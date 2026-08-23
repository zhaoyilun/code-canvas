import {
	nodeTypeBindingsV1Schema,
	sourceSnapshotV1Schema,
	stableReferenceSchema,
	type CanvasArtifactV1,
	type DualCanvasDocumentV1,
	type GeneratedLogicCanvasV1,
	type LogicNodeDraftV1,
	type ResultV1,
	type VisualProgramIRV1,
	type WorkflowFragmentV1,
} from '@n8n/dual-canvas-core';
import { z } from 'zod';

export const BLOCKLY_DATA_PAYLOAD_MEDIA_TYPE = 'application/vnd.n8n.blockly-data+json';

const entryFunctionSchema = z
	.string()
	.min(1)
	.max(64)
	.regex(/^[A-Za-z_][A-Za-z0-9_]*$/);

const workflowNodeBindingV1Schema = z
	.object({
		bindingRef: stableReferenceSchema,
		typeVersion: z.number().positive().finite(),
		label: z.string().trim().min(1).max(128),
	})
	.strict();

export const typeScriptSourceLanguageV1Schema = z.enum(['javascript', 'typescript', 'arkts']);

const supportedSourceSnapshotV1Schema = sourceSnapshotV1Schema
	.extend({ language: typeScriptSourceLanguageV1Schema })
	.strict();

export const typeScriptSourceImporterOptionsV1Schema = z
	.object({
		apiVersion: z.literal(1),
		title: z.string().trim().min(1).max(128),
		entryFunction: entryFunctionSchema,
	})
	.strict();

export type TypeScriptSourceImporterOptionsV1 = z.infer<
	typeof typeScriptSourceImporterOptionsV1Schema
>;

export const typeScriptImportRequestV1Schema = z
	.object({
		apiVersion: z.literal(1),
		documentRef: stableReferenceSchema,
		revisionRef: stableReferenceSchema,
		title: z.string().trim().min(1).max(128),
		profileRef: stableReferenceSchema,
		entryFunction: entryFunctionSchema,
		source: supportedSourceSnapshotV1Schema,
		bindings: nodeTypeBindingsV1Schema,
		workflow: z
			.object({
				manualTrigger: workflowNodeBindingV1Schema,
				blocklyCode: workflowNodeBindingV1Schema,
			})
			.strict(),
		canvasAdapterRef: stableReferenceSchema,
	})
	.strict();

export type TypeScriptImportRequestV1 = z.infer<typeof typeScriptImportRequestV1Schema>;

export type TypeScriptImportArtifactV1 = {
	program: VisualProgramIRV1;
	logic: LogicNodeDraftV1;
	generatedCanvas: GeneratedLogicCanvasV1;
	canvas: CanvasArtifactV1;
	workflow: WorkflowFragmentV1;
	document: DualCanvasDocumentV1;
};

export type TypeScriptImportResultV1 = ResultV1<TypeScriptImportArtifactV1>;
