import {
	createOperationBlockDescriptorV1,
	createOperationModuleCatalogV1,
	OPERATION_JSON_MAX_DEPTH,
	OPERATION_JSON_MAX_KEY_LENGTH,
	OPERATION_JSON_MAX_NODES,
	OPERATION_JSON_MAX_STRING_LENGTH,
	type OperationExpressionV1,
	type OperationModuleCatalogV1,
	type OperationModuleSpecV1,
} from '@n8n/dual-canvas-operation-runtime';

export const BLOCKLY_DATA_SCHEMA_VERSION = 3;

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
	'n8n_delete_field',
	'n8n_if',
	'n8n_assert',
	'n8n_get_field',
	'n8n_get_path',
	'n8n_convert',
	'lists_create_with',
	'lists_length',
	'n8n_array_at',
	'n8n_array_map_path',
	'n8n_array_filter_path',
	'n8n_object_create',
	'n8n_object_property',
	'math_number',
	'math_arithmetic',
	'text',
	'text_join',
	'logic_boolean',
	'logic_null',
	'logic_compare',
	'logic_operation',
	'logic_negate',
	'logic_ternary',
]);

const allowedInputs: Record<string, readonly string[]> = {
	n8n_transform_item: ['STATEMENTS'],
	n8n_set_field: ['VALUE'],
	n8n_delete_field: [],
	n8n_if: ['CONDITION', 'THEN', 'ELSE'],
	n8n_assert: ['CONDITION', 'MESSAGE'],
	n8n_get_field: [],
	n8n_get_path: ['VALUE'],
	n8n_convert: ['VALUE'],
	lists_create_with: [],
	lists_length: ['VALUE'],
	n8n_array_at: ['ARRAY', 'INDEX'],
	n8n_array_map_path: ['ARRAY'],
	n8n_array_filter_path: ['ARRAY', 'VALUE'],
	n8n_object_create: ['PROPERTIES'],
	n8n_object_property: ['VALUE'],
	math_number: [],
	math_arithmetic: ['A', 'B'],
	text: [],
	text_join: [],
	logic_boolean: [],
	logic_null: [],
	logic_compare: ['A', 'B'],
	logic_operation: ['A', 'B'],
	logic_negate: ['BOOL'],
	logic_ternary: ['IF', 'THEN', 'ELSE'],
};

const statementTypes = new Set(['n8n_set_field', 'n8n_delete_field', 'n8n_if', 'n8n_assert']);
const chainedTypes = new Set([...statementTypes, 'n8n_object_property']);

type JsonRecord = Record<string, unknown>;
type Block = JsonRecord & { type: string };

type Expression = { code: string };

const operationBinaryOperators: Record<
	Extract<OperationExpressionV1, { kind: 'binary' }>['operator'],
	string
> = {
	add: '+',
	subtract: '-',
	multiply: '*',
	divide: '/',
	power: '**',
	eq: '===',
	neq: '!==',
	lt: '<',
	lte: '<=',
	gt: '>',
	gte: '>=',
	and: '&&',
	or: '||',
};

const operationFiniteOperatorNames: Partial<
	Record<Extract<OperationExpressionV1, { kind: 'binary' }>['operator'], string>
> = {
	subtract: 'subtraction',
	multiply: 'multiplication',
	divide: 'division',
	power: 'power',
};

const operationTypeConditions = new Map<string, (value: string) => string>([
	['json', () => 'true'],
	['number', (value) => `typeof ${value} === "number" && Number.isFinite(${value})`],
	['string', (value) => `typeof ${value} === "string"`],
	['boolean', (value) => `typeof ${value} === "boolean"`],
	['array', (value) => `Array.isArray(${value})`],
	['object', (value) => `typeof ${value} === "object" && !Array.isArray(${value})`],
]);

export type BlocklyDataPayload = {
	schemaVersion: 3;
	operationCatalog: OperationModuleCatalogV1;
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

export function compileBlocklyWorkspace(
	workspace: unknown,
	operationCatalog: OperationModuleCatalogV1,
): CompileResult {
	try {
		const catalog = createOperationModuleCatalogV1(operationCatalog);
		const compiler = new WorkspaceCompiler(workspace, catalog);
		return compiler.compile();
	} catch (error: unknown) {
		return {
			ok: false,
			error: errorMessage(error, 'Invalid Blockly workspace'),
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
	const payloadKeys = Object.keys(parsed);
	if (
		payloadKeys.length !== 4 ||
		payloadKeys.some(
			(key) =>
				key !== 'schemaVersion' &&
				key !== 'operationCatalog' &&
				key !== 'workspace' &&
				key !== 'javascript',
		)
	)
		return failure(
			'Payload must contain only schemaVersion, operationCatalog, workspace, and javascript',
		);
	if (parsed.schemaVersion !== BLOCKLY_DATA_SCHEMA_VERSION)
		return failure('Unsupported payload schema version');
	if (!isRecord(parsed.workspace)) return failure('Payload workspace must be an object');
	if (typeof parsed.javascript !== 'string') return failure('Payload javascript must be a string');
	let operationCatalog: OperationModuleCatalogV1;
	try {
		operationCatalog = createOperationModuleCatalogV1(parsed.operationCatalog);
	} catch (error: unknown) {
		return failure(`Invalid operation catalog: ${errorMessage(error)}`);
	}

	const result = compileBlocklyWorkspace(parsed.workspace, operationCatalog);
	return {
		ok: true,
		payload: {
			schemaVersion: BLOCKLY_DATA_SCHEMA_VERSION,
			operationCatalog,
			workspace: parsed.workspace,
			javascript: result.ok ? result.javascript : '',
		},
	};
}

export function serializeBlocklyDataPayload(
	workspace: Record<string, unknown>,
	operationCatalog: OperationModuleCatalogV1,
): string {
	const catalog = createOperationModuleCatalogV1(operationCatalog);
	const result = compileBlocklyWorkspace(workspace, catalog);
	const payload: BlocklyDataPayload = {
		schemaVersion: BLOCKLY_DATA_SCHEMA_VERSION,
		operationCatalog: catalog,
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
	private readonly operationsByBlockType = new Map<
		string,
		{ module: OperationModuleSpecV1; allowedInputs: readonly string[] }
	>();
	private readonly operationsByLogicalIdentity = new Map<string, OperationModuleSpecV1>();

	constructor(
		private readonly workspace: unknown,
		operationCatalog: OperationModuleCatalogV1,
	) {
		for (const module of operationCatalog.modules) {
			const descriptor = createOperationBlockDescriptorV1(module);
			this.operationsByBlockType.set(descriptor.blockType, {
				module,
				allowedInputs: descriptor.inputs.map(({ inputName }) => inputName),
			});
			const logicalIdentity = this.operationLogicalIdentity(module.operationRef, module.version);
			this.operationsByLogicalIdentity.set(logicalIdentity, module);
		}
	}

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

	private compileStatements(block: Block, lines: string[], depth: number, indent = 0): void {
		if (depth > MAX_DEPTH) this.fail('Block depth exceeds 40');
		if (!statementTypes.has(block.type))
			this.fail(`${block.type} cannot appear in a statement chain`);

		const padding = '\t'.repeat(indent);
		switch (block.type) {
			case 'n8n_set_field': {
				const path = this.safePath(this.stringField(block, 'KEY'), 'Output path');
				const value = this.requiredChild(block, 'VALUE');
				lines.push(
					...this.pathAssignment('output', path, this.expression(value, depth + 1).code, padding),
				);
				break;
			}
			case 'n8n_delete_field': {
				const path = this.safePath(this.stringField(block, 'KEY'), 'Output path');
				lines.push(...this.pathDeletion('output', path, padding));
				break;
			}
			case 'n8n_if': {
				const condition = this.expression(this.requiredChild(block, 'CONDITION'), depth + 1);
				lines.push(`${padding}if (${condition.code}) {`);
				const thenBranch = this.optionalChild(block, 'THEN');
				if (thenBranch) this.compileStatements(thenBranch, lines, depth + 1, indent + 1);
				const elseBranch = this.optionalChild(block, 'ELSE');
				if (elseBranch) {
					lines.push(`${padding}} else {`);
					this.compileStatements(elseBranch, lines, depth + 1, indent + 1);
				}
				lines.push(`${padding}}`);
				break;
			}
			case 'n8n_assert': {
				const condition = this.expression(this.requiredChild(block, 'CONDITION'), depth + 1);
				const message = this.expression(this.requiredChild(block, 'MESSAGE'), depth + 1);
				lines.push(`${padding}if (!(${condition.code})) {`);
				lines.push(`${padding}\tthrow new Error(String(${message.code}));`);
				lines.push(`${padding}}`);
				break;
			}
		}

		const next = this.optionalNext(block);
		if (next) this.compileStatements(next, lines, depth + 1, indent);
	}

	private expression(block: Block, depth: number): Expression {
		if (depth > MAX_DEPTH) this.fail('Block depth exceeds 40');
		const operation = this.operationsByBlockType.get(block.type);
		if (operation) return this.operationCall(block, operation.module, depth);
		switch (block.type) {
			case 'n8n_get_field': {
				const path = this.safePath(this.stringField(block, 'PATH'), 'Field path');
				return { code: `(${this.pathRead('$json', path)} ?? null)` };
			}
			case 'n8n_get_path': {
				const path = this.safePath(this.stringField(block, 'PATH'), 'Field path');
				const value = this.expression(this.requiredChild(block, 'VALUE'), depth + 1);
				return { code: `(${this.pathRead(`(${value.code})`, path)} ?? null)` };
			}
			case 'n8n_convert':
				return this.convert(block, depth);
			case 'lists_create_with':
				return this.arrayLiteral(block, depth);
			case 'lists_length': {
				const value = this.expression(this.requiredChild(block, 'VALUE'), depth + 1);
				return {
					code: `((value) => Array.isArray(value) || typeof value === 'string' ? value.length : 0)(${value.code})`,
				};
			}
			case 'n8n_array_at': {
				const array = this.expression(this.requiredChild(block, 'ARRAY'), depth + 1);
				const index = this.expression(this.requiredChild(block, 'INDEX'), depth + 1);
				return {
					code: `((items, index) => Array.isArray(items) && Number.isInteger(index) ? (items.at(index) ?? null) : null)(${array.code}, ${index.code})`,
				};
			}
			case 'n8n_array_map_path':
				return this.mapArrayPath(block, depth);
			case 'n8n_array_filter_path':
				return this.filterArrayPath(block, depth);
			case 'n8n_object_create':
				return this.objectLiteral(block, depth);
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
			case 'logic_null':
				return { code: 'null' };
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

	private operationCall(block: Block, module: OperationModuleSpecV1, depth: number): Expression {
		const fields = this.operationFields(block);
		if (fields.OPERATION_REF !== module.operationRef)
			this.fail(
				`OPERATION_BLOCK_IDENTITY_MISMATCH: ${block.type} OPERATION_REF does not match its catalog module`,
			);
		if (fields.VERSION !== module.version)
			this.fail(
				`OPERATION_BLOCK_IDENTITY_MISMATCH: ${block.type} VERSION does not match its catalog module`,
			);
		if (fields.IMPLEMENTATION_REF !== module.implementationRef)
			this.fail(
				`OPERATION_BLOCK_IDENTITY_MISMATCH: ${block.type} IMPLEMENTATION_REF does not match its catalog module`,
			);
		if (fields.QUALIFIED_NAME !== module.qualifiedName)
			this.fail(
				`OPERATION_BLOCK_IDENTITY_MISMATCH: ${block.type} QUALIFIED_NAME does not match its catalog module`,
			);

		const argumentCodes = module.parameters.map(
			(_parameter, index) =>
				this.expression(this.requiredChild(block, `ARG${index}`), depth + 1).code,
		);
		const parameterNames = module.parameters.map((_parameter, index) => `operationArg${index}`);
		const parameterByRef = new Map(
			module.parameters.map((parameter, index) => [parameter.parameterRef, parameterNames[index]]),
		);
		const expression = this.operationExpression(module.expression, parameterByRef, 1);
		const statements = [
			'const operationFail = (code, message) => { const error = new Error(code + ": " + message); error.name = "OperationModuleRuntimeError"; error.code = code; throw error; };',
			`const operationIsJson = (root) => { const stack = [{ value: root, depth: 1 }]; const ancestors = new Set(); let nodes = 0; while (stack.length > 0) { const current = stack.pop(); if (current.exit) { ancestors.delete(current.value); continue; } nodes += 1; if (current.depth > ${OPERATION_JSON_MAX_DEPTH} || nodes > ${OPERATION_JSON_MAX_NODES}) return false; const value = current.value; if (value === null || typeof value === "boolean") continue; if (typeof value === "string") { if (value.length > ${OPERATION_JSON_MAX_STRING_LENGTH}) return false; continue; } if (typeof value === "number") { if (!Number.isFinite(value)) return false; continue; } if (typeof value !== "object" || ancestors.has(value)) return false; ancestors.add(value); stack.push({ value, depth: current.depth, exit: true }); if (Array.isArray(value)) { for (const item of value) stack.push({ value: item, depth: current.depth + 1 }); } else { for (const key of Object.keys(value)) { if (key.length > ${OPERATION_JSON_MAX_KEY_LENGTH} || key === "__proto__" || key === "prototype" || key === "constructor") return false; stack.push({ value: value[key], depth: current.depth + 1 }); } } } return true; };`,
			'const operationCloneJson = (value) => Array.isArray(value) ? value.map(operationCloneJson) : value !== null && typeof value === "object" ? Object.fromEntries(Object.entries(value).map(([key, item]) => [key, operationCloneJson(item)])) : value;',
			'const operationFinite = (value, operation) => { if (!Number.isFinite(value)) operationFail("OPERATION_EXPRESSION_RESULT_INVALID", operation + " produced a non-finite number"); return value; };',
			'const operationArrayElementString = (value) => value === null ? "" : Array.isArray(value) ? value.map(operationArrayElementString).join(",") : typeof value === "object" ? "[object Object]" : String(value);',
			'const operationToPrimitive = (value) => Array.isArray(value) ? value.map(operationArrayElementString).join(",") : value !== null && typeof value === "object" ? "[object Object]" : value;',
			'const operationToNumber = (value) => Number(operationToPrimitive(value));',
			'const operationAdd = (left, right) => { const leftPrimitive = operationToPrimitive(left); const rightPrimitive = operationToPrimitive(right); if (typeof leftPrimitive === "string" || typeof rightPrimitive === "string") return String(leftPrimitive) + String(rightPrimitive); return operationFinite(Number(leftPrimitive) + Number(rightPrimitive), "addition"); };',
			'const operationRelational = (left, right, operator) => { const leftPrimitive = operationToPrimitive(left); const rightPrimitive = operationToPrimitive(right); if (typeof leftPrimitive === "string" && typeof rightPrimitive === "string") { if (operator === "lt") return leftPrimitive < rightPrimitive; if (operator === "lte") return leftPrimitive <= rightPrimitive; if (operator === "gt") return leftPrimitive > rightPrimitive; return leftPrimitive >= rightPrimitive; } const leftNumber = Number(leftPrimitive); const rightNumber = Number(rightPrimitive); if (operator === "lt") return leftNumber < rightNumber; if (operator === "lte") return leftNumber <= rightNumber; if (operator === "gt") return leftNumber > rightNumber; return leftNumber >= rightNumber; };',
		];
		for (const [index, parameter] of module.parameters.entries()) {
			const parameterName = parameterNames[index];
			statements.push(
				`if (!operationIsJson(${parameterName})) operationFail("OPERATION_ARGUMENT_COUNT_INVALID", ${JSON.stringify(`${module.qualifiedName}/${module.arity} requires exactly ${module.parameters.length} arguments`)});`,
			);
			statements.push(
				...this.operationContractChecks(
					parameterName,
					parameter,
					`argument ${index} (${parameter.name})`,
					'OPERATION_ARGUMENT_TYPE_INVALID',
				),
			);
			statements.push(`${parameterName} = operationCloneJson(${parameterName});`);
		}
		const propagateCondition = module.parameters
			.map((parameter, index) =>
				parameter.nullPolicy === 'propagate' ? `${parameterNames[index]} === null` : undefined,
			)
			.filter((condition): condition is string => condition !== undefined)
			.join(' || ');
		statements.push(
			`const operationResult = ${propagateCondition === '' ? expression : `(${propagateCondition}) ? null : ${expression}`};`,
		);
		statements.push(
			'if (!operationIsJson(operationResult)) operationFail("OPERATION_EXPRESSION_RESULT_INVALID", "operation expression produced a non-JSON value");',
		);
		statements.push(
			...this.operationContractChecks(
				'operationResult',
				module.output,
				'operation output',
				'OPERATION_OUTPUT_TYPE_INVALID',
			),
		);
		statements.push('return operationResult;');
		return {
			code: `((${parameterNames.join(', ')}) => { ${statements.join(' ')} })(${argumentCodes.join(', ')})`,
		};
	}

	private operationContractChecks(
		value: string,
		contract: { type: string; nullPolicy: string },
		location: string,
		errorCode: 'OPERATION_ARGUMENT_TYPE_INVALID' | 'OPERATION_OUTPUT_TYPE_INVALID',
	): string[] {
		const checks: string[] = [];
		if (contract.nullPolicy === 'reject') {
			checks.push(
				`if (${value} === null) operationFail(${JSON.stringify(errorCode)}, ${JSON.stringify(`${location} rejects null`)});`,
			);
		}
		const condition = operationTypeConditions.get(contract.type);
		if (!condition)
			this.fail(`OPERATION_CONTRACT_INVALID: unsupported value type ${contract.type}`);
		if (contract.type !== 'json') {
			checks.push(
				`if (${value} !== null && !(${condition(value)})) operationFail(${JSON.stringify(errorCode)}, ${JSON.stringify(`${location} must have type ${contract.type}`)});`,
			);
		}
		return checks;
	}

	private operationExpression(
		expression: OperationExpressionV1,
		parameterByRef: ReadonlyMap<string, string>,
		depth: number,
	): string {
		if (depth > 16) this.fail('OPERATION_EXPRESSION_INVALID: expression depth exceeds 16');
		switch (expression.kind) {
			case 'literal':
				return JSON.stringify(expression.value);
			case 'parameter': {
				const parameterName = parameterByRef.get(expression.parameterRef);
				if (!parameterName)
					this.fail(
						`OPERATION_EXPRESSION_INVALID: undeclared parameter ${expression.parameterRef}`,
					);
				return parameterName;
			}
			case 'unary': {
				const value = this.operationExpression(expression.value, parameterByRef, depth + 1);
				return expression.operator === 'not'
					? `(!${value})`
					: `operationFinite(-operationToNumber(${value}), "unary negate")`;
			}
			case 'binary': {
				const operator = operationBinaryOperators[expression.operator];
				const left = this.operationExpression(expression.left, parameterByRef, depth + 1);
				const right = this.operationExpression(expression.right, parameterByRef, depth + 1);
				if (expression.operator === 'add') {
					return `operationAdd(${left}, ${right})`;
				}
				const finiteOperation = operationFiniteOperatorNames[expression.operator];
				if (finiteOperation) {
					return `operationFinite((operationToNumber(${left}) ${operator} operationToNumber(${right})), ${JSON.stringify(finiteOperation)})`;
				}
				if (
					expression.operator === 'lt' ||
					expression.operator === 'lte' ||
					expression.operator === 'gt' ||
					expression.operator === 'gte'
				) {
					return `operationRelational(${left}, ${right}, ${JSON.stringify(expression.operator)})`;
				}
				return `(${left} ${operator} ${right})`;
			}
			case 'conditional':
				return `(${this.operationExpression(expression.condition, parameterByRef, depth + 1)} ? ${this.operationExpression(expression.whenTrue, parameterByRef, depth + 1)} : ${this.operationExpression(expression.whenFalse, parameterByRef, depth + 1)})`;
			case 'array':
				return `[${expression.values
					.map((value) => this.operationExpression(value, parameterByRef, depth + 1))
					.join(', ')}]`;
			case 'object':
				return `{ ${expression.properties
					.map(
						({ key, value }) =>
							`[${JSON.stringify(key)}]: ${this.operationExpression(value, parameterByRef, depth + 1)}`,
					)
					.join(', ')} }`;
		}
	}

	private operationFields(block: Block): {
		OPERATION_REF: string;
		IMPLEMENTATION_REF: string;
		VERSION: string;
		QUALIFIED_NAME: string;
	} {
		if (!isRecord(block.fields))
			this.fail(`OPERATION_BLOCK_MALFORMED: ${block.type} requires operation identity fields`);
		const allowed = new Set(['OPERATION_REF', 'IMPLEMENTATION_REF', 'VERSION', 'QUALIFIED_NAME']);
		if (Object.keys(block.fields).some((key) => !allowed.has(key)))
			this.fail(`OPERATION_BLOCK_MALFORMED: ${block.type} contains an unsupported field`);
		return {
			OPERATION_REF: this.stringField(block, 'OPERATION_REF'),
			IMPLEMENTATION_REF: this.stringField(block, 'IMPLEMENTATION_REF'),
			VERSION: this.stringField(block, 'VERSION'),
			QUALIFIED_NAME: this.stringField(block, 'QUALIFIED_NAME'),
		};
	}

	private operationLogicalIdentity(operationRef: string, version: string): string {
		return `${operationRef}@${version}`;
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
		this.validateItemCount(block, keys.length);
		const values = keys.map(
			(key) => this.expression(this.childFromInput(inputs[key]), depth + 1).code,
		);
		return { code: `[${values.join(', ')}].join('')` };
	}

	private convert(block: Block, depth: number): Expression {
		const value = this.expression(this.requiredChild(block, 'VALUE'), depth + 1);
		switch (this.stringField(block, 'TYPE')) {
			case 'TEXT':
				return {
					code: `((value) => value === null ? '' : typeof value === 'object' ? JSON.stringify(value) : String(value))(${value.code})`,
				};
			case 'NUMBER':
				return {
					code: `((value) => { if (value === null || value === '') return null; const number = Number(value); return Number.isFinite(number) ? number : null; })(${value.code})`,
				};
			case 'BOOLEAN':
				return { code: `Boolean(${value.code})` };
			default:
				this.fail('n8n_convert TYPE must be TEXT, NUMBER, or BOOLEAN');
		}
	}

	private arrayLiteral(block: Block, depth: number): Expression {
		const inputs = this.inputs(block);
		const declaredItemCount = this.itemCount(block);
		const keys = this.sequentialInputKeys(
			inputs,
			'ADD',
			'lists_create_with',
			true,
			declaredItemCount !== undefined,
		);
		const itemCount = declaredItemCount ?? keys.length;
		if (keys.some((key) => Number(key.slice(3)) >= itemCount))
			this.fail('lists_create_with inputs exceed itemCount');
		const values = Array.from({ length: itemCount }, (_, index) => {
			const input = inputs[`ADD${index}`];
			return input === undefined
				? 'null'
				: this.expression(this.childFromInput(input), depth + 1).code;
		});
		return { code: `[${values.join(', ')}]` };
	}

	private mapArrayPath(block: Block, depth: number): Expression {
		const path = this.safePath(this.stringField(block, 'PATH'), 'Field path');
		const array = this.expression(this.requiredChild(block, 'ARRAY'), depth + 1);
		return {
			code: `((items) => Array.isArray(items) ? items.map((item) => (${this.pathRead('item', path)} ?? null)) : [])(${array.code})`,
		};
	}

	private filterArrayPath(block: Block, depth: number): Expression {
		const path = this.safePath(this.stringField(block, 'PATH'), 'Field path');
		const operator = this.stringField(block, 'OP');
		const operators: Record<string, string> = {
			EQ: '===',
			NEQ: '!==',
			LT: '<',
			LTE: '<=',
			GT: '>',
			GTE: '>=',
		};
		const code = operators[operator];
		if (!code) this.fail('Unsupported n8n_array_filter_path operator');
		const array = this.expression(this.requiredChild(block, 'ARRAY'), depth + 1);
		const expected = this.expression(this.requiredChild(block, 'VALUE'), depth + 1);
		return {
			code: `((items, expected) => Array.isArray(items) ? items.filter((item) => ((${this.pathRead('item', path)} ?? null) ${code} expected)) : [])(${array.code}, ${expected.code})`,
		};
	}

	private objectLiteral(block: Block, depth: number): Expression {
		const firstProperty = this.optionalChild(block, 'PROPERTIES');
		if (!firstProperty) return { code: '{}' };

		const properties: string[] = [];
		this.compileObjectProperties(firstProperty, properties, new Set<string>(), depth + 1);
		return { code: `{ ${properties.join(', ')} }` };
	}

	private compileObjectProperties(
		block: Block,
		properties: string[],
		keys: Set<string>,
		depth: number,
	): void {
		if (depth > MAX_DEPTH) this.fail('Block depth exceeds 40');
		if (block.type !== 'n8n_object_property')
			this.fail(`${block.type} cannot appear in an object property chain`);
		const key = this.safeObjectKey(this.stringField(block, 'KEY'));
		if (keys.has(key)) this.fail(`Object contains duplicate key: ${key}`);
		keys.add(key);
		const value = this.expression(this.requiredChild(block, 'VALUE'), depth + 1);
		properties.push(`[${JSON.stringify(key)}]: ${value.code}`);
		const next = this.optionalNext(block);
		if (next) this.compileObjectProperties(next, properties, keys, depth + 1);
	}

	private sequentialInputKeys(
		inputs: JsonRecord,
		prefix: string,
		blockType: string,
		allowEmpty = false,
		allowGaps = false,
	): string[] {
		const matcher = new RegExp(`^${prefix}\\d+$`);
		const keys = Object.keys(inputs)
			.filter((key) => matcher.test(key))
			.sort((a, b) => Number(a.slice(prefix.length)) - Number(b.slice(prefix.length)));
		if (
			(!allowEmpty && keys.length === 0) ||
			keys.some((key, index) => {
				const numericIndex = Number(key.slice(prefix.length));
				return key !== `${prefix}${numericIndex}` || (!allowGaps && numericIndex !== index);
			})
		)
			this.fail(`${blockType} inputs are malformed`);
		return keys;
	}

	private pathRead(receiver: string, path: string): string {
		const read = path
			.split('.')
			.map((segment) => `[${JSON.stringify(segment)}]`)
			.join('?.');
		return `${receiver}?.${read}`;
	}

	private pathAssignment(receiver: string, path: string, value: string, padding: string): string[] {
		const segments = path.split('.');
		if (segments.length === 1) {
			return [`${padding}${this.pathAccess(receiver, segments)} = ${value};`];
		}

		const lines: string[] = [];
		for (let index = 1; index < segments.length; index += 1) {
			const target = this.pathAccess(receiver, segments.slice(0, index));
			lines.push(
				`${padding}${target} = typeof ${target} === 'object' && ${target} !== null && !Array.isArray(${target}) ? { ...${target} } : {};`,
			);
		}
		lines.push(`${padding}${this.pathAccess(receiver, segments)} = ${value};`);
		return lines;
	}

	private pathDeletion(receiver: string, path: string, padding: string): string[] {
		const segments = path.split('.');
		if (segments.length === 1) {
			return [`${padding}delete ${this.pathAccess(receiver, segments)};`];
		}

		const parentSegments = segments.slice(0, -1);
		const conditions = parentSegments.flatMap((_, index) => {
			const target = this.pathAccess(receiver, parentSegments.slice(0, index + 1));
			return [`typeof ${target} === 'object'`, `${target} !== null`, `!Array.isArray(${target})`];
		});
		const lines = [`${padding}if (${conditions.join(' && ')}) {`];
		for (let index = 1; index <= parentSegments.length; index += 1) {
			const target = this.pathAccess(receiver, parentSegments.slice(0, index));
			lines.push(`${padding}\t${target} = { ...${target} };`);
		}
		lines.push(`${padding}\tdelete ${this.pathAccess(receiver, segments)};`);
		lines.push(`${padding}}`);
		return lines;
	}

	private pathAccess(receiver: string, segments: string[]): string {
		return `${receiver}${segments.map((segment) => `[${JSON.stringify(segment)}]`).join('')}`;
	}

	private itemCount(block: Block): number | undefined {
		if (!('extraState' in block)) return undefined;
		if (!isRecord(block.extraState)) this.fail(`${block.type} extraState is malformed`);
		const itemCount = block.extraState.itemCount;
		if (
			typeof itemCount !== 'number' ||
			!Number.isInteger(itemCount) ||
			itemCount < 0 ||
			itemCount > MAX_BLOCKS
		)
			this.fail(`${block.type} itemCount is malformed`);
		return itemCount;
	}

	private validateItemCount(block: Block, connectedItemCount: number): void {
		const itemCount = this.itemCount(block);
		if (itemCount !== undefined && itemCount !== connectedItemCount)
			this.fail(`${block.type} contains an empty or unexpected item input`);
	}

	private block(value: unknown, depth: number): Block {
		if (depth > MAX_DEPTH) this.fail('Block depth exceeds 40');
		if (!isBlock(value)) this.fail('Block is malformed');
		const operation = this.operationsByBlockType.get(value.type);
		if (!supportedTypes.has(value.type) && !operation) {
			if (value.type.startsWith('n8n_operation_')) {
				const fields = this.operationFields(value);
				const logicalIdentity = this.operationLogicalIdentity(fields.OPERATION_REF, fields.VERSION);
				const logicalOperation = this.operationsByLogicalIdentity.get(logicalIdentity);
				if (logicalOperation !== undefined) {
					this.fail(
						logicalOperation.implementationRef !== fields.IMPLEMENTATION_REF
							? `OPERATION_BLOCK_IDENTITY_MISMATCH: ${value.type} IMPLEMENTATION_REF does not match any catalog module for ${logicalIdentity}`
							: `OPERATION_BLOCK_IDENTITY_MISMATCH: ${value.type} block type does not match its exact catalog identity`,
					);
				}
				this.fail(`OPERATION_MODULE_MISSING: no catalog module matches block type ${value.type}`);
			}
			this.fail(`Unsupported block type: ${value.type}`);
		}
		if (this.visited.has(value))
			this.fail('Workspace contains a block cycle or duplicate reference');
		this.visited.add(value);
		this.blockCount += 1;
		if (this.blockCount > MAX_BLOCKS) this.fail('Workspace exceeds 200 blocks');
		const inputs = this.inputs(value);
		const permittedInputs = operation?.allowedInputs ?? allowedInputs[value.type];
		if (operation) {
			const inputKeys = Object.keys(inputs).sort();
			const expectedInputKeys = [...permittedInputs].sort();
			if (
				inputKeys.length !== expectedInputKeys.length ||
				inputKeys.some((key, index) => key !== expectedInputKeys[index])
			) {
				this.fail(
					`OPERATION_ARGUMENTS_INVALID: ${value.type} requires exactly ${expectedInputKeys.join(', ') || 'zero arguments'}`,
				);
			}
			this.operationFields(value);
		} else if (value.type === 'text_join' || value.type === 'lists_create_with') {
			if (Object.keys(inputs).some((key) => !/^ADD\d+$/.test(key)))
				this.fail(`${value.type} inputs are malformed`);
		} else if (Object.keys(inputs).some((key) => !permittedInputs.includes(key))) {
			this.fail(`${value.type} contains an unsupported input`);
		}
		if (!chainedTypes.has(value.type) && 'next' in value)
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

	private safeObjectKey(value: string | number): string {
		if (
			typeof value !== 'string' ||
			value.length === 0 ||
			value.length > MAX_PATH_LENGTH ||
			value.includes('.') ||
			dangerousSegments.has(value)
		) {
			this.fail('Object key must be one safe segment of 1 to 128 characters');
		}
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

function errorMessage(
	error: unknown,
	defaultMessage = 'Operation catalog validation failed',
): string {
	if (!(error instanceof Error)) return defaultMessage;
	const code = (error as Error & { code?: unknown }).code;
	return typeof code === 'string' ? `${code}: ${error.message}` : error.message;
}
