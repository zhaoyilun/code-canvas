import type {
	DiagnosticV1,
	LogicExpressionV1,
	LogicNodeDraftV1,
	LogicStatementV1,
	SourceSpanV1,
} from '@n8n/dual-canvas-core';
import ts from 'typescript';

import type { TypeScriptImportRequestV1 } from './contracts';
import { MissingOperationDiscovery, staticQualifiedCallName } from './operation-discovery';
import { diagnosticForNode, diagnosticForRange, sourceSpanForNode } from './source-location';

export type ParsedTeachingProgram = {
	logic: LogicNodeDraftV1;
	entrySpan: SourceSpanV1;
	outputInitializationSpan: SourceSpanV1;
	returnSpan: SourceSpanV1;
};

export type TeachingProgramParseResult =
	| { ok: true; parsed: ParsedTeachingProgram }
	| { ok: false; diagnostics: DiagnosticV1[] };

export type TeachingProgramParseRequestV1 = Pick<
	TypeScriptImportRequestV1,
	'documentRef' | 'revisionRef' | 'entryFunction' | 'source'
>;

export function parseTeachingProgram(
	request: TeachingProgramParseRequestV1,
	logicNodeRef: string,
	logicLabel = 'Imported data transform',
): TeachingProgramParseResult {
	const sourceFile = createTeachingSourceFile(request);
	const parseDiagnostics = getSyntacticDiagnostics(
		sourceFile,
		request.source.language === 'javascript',
	).map((diagnostic) =>
		diagnosticForRange(
			'SOURCE_PARSE_ERROR',
			ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'),
			sourceFile,
			request.source.sourceRef,
			diagnostic.start ?? 0,
			diagnostic.length ?? 0,
		),
	);
	if (parseDiagnostics.length > 0) return { ok: false, diagnostics: parseDiagnostics };

	const entryFunctions = sourceFile.statements.filter(
		(statement): statement is ts.FunctionDeclaration =>
			ts.isFunctionDeclaration(statement) && statement.name?.text === request.entryFunction,
	);
	if (entryFunctions.length !== 1) {
		return {
			ok: false,
			diagnostics: [
				diagnosticForRange(
					entryFunctions.length === 0 ? 'ENTRY_FUNCTION_MISSING' : 'ENTRY_FUNCTION_AMBIGUOUS',
					entryFunctions.length === 0
						? `Expected one function named "${request.entryFunction}"`
						: `Function "${request.entryFunction}" is declared more than once`,
					sourceFile,
					request.source.sourceRef,
					0,
					0,
				),
			],
		};
	}

	const entryFunction = entryFunctions[0];
	if (entryFunction === undefined) throw new Error('validated entry function is missing');
	const shapeDiagnostics = validateProgramShape(sourceFile, request, entryFunction);
	if (shapeDiagnostics.length > 0) return { ok: false, diagnostics: shapeDiagnostics };
	if (entryFunction.body === undefined) throw new Error('validated entry function has no body');
	const parameter = entryFunction.parameters[0];
	if (parameter === undefined || !ts.isIdentifier(parameter.name)) {
		throw new Error('validated entry function parameter is missing');
	}

	const bodyStatements = entryFunction.body.statements;
	const outputDeclaration = bodyStatements[0];
	const returnStatement = bodyStatements.at(-1);
	if (outputDeclaration === undefined || returnStatement === undefined) {
		throw new Error('validated entry function body is incomplete');
	}
	const outputMode = outputModeFromDeclaration(outputDeclaration, parameter.name.text);
	if (outputMode === undefined) throw new Error('validated output declaration is malformed');

	const translator = new TeachingAstTranslator(
		sourceFile,
		request.source.sourceRef,
		parameter.name.text,
		request.documentRef,
		request.revisionRef,
	);
	const statements = translator.translateStatements(bodyStatements.slice(1, -1));
	translator.completeDiscovery();
	if (translator.diagnostics.length > 0) {
		return { ok: false, diagnostics: translator.diagnostics };
	}
	if (statements.length === 0) {
		return {
			ok: false,
			diagnostics: [
				diagnosticForNode(
					'PROGRAM_HAS_NO_LOGIC',
					'The entry function requires at least one supported logic statement',
					sourceFile,
					request.source.sourceRef,
					entryFunction.body,
				),
			],
		};
	}

	return {
		ok: true,
		parsed: {
			logic: {
				nodeRef: logicNodeRef,
				label: logicLabel,
				outputMode,
				statements,
			},
			entrySpan: sourceSpanForNode(sourceFile, request.source.sourceRef, entryFunction),
			outputInitializationSpan: sourceSpanForNode(
				sourceFile,
				request.source.sourceRef,
				outputDeclaration,
			),
			returnSpan: sourceSpanForNode(sourceFile, request.source.sourceRef, returnStatement),
		},
	};
}

function createTeachingSourceFile(request: TeachingProgramParseRequestV1): ts.SourceFile {
	const extension =
		request.source.language === 'javascript'
			? 'js'
			: request.source.language === 'arkts'
				? 'ets'
				: 'ts';
	return ts.createSourceFile(
		`source.${extension}`,
		request.source.content,
		ts.ScriptTarget.Latest,
		true,
		request.source.language === 'javascript' ? ts.ScriptKind.JS : ts.ScriptKind.TS,
	);
}

function getSyntacticDiagnostics(
	sourceFile: ts.SourceFile,
	isJavaScript: boolean,
): readonly ts.Diagnostic[] {
	const options: ts.CompilerOptions = {
		allowJs: isJavaScript,
		checkJs: false,
		module: ts.ModuleKind.ESNext,
		noLib: true,
		noResolve: true,
		target: ts.ScriptTarget.ESNext,
	};
	const defaultHost = ts.createCompilerHost(options, true);
	const host: ts.CompilerHost = {
		...defaultHost,
		fileExists: (fileName) => fileName === sourceFile.fileName,
		getSourceFile: (fileName) => (fileName === sourceFile.fileName ? sourceFile : undefined),
		readFile: (fileName) => (fileName === sourceFile.fileName ? sourceFile.text : undefined),
	};
	return ts
		.createProgram({ rootNames: [sourceFile.fileName], options, host })
		.getSyntacticDiagnostics(sourceFile);
}

function validateProgramShape(
	sourceFile: ts.SourceFile,
	request: TeachingProgramParseRequestV1,
	entryFunction: ts.FunctionDeclaration,
): DiagnosticV1[] {
	const diagnostics: DiagnosticV1[] = [];
	for (const statement of sourceFile.statements) {
		if (
			statement === entryFunction ||
			ts.isInterfaceDeclaration(statement) ||
			ts.isTypeAliasDeclaration(statement) ||
			ts.isEmptyStatement(statement)
		) {
			continue;
		}
		diagnostics.push(
			diagnosticForNode(
				'UNSUPPORTED_TOP_LEVEL_SYNTAX',
				'Only the selected entry function and type-only declarations are supported',
				sourceFile,
				request.source.sourceRef,
				statement,
			),
		);
	}

	if (entryFunction.body === undefined) {
		diagnostics.push(
			diagnosticForNode(
				'ENTRY_FUNCTION_BODY_REQUIRED',
				'The entry function requires an implementation body',
				sourceFile,
				request.source.sourceRef,
				entryFunction,
			),
		);
		return diagnostics;
	}
	if (entryFunction.asteriskToken !== undefined || entryFunction.typeParameters !== undefined) {
		diagnostics.push(
			diagnosticForNode(
				'ENTRY_FUNCTION_SHAPE_INVALID',
				'Generator and generic entry functions are outside the teaching subset',
				sourceFile,
				request.source.sourceRef,
				entryFunction,
			),
		);
	}
	if (entryFunction.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.AsyncKeyword)) {
		diagnostics.push(
			diagnosticForNode(
				'ENTRY_FUNCTION_SHAPE_INVALID',
				'Async entry functions are outside the teaching subset',
				sourceFile,
				request.source.sourceRef,
				entryFunction,
			),
		);
	}
	if (
		entryFunction.parameters.length !== 1 ||
		entryFunction.parameters[0] === undefined ||
		!ts.isIdentifier(entryFunction.parameters[0].name) ||
		entryFunction.parameters[0].dotDotDotToken !== undefined ||
		entryFunction.parameters[0].initializer !== undefined
	) {
		diagnostics.push(
			diagnosticForNode(
				'ENTRY_PARAMETER_INVALID',
				'The entry function requires one plain input parameter',
				sourceFile,
				request.source.sourceRef,
				entryFunction,
			),
		);
		return diagnostics;
	}

	const bodyStatements = entryFunction.body.statements;
	const outputDeclaration = bodyStatements[0];
	if (
		outputDeclaration === undefined ||
		outputModeFromDeclaration(outputDeclaration, entryFunction.parameters[0].name.text) ===
			undefined
	) {
		diagnostics.push(
			diagnosticForNode(
				'OUTPUT_INITIALIZER_INVALID',
				'The first statement must be `const output = { ...input };` or `const output = {};`',
				sourceFile,
				request.source.sourceRef,
				outputDeclaration ?? entryFunction.body,
			),
		);
	}

	const returnStatement = bodyStatements.at(-1);
	if (
		returnStatement === undefined ||
		!ts.isReturnStatement(returnStatement) ||
		returnStatement.expression === undefined ||
		!ts.isIdentifier(returnStatement.expression) ||
		returnStatement.expression.text !== 'output'
	) {
		diagnostics.push(
			diagnosticForNode(
				'OUTPUT_RETURN_INVALID',
				'The final statement must be `return output;`',
				sourceFile,
				request.source.sourceRef,
				returnStatement ?? entryFunction.body,
			),
		);
	}
	return diagnostics;
}

function outputModeFromDeclaration(
	statement: ts.Statement,
	inputName: string,
): LogicNodeDraftV1['outputMode'] | undefined {
	if (
		!ts.isVariableStatement(statement) ||
		(statement.declarationList.flags & ts.NodeFlags.Const) === 0 ||
		statement.declarationList.declarations.length !== 1
	) {
		return undefined;
	}
	const declaration = statement.declarationList.declarations[0];
	if (
		declaration === undefined ||
		!ts.isIdentifier(declaration.name) ||
		declaration.name.text !== 'output' ||
		declaration.initializer === undefined ||
		!ts.isObjectLiteralExpression(unwrapTypeOnlyExpression(declaration.initializer))
	) {
		return undefined;
	}
	const initializer = unwrapTypeOnlyExpression(declaration.initializer);
	if (!ts.isObjectLiteralExpression(initializer)) return undefined;
	const properties = initializer.properties;
	if (properties.length === 0) return 'empty';
	if (
		properties.length === 1 &&
		properties[0] !== undefined &&
		ts.isSpreadAssignment(properties[0]) &&
		ts.isIdentifier(properties[0].expression) &&
		properties[0].expression.text === inputName
	) {
		return 'copyInput';
	}
	return undefined;
}

class TeachingAstTranslator {
	readonly diagnostics: DiagnosticV1[] = [];
	private readonly stepRefs = new Map<string, number>();
	private readonly missingOperations: MissingOperationDiscovery;

	constructor(
		private readonly sourceFile: ts.SourceFile,
		private readonly sourceRef: string,
		private readonly inputName: string,
		documentRef: string,
		revisionRef: string,
	) {
		this.missingOperations = new MissingOperationDiscovery(
			sourceFile,
			sourceRef,
			documentRef,
			revisionRef,
		);
	}

	completeDiscovery(): void {
		this.diagnostics.push(...this.missingOperations.createDiagnostics());
	}

	translateStatements(statements: readonly ts.Statement[]): LogicStatementV1[] {
		const translated: LogicStatementV1[] = [];
		for (const statement of statements) {
			if (ts.isEmptyStatement(statement)) continue;
			const result = this.translateStatement(statement);
			if (result !== undefined) translated.push(result);
		}
		return translated;
	}

	private translateStatement(statement: ts.Statement): LogicStatementV1 | undefined {
		if (ts.isIfStatement(statement)) {
			const assertion = throwingAssertionParts(statement);
			return assertion === undefined
				? this.translateIf(statement)
				: this.translateThrowingAssertion(statement, assertion);
		}
		if (!ts.isExpressionStatement(statement)) {
			this.unsupported(statement, 'This statement is outside the teaching subset');
			return undefined;
		}
		const expression = statement.expression;
		if (ts.isDeleteExpression(expression)) return this.translateDelete(statement, expression);
		if (
			ts.isBinaryExpression(expression) &&
			expression.operatorToken.kind === ts.SyntaxKind.EqualsToken
		) {
			return this.translateAssignment(statement, expression);
		}
		if (ts.isCallExpression(expression) && isAssertCall(expression.expression)) {
			this.semanticMismatch(
				expression,
				'Assertion calls do not have the throwing semantics of the generated Blockly validation; use `if (!condition) { throw new Error(message); }`',
			);
			return undefined;
		}
		this.unsupported(
			statement,
			'Only assignments, deletes, assertions, and branches are supported',
		);
		return undefined;
	}

	private translateAssignment(
		statement: ts.ExpressionStatement,
		expression: ts.BinaryExpression,
	): LogicStatementV1 | undefined {
		const targetField = memberPathFromRoot(expression.left, 'output');
		if (targetField === undefined || targetField.length === 0 || !isSafePath(targetField)) {
			this.unsupported(expression.left, 'Assignments must target a field below `output`');
			return undefined;
		}
		if (targetField.length !== 1) {
			this.semanticMismatch(
				expression.left,
				'Nested output assignment is not source-equivalent because the Blockly runtime creates and clones parent objects',
			);
			return undefined;
		}
		const value = this.translateExpression(expression.right);
		if (value === undefined) return undefined;
		return {
			kind: 'set',
			stepRef: this.stepRef(statement, 'set'),
			targetField: targetField.join('.'),
			value,
			source: sourceSpanForNode(this.sourceFile, this.sourceRef, statement),
		};
	}

	private translateDelete(
		statement: ts.ExpressionStatement,
		expression: ts.DeleteExpression,
	): LogicStatementV1 | undefined {
		const targetField = memberPathFromRoot(expression.expression, 'output');
		if (targetField === undefined || targetField.length === 0 || !isSafePath(targetField)) {
			this.unsupported(expression, 'Delete must target a field below `output`');
			return undefined;
		}
		if (targetField.length !== 1) {
			this.semanticMismatch(
				expression.expression,
				'Nested output deletion is not source-equivalent because the Blockly runtime guards and clones parent objects',
			);
			return undefined;
		}
		return {
			kind: 'delete',
			stepRef: this.stepRef(statement, 'delete'),
			targetField: targetField.join('.'),
			source: sourceSpanForNode(this.sourceFile, this.sourceRef, statement),
		};
	}

	private translateThrowingAssertion(
		statement: ts.IfStatement,
		assertion: ThrowingAssertionParts,
	): LogicStatementV1 | undefined {
		const condition = this.translateExpression(assertion.condition);
		const message = this.translateExpression(assertion.message);
		if (condition === undefined || message === undefined) return undefined;
		return {
			kind: 'assert',
			stepRef: this.stepRef(statement, 'assert'),
			condition,
			message,
			source: sourceSpanForNode(this.sourceFile, this.sourceRef, statement),
		};
	}

	private translateIf(statement: ts.IfStatement): LogicStatementV1 | undefined {
		const condition = this.translateExpression(statement.expression);
		const thenBranch = this.translateBranch(statement.thenStatement);
		const elseBranch =
			statement.elseStatement === undefined ? [] : this.translateBranch(statement.elseStatement);
		if (condition === undefined) return undefined;
		if (thenBranch.length === 0 && elseBranch.length === 0) {
			this.unsupported(statement, 'If requires at least one supported branch statement');
			return undefined;
		}
		return {
			kind: 'if',
			stepRef: this.stepRef(statement, 'if'),
			condition,
			then: thenBranch,
			else: elseBranch,
			source: sourceSpanForNode(this.sourceFile, this.sourceRef, statement),
		};
	}

	private translateBranch(statement: ts.Statement): LogicStatementV1[] {
		return ts.isBlock(statement)
			? this.translateStatements(statement.statements)
			: this.translateStatements([statement]);
	}

	private translateExpression(expression: ts.Expression): LogicExpressionV1 | undefined {
		const unwrapped = unwrapTypeOnlyExpression(expression);
		if (unwrapped !== expression) return this.translateExpression(unwrapped);
		const normalizedInputPath = nullNormalizedOptionalInputPath(expression, this.inputName);
		if (normalizedInputPath !== undefined) {
			return { kind: 'input', path: normalizedInputPath.join('.') };
		}
		if (ts.isNumericLiteral(expression)) return { kind: 'number', value: Number(expression.text) };
		if (ts.isStringLiteralLike(expression)) return { kind: 'text', value: expression.text };
		if (expression.kind === ts.SyntaxKind.TrueKeyword) return { kind: 'boolean', value: true };
		if (expression.kind === ts.SyntaxKind.FalseKeyword) return { kind: 'boolean', value: false };
		if (expression.kind === ts.SyntaxKind.NullKeyword) {
			this.semanticMismatch(
				expression,
				'Null literals are only accepted as the right side of an optional input read normalized with `?? null`',
			);
			return undefined;
		}
		if (ts.isPrefixUnaryExpression(expression)) return this.translatePrefix(expression);
		if (ts.isBinaryExpression(expression)) return this.translateBinary(expression);
		if (ts.isConditionalExpression(expression)) return this.translateConditional(expression);
		if (ts.isArrayLiteralExpression(expression)) return this.translateArray(expression);
		if (ts.isObjectLiteralExpression(expression)) return this.translateObject(expression);
		if (ts.isCallExpression(expression)) return this.translateConversion(expression);
		if (ts.isPropertyAccessExpression(expression) || ts.isElementAccessExpression(expression)) {
			return this.translateMemberRead(expression);
		}
		this.unsupported(expression, 'This expression is outside the teaching subset');
		return undefined;
	}

	private translatePrefix(expression: ts.PrefixUnaryExpression): LogicExpressionV1 | undefined {
		if (expression.operator === ts.SyntaxKind.ExclamationToken) {
			const value = this.translateExpression(expression.operand);
			return value === undefined ? undefined : { kind: 'not', value };
		}
		if (
			(expression.operator === ts.SyntaxKind.MinusToken ||
				expression.operator === ts.SyntaxKind.PlusToken) &&
			ts.isNumericLiteral(expression.operand)
		) {
			const value = Number(expression.operand.text);
			return {
				kind: 'number',
				value: expression.operator === ts.SyntaxKind.MinusToken ? -value : value,
			};
		}
		this.unsupported(expression, 'Only boolean negation and signed numeric literals are supported');
		return undefined;
	}

	private translateBinary(expression: ts.BinaryExpression): LogicExpressionV1 | undefined {
		if (expression.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken) {
			this.semanticMismatch(
				expression,
				'Nullish coalescing is only accepted in the exact form `input?.field ?? null` with every path segment optional',
			);
			return undefined;
		}
		const left = this.translateExpression(expression.left);
		const right = this.translateExpression(expression.right);
		if (left === undefined || right === undefined) return undefined;
		const arithmetic = arithmeticOperators.get(expression.operatorToken.kind);
		if (arithmetic !== undefined) return { kind: 'arithmetic', op: arithmetic, left, right };
		const comparison = comparisonOperators.get(expression.operatorToken.kind);
		if (comparison !== undefined) return { kind: 'compare', op: comparison, left, right };
		const booleanOperation = booleanOperators.get(expression.operatorToken.kind);
		if (booleanOperation !== undefined) {
			return { kind: 'booleanOperation', op: booleanOperation, left, right };
		}
		this.unsupported(
			expression.operatorToken,
			'This binary operator is outside the teaching subset',
		);
		return undefined;
	}

	private translateConditional(
		expression: ts.ConditionalExpression,
	): LogicExpressionV1 | undefined {
		const condition = this.translateExpression(expression.condition);
		const whenTrue = this.translateExpression(expression.whenTrue);
		const whenFalse = this.translateExpression(expression.whenFalse);
		if (condition === undefined || whenTrue === undefined || whenFalse === undefined) {
			return undefined;
		}
		return { kind: 'conditional', condition, whenTrue, whenFalse };
	}

	private translateArray(expression: ts.ArrayLiteralExpression): LogicExpressionV1 | undefined {
		const values: LogicExpressionV1[] = [];
		for (const element of expression.elements) {
			if (ts.isSpreadElement(element) || ts.isOmittedExpression(element)) {
				this.unsupported(
					element,
					'Array spreads and empty elements are outside the teaching subset',
				);
				continue;
			}
			const value = this.translateExpression(element);
			if (value !== undefined) values.push(value);
		}
		return values.length === expression.elements.length ? { kind: 'array', values } : undefined;
	}

	private translateObject(expression: ts.ObjectLiteralExpression): LogicExpressionV1 | undefined {
		const properties: Array<{ key: string; value: LogicExpressionV1 }> = [];
		for (const property of expression.properties) {
			if (!ts.isPropertyAssignment(property)) {
				this.unsupported(property, 'Only explicit object properties are supported');
				continue;
			}
			const key = propertyName(property.name);
			if (key === undefined || !isSafePathSegment(key)) {
				this.unsupported(property.name, 'Object keys must be safe static property names');
				continue;
			}
			const value = this.translateExpression(property.initializer);
			if (value !== undefined) properties.push({ key, value });
		}
		return properties.length === expression.properties.length
			? { kind: 'object', properties }
			: undefined;
	}

	private translateConversion(expression: ts.CallExpression): LogicExpressionV1 | undefined {
		const conversionName = ts.isIdentifier(expression.expression)
			? expression.expression.text
			: undefined;
		const conversion =
			conversionName === undefined ? undefined : conversionFunctions.get(conversionName);
		if (conversion === undefined) {
			const qualifiedName =
				expression.questionDotToken === undefined
					? staticQualifiedCallName(expression.expression)
					: undefined;
			if (qualifiedName === undefined) {
				this.unsupported(
					expression,
					'Dynamic, computed, optional, and call-result invocations are outside operation discovery',
				);
			} else if (!this.missingOperations.record(expression, qualifiedName)) {
				this.unsupported(expression, 'Static operation call exceeds discovery contract limits');
			}
			this.discoverNestedOperationCalls(expression.arguments);
			return undefined;
		}
		if (expression.arguments.length !== 1) {
			this.unsupported(expression, 'Number, String, and Boolean conversions require one argument');
			return undefined;
		}
		const argument = expression.arguments[0];
		if (argument === undefined) throw new Error('validated conversion argument is missing');
		if (conversion !== 'boolean' && !isSourceEquivalentPrimitiveConversion(argument, conversion)) {
			this.semanticMismatch(
				expression,
				`${conversionName} conversion is only source-equivalent for supported primitive literals`,
			);
			return undefined;
		}
		const value = this.translateExpression(argument);
		return value === undefined ? undefined : { kind: 'convert', to: conversion, value };
	}

	private discoverNestedOperationCalls(nodes: readonly ts.Node[]): void {
		for (const node of nodes) this.discoverNestedOperationCallsInNode(node);
	}

	private discoverNestedOperationCallsInNode(node: ts.Node): void {
		if (ts.isCallExpression(node)) {
			const conversionName = ts.isIdentifier(node.expression) ? node.expression.text : undefined;
			if (conversionName !== undefined && conversionFunctions.has(conversionName)) {
				if (node.arguments.length !== 1) {
					this.unsupported(node, 'Number, String, and Boolean conversions require one argument');
					return;
				}
				this.discoverNestedOperationCalls(node.arguments);
				return;
			}

			const qualifiedName =
				node.questionDotToken === undefined ? staticQualifiedCallName(node.expression) : undefined;
			if (qualifiedName === undefined) {
				this.unsupported(
					node,
					'Dynamic, computed, optional, and call-result invocations are outside operation discovery',
				);
				return;
			}
			if (!this.missingOperations.record(node, qualifiedName)) {
				this.unsupported(node, 'Static operation call exceeds discovery contract limits');
			}
			this.discoverNestedOperationCalls(node.arguments);
			return;
		}
		ts.forEachChild(node, (child) => this.discoverNestedOperationCallsInNode(child));
	}

	private translateMemberRead(
		expression: ts.PropertyAccessExpression | ts.ElementAccessExpression,
	): LogicExpressionV1 | undefined {
		const inputPath = memberPathFromRoot(expression, this.inputName);
		if (inputPath !== undefined) {
			this.semanticMismatch(
				expression,
				'Input reads must normalize missing and null values with the exact form `input?.field ?? null`',
			);
			return undefined;
		}
		if (ts.isElementAccessExpression(expression)) {
			const argument = expression.argumentExpression;
			this.semanticMismatch(
				expression,
				argument !== undefined && isNegativeNumericLiteral(argument)
					? 'Negative bracket indexes use property lookup in JavaScript but relative indexing in the Blockly runtime'
					: 'Bracket indexing is outside the source-equivalent version-one subset',
			);
			return undefined;
		}
		this.semanticMismatch(
			expression,
			'Property reads outside a null-normalized optional input path are outside the source-equivalent version-one subset',
		);
		return undefined;
	}

	private stepRef(node: ts.Node, kind: string): string {
		const start = node.getStart(this.sourceFile);
		const position = this.sourceFile.getLineAndCharacterOfPosition(start);
		const base = `step.${position.line + 1}.${position.character}.${kind}`;
		const count = (this.stepRefs.get(base) ?? 0) + 1;
		this.stepRefs.set(base, count);
		return count === 1 ? base : `${base}.${count}`;
	}

	private unsupported(node: ts.Node, message: string): void {
		this.diagnostics.push(
			diagnosticForNode(
				'UNSUPPORTED_SYNTAX',
				`${message}: ${ts.SyntaxKind[node.kind]}`,
				this.sourceFile,
				this.sourceRef,
				node,
			),
		);
	}

	private semanticMismatch(node: ts.Node, message: string): void {
		this.diagnostics.push(
			diagnosticForNode(
				'SOURCE_SEMANTICS_MISMATCH',
				message,
				this.sourceFile,
				this.sourceRef,
				node,
			),
		);
	}
}

const arithmeticOperators = new Map<
	ts.SyntaxKind,
	'add' | 'subtract' | 'multiply' | 'divide' | 'power'
>([
	[ts.SyntaxKind.PlusToken, 'add'],
	[ts.SyntaxKind.MinusToken, 'subtract'],
	[ts.SyntaxKind.AsteriskToken, 'multiply'],
	[ts.SyntaxKind.SlashToken, 'divide'],
	[ts.SyntaxKind.AsteriskAsteriskToken, 'power'],
]);

const comparisonOperators = new Map<ts.SyntaxKind, 'eq' | 'neq' | 'lt' | 'lte' | 'gt' | 'gte'>([
	[ts.SyntaxKind.EqualsEqualsEqualsToken, 'eq'],
	[ts.SyntaxKind.ExclamationEqualsEqualsToken, 'neq'],
	[ts.SyntaxKind.LessThanToken, 'lt'],
	[ts.SyntaxKind.LessThanEqualsToken, 'lte'],
	[ts.SyntaxKind.GreaterThanToken, 'gt'],
	[ts.SyntaxKind.GreaterThanEqualsToken, 'gte'],
]);

const booleanOperators = new Map<ts.SyntaxKind, 'and' | 'or'>([
	[ts.SyntaxKind.AmpersandAmpersandToken, 'and'],
	[ts.SyntaxKind.BarBarToken, 'or'],
]);

const conversionFunctions = new Map<string, 'text' | 'number' | 'boolean'>([
	['String', 'text'],
	['Number', 'number'],
	['Boolean', 'boolean'],
]);

function unwrapTypeOnlyExpression(expression: ts.Expression): ts.Expression {
	if (
		ts.isParenthesizedExpression(expression) ||
		ts.isAsExpression(expression) ||
		ts.isTypeAssertionExpression(expression) ||
		ts.isNonNullExpression(expression) ||
		ts.isSatisfiesExpression(expression)
	) {
		return expression.expression;
	}
	return expression;
}

function memberPathFromRoot(expression: ts.Expression, rootName: string): string[] | undefined {
	const unwrapped = unwrapTypeOnlyExpression(expression);
	if (ts.isIdentifier(unwrapped)) return unwrapped.text === rootName ? [] : undefined;
	if (ts.isPropertyAccessExpression(unwrapped)) {
		const parent = memberPathFromRoot(unwrapped.expression, rootName);
		return parent === undefined || !isSafePathSegment(unwrapped.name.text)
			? undefined
			: [...parent, unwrapped.name.text];
	}
	if (ts.isElementAccessExpression(unwrapped) && unwrapped.argumentExpression !== undefined) {
		const key = staticElementKey(unwrapped.argumentExpression);
		const parent = memberPathFromRoot(unwrapped.expression, rootName);
		return key === undefined || parent === undefined || !isSafePathSegment(key)
			? undefined
			: [...parent, key];
	}
	return undefined;
}

function nullNormalizedOptionalInputPath(
	expression: ts.Expression,
	rootName: string,
): string[] | undefined {
	const unwrapped = unwrapTypeOnlyExpression(expression);
	if (
		!ts.isBinaryExpression(unwrapped) ||
		unwrapped.operatorToken.kind !== ts.SyntaxKind.QuestionQuestionToken ||
		unwrapTypeOnlyExpression(unwrapped.right).kind !== ts.SyntaxKind.NullKeyword
	) {
		return undefined;
	}
	const path = fullyOptionalMemberPathFromRoot(unwrapped.left, rootName);
	return path !== undefined && path.length > 0 && isSafePath(path) ? path : undefined;
}

function fullyOptionalMemberPathFromRoot(
	expression: ts.Expression,
	rootName: string,
): string[] | undefined {
	const unwrapped = unwrapTypeOnlyExpression(expression);
	if (ts.isIdentifier(unwrapped)) return unwrapped.text === rootName ? [] : undefined;
	if (ts.isPropertyAccessExpression(unwrapped)) {
		if (unwrapped.questionDotToken === undefined) return undefined;
		const parent = fullyOptionalMemberPathFromRoot(unwrapped.expression, rootName);
		return parent === undefined || !isSafePathSegment(unwrapped.name.text)
			? undefined
			: [...parent, unwrapped.name.text];
	}
	if (ts.isElementAccessExpression(unwrapped) && unwrapped.argumentExpression !== undefined) {
		if (unwrapped.questionDotToken === undefined) return undefined;
		const key = staticElementKey(unwrapped.argumentExpression);
		const parent = fullyOptionalMemberPathFromRoot(unwrapped.expression, rootName);
		return key === undefined || parent === undefined || !isSafePathSegment(key)
			? undefined
			: [...parent, key];
	}
	return undefined;
}

function isSourceEquivalentPrimitiveConversion(
	expression: ts.Expression,
	conversion: 'text' | 'number',
): boolean {
	const unwrapped = unwrapTypeOnlyExpression(expression);
	if (
		ts.isNumericLiteral(unwrapped) ||
		unwrapped.kind === ts.SyntaxKind.TrueKeyword ||
		unwrapped.kind === ts.SyntaxKind.FalseKeyword ||
		isSignedNumericLiteral(unwrapped)
	) {
		return true;
	}
	if (!ts.isStringLiteralLike(unwrapped)) return false;
	return (
		conversion === 'text' || (unwrapped.text.length > 0 && Number.isFinite(Number(unwrapped.text)))
	);
}

function isSignedNumericLiteral(expression: ts.Expression): boolean {
	return (
		ts.isPrefixUnaryExpression(expression) &&
		(expression.operator === ts.SyntaxKind.MinusToken ||
			expression.operator === ts.SyntaxKind.PlusToken) &&
		ts.isNumericLiteral(expression.operand)
	);
}

function isNegativeNumericLiteral(expression: ts.Expression): boolean {
	const unwrapped = unwrapTypeOnlyExpression(expression);
	return (
		ts.isPrefixUnaryExpression(unwrapped) &&
		unwrapped.operator === ts.SyntaxKind.MinusToken &&
		ts.isNumericLiteral(unwrapped.operand)
	);
}

function staticElementKey(expression: ts.Expression): string | undefined {
	if (ts.isStringLiteralLike(expression) || ts.isNumericLiteral(expression)) return expression.text;
	return undefined;
}

function propertyName(name: ts.PropertyName): string | undefined {
	if (ts.isIdentifier(name) || ts.isStringLiteralLike(name) || ts.isNumericLiteral(name)) {
		return name.text;
	}
	return undefined;
}

function isSafePathSegment(value: string): boolean {
	return (
		value.length > 0 &&
		value.length <= 128 &&
		!value.includes('.') &&
		value !== '__proto__' &&
		value !== 'prototype' &&
		value !== 'constructor'
	);
}

function isSafePath(segments: string[]): boolean {
	return segments.join('.').length <= 128 && segments.every(isSafePathSegment);
}

function isAssertCall(expression: ts.LeftHandSideExpression): boolean {
	return (
		(ts.isIdentifier(expression) && expression.text === 'assert') ||
		(ts.isPropertyAccessExpression(expression) &&
			ts.isIdentifier(expression.expression) &&
			expression.expression.text === 'console' &&
			expression.name.text === 'assert')
	);
}

type ThrowingAssertionParts = {
	condition: ts.Expression;
	message: ts.Expression;
};

function throwingAssertionParts(statement: ts.IfStatement): ThrowingAssertionParts | undefined {
	if (statement.elseStatement !== undefined) return undefined;
	const condition = unwrapTypeOnlyExpression(statement.expression);
	if (
		!ts.isPrefixUnaryExpression(condition) ||
		condition.operator !== ts.SyntaxKind.ExclamationToken
	) {
		return undefined;
	}
	const bodyStatements = ts.isBlock(statement.thenStatement)
		? statement.thenStatement.statements
		: [statement.thenStatement];
	if (bodyStatements.length !== 1) return undefined;
	const throwing = bodyStatements[0];
	if (
		throwing === undefined ||
		!ts.isThrowStatement(throwing) ||
		throwing.expression === undefined ||
		!ts.isNewExpression(throwing.expression) ||
		!ts.isIdentifier(throwing.expression.expression) ||
		throwing.expression.expression.text !== 'Error' ||
		throwing.expression.arguments?.length !== 1 ||
		throwing.expression.arguments[0] === undefined
	) {
		return undefined;
	}
	return {
		condition: condition.operand,
		message: throwing.expression.arguments[0],
	};
}
