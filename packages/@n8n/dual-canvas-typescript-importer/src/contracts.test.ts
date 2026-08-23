import { describe, expect, it } from 'vitest';

import {
	BLOCKLY_DATA_PAYLOAD_MEDIA_TYPE,
	typeScriptImportRequestV1Schema,
	typeScriptSourceImporterOptionsV1Schema,
} from './contracts';
import { createTestRequest } from './test-support';

const source = `function transform(input) {
	const output = {};
	output.name = input.name;
	return output;
}`;

describe('TypeScript import contracts', () => {
	it.each(['javascript', 'typescript', 'arkts'] as const)(
		'accepts the %s source language',
		(language) => {
			expect(
				typeScriptImportRequestV1Schema.safeParse(createTestRequest(source, language)).success,
			).toBe(true);
		},
	);

	it('rejects unknown languages and incomplete bindings', () => {
		const request = createTestRequest(source);
		expect(
			typeScriptImportRequestV1Schema.safeParse({
				...request,
				source: { ...request.source, language: 'python' },
			}).success,
		).toBe(false);
		expect(
			typeScriptImportRequestV1Schema.safeParse({
				...request,
				bindings: { ...request.bindings, nodeTypes: {} },
			}).success,
		).toBe(false);
	});

	it('publishes a stable media type for Blockly data payloads', () => {
		expect(BLOCKLY_DATA_PAYLOAD_MEDIA_TYPE).toBe('application/vnd.n8n.blockly-data+json');
	});

	it('validates the versioned options carried by the generic source-import contract', () => {
		const request = createTestRequest(source);
		const options = {
			apiVersion: 1,
			title: request.title,
			entryFunction: request.entryFunction,
		};

		expect(typeScriptSourceImporterOptionsV1Schema.safeParse(options).success).toBe(true);
		expect(
			typeScriptSourceImporterOptionsV1Schema.safeParse({ ...options, extra: true }).success,
		).toBe(false);
		expect(
			typeScriptSourceImporterOptionsV1Schema.safeParse({
				...options,
				bindings: request.bindings,
			}).success,
		).toBe(false);
	});
});
