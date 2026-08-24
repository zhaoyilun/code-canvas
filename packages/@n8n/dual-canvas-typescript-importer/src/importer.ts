import {
	canvasArtifactV1Schema,
	createStableArtifactRef,
	createStableId,
	dualCanvasDocumentV1Schema,
	flattenLogicStatements,
	generateLogicCanvas,
	resolveNodeTypeBinding,
	sourceImportRequestV1Schema,
	validateWorkflowFragmentBindings,
	visualProgramIRV1Schema,
	workflowFragmentV1Schema,
	type DiagnosticV1,
	type ResultV1,
	type SourceImportRequestV1,
	type SourceImporterV1,
	type SourceMapEntryV1,
	type VisualProgramIRV1,
} from '@n8n/dual-canvas-core';
import type { z } from 'zod';

import {
	BLOCKLY_DATA_PAYLOAD_MEDIA_TYPE,
	type TypeScriptImportArtifactV1,
	type TypeScriptImportResultV1,
	type TypeScriptImportRequestV1,
	type TypeScriptSourceImporterOptionsV1,
	typeScriptSourceLanguageV1Schema,
	typeScriptSourceImporterOptionsV1Schema,
	typeScriptImportRequestV1Schema,
} from './contracts';
import { parseTeachingProgram } from './parser';

export const TYPE_SCRIPT_IMPORTER_REF = 'source-import.typescript.v1';
export const TYPE_SCRIPT_IMPORTER_LANGUAGES = ['javascript', 'typescript', 'arkts'] as const;
export const TYPE_SCRIPT_IMPORTER_SEMANTICS_REF =
	'source-semantics.blockly-data-transform-equivalent.v1';
export const TYPE_SCRIPT_IMPORTER_OPERATION_REF = 'logic.data-transform.v1';

export function importTypeScriptSource(requestInput: unknown): TypeScriptImportResultV1 {
	const parsedRequest = typeScriptImportRequestV1Schema.safeParse(requestInput);
	if (!parsedRequest.success) {
		return {
			ok: false,
			diagnostics: zodDiagnostics('IMPORT_REQUEST_INVALID', parsedRequest.error),
		};
	}
	const request = parsedRequest.data;
	const refs = createArtifactRefs(request);

	const manualType = resolveNodeTypeBinding(
		request.bindings,
		request.workflow.manualTrigger.bindingRef,
	);
	const blocklyType = resolveNodeTypeBinding(
		request.bindings,
		request.workflow.blocklyCode.bindingRef,
	);
	if (!manualType.ok || !blocklyType.ok) {
		const bindingDiagnostics: DiagnosticV1[] = [];
		if (!manualType.ok) bindingDiagnostics.push(manualType.diagnostic);
		if (!blocklyType.ok) bindingDiagnostics.push(blocklyType.diagnostic);
		return { ok: false, diagnostics: bindingDiagnostics };
	}

	const sourceResult = parseTeachingProgram(
		request,
		refs.logicNodeRef,
		request.workflow.blocklyCode.label,
	);
	if (!sourceResult.ok) return sourceResult;

	const generationResult = generateLogicCanvas(
		sourceResult.parsed.logic,
		request.documentRef,
		request.operationCatalog,
	);
	if (!generationResult.ok) {
		return {
			ok: false,
			diagnostics: [
				{
					apiVersion: 1,
					code: generationResult.error.code,
					severity: 'error',
					message: generationResult.error.message,
					path: generationResult.error.path,
				},
			],
		};
	}

	const entryMapping = createSourceMapping(
		request,
		'entry-function',
		refs.logicNodeRef,
		{ kind: 'workflowNode', ref: refs.logicNodeRef },
		sourceResult.parsed.entrySpan,
	);
	const initializationMapping = createSourceMapping(
		request,
		'output-initialization',
		refs.outputInitializationRef,
		{ kind: 'canvas', ref: refs.canvasRef },
		sourceResult.parsed.outputInitializationSpan,
	);
	const returnMapping = createSourceMapping(
		request,
		'output-return',
		refs.outputReturnRef,
		{ kind: 'workflowNode', ref: refs.logicNodeRef },
		sourceResult.parsed.returnSpan,
	);
	const sourceMap = [
		entryMapping,
		initializationMapping,
		returnMapping,
		...generationResult.generated.sourceMap,
	];

	const workflowResult = workflowFragmentV1Schema.safeParse({
		apiVersion: 1,
		fragmentRef: refs.fragmentRef,
		nodes: [
			{
				nodeRef: refs.manualNodeRef,
				bindingRef: request.workflow.manualTrigger.bindingRef,
				nodeType: manualType.nodeType,
				typeVersion: request.workflow.manualTrigger.typeVersion,
				label: request.workflow.manualTrigger.label,
				position: { x: 0, y: 0 },
				parameters: {},
			},
			{
				nodeRef: refs.logicNodeRef,
				bindingRef: request.workflow.blocklyCode.bindingRef,
				nodeType: blocklyType.nodeType,
				typeVersion: request.workflow.blocklyCode.typeVersion,
				label: request.workflow.blocklyCode.label,
				position: { x: 280, y: 0 },
				parameters: { blocklyPayload: generationResult.generated.blocklyPayload },
			},
		],
		connections: [
			{
				connectionRef: refs.connectionRef,
				from: { nodeRef: refs.manualNodeRef, port: 'main', index: 0 },
				to: { nodeRef: refs.logicNodeRef, port: 'main', index: 0 },
			},
		],
		entryNodeRefs: [refs.manualNodeRef],
		exitNodeRefs: [refs.logicNodeRef],
		metadata: {
			importerRef: TYPE_SCRIPT_IMPORTER_REF,
			sourceSemanticsRef: TYPE_SCRIPT_IMPORTER_SEMANTICS_REF,
			sourceRef: request.source.sourceRef,
			canvasRef: refs.canvasRef,
		},
	});
	if (!workflowResult.success) {
		return {
			ok: false,
			diagnostics: zodDiagnostics('WORKFLOW_FRAGMENT_GENERATION_INVALID', workflowResult.error),
		};
	}
	const bindingValidation = validateWorkflowFragmentBindings(workflowResult.data, request.bindings);
	if (bindingValidation.length > 0) return { ok: false, diagnostics: bindingValidation };

	const canvasResult = canvasArtifactV1Schema.safeParse({
		apiVersion: 1,
		canvasRef: refs.canvasRef,
		adapterRef: request.canvasAdapterRef,
		ownerNodeRef: refs.logicNodeRef,
		payloadMediaType: BLOCKLY_DATA_PAYLOAD_MEDIA_TYPE,
		payload: generationResult.generated.blocklyPayload,
		preview: generationResult.generated.javascript,
		blockRefs: generationResult.generated.blockRefs,
		sourceMap: [initializationMapping, ...generationResult.generated.sourceMap],
	});
	if (!canvasResult.success) {
		return {
			ok: false,
			diagnostics: zodDiagnostics('CANVAS_GENERATION_INVALID', canvasResult.error),
		};
	}

	const programResult = visualProgramIRV1Schema.safeParse({
		apiVersion: 1,
		documentRef: request.documentRef,
		revisionRef: request.revisionRef,
		title: request.title,
		profileRef: request.profileRef,
		sources: [request.source],
		nodes: [
			{
				nodeRef: refs.manualNodeRef,
				operationRef: request.workflow.manualTrigger.bindingRef,
				label: request.workflow.manualTrigger.label,
				position: { x: 0, y: 0 },
				parameters: {},
			},
			{
				nodeRef: refs.logicNodeRef,
				operationRef: request.workflow.blocklyCode.bindingRef,
				label: request.workflow.blocklyCode.label,
				position: { x: 280, y: 0 },
				parameters: { blocklyPayload: generationResult.generated.blocklyPayload },
				logic: generationResult.normalizedDraft,
				metadata: { canvasRef: refs.canvasRef },
			},
		],
		edges: [
			{
				edgeRef: refs.edgeRef,
				from: { nodeRef: refs.manualNodeRef, portRef: 'main' },
				to: { nodeRef: refs.logicNodeRef, portRef: 'main' },
			},
		],
		sourceMap,
		metadata: {
			importerRef: TYPE_SCRIPT_IMPORTER_REF,
			sourceSemanticsRef: TYPE_SCRIPT_IMPORTER_SEMANTICS_REF,
			canvasRef: refs.canvasRef,
		},
	});
	if (!programResult.success) {
		return {
			ok: false,
			diagnostics: zodDiagnostics('PROGRAM_GENERATION_INVALID', programResult.error),
		};
	}

	const documentResult = dualCanvasDocumentV1Schema.safeParse({
		apiVersion: 1,
		documentRef: request.documentRef,
		revisionRef: request.revisionRef,
		title: request.title,
		profileRef: request.profileRef,
		workflow: workflowResult.data,
		canvases: [canvasResult.data],
		sources: [request.source],
		sourceMap,
		metadata: {
			importerRef: TYPE_SCRIPT_IMPORTER_REF,
			sourceSemanticsRef: TYPE_SCRIPT_IMPORTER_SEMANTICS_REF,
		},
	});
	if (!documentResult.success) {
		return {
			ok: false,
			diagnostics: zodDiagnostics('DOCUMENT_GENERATION_INVALID', documentResult.error),
		};
	}

	const artifact: TypeScriptImportArtifactV1 = {
		program: programResult.data,
		logic: generationResult.normalizedDraft,
		generatedCanvas: generationResult.generated,
		canvas: canvasResult.data,
		workflow: workflowResult.data,
		document: documentResult.data,
	};
	return { ok: true, value: artifact };
}

export const typescriptSourceImporterV1: SourceImporterV1 = {
	apiVersion: 1,
	importerRef: TYPE_SCRIPT_IMPORTER_REF,
	supportedLanguages: [...TYPE_SCRIPT_IMPORTER_LANGUAGES],
	importSource(request) {
		const parsedRequest = sourceImportRequestV1Schema.safeParse(request);
		if (!parsedRequest.success) {
			return {
				ok: false,
				diagnostics: zodDiagnostics('SOURCE_IMPORT_REQUEST_INVALID', parsedRequest.error),
			};
		}
		const parsedOptions = typeScriptSourceImporterOptionsV1Schema.safeParse(
			parsedRequest.data.options,
		);
		if (!parsedOptions.success) {
			return {
				ok: false,
				diagnostics: zodDiagnostics('SOURCE_IMPORT_OPTIONS_INVALID', parsedOptions.error),
			};
		}

		return importTypeScriptSourceToVisualProgram(parsedRequest.data, parsedOptions.data);
	},
};

function importTypeScriptSourceToVisualProgram(
	request: SourceImportRequestV1,
	options: TypeScriptSourceImporterOptionsV1,
): ResultV1<VisualProgramIRV1> {
	const language = typeScriptSourceLanguageV1Schema.safeParse(request.source.language);
	if (!language.success) {
		return {
			ok: false,
			diagnostics: [
				{
					apiVersion: 1,
					code: 'SOURCE_LANGUAGE_UNSUPPORTED',
					severity: 'error',
					message: `Unsupported source language: ${request.source.language}`,
					path: 'source.language',
				},
			],
		};
	}

	const refs = createArtifactRefs(request);
	const sourceResult = parseTeachingProgram(
		{
			documentRef: request.documentRef,
			revisionRef: request.revisionRef,
			entryFunction: options.entryFunction,
			source: { ...request.source, language: language.data },
			operationCatalog: options.operationCatalog,
		},
		refs.logicNodeRef,
		options.title,
	);
	if (!sourceResult.ok) return sourceResult;

	const entryMapping = createSourceMapping(
		request,
		'entry-function',
		refs.logicNodeRef,
		{ kind: 'workflowNode', ref: refs.logicNodeRef },
		sourceResult.parsed.entrySpan,
	);
	const initializationMapping = createSourceMapping(
		request,
		'output-initialization',
		refs.outputInitializationRef,
		{ kind: 'workflowNode', ref: refs.logicNodeRef },
		sourceResult.parsed.outputInitializationSpan,
	);
	const returnMapping = createSourceMapping(
		request,
		'output-return',
		refs.outputReturnRef,
		{ kind: 'workflowNode', ref: refs.logicNodeRef },
		sourceResult.parsed.returnSpan,
	);
	const statementMappings = flattenLogicStatements(sourceResult.parsed.logic.statements).map(
		(statement) =>
			createSourceMapping(
				request,
				`logic-statement:${statement.stepRef}`,
				statement.stepRef,
				{ kind: 'workflowNode', ref: refs.logicNodeRef },
				statement.source,
			),
	);
	const program = visualProgramIRV1Schema.safeParse({
		apiVersion: 1,
		documentRef: request.documentRef,
		revisionRef: request.revisionRef,
		title: options.title,
		profileRef: request.profileRef,
		sources: [{ ...request.source, language: language.data }],
		nodes: [
			{
				nodeRef: refs.logicNodeRef,
				operationRef: TYPE_SCRIPT_IMPORTER_OPERATION_REF,
				label: options.title,
				position: { x: 0, y: 0 },
				parameters: {},
				logic: sourceResult.parsed.logic,
				metadata: { sourceRef: request.source.sourceRef },
			},
		],
		edges: [],
		sourceMap: [entryMapping, initializationMapping, returnMapping, ...statementMappings],
		metadata: {
			importerRef: TYPE_SCRIPT_IMPORTER_REF,
			sourceSemanticsRef: TYPE_SCRIPT_IMPORTER_SEMANTICS_REF,
		},
	});
	return program.success
		? { ok: true, value: program.data }
		: {
				ok: false,
				diagnostics: zodDiagnostics('PROGRAM_GENERATION_INVALID', program.error),
			};
}

type ArtifactRefs = {
	manualNodeRef: string;
	logicNodeRef: string;
	edgeRef: string;
	connectionRef: string;
	canvasRef: string;
	fragmentRef: string;
	outputInitializationRef: string;
	outputReturnRef: string;
};

function createArtifactRefs(request: Pick<TypeScriptImportRequestV1, 'documentRef'>): ArtifactRefs {
	return {
		manualNodeRef: createStableArtifactRef('node', request.documentRef, 'workflow:manual-trigger'),
		logicNodeRef: createStableArtifactRef('node', request.documentRef, 'workflow:blockly-code'),
		edgeRef: createStableArtifactRef('edge', request.documentRef, 'workflow:manual-to-blockly'),
		connectionRef: `connection-${createStableId(
			request.documentRef,
			'connection:manual-to-blockly',
		)}`,
		canvasRef: createStableArtifactRef('canvas', request.documentRef, 'logic:blockly-code'),
		fragmentRef: `fragment-${createStableId(request.documentRef, 'fragment:source-import')}`,
		outputInitializationRef: createStableArtifactRef(
			'step',
			request.documentRef,
			'source:output-initialization',
		),
		outputReturnRef: createStableArtifactRef('step', request.documentRef, 'source:output-return'),
	};
}

function createSourceMapping(
	request: Pick<TypeScriptImportRequestV1, 'documentRef'>,
	localRef: string,
	semanticRef: string,
	artifact: SourceMapEntryV1['artifact'],
	source: SourceMapEntryV1['source'],
): SourceMapEntryV1 {
	return {
		apiVersion: 1,
		mappingRef: createStableArtifactRef('mapping', request.documentRef, `source:${localRef}`),
		semanticRef,
		artifact,
		source,
		context: { importerRef: TYPE_SCRIPT_IMPORTER_REF },
	};
}

function zodDiagnostics(code: string, error: z.ZodError): DiagnosticV1[] {
	return error.issues.map((issue) => ({
		apiVersion: 1,
		code,
		severity: 'error',
		message: issue.message,
		...(issue.path.length === 0 ? {} : { path: issue.path.join('.') }),
	}));
}
