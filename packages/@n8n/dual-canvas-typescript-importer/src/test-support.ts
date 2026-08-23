import type { TypeScriptImportRequestV1 } from './contracts';

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
