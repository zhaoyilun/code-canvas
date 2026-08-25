import type {
	BlocklySourceReadyResponse,
	ConvertBlocklySourceRequestDto,
	ConvertBlocklySourceResponse,
} from '@n8n/api-types';
import { Service } from '@n8n/di';
import type { OperationModuleCatalogV1 } from '@n8n/dual-canvas-operation-runtime';
import type {
	ModuleScaffoldRequestV1,
	OperationModuleTemplateV1,
} from '@n8n/dual-canvas-operation-sdk';
import { jsonParse } from 'n8n-workflow';

const DEEPSEEK_BASE_URL = 'https://api.deepseek.com';
const DEEPSEEK_MODEL = 'deepseek-v4-flash';

const OPERATION_DRAFT_PROMPT = `You generate one n8n dual-canvas operation module draft.
Return one JSON object only. Do not wrap it in markdown and do not add a parent key.

The root object must contain exactly these keys:
apiVersion, requestRef, operationRef, implementationRef, qualifiedName, arity, version,
behaviorSummary, execution, determinism, effects, dataFlow, parameters, output, expression,
testVectors.

Copy requestRef, qualifiedName, arity, operationRef, version, and every parameterRef exactly
from the supplied scaffoldRequest and moduleTemplate. Set apiVersion to 1 and
implementationRef to null. Set execution to "synchronous", determinism to "deterministic",
effects to "none", and dataFlow to "json-to-json".

Parameter and output types are one of: json, number, string, boolean, array, object.
Parameter nullPolicy is one of: allow, reject, propagate. Output nullPolicy is allow or reject.
Parameter names must be JavaScript identifiers. The parameters array length must equal arity.
For every slot i, parameters[i].parameterRef must equal moduleTemplate.parameters[i].parameterRef
(for example "arg.0"). Every expression node whose kind is "parameter" must use one of
those exact parameterRef values. Never put a semantic parameter name such as "value", "min",
or "max" in expression.parameterRef. Before returning JSON, verify every expression parameterRef
exists verbatim in the root parameters array.

Expression nodes use only these JSON shapes:
{"kind":"literal","value":JSON_VALUE}
{"kind":"parameter","parameterRef":"PARAMETER_REF"}
{"kind":"unary","operator":"not|negate","value":EXPRESSION}
{"kind":"binary","operator":"add|subtract|multiply|divide|power|eq|neq|lt|lte|gt|gte|and|or","left":EXPRESSION,"right":EXPRESSION}
{"kind":"conditional","condition":EXPRESSION,"whenTrue":EXPRESSION,"whenFalse":EXPRESSION}
{"kind":"array","values":[EXPRESSION]}
{"kind":"object","properties":[{"key":"KEY","value":EXPRESSION}]}

Provide exactly four compact testVectors, each with this exact shape:
{"name":"SHORT UNIQUE NAME","arguments":[JSON_VALUES],"expected":JSON_VALUE}.
Every vector has exactly the operation arity in arguments. Make the vectors cover the main
behavior and an edge case.
Infer the intended pure function from the source, call observations, function name, and optional
teacher intent. The response must be valid JSON and must match the operation draft contract.`;

@Service()
export class BlocklySourceConversionService {
	async convert(payload: ConvertBlocklySourceRequestDto): Promise<ConvertBlocklySourceResponse> {
		const operationCatalog = await this.readOperationCatalog(payload.currentBlocklyPayload);
		const initialResult = await this.importSource(payload.source, operationCatalog);

		if (initialResult.ok) return this.readyResponse(initialResult.value);

		const scaffoldRequest = await this.missingOperation(initialResult.diagnostics);
		if (scaffoldRequest === undefined) {
			throw new Error(this.diagnosticMessage(initialResult.diagnostics));
		}

		if (!payload.generateMissingOperation) {
			return {
				status: 'missing-operation',
				qualifiedName: scaffoldRequest.qualifiedName,
				arity: scaffoldRequest.arity,
				message: `缺少函数模块 ${scaffoldRequest.qualifiedName}/${scaffoldRequest.arity}`,
			};
		}

		const moduleSpec = await this.generateOperationModule(
			payload.source,
			payload.teacherIntent,
			scaffoldRequest,
		);
		const { createOperationModuleCatalogV1 } = await import('@n8n/dual-canvas-operation-runtime');
		const updatedCatalog = createOperationModuleCatalogV1({
			apiVersion: 1,
			modules: [...operationCatalog.modules, moduleSpec],
		});
		const registeredResult = await this.importSource(payload.source, updatedCatalog);
		if (!registeredResult.ok) {
			throw new Error(this.diagnosticMessage(registeredResult.diagnostics));
		}

		return this.readyResponse(registeredResult.value);
	}

	private async readOperationCatalog(payload: string): Promise<OperationModuleCatalogV1> {
		const { createOperationModuleCatalogV1 } = await import('@n8n/dual-canvas-operation-runtime');
		if (payload.trim() === '') {
			return createOperationModuleCatalogV1({ apiVersion: 1, modules: [] });
		}

		const { parseBlocklyDataPayload } = await import('@n8n/blockly-data-transform');
		const parsed = parseBlocklyDataPayload(payload);
		if (!parsed.ok) throw new Error(parsed.error);
		return parsed.payload.operationCatalog;
	}

	private async importSource(source: string, operationCatalog: OperationModuleCatalogV1) {
		const { importTypeScriptSource, typeScriptImportRequestV1Schema } = await import(
			'@n8n/dual-canvas-typescript-importer'
		);
		const request = typeScriptImportRequestV1Schema.parse({
			apiVersion: 1,
			documentRef: 'education.blockly-source-editor',
			revisionRef: 'revision.current',
			title: 'Blockly source conversion',
			profileRef: 'education.generic-data-transform',
			entryFunction: 'transform',
			source: {
				apiVersion: 1,
				sourceRef: 'source.blockly-editor',
				language: 'typescript',
				content: source,
				uri: 'editor://blockly-source',
			},
			operationCatalog,
			bindings: {
				apiVersion: 1,
				packageName: 'n8n-nodes-blockly-code',
				nodeTypes: {
					manualTrigger: 'n8n-nodes-base.manualTrigger',
					blocklyCode: 'n8n-nodes-blockly-code.blocklyCode',
				},
			},
			workflow: {
				manualTrigger: {
					bindingRef: 'manualTrigger',
					typeVersion: 1,
					label: 'Start',
				},
				blocklyCode: {
					bindingRef: 'blocklyCode',
					typeVersion: 1,
					label: 'Blockly Logic',
				},
			},
			canvasAdapterRef: 'blockly.data-transform.v1',
		});

		return importTypeScriptSource(request);
	}

	private async missingOperation(
		diagnostics: ReadonlyArray<{ code: string; details?: unknown }>,
	): Promise<ModuleScaffoldRequestV1 | undefined> {
		const diagnostic = diagnostics.find(({ code }) => code === 'OPERATION_MODULE_MISSING');
		if (diagnostic === undefined) return undefined;
		const { moduleScaffoldRequestV1Schema } = await import('@n8n/dual-canvas-operation-sdk');
		const parsed = moduleScaffoldRequestV1Schema.safeParse(diagnostic.details);
		return parsed.success ? parsed.data : undefined;
	}

	private async generateOperationModule(
		source: string,
		teacherIntent: string | undefined,
		scaffoldRequest: ModuleScaffoldRequestV1,
	) {
		const apiKey = process.env.DEEPSEEK_API_KEY;
		if (!apiKey) throw new Error('DEEPSEEK_API_KEY is not set');

		const {
			createOperationModuleTemplateV1,
			finalizeOperationModuleSpecV1,
			operationModuleAdmissionV1Schema,
			operationModuleDraftSpecV1Schema,
		} = await import('@n8n/dual-canvas-operation-sdk');
		const template = createOperationModuleTemplateV1(scaffoldRequest);
		const draftInput = await this.requestOperationDraft({
			apiKey,
			source,
			teacherIntent,
			scaffoldRequest,
			template,
		});
		const draft = operationModuleDraftSpecV1Schema.parse(draftInput);
		const moduleSpec = finalizeOperationModuleSpecV1(draft);
		operationModuleAdmissionV1Schema.parse({ request: scaffoldRequest, spec: moduleSpec });
		return moduleSpec;
	}

	private async requestOperationDraft(input: {
		apiKey: string;
		source: string;
		teacherIntent: string | undefined;
		scaffoldRequest: ModuleScaffoldRequestV1;
		template: OperationModuleTemplateV1;
	}): Promise<unknown> {
		const { default: OpenAI } = await import('openai');
		const client = new OpenAI({ apiKey: input.apiKey, baseURL: DEEPSEEK_BASE_URL });
		const completion = await client.chat.completions.create({
			model: DEEPSEEK_MODEL,
			temperature: 0,
			max_tokens: 12_000,
			response_format: { type: 'json_object' },
			messages: [
				{ role: 'system', content: OPERATION_DRAFT_PROMPT },
				{
					role: 'user',
					content: JSON.stringify({
						source: input.source,
						teacherIntent: input.teacherIntent ?? null,
						scaffoldRequest: input.scaffoldRequest,
						moduleTemplate: input.template,
					}),
				},
			],
		});
		const content = completion.choices[0]?.message.content;
		if (!content) throw new Error('DeepSeek returned an empty operation module');
		return jsonParse<unknown>(content);
	}

	private readyResponse(artifact: {
		generatedCanvas: { blocklyPayload: string };
		workflow: BlocklySourceReadyResponse['workflowFragment'];
	}): BlocklySourceReadyResponse {
		return {
			status: 'ready',
			blocklyPayload: artifact.generatedCanvas.blocklyPayload,
			workflowFragment: artifact.workflow,
		};
	}

	private diagnosticMessage(diagnostics: ReadonlyArray<{ message: string }>): string {
		return diagnostics.map(({ message }) => message).join('; ') || 'Source conversion failed';
	}
}
