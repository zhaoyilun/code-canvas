import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';

import {
	BLOCKLY_DATA_SCHEMA_VERSION,
	compileBlocklyWorkspace,
	createDefaultWorkspace,
	parseBlocklyDataPayload,
	serializeBlocklyDataPayload,
} from './index';

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

		expect(BLOCKLY_DATA_SCHEMA_VERSION).toBe(2);
		expect(result).toEqual({
			ok: true,
			blockCount: 3,
			javascript:
				'const output = { ...$json };\noutput["processed"] = true;\nreturn { json: output };\n',
		});
		const serialized = serializeBlocklyDataPayload(defaultWorkspace);
		expect(serialized).toBe(serializeBlocklyDataPayload(defaultWorkspace));
		expect(parseJson(serialized)).toEqual({
			schemaVersion: 2,
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
					schemaVersion: 2,
					workspace: createDefaultWorkspace(),
					javascript: '',
					hiddenCode: 'ignored field',
				}),
			),
		).toEqual({
			ok: false,
			error: 'Payload must contain only schemaVersion, workspace, and javascript',
		});
		const parsed = parseBlocklyDataPayload(
			JSON.stringify({
				schemaVersion: 2,
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

	it('preserves an invalid schema 2 workspace with an empty preview', () => {
		const invalidWorkspace = workspace(root(setField('value', { type: 'controls_repeat_ext' })));
		const serialized = serializeBlocklyDataPayload(invalidWorkspace);

		expect(parseJson(serialized)).toEqual({
			schemaVersion: 2,
			workspace: invalidWorkspace,
			javascript: '',
		});
		expect(parseBlocklyDataPayload(serialized)).toEqual({
			ok: true,
			payload: {
				schemaVersion: 2,
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
