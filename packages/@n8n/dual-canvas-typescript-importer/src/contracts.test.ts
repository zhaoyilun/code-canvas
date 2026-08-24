import { describe, expect, it } from 'vitest';

import {
	BLOCKLY_DATA_PAYLOAD_MEDIA_TYPE,
	typeScriptImportRequestV1Schema,
	typeScriptSourceImporterOptionsV1Schema,
} from './contracts';
import { createTestRequest, scoreOperationCatalog } from './test-support';

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

	it('runs catalog test-vector admission at the import boundary', () => {
		const request = createTestRequest(source);
		const invalidCatalog = structuredClone(scoreOperationCatalog);
		invalidCatalog.modules[0].testVectors[2] = {
			name: 'above',
			arguments: [125, 0, 100],
			expected: 99,
		};
		const result = typeScriptImportRequestV1Schema.safeParse({
			...request,
			operationCatalog: invalidCatalog,
		});
		expect(result.success).toBe(false);
		if (!result.success) expect(result.error.issues[0]?.message).toContain('expected 99');
	});

	it('rejects a catalog whose semantic implementation no longer matches its immutable reference', () => {
		const request = createTestRequest(source);
		const staleCatalog = structuredClone(scoreOperationCatalog);
		const module = staleCatalog.modules[0];
		if (module === undefined) throw new Error('score operation fixture is missing');
		module.expression = { kind: 'literal', value: 50 };
		module.testVectors = module.testVectors.map((vector) => ({ ...vector, expected: 50 }));

		const result = typeScriptImportRequestV1Schema.safeParse({
			...request,
			operationCatalog: staleCatalog,
		});

		expect(result.success).toBe(false);
		if (!result.success) {
			expect(result.error.issues[0]?.message).toContain(
				'OPERATION_IMPLEMENTATION_IDENTITY_MISMATCH',
			);
		}
	});

	it('validates the versioned options carried by the generic source-import contract', () => {
		const request = createTestRequest(source);
		const options = {
			apiVersion: 1,
			title: request.title,
			entryFunction: request.entryFunction,
			operationCatalog: request.operationCatalog,
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
