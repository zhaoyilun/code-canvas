export const BLOCKLY_DATA_SCHEMA_VERSION = 2;

const MAX_PAYLOAD_BYTES = 256 * 1024;
const MAX_BLOCKS = 200;
const MAX_DEPTH = 40;
const MAX_PATH_LENGTH = 128;
const MAX_TEXT_LENGTH = 1000;
const MAX_JAVASCRIPT_BYTES = 64 * 1024;

const dangerousSegments = new Set(['__proto__', 'prototype', 'constructor']);
const supportedTypes = new Set([
	'n8n_transform_item',
	'n8n_set_field',
	'n8n_get_field',
	'math_number',
	'math_arithmetic',
	'text',
	'text_join',
	'logic_boolean',
	'logic_compare',
	'logic_operation',
	'logic_negate',
	'logic_ternary',
]);

const allowedInputs: Record<string, readonly string[]> = {
	n8n_transform_item: ['STATEMENTS'],
	n8n_set_field: ['VALUE'],
	n8n_get_field: [],
	math_number: [],
	math_arithmetic: ['A', 'B'],
	text: [],
	text_join: [],
	logic_boolean: [],
	logic_compare: ['A', 'B'],
	logic_operation: ['A', 'B'],
	logic_negate: ['BOOL'],
	logic_ternary: ['IF', 'THEN', 'ELSE'],
};

type JsonRecord = Record<string, unknown>;
type Block = JsonRecord & { type: string };

type Expression = { code: string };

export type BlocklyDataPayload = {
	schemaVersion: 2;
	workspace: Record<string, unknown>;
	javascript: string;
};

export type CompileResult =
	| { ok: true; javascript: string; blockCount: number }
	| { ok: false; error: string };

export function createDefaultWorkspace(): Record<string, unknown> {
	return {
		blocks: {
			languageVersion: 0,
			blocks: [
				{
					type: 'n8n_transform_item',
					x: 24,
					y: 24,
					fields: { MODE: 'COPY' },
					inputs: {
						STATEMENTS: {
							block: {
								type: 'n8n_set_field',
								fields: { KEY: 'processed' },
								inputs: {
									VALUE: { block: { type: 'logic_boolean', fields: { BOOL: 'TRUE' } } },
								},
							},
						},
					},
				},
			],
		},
	};
}

export function compileBlocklyWorkspace(workspace: unknown): CompileResult {
	try {
		const compiler = new WorkspaceCompiler(workspace);
		return compiler.compile();
	} catch (error: unknown) {
		return {
			ok: false,
			error: error instanceof Error ? error.message : 'Invalid Blockly workspace',
		};
	}
}

export function parseBlocklyDataPayload(
	value: string,
): { ok: true; payload: BlocklyDataPayload } | { ok: false; error: string } {
	if (byteLength(value) > MAX_PAYLOAD_BYTES) return failure('Payload exceeds 256 KiB');

	let parsed: unknown;
	try {
		parsed = JSON.parse(value);
	} catch {
		return failure('Payload is not valid JSON');
	}
	if (!isRecord(parsed)) return failure('Payload must be an object');
	if (parsed.schemaVersion !== BLOCKLY_DATA_SCHEMA_VERSION)
		return failure('Unsupported payload schema version');
	if (!isRecord(parsed.workspace)) return failure('Payload workspace must be an object');
	if (typeof parsed.javascript !== 'string') return failure('Payload javascript must be a string');

	const result = compileBlocklyWorkspace(parsed.workspace);
	return {
		ok: true,
		payload: {
			schemaVersion: BLOCKLY_DATA_SCHEMA_VERSION,
			workspace: parsed.workspace,
			javascript: result.ok ? result.javascript : '',
		},
	};
}

export function serializeBlocklyDataPayload(workspace: Record<string, unknown>): string {
	const result = compileBlocklyWorkspace(workspace);
	const payload: BlocklyDataPayload = {
		schemaVersion: BLOCKLY_DATA_SCHEMA_VERSION,
		workspace,
		javascript: result.ok ? result.javascript : '',
	};
	const serialized = JSON.stringify(payload);
	if (byteLength(serialized) > MAX_PAYLOAD_BYTES) throw new Error('Payload exceeds 256 KiB');
	return serialized;
}

class WorkspaceCompiler {
	private blockCount = 0;
	private readonly visited = new Set<object>();

	constructor(private readonly workspace: unknown) {}

	compile(): CompileResult {
		const root = this.parseRoot();
		const mode = this.stringField(root, 'MODE');
		if (mode !== 'COPY' && mode !== 'EMPTY') this.fail('Root MODE must be COPY or EMPTY');
		const statements = this.optionalChild(root, 'STATEMENTS');
		const lines = [mode === 'COPY' ? 'const output = { ...$json };' : 'const output = {};'];
		if (statements) this.compileStatements(statements, lines, 1);
		lines.push('return { json: output };');
		const javascript = `${lines.join('\n')}\n`;
		if (byteLength(javascript) > MAX_JAVASCRIPT_BYTES)
			this.fail('Generated JavaScript exceeds 64 KiB');
		return { ok: true, javascript, blockCount: this.blockCount };
	}

	private parseRoot(): Block {
		if (!isRecord(this.workspace)) this.fail('Workspace must be an object');
		const blocksState = this.workspace.blocks;
		if (!isRecord(blocksState) || !Array.isArray(blocksState.blocks))
			this.fail('Workspace blocks are malformed');
		if (blocksState.blocks.length !== 1) this.fail('Workspace must contain exactly one root block');
		const root = this.block(blocksState.blocks[0], 0);
		if (root.type !== 'n8n_transform_item') this.fail('Root block must be n8n_transform_item');
		return root;
	}

	private compileStatements(block: Block, lines: string[], depth: number): void {
		if (depth > MAX_DEPTH) this.fail('Block depth exceeds 40');
		if (block.type !== 'n8n_set_field')
			this.fail('Only n8n_set_field may appear in a statement chain');
		const key = this.safePath(this.stringField(block, 'KEY'), 'Output key');
		const value = this.requiredChild(block, 'VALUE');
		lines.push(`output[${JSON.stringify(key)}] = ${this.expression(value, depth + 1).code};`);
		const next = this.optionalNext(block);
		if (next) this.compileStatements(next, lines, depth + 1);
	}

	private expression(block: Block, depth: number): Expression {
		if (depth > MAX_DEPTH) this.fail('Block depth exceeds 40');
		switch (block.type) {
			case 'n8n_get_field': {
				const path = this.safePath(this.stringField(block, 'PATH'), 'Field path');
				const read = path
					.split('.')
					.map((segment) => `[${JSON.stringify(segment)}]`)
					.join('?.');
				return { code: `($json?.${read} ?? null)` };
			}
			case 'math_number': {
				const numericValue = this.field(block, 'NUM');
				if (!isFiniteNumber(numericValue)) this.fail('math_number NUM must be finite');
				return { code: String(numericValue) };
			}
			case 'text': {
				const text = this.stringField(block, 'TEXT');
				if (text.length > MAX_TEXT_LENGTH) this.fail('Text literal exceeds 1000 characters');
				return { code: JSON.stringify(text) };
			}
			case 'logic_boolean': {
				const value = this.stringField(block, 'BOOL');
				if (value !== 'TRUE' && value !== 'FALSE')
					this.fail('logic_boolean BOOL must be TRUE or FALSE');
				return { code: value === 'TRUE' ? 'true' : 'false' };
			}
			case 'math_arithmetic':
				return this.binary(block, depth, 'A', 'B', {
					ADD: '+',
					SUBTRACT: '-',
					MULTIPLY: '*',
					DIVIDE: '/',
					POWER: '**',
				});
			case 'logic_compare':
				return this.binary(block, depth, 'A', 'B', {
					EQ: '===',
					NEQ: '!==',
					LT: '<',
					LTE: '<=',
					GT: '>',
					GTE: '>=',
				});
			case 'logic_operation':
				return this.binary(block, depth, 'A', 'B', { AND: '&&', OR: '||' });
			case 'logic_negate':
				return { code: `(!${this.expression(this.requiredChild(block, 'BOOL'), depth + 1).code})` };
			case 'logic_ternary':
				return {
					code: `(${this.expression(this.requiredChild(block, 'IF'), depth + 1).code} ? ${this.expression(this.requiredChild(block, 'THEN'), depth + 1).code} : ${this.expression(this.requiredChild(block, 'ELSE'), depth + 1).code})`,
				};
			case 'text_join':
				return this.join(block, depth);
			default:
				this.fail(`Unsupported value block: ${block.type}`);
		}
	}

	private binary(
		block: Block,
		depth: number,
		left: string,
		right: string,
		operators: Record<string, string>,
	): Expression {
		const operator = this.stringField(block, 'OP');
		const code = operators[operator];
		if (!code) this.fail(`Unsupported ${block.type} operator`);
		return {
			code: `(${this.expression(this.requiredChild(block, left), depth + 1).code} ${code} ${this.expression(this.requiredChild(block, right), depth + 1).code})`,
		};
	}

	private join(block: Block, depth: number): Expression {
		const inputs = this.inputs(block);
		const keys = Object.keys(inputs)
			.filter((key) => /^ADD\d+$/.test(key))
			.sort((a, b) => Number(a.slice(3)) - Number(b.slice(3)));
		if (keys.length === 0 || keys.some((key, index) => key !== `ADD${index}`))
			this.fail('text_join inputs are malformed');
		const values = keys.map(
			(key) => this.expression(this.childFromInput(inputs[key]), depth + 1).code,
		);
		return { code: `[${values.join(', ')}].join('')` };
	}

	private block(value: unknown, depth: number): Block {
		if (depth > MAX_DEPTH) this.fail('Block depth exceeds 40');
		if (!isBlock(value)) this.fail('Block is malformed');
		if (!supportedTypes.has(value.type)) this.fail(`Unsupported block type: ${value.type}`);
		if (this.visited.has(value))
			this.fail('Workspace contains a block cycle or duplicate reference');
		this.visited.add(value);
		this.blockCount += 1;
		if (this.blockCount > MAX_BLOCKS) this.fail('Workspace exceeds 200 blocks');
		const inputs = this.inputs(value);
		const permittedInputs = allowedInputs[value.type];
		if (value.type === 'text_join') {
			if (Object.keys(inputs).some((key) => !/^ADD\d+$/.test(key)))
				this.fail('text_join inputs are malformed');
		} else if (Object.keys(inputs).some((key) => !permittedInputs.includes(key))) {
			this.fail(`${value.type} contains an unsupported input`);
		}
		if (value.type !== 'n8n_set_field' && 'next' in value)
			this.fail(`${value.type} cannot have a next block`);
		return value;
	}

	private requiredChild(block: Block, name: string): Block {
		const inputs = this.inputs(block);
		if (!(name in inputs)) this.fail(`${block.type} requires ${name}`);
		return this.childFromInput(inputs[name]);
	}

	private optionalChild(block: Block, name: string): Block | undefined {
		const inputs = this.inputs(block);
		if (!(name in inputs)) return undefined;
		return this.childFromInput(inputs[name]);
	}

	private childFromInput(input: unknown): Block {
		if (
			!isRecord(input) ||
			!('block' in input) ||
			Object.keys(input).some((key) => key !== 'block')
		)
			this.fail('Block input is malformed');
		return this.block(input.block, 1);
	}

	private optionalNext(block: Block): Block | undefined {
		if (!('next' in block)) return undefined;
		const next = block.next;
		if (!isRecord(next) || !('block' in next) || Object.keys(next).some((key) => key !== 'block'))
			this.fail('Block next is malformed');
		return this.block(next.block, 1);
	}

	private inputs(block: Block): JsonRecord {
		if (!('inputs' in block)) return {};
		if (!isRecord(block.inputs)) this.fail(`${block.type} inputs are malformed`);
		return block.inputs;
	}

	private field(block: Block, name: string): string | number {
		if (!isRecord(block.fields) || !(name in block.fields))
			this.fail(`${block.type} requires ${name}`);
		const value = block.fields[name];
		if (typeof value !== 'string' && typeof value !== 'number')
			this.fail(`${block.type} ${name} is malformed`);
		return value;
	}

	private stringField(block: Block, name: string): string {
		const value = this.field(block, name);
		if (typeof value !== 'string') this.fail(`${block.type} ${name} must be a string`);
		return value;
	}

	private safePath(value: string | number, label: string): string {
		if (typeof value !== 'string' || value.length === 0 || value.length > MAX_PATH_LENGTH)
			this.fail(`${label} must be 1 to 128 characters`);
		const segments = value.split('.');
		if (segments.some((segment) => segment.length === 0 || dangerousSegments.has(segment)))
			this.fail(`${label} contains a forbidden path segment`);
		return value;
	}

	private fail(message: string): never {
		throw new Error(message);
	}
}

function isRecord(value: unknown): value is JsonRecord {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isBlock(value: unknown): value is Block {
	return isRecord(value) && typeof value.type === 'string';
}

function isFiniteNumber(value: string | number): value is number {
	return typeof value === 'number' && Number.isFinite(value);
}

function byteLength(value: string): number {
	return new TextEncoder().encode(value).length;
}

function failure(error: string): { ok: false; error: string } {
	return { ok: false, error };
}
