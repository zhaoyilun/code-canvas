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

const numberBlock = (num: number) => ({ type: 'math_number', fields: { NUM: num } });
const text = (textValue: string) => ({ type: 'text', fields: { TEXT: textValue } });
const field = (path: string) => ({ type: 'n8n_get_field', fields: { PATH: path } });

describe('Blockly data transform compiler', () => {
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
