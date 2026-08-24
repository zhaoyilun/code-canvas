import {
	createOperationModuleCatalogV1,
	finalizeOperationModuleSpecV1,
} from '@n8n/dual-canvas-operation-runtime';

import type { TypeScriptImportRequestV1 } from './contracts';

export const emptyOperationCatalog = createOperationModuleCatalogV1({ apiVersion: 1, modules: [] });

export const scoreOperationCatalog = createOperationModuleCatalogV1({
	apiVersion: 1,
	modules: [
		finalizeOperationModuleSpecV1({
			apiVersion: 1,
			requestRef: 'module-request.clamp-score',
			operationRef: 'operation.clamp-score.v1',
			implementationRef: null,
			qualifiedName: 'clampScore',
			arity: 3,
			version: '1.0.0',
			behaviorSummary: 'Bounds a score between the supplied minimum and maximum.',
			execution: 'synchronous',
			determinism: 'deterministic',
			effects: 'none',
			dataFlow: 'json-to-json',
			parameters: [
				{ parameterRef: 'arg.value', name: 'value', type: 'number', nullPolicy: 'reject' },
				{ parameterRef: 'arg.minimum', name: 'minimum', type: 'number', nullPolicy: 'reject' },
				{ parameterRef: 'arg.maximum', name: 'maximum', type: 'number', nullPolicy: 'reject' },
			],
			output: { type: 'number', nullPolicy: 'reject' },
			expression: {
				kind: 'conditional',
				condition: {
					kind: 'binary',
					operator: 'lt',
					left: { kind: 'parameter', parameterRef: 'arg.value' },
					right: { kind: 'parameter', parameterRef: 'arg.minimum' },
				},
				whenTrue: { kind: 'parameter', parameterRef: 'arg.minimum' },
				whenFalse: {
					kind: 'conditional',
					condition: {
						kind: 'binary',
						operator: 'gt',
						left: { kind: 'parameter', parameterRef: 'arg.value' },
						right: { kind: 'parameter', parameterRef: 'arg.maximum' },
					},
					whenTrue: { kind: 'parameter', parameterRef: 'arg.maximum' },
					whenFalse: { kind: 'parameter', parameterRef: 'arg.value' },
				},
			},
			testVectors: [
				{ name: 'below', arguments: [-5, 0, 100], expected: 0 },
				{ name: 'inside', arguments: [68, 0, 100], expected: 68 },
				{ name: 'above', arguments: [125, 0, 100], expected: 100 },
			],
		}),
		finalizeOperationModuleSpecV1({
			apiVersion: 1,
			requestRef: 'module-request.double-score',
			operationRef: 'operation.double-score.v1',
			implementationRef: null,
			qualifiedName: 'doubleScore',
			arity: 1,
			version: '1.0.0',
			behaviorSummary: 'Doubles a numeric score.',
			execution: 'synchronous',
			determinism: 'deterministic',
			effects: 'none',
			dataFlow: 'json-to-json',
			parameters: [
				{ parameterRef: 'arg.score', name: 'score', type: 'number', nullPolicy: 'reject' },
			],
			output: { type: 'number', nullPolicy: 'reject' },
			expression: {
				kind: 'binary',
				operator: 'multiply',
				left: { kind: 'parameter', parameterRef: 'arg.score' },
				right: { kind: 'literal', value: 2 },
			},
			testVectors: [
				{ name: 'zero', arguments: [0], expected: 0 },
				{ name: 'positive', arguments: [12], expected: 24 },
				{ name: 'negative', arguments: [-3], expected: -6 },
			],
		}),
	],
});

export function createTestRequest(
	source: string,
	language: TypeScriptImportRequestV1['source']['language'] = 'typescript',
): TypeScriptImportRequestV1 {
	return {
		apiVersion: 1,
		documentRef: 'lesson.score-normalizer',
		revisionRef: 'revision.1',
		title: 'Score normalizer',
		profileRef: 'teaching.data-transform',
		entryFunction: 'transform',
		operationCatalog: emptyOperationCatalog,
		source: {
			apiVersion: 1,
			sourceRef: 'source.main',
			language,
			content: source,
		},
		bindings: {
			apiVersion: 1,
			packageName: 'n8n-nodes-teaching',
			nodeTypes: {
				manual: 'example.nodes.start',
				logic: 'example.nodes.transform',
			},
		},
		workflow: {
			manualTrigger: { bindingRef: 'manual', typeVersion: 1, label: 'Start' },
			blocklyCode: { bindingRef: 'logic', typeVersion: 1, label: 'Transform data' },
		},
		canvasAdapterRef: 'blockly.data-transform.v1',
	};
}
