import {
	createOperationBlockDescriptorV1,
	createOperationModuleCatalogV1,
	evaluateOperationModuleV1,
	finalizeOperationModuleSpecV1,
	OPERATION_JSON_MAX_DEPTH,
	OPERATION_JSON_MAX_KEY_LENGTH,
	OPERATION_JSON_MAX_STRING_LENGTH,
	OperationModuleRuntimeError,
	type OperationModuleCatalogV1,
	type OperationModuleSpecV1,
} from '@n8n/dual-canvas-operation-runtime';
import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';

import {
	BLOCKLY_DATA_SCHEMA_VERSION,
	compileBlocklyWorkspace as compileSharedBlocklyWorkspace,
	createDefaultWorkspace,
	parseBlocklyDataPayload,
	serializeBlocklyDataPayload as serializeSharedBlocklyDataPayload,
} from './index';

const EMPTY_OPERATION_CATALOG = createOperationModuleCatalogV1({ apiVersion: 1, modules: [] });

const compileBlocklyWorkspace = (
	workspaceState: unknown,
	operationCatalog: OperationModuleCatalogV1 = EMPTY_OPERATION_CATALOG,
) => compileSharedBlocklyWorkspace(workspaceState, operationCatalog);

const serializeBlocklyDataPayload = (
	workspaceState: Record<string, unknown>,
	operationCatalog: OperationModuleCatalogV1 = EMPTY_OPERATION_CATALOG,
) => serializeSharedBlocklyDataPayload(workspaceState, operationCatalog);

const value = (block: Record<string, unknown>) => ({ block });

function workspace(root: Record<string, unknown>): Record<string, unknown> {
	return { blocks: { languageVersion: 0, blocks: [root] } };
}

function root(statements?: Record<string, unknown>, mode = 'COPY'): Record<string, unknown> {
	return {
		type: 'n8n_transform_item',
		fields: { MODE: mode },
		...(statements ? { inputs: { STATEMENTS: value(statements) } } : {}),
	};
}

function setField(
	key: string,
	expression: Record<string, unknown>,
	next?: Record<string, unknown>,
) {
	return {
		type: 'n8n_set_field',
		fields: { KEY: key },
		inputs: { VALUE: value(expression) },
		...(next ? { next: value(next) } : {}),
	};
}

function deleteField(key: string, next?: Record<string, unknown>): Record<string, unknown> {
	return {
		type: 'n8n_delete_field',
		fields: { KEY: key },
		...(next ? { next: value(next) } : {}),
	};
}

const numberBlock = (num: number) => ({ type: 'math_number', fields: { NUM: num } });
const text = (textValue: string) => ({ type: 'text', fields: { TEXT: textValue } });
const field = (path: string) => ({ type: 'n8n_get_field', fields: { PATH: path } });
const booleanBlock = (enabled: boolean) => ({
	type: 'logic_boolean',
	fields: { BOOL: enabled ? 'TRUE' : 'FALSE' },
});

function objectProperty(
	key: string,
	expression: Record<string, unknown>,
	next?: Record<string, unknown>,
): Record<string, unknown> {
	return {
		type: 'n8n_object_property',
		fields: { KEY: key },
		inputs: { VALUE: value(expression) },
		...(next ? { next: value(next) } : {}),
	};
}

describe('Blockly Logic compiler', () => {
	it('compiles the default copy-input workspace deterministically', () => {
		const defaultWorkspace = createDefaultWorkspace();
		const result = compileBlocklyWorkspace(defaultWorkspace);

		expect(BLOCKLY_DATA_SCHEMA_VERSION).toBe(3);
		expect(result).toEqual({
			ok: true,
			blockCount: 3,
			javascript:
				'const output = { ...$json };\noutput["processed"] = true;\nreturn { json: output };\n',
		});
		const serialized = serializeBlocklyDataPayload(defaultWorkspace);
		expect(serialized).toBe(serializeBlocklyDataPayload(defaultWorkspace));
		expect(parseJson(serialized)).toEqual({
			schemaVersion: 3,
			operationCatalog: EMPTY_OPERATION_CATALOG,
			workspace: defaultWorkspace,
			javascript:
				'const output = { ...$json };\noutput["processed"] = true;\nreturn { json: output };\n',
		});
	});

	it('preserves empty slots from the official list mutator as null values', () => {
		const result = compileBlocklyWorkspace(
			workspace(
				root(
					setField('items', {
						type: 'lists_create_with',
						extraState: { itemCount: 3 },
						inputs: { ADD1: value(text('middle')) },
					}),
				),
			),
		);

		expect(result).toEqual({
			ok: true,
			blockCount: 4,
			javascript:
				'const output = { ...$json };\noutput["items"] = [null, "middle", null];\nreturn { json: output };\n',
		});
	});

	it('compiles field normalization with get, text join, and empty output mode', () => {
		const result = compileBlocklyWorkspace(
			workspace(
				root(
					setField('normalized', {
						type: 'text_join',
						inputs: { ADD0: value(text('user-')), ADD1: value(field('profile.id')) },
					}),
					'EMPTY',
				),
			),
		);

		expect(result).toEqual({
			ok: true,
			blockCount: 5,
			javascript:
				'const output = {};\noutput["normalized"] = ["user-", ($json?.["profile"]?.["id"] ?? null)].join(\'\');\nreturn { json: output };\n',
		});
	});

	it('writes and deletes nested output paths without mutating the input item', () => {
		const input = {
			profile: { name: 'before', retained: true },
			obsolete: { flag: true, retained: 'yes' },
		};
		const result = compileBlocklyWorkspace(
			workspace(root(setField('profile.name', text('after'), deleteField('obsolete.flag')))),
		);

		expect(result.ok).toBe(true);
		if (!result.ok) return;
		const execution = runInNewContext(`(() => { ${result.javascript} })()`, {
			$json: input,
		}) as { json: Record<string, unknown> };
		expect(execution.json).toEqual({
			profile: { name: 'after', retained: true },
			obsolete: { retained: 'yes' },
		});
		expect(input).toEqual({
			profile: { name: 'before', retained: true },
			obsolete: { flag: true, retained: 'yes' },
		});
	});

	it('compiles amount calculation with arithmetic', () => {
		const result = compileBlocklyWorkspace(
			workspace(
				root(
					setField('amount', {
						type: 'math_arithmetic',
						fields: { OP: 'MULTIPLY' },
						inputs: { A: value(field('price')), B: value(numberBlock(1.2)) },
					}),
				),
			),
		);

		expect(result).toEqual({
			ok: true,
			blockCount: 5,
			javascript:
				'const output = { ...$json };\noutput["amount"] = (($json?.["price"] ?? null) * 1.2);\nreturn { json: output };\n',
		});
	});

	it('compiles conditional grading with comparison, boolean, negate, and ternary', () => {
		const result = compileBlocklyWorkspace(
			workspace(
				root(
					setField('grade', {
						type: 'logic_ternary',
						inputs: {
							IF: value({
								type: 'logic_operation',
								fields: { OP: 'AND' },
								inputs: {
									A: value({
										type: 'logic_compare',
										fields: { OP: 'GTE' },
										inputs: { A: value(field('score')), B: value(numberBlock(60)) },
									}),
									B: value({
										type: 'logic_negate',
										inputs: { BOOL: value({ type: 'logic_boolean', fields: { BOOL: 'FALSE' } }) },
									}),
								},
							}),
							THEN: value(text('pass')),
							ELSE: value(text('fail')),
						},
					}),
				),
			),
		);

		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.javascript).toContain('(($json?.["score"] ?? null) >= 60)');
			expect(result.javascript).toContain('&& (!false)');
			expect(result.javascript).toContain('? "pass" : "fail"');
		}
	});

	it('compiles array creation, indexed access, and length without loops', () => {
		const array = {
			type: 'lists_create_with',
			extraState: { itemCount: 2 },
			inputs: { ADD0: value(text('first')), ADD1: value(text('second')) },
		};
		const result = compileBlocklyWorkspace(
			workspace(
				root(
					setField(
						'selected',
						{
							type: 'n8n_array_at',
							inputs: { ARRAY: value(array), INDEX: value(numberBlock(1)) },
						},
						{
							type: 'n8n_set_field',
							fields: { KEY: 'itemCount' },
							inputs: {
								VALUE: value({
									type: 'lists_length',
									inputs: {
										VALUE: value({ type: 'lists_create_with', extraState: { itemCount: 0 } }),
									},
								}),
							},
						},
					),
				),
			),
		);

		expect(result).toEqual({
			ok: true,
			blockCount: 10,
			javascript:
				'const output = { ...$json };\noutput["selected"] = ((items, index) => Array.isArray(items) && Number.isInteger(index) ? (items.at(index) ?? null) : null)(["first", "second"], 1);\noutput["itemCount"] = ((value) => Array.isArray(value) || typeof value === \'string\' ? value.length : 0)([]);\nreturn { json: output };\n',
		});
	});

	it('compiles bounded array filter and path projection', () => {
		const result = compileBlocklyWorkspace(
			workspace(
				root(
					setField('activeNames', {
						type: 'n8n_array_map_path',
						fields: { PATH: 'profile.name' },
						inputs: {
							ARRAY: value({
								type: 'n8n_array_filter_path',
								fields: { PATH: 'active', OP: 'EQ' },
								inputs: { ARRAY: value(field('users')), VALUE: value(booleanBlock(true)) },
							}),
						},
					}),
				),
			),
		);

		expect(result).toEqual({
			ok: true,
			blockCount: 6,
			javascript:
				'const output = { ...$json };\noutput["activeNames"] = ((items) => Array.isArray(items) ? items.map((item) => (item?.["profile"]?.["name"] ?? null)) : [])(((items, expected) => Array.isArray(items) ? items.filter((item) => ((item?.["active"] ?? null) === expected)) : [])(($json?.["users"] ?? null), true));\nreturn { json: output };\n',
		});
	});

	it('compiles object construction, arbitrary path reads, and explicit conversions', () => {
		const result = compileBlocklyWorkspace(
			workspace(
				root(
					setField('summary', {
						type: 'n8n_object_create',
						inputs: {
							PROPERTIES: value(
								objectProperty(
									'count',
									{
										type: 'n8n_convert',
										fields: { TYPE: 'NUMBER' },
										inputs: { VALUE: value(field('count')) },
									},
									objectProperty('email', {
										type: 'n8n_get_path',
										fields: { PATH: 'contact.email' },
										inputs: { VALUE: value(field('profile')) },
									}),
								),
							),
						},
					}),
				),
			),
		);

		expect(result).toEqual({
			ok: true,
			blockCount: 9,
			javascript:
				'const output = { ...$json };\noutput["summary"] = { ["count"]: ((value) => { if (value === null || value === \'\') return null; const number = Number(value); return Number.isFinite(number) ? number : null; })(($json?.["count"] ?? null)), ["email"]: ((($json?.["profile"] ?? null))?.["contact"]?.["email"] ?? null) };\nreturn { json: output };\n',
		});
	});

	it('compiles assertion, conditional statement branches, deletion, and following statements', () => {
		const assertion = {
			type: 'n8n_assert',
			inputs: {
				CONDITION: value({
					type: 'logic_compare',
					fields: { OP: 'GTE' },
					inputs: { A: value(field('age')), B: value(numberBlock(18)) },
				}),
				MESSAGE: value(text('age must be at least 18')),
			},
			next: value({
				type: 'n8n_if',
				inputs: {
					CONDITION: value(field('active')),
					THEN: value(setField('status', text('active'))),
					ELSE: value({ type: 'n8n_delete_field', fields: { KEY: 'legacyStatus' } }),
				},
				next: value(setField('reviewed', booleanBlock(true))),
			}),
		};
		const result = compileBlocklyWorkspace(workspace(root(assertion)));

		expect(result).toEqual({
			ok: true,
			blockCount: 13,
			javascript:
				'const output = { ...$json };\nif (!((($json?.["age"] ?? null) >= 18))) {\n\tthrow new Error(String("age must be at least 18"));\n}\nif (($json?.["active"] ?? null)) {\n\toutput["status"] = "active";\n} else {\n\tdelete output["legacyStatus"];\n}\noutput["reviewed"] = true;\nreturn { json: output };\n',
		});
	});

	it('compiles an admitted operation block from catalog data and executes its expression', () => {
		const catalog = createOperationModuleCatalogV1({ apiVersion: 1, modules: [clampScoreModule] });
		const result = compileBlocklyWorkspace(
			workspace(root(setField('score', clampScoreBlock(field('score'))))),
			catalog,
		);

		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.javascript).toContain('((operationArg0, operationArg1, operationArg2) =>');
		expect(result.javascript).not.toContain('clampScore(');
		const execution = runInNewContext(`(() => { ${result.javascript} })()`, {
			$json: { score: 125 },
		}) as { json: Record<string, unknown> };
		expect(execution.json).toEqual({ score: 100 });
	});

	it('compiles two implementations of one logical operation under distinct block types', () => {
		const originalDescriptor = createOperationBlockDescriptorV1(clampScoreModule);
		const changedDescriptor = createOperationBlockDescriptorV1(fixedScoreModule);
		const originalCatalog = createOperationModuleCatalogV1({
			apiVersion: 1,
			modules: [clampScoreModule],
		});
		const changedCatalog = createOperationModuleCatalogV1({
			apiVersion: 1,
			modules: [fixedScoreModule],
		});

		expect(changedDescriptor.operationRef).toBe(originalDescriptor.operationRef);
		expect(changedDescriptor.version).toBe(originalDescriptor.version);
		expect(changedDescriptor.implementationRef).not.toBe(originalDescriptor.implementationRef);
		expect(changedDescriptor.blockType).not.toBe(originalDescriptor.blockType);

		const original = compileBlocklyWorkspace(
			workspace(root(setField('score', scoreOperationBlock(clampScoreModule, field('score'))))),
			originalCatalog,
		);
		const changed = compileBlocklyWorkspace(
			workspace(root(setField('score', scoreOperationBlock(fixedScoreModule, field('score'))))),
			changedCatalog,
		);

		expect(original.ok).toBe(true);
		expect(changed.ok).toBe(true);
	});

	it('rejects an old workspace when the catalog contains a newer implementation identity', () => {
		const oldWorkspace = workspace(
			root(setField('score', scoreOperationBlock(clampScoreModule, field('score')))),
		);
		const newCatalog = createOperationModuleCatalogV1({
			apiVersion: 1,
			modules: [fixedScoreModule],
		});

		const result = compileBlocklyWorkspace(oldWorkspace, newCatalog);

		expect(result).toMatchObject({ ok: false });
		if (!result.ok) {
			expect(result.error).toContain('OPERATION_BLOCK_IDENTITY_MISMATCH');
			expect(result.error).toContain('IMPLEMENTATION_REF');
		}
	});

	it('round-trips the exact operation implementation identity in a schema 3 payload', () => {
		const catalog = createOperationModuleCatalogV1({ apiVersion: 1, modules: [clampScoreModule] });
		const operationWorkspace = workspace(
			root(setField('score', scoreOperationBlock(clampScoreModule, field('score')))),
		);

		const parsed = parseBlocklyDataPayload(
			serializeBlocklyDataPayload(operationWorkspace, catalog),
		);

		expect(parsed.ok).toBe(true);
		if (!parsed.ok) return;
		expect(parsed.payload.workspace).toEqual(operationWorkspace);
		expect(parsed.payload.operationCatalog.modules[0]?.implementationRef).toBe(
			clampScoreModule.implementationRef,
		);
		expect(JSON.stringify(parsed.payload.workspace)).toContain(clampScoreModule.implementationRef);
	});

	it('compiles the standard null literal', () => {
		expect(
			compileBlocklyWorkspace(workspace(root(setField('optional', { type: 'logic_null' })))).ok,
		).toBe(true);
	});

	it.each([
		{
			name: 'rejects null arguments',
			module: 'rejectNumber',
			arguments: [null],
		},
		{
			name: 'rejects arguments of the wrong type',
			module: 'rejectNumber',
			arguments: ['12'],
		},
		{
			name: 'propagates null without evaluating the expression',
			module: 'propagateNumber',
			arguments: [null],
		},
		{
			name: 'rejects a branch with the wrong output type',
			module: 'conditionalString',
			arguments: [false],
		},
		{
			name: 'rejects division by zero',
			module: 'finiteDivision',
			arguments: [10, 0],
		},
		{
			name: 'rejects numeric overflow',
			module: 'finiteDivision',
			arguments: [1e308, 1e-308],
		},
		{
			name: 'coerces objects independently of an own toString property',
			module: 'objectStringAdd',
			arguments: [],
		},
	] as const)(
		'matches the operation runtime when it $name',
		({ module, arguments: argumentValues }) => {
			const operationModule = operationModules[module];
			const runtimeResult = captureRuntimeEvaluation(operationModule, [...argumentValues]);
			const generatedResult = captureGeneratedEvaluation(operationModule, [...argumentValues]);

			expect(generatedResult).toEqual(runtimeResult);
		},
	);

	it('matches runtime JSON bounds for deep, cyclic, reserved-key, and long arguments', () => {
		const tooDeep: Record<string, unknown> = {};
		let cursor = tooDeep;
		for (let depth = 0; depth < OPERATION_JSON_MAX_DEPTH; depth += 1) {
			const child: Record<string, unknown> = {};
			cursor.value = child;
			cursor = child;
		}
		const cyclic: Record<string, unknown> = {};
		cyclic.self = cyclic;
		const shared = { value: 1 };
		const withOwnProto = Object.create(null) as Record<string, unknown>;
		Object.defineProperty(withOwnProto, '__proto__', { enumerable: true, value: 1 });
		const values = [
			tooDeep,
			cyclic,
			{ left: shared, right: shared },
			withOwnProto,
			{ ['x'.repeat(OPERATION_JSON_MAX_KEY_LENGTH + 1)]: 1 },
			'x'.repeat(OPERATION_JSON_MAX_STRING_LENGTH + 1),
		];

		for (const value of values) {
			expect(captureGeneratedFieldEvaluation(operationModules.jsonIdentity, value)).toEqual(
				captureRuntimeEvaluation(operationModules.jsonIdentity, [value]),
			);
		}
	});

	it.each([
		{
			name: 'module is absent from the catalog',
			catalog: EMPTY_OPERATION_CATALOG,
			block: clampScoreBlock(field('score')),
			code: 'OPERATION_MODULE_MISSING',
		},
		{
			name: 'operation identity is tampered',
			catalog: createOperationModuleCatalogV1({ apiVersion: 1, modules: [clampScoreModule] }),
			block: clampScoreBlock(field('score'), { VERSION: '9.9.9' }),
			code: 'OPERATION_BLOCK_IDENTITY_MISMATCH',
		},
		{
			name: 'operation argument is missing',
			catalog: createOperationModuleCatalogV1({ apiVersion: 1, modules: [clampScoreModule] }),
			block: clampScoreBlock(field('score'), undefined, 2),
			code: 'OPERATION_ARGUMENTS_INVALID',
		},
	])('rejects an operation block when $name', ({ catalog, block, code }) => {
		const result = compileBlocklyWorkspace(workspace(root(setField('score', block))), catalog);
		expect(result).toMatchObject({ ok: false });
		if (!result.ok) expect(result.error).toContain(code);
	});

	it('rejects a duplicate catalog before inspecting its workspace', () => {
		const duplicateCatalog = {
			apiVersion: 1,
			modules: [
				clampScoreModule,
				{ ...structuredClone(clampScoreModule), requestRef: 'request.clamp.copy' },
			],
		} as OperationModuleCatalogV1;
		const result = compileBlocklyWorkspace(createDefaultWorkspace(), duplicateCatalog);

		expect(result).toMatchObject({ ok: false });
		if (!result.ok) expect(result.error).toContain('OPERATION_CATALOG_DUPLICATE');
	});

	it.each([
		[
			'array input gaps',
			workspace(
				root(
					setField('items', {
						type: 'lists_create_with',
						inputs: { ADD0: value(text('a')), ADD2: value(text('c')) },
					}),
				),
			),
		],
		[
			'array extra input',
			workspace(
				root(setField('items', { type: 'lists_create_with', inputs: { ITEM: value(text('x')) } })),
			),
		],
		[
			'conversion type',
			workspace(
				root(
					setField('value', {
						type: 'n8n_convert',
						fields: { TYPE: 'DATE' },
						inputs: { VALUE: value(text('2026-08-22')) },
					}),
				),
			),
		],
		[
			'filter operator',
			workspace(
				root(
					setField('items', {
						type: 'n8n_array_filter_path',
						fields: { PATH: 'ready', OP: 'MATCHES' },
						inputs: { ARRAY: value(field('items')), VALUE: value(booleanBlock(true)) },
					}),
				),
			),
		],
		[
			'duplicate object key',
			workspace(
				root(
					setField('object', {
						type: 'n8n_object_create',
						inputs: {
							PROPERTIES: value(
								objectProperty('same', text('a'), objectProperty('same', text('b'))),
							),
						},
					}),
				),
			),
		],
		[
			'dotted object key',
			workspace(
				root(
					setField('object', {
						type: 'n8n_object_create',
						inputs: { PROPERTIES: value(objectProperty('profile.name', text('Ada'))) },
					}),
				),
			),
		],
		[
			'object property in root statement chain',
			workspace(root(objectProperty('value', text('x')))),
		],
		[
			'output statement in object property chain',
			workspace(
				root(
					setField('object', {
						type: 'n8n_object_create',
						inputs: { PROPERTIES: value(setField('value', text('x'))) },
					}),
				),
			),
		],
	])('rejects malformed Blockly Logic grammar: %s', (_name, invalidWorkspace) => {
		expect(compileBlocklyWorkspace(invalidWorkspace).ok).toBe(false);
	});

	it.each([
		['unknown block', workspace(root(setField('value', { type: 'controls_repeat_ext' })))],
		['disconnected root', { blocks: { languageVersion: 0, blocks: [root(), root()] } }],
		[
			'malformed input',
			workspace(root({ type: 'n8n_set_field', fields: { KEY: 'value' }, inputs: { VALUE: {} } })),
		],
		['dangerous output key', workspace(root(setField('__proto__.polluted', text('x'))))],
		['dangerous field path', workspace(root(setField('value', field('profile.constructor.name'))))],
		['text limit', workspace(root(setField('value', text('x'.repeat(1001)))))],
		['path limit', workspace(root(setField('x'.repeat(129), text('x'))))],
		['next-chain depth', workspace(root(setField('a0', text('x'), makeNextChain(40))))],
		['block count', workspace(root(setField('value', makeJoin(198))))],
	])('rejects %s', (_name, invalidWorkspace) => {
		const result = compileBlocklyWorkspace(invalidWorkspace);
		expect(result.ok).toBe(false);
	});

	it('rejects cycles and schema 1, then canonicalizes stale preview JavaScript', () => {
		const cyclic: Record<string, unknown> = setField('value', text('x'));
		cyclic.next = value(cyclic);
		expect(compileBlocklyWorkspace(workspace(root(cyclic))).ok).toBe(false);

		expect(parseBlocklyDataPayload('{"schemaVersion":1,"workspace":{},"javascript":""}').ok).toBe(
			false,
		);
		expect(
			parseBlocklyDataPayload(
				JSON.stringify({
					schemaVersion: 3,
					operationCatalog: EMPTY_OPERATION_CATALOG,
					workspace: createDefaultWorkspace(),
					javascript: '',
					hiddenCode: 'ignored field',
				}),
			),
		).toEqual({
			ok: false,
			error: 'Payload must contain only schemaVersion, operationCatalog, workspace, and javascript',
		});
		const parsed = parseBlocklyDataPayload(
			JSON.stringify({
				schemaVersion: 3,
				operationCatalog: EMPTY_OPERATION_CATALOG,
				workspace: createDefaultWorkspace(),
				javascript: 'untrusted stale preview',
			}),
		);
		expect(parsed).toMatchObject({
			ok: true,
			payload: {
				javascript:
					'const output = { ...$json };\noutput["processed"] = true;\nreturn { json: output };\n',
			},
		});
	});

	it('preserves an invalid schema 3 workspace with an empty preview', () => {
		const invalidWorkspace = workspace(root(setField('value', { type: 'controls_repeat_ext' })));
		const serialized = serializeBlocklyDataPayload(invalidWorkspace);

		expect(parseJson(serialized)).toEqual({
			schemaVersion: 3,
			operationCatalog: EMPTY_OPERATION_CATALOG,
			workspace: invalidWorkspace,
			javascript: '',
		});
		expect(parseBlocklyDataPayload(serialized)).toEqual({
			ok: true,
			payload: {
				schemaVersion: 3,
				operationCatalog: EMPTY_OPERATION_CATALOG,
				workspace: invalidWorkspace,
				javascript: '',
			},
		});
	});

	it('rejects payload and generated JavaScript size limits', () => {
		expect(parseBlocklyDataPayload(' '.repeat(256 * 1024 + 1)).ok).toBe(false);
		expect(
			compileBlocklyWorkspace(workspace(root(setField('value', makeJoin(66, 'x'.repeat(1000)))))),
		).toMatchObject({
			ok: false,
			error: 'Generated JavaScript exceeds 64 KiB',
		});
	});
});

function makeNextChain(length: number): Record<string, unknown> {
	let current = setField('tail', text('x'));
	for (let index = 0; index < length; index += 1)
		current = setField(`key${index}`, text('x'), current);
	return current;
}

function makeJoin(length: number, textValue = 'x'): Record<string, unknown> {
	const inputs: Record<string, unknown> = {};
	for (let index = 0; index < length; index += 1) inputs[`ADD${index}`] = value(text(textValue));
	return { type: 'text_join', inputs };
}

function parseJson(value: string): unknown {
	try {
		return JSON.parse(value);
	} catch {
		throw new Error('Expected serialized payload to be valid JSON');
	}
}

const clampScoreModule = finalizeTestModule({
	apiVersion: 1,
	requestRef: 'request.clamp-score',
	operationRef: 'operation.clamp-score',
	qualifiedName: 'clampScore',
	arity: 3,
	version: '1.0.0',
	behaviorSummary: 'Keep a numeric score between the configured minimum and maximum.',
	execution: 'synchronous',
	determinism: 'deterministic',
	effects: 'none',
	dataFlow: 'json-to-json',
	parameters: [
		{ parameterRef: 'arg.value', name: 'value', type: 'number', nullPolicy: 'allow' },
		{ parameterRef: 'arg.minimum', name: 'minimum', type: 'number', nullPolicy: 'reject' },
		{ parameterRef: 'arg.maximum', name: 'maximum', type: 'number', nullPolicy: 'reject' },
	],
	output: { type: 'number', nullPolicy: 'allow' },
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
});

const fixedScoreModule = finalizeTestModule({
	...clampScoreModule,
	requestRef: 'request.clamp-score.fixed',
	behaviorSummary: 'Return the admitted fixed score implementation.',
	expression: { kind: 'literal', value: 50 },
	testVectors: [
		{ name: 'below', arguments: [-5, 0, 100], expected: 50 },
		{ name: 'inside', arguments: [68, 0, 100], expected: 50 },
		{ name: 'above', arguments: [125, 0, 100], expected: 50 },
	],
});

const operationModules = {
	rejectNumber: createUnaryNumberModule(
		'operation.reject-number',
		'rejectNumber',
		'reject',
		'reject',
	),
	propagateNumber: createUnaryNumberModule(
		'operation.propagate-number',
		'propagateNumber',
		'propagate',
		'allow',
	),
	conditionalString: finalizeTestModule({
		apiVersion: 1,
		requestRef: 'request.conditional-string',
		operationRef: 'operation.conditional-string',
		qualifiedName: 'conditionalString',
		arity: 1,
		version: '1.0.0',
		behaviorSummary: 'Return text for the admitted branch.',
		execution: 'synchronous',
		determinism: 'deterministic',
		effects: 'none',
		dataFlow: 'json-to-json',
		parameters: [{ parameterRef: 'arg.flag', name: 'flag', type: 'boolean', nullPolicy: 'reject' }],
		output: { type: 'string', nullPolicy: 'reject' },
		expression: {
			kind: 'conditional',
			condition: { kind: 'parameter', parameterRef: 'arg.flag' },
			whenTrue: { kind: 'literal', value: 'ready' },
			whenFalse: { kind: 'literal', value: 0 },
		},
		testVectors: [
			{ name: 'true one', arguments: [true], expected: 'ready' },
			{ name: 'true two', arguments: [true], expected: 'ready' },
			{ name: 'true three', arguments: [true], expected: 'ready' },
		],
	}),
	finiteDivision: finalizeTestModule({
		apiVersion: 1,
		requestRef: 'request.finite-division',
		operationRef: 'operation.finite-division',
		qualifiedName: 'finiteDivision',
		arity: 2,
		version: '1.0.0',
		behaviorSummary: 'Divide two numbers and require a finite result.',
		execution: 'synchronous',
		determinism: 'deterministic',
		effects: 'none',
		dataFlow: 'json-to-json',
		parameters: [
			{ parameterRef: 'arg.left', name: 'left', type: 'number', nullPolicy: 'reject' },
			{ parameterRef: 'arg.right', name: 'right', type: 'number', nullPolicy: 'reject' },
		],
		output: { type: 'number', nullPolicy: 'reject' },
		expression: {
			kind: 'binary',
			operator: 'divide',
			left: { kind: 'parameter', parameterRef: 'arg.left' },
			right: { kind: 'parameter', parameterRef: 'arg.right' },
		},
		testVectors: [
			{ name: 'six by two', arguments: [6, 2], expected: 3 },
			{ name: 'nine by three', arguments: [9, 3], expected: 3 },
			{ name: 'zero by four', arguments: [0, 4], expected: 0 },
		],
	}),
	objectStringAdd: finalizeTestModule({
		apiVersion: 1,
		requestRef: 'request.object-string-add',
		operationRef: 'operation.object-string-add',
		qualifiedName: 'objectStringAdd',
		arity: 0,
		version: '1.0.0',
		behaviorSummary: 'Coerce a JSON object to its deterministic string representation.',
		execution: 'synchronous',
		determinism: 'deterministic',
		effects: 'none',
		dataFlow: 'json-to-json',
		parameters: [],
		output: { type: 'string', nullPolicy: 'reject' },
		expression: {
			kind: 'binary',
			operator: 'add',
			left: {
				kind: 'object',
				properties: [{ key: 'toString', value: { kind: 'literal', value: 'x' } }],
			},
			right: { kind: 'literal', value: '' },
		},
		testVectors: [
			{ name: 'first', arguments: [], expected: '[object Object]' },
			{ name: 'second', arguments: [], expected: '[object Object]' },
			{ name: 'third', arguments: [], expected: '[object Object]' },
		],
	}),
	jsonIdentity: finalizeTestModule({
		apiVersion: 1,
		requestRef: 'request.json-identity',
		operationRef: 'operation.json-identity',
		qualifiedName: 'jsonIdentity',
		arity: 1,
		version: '1.0.0',
		behaviorSummary: 'Return one bounded JSON value unchanged.',
		execution: 'synchronous',
		determinism: 'deterministic',
		effects: 'none',
		dataFlow: 'json-to-json',
		parameters: [{ parameterRef: 'arg.value', name: 'value', type: 'json', nullPolicy: 'allow' }],
		output: { type: 'json', nullPolicy: 'allow' },
		expression: { kind: 'parameter', parameterRef: 'arg.value' },
		testVectors: [
			{ name: 'number', arguments: [1], expected: 1 },
			{ name: 'text', arguments: ['value'], expected: 'value' },
			{ name: 'null', arguments: [null], expected: null },
		],
	}),
};

function createUnaryNumberModule(
	operationRef: string,
	qualifiedName: string,
	parameterNullPolicy: 'reject' | 'propagate',
	outputNullPolicy: 'reject' | 'allow',
): OperationModuleSpecV1 {
	return finalizeTestModule({
		apiVersion: 1,
		requestRef: `request.${qualifiedName}`,
		operationRef,
		qualifiedName,
		arity: 1,
		version: '1.0.0',
		behaviorSummary: 'Return the numeric input according to its null contract.',
		execution: 'synchronous',
		determinism: 'deterministic',
		effects: 'none',
		dataFlow: 'json-to-json',
		parameters: [
			{
				parameterRef: 'arg.value',
				name: 'value',
				type: 'number',
				nullPolicy: parameterNullPolicy,
			},
		],
		output: { type: 'number', nullPolicy: outputNullPolicy },
		expression: { kind: 'parameter', parameterRef: 'arg.value' },
		testVectors:
			parameterNullPolicy === 'propagate'
				? [
						{ name: 'null', arguments: [null], expected: null },
						{ name: 'positive', arguments: [2], expected: 2 },
						{ name: 'negative', arguments: [-1], expected: -1 },
					]
				: [
						{ name: 'one', arguments: [1], expected: 1 },
						{ name: 'two', arguments: [2], expected: 2 },
						{ name: 'three', arguments: [3], expected: 3 },
					],
	});
}

function finalizeTestModule(module: Record<string, unknown>): OperationModuleSpecV1 {
	return finalizeOperationModuleSpecV1({ ...module, implementationRef: null });
}

function captureRuntimeEvaluation(module: OperationModuleSpecV1, argumentValues: unknown[]) {
	try {
		return { ok: true as const, value: evaluateOperationModuleV1(module, argumentValues) };
	} catch (error) {
		if (!(error instanceof OperationModuleRuntimeError)) throw error;
		return { ok: false as const, name: error.name, code: error.code };
	}
}

function captureGeneratedEvaluation(module: OperationModuleSpecV1, argumentValues: unknown[]) {
	const catalog = createOperationModuleCatalogV1({ apiVersion: 1, modules: [module] });
	const descriptor = createOperationBlockDescriptorV1(module);
	const argumentInputs = Object.fromEntries(
		argumentValues.map((argument, index) => [`ARG${index}`, value(literalBlock(argument))]),
	);
	const operationBlock = {
		type: descriptor.blockType,
		fields: {
			OPERATION_REF: descriptor.operationRef,
			IMPLEMENTATION_REF: descriptor.implementationRef,
			VERSION: descriptor.version,
			QUALIFIED_NAME: descriptor.qualifiedName,
		},
		inputs: argumentInputs,
	};
	const compiled = compileBlocklyWorkspace(
		workspace(root(setField('result', operationBlock), 'EMPTY')),
		catalog,
	);
	if (!compiled.ok) throw new Error(compiled.error);
	try {
		const execution = runInNewContext(`(() => { ${compiled.javascript} })()`, { $json: {} }) as {
			json: Record<string, unknown>;
		};
		return { ok: true as const, value: execution.json.result };
	} catch (error) {
		const record = error as { name?: unknown; code?: unknown };
		return { ok: false as const, name: record.name, code: record.code };
	}
}

function captureGeneratedFieldEvaluation(module: OperationModuleSpecV1, fieldValue: unknown) {
	const catalog = createOperationModuleCatalogV1({ apiVersion: 1, modules: [module] });
	const descriptor = createOperationBlockDescriptorV1(module);
	const operationBlock = {
		type: descriptor.blockType,
		fields: {
			OPERATION_REF: descriptor.operationRef,
			IMPLEMENTATION_REF: descriptor.implementationRef,
			VERSION: descriptor.version,
			QUALIFIED_NAME: descriptor.qualifiedName,
		},
		inputs: { ARG0: value(field('value')) },
	};
	const compiled = compileBlocklyWorkspace(
		workspace(root(setField('result', operationBlock), 'EMPTY')),
		catalog,
	);
	if (!compiled.ok) throw new Error(compiled.error);
	try {
		const execution = runInNewContext(`(() => { ${compiled.javascript} })()`, {
			$json: { value: fieldValue },
		}) as { json: Record<string, unknown> };
		return { ok: true as const, value: execution.json.result };
	} catch (error) {
		const record = error as { name?: unknown; code?: unknown };
		return { ok: false as const, name: record.name, code: record.code };
	}
}

function literalBlock(value: unknown): Record<string, unknown> {
	if (value === null) return { type: 'logic_null' };
	if (typeof value === 'number') return numberBlock(value);
	if (typeof value === 'string') return text(value);
	if (typeof value === 'boolean') return booleanBlock(value);
	throw new Error('Synthetic operation argument must be a primitive JSON value');
}

function clampScoreBlock(
	score: Record<string, unknown>,
	fieldOverrides?: Record<string, string>,
	argumentCount = 3,
): Record<string, unknown> {
	return scoreOperationBlock(clampScoreModule, score, fieldOverrides, argumentCount);
}

function scoreOperationBlock(
	module: OperationModuleSpecV1,
	score: Record<string, unknown>,
	fieldOverrides?: Record<string, string>,
	argumentCount = 3,
): Record<string, unknown> {
	const descriptor = createOperationBlockDescriptorV1(module);
	const argumentsByName: Record<string, unknown> = {
		ARG0: value(score),
		ARG1: value(numberBlock(0)),
		ARG2: value(numberBlock(100)),
	};
	return {
		type: descriptor.blockType,
		fields: {
			OPERATION_REF: descriptor.operationRef,
			IMPLEMENTATION_REF: descriptor.implementationRef,
			VERSION: descriptor.version,
			QUALIFIED_NAME: descriptor.qualifiedName,
			...fieldOverrides,
		},
		inputs: Object.fromEntries(Object.entries(argumentsByName).slice(0, argumentCount)),
	};
}
