import { createStableId, type DiagnosticV1, type JsonValue } from '@n8n/dual-canvas-core';
import {
	moduleScaffoldRequestV1Schema,
	type ModuleScaffoldRequestV1,
	type OperationCallObservationV1,
} from '@n8n/dual-canvas-operation-sdk';
import ts from 'typescript';

import { sourceSpanForNode } from './source-location';

type MissingOperationGroup = {
	qualifiedName: string;
	arity: number;
	calls: OperationCallObservationV1[];
};

export class MissingOperationDiscovery {
	private readonly groups = new Map<string, MissingOperationGroup>();
	private readonly discoveryScopeRef: string;

	constructor(
		private readonly sourceFile: ts.SourceFile,
		private readonly sourceRef: string,
		private readonly documentRef: string,
		private readonly revisionRef: string,
	) {
		this.discoveryScopeRef = `operation-discovery-${createStableId(
			documentRef,
			`revision:${revisionRef}:source:${sourceRef}`,
		)}`;
	}

	record(call: ts.CallExpression, qualifiedName: string): boolean {
		const arity = call.arguments.length;
		const callText = call.getText(this.sourceFile);
		if (
			qualifiedName.length > 256 ||
			arity > 16 ||
			callText.length > 4096 ||
			call.arguments.some(ts.isSpreadElement) ||
			call.arguments.some((argument) => argument.getText(this.sourceFile).length > 2048)
		) {
			return false;
		}
		const groupKey = `${qualifiedName}\u0000${arity}`;
		const observation: OperationCallObservationV1 = {
			callRef: this.createCallRef(call, qualifiedName),
			callText,
			source: sourceSpanForNode(this.sourceFile, this.sourceRef, call),
			arguments: call.arguments.map((argument, index) =>
				observeArgument(this.sourceFile, this.sourceRef, argument, index),
			),
		};
		const group = this.groups.get(groupKey);
		if (group === undefined) {
			this.groups.set(groupKey, { qualifiedName, arity, calls: [observation] });
		} else {
			if (group.calls.length >= 128) return false;
			group.calls.push(observation);
		}
		return true;
	}

	createCallRef(call: ts.CallExpression, qualifiedName: string): string {
		const requestRef = requestRefFor(this.discoveryScopeRef, qualifiedName, call.arguments.length);
		return `operation-call-${createStableId(
			requestRef,
			`call:${call.getStart(this.sourceFile)}:${call.getEnd()}`,
		)}`;
	}

	createDiagnostics(): DiagnosticV1[] {
		return [...this.groups.values()]
			.sort((left, right) => {
				const leftOffset = left.calls[0]?.source.start.offset ?? 0;
				const rightOffset = right.calls[0]?.source.start.offset ?? 0;
				return (
					leftOffset - rightOffset ||
					left.qualifiedName.localeCompare(right.qualifiedName) ||
					left.arity - right.arity
				);
			})
			.map((group) => {
				const request = createScaffoldRequest(
					this.discoveryScopeRef,
					this.documentRef,
					this.revisionRef,
					this.sourceRef,
					group,
				);
				const firstCall = request.calls[0];
				if (firstCall === undefined) throw new Error('missing operation group has no calls');
				return {
					apiVersion: 1,
					code: 'OPERATION_MODULE_MISSING',
					severity: 'error',
					message: `No admitted operation module matches ${request.qualifiedName}/${request.arity}`,
					path: `source.${firstCall.source.start.line}.${firstCall.source.start.column}`,
					ref: request.requestRef,
					details: request,
				};
			});
	}
}

export function staticQualifiedCallName(
	expression: ts.LeftHandSideExpression,
	runtimeValueRoots: ReadonlySet<string> = new Set(),
): string | undefined {
	if (ts.isIdentifier(expression))
		return isSafeQualifiedSegment(expression.text) && !runtimeValueRoots.has(expression.text)
			? expression.text
			: undefined;
	if (!ts.isPropertyAccessExpression(expression) || expression.questionDotToken !== undefined)
		return undefined;
	const parent = staticQualifiedCallName(expression.expression, runtimeValueRoots);
	return parent === undefined || !isSafeQualifiedSegment(expression.name.text)
		? undefined
		: `${parent}.${expression.name.text}`;
}

function createScaffoldRequest(
	discoveryScopeRef: string,
	documentRef: string,
	revisionRef: string,
	sourceRef: string,
	group: MissingOperationGroup,
): ModuleScaffoldRequestV1 {
	return moduleScaffoldRequestV1Schema.parse({
		apiVersion: 1,
		requestRef: requestRefFor(discoveryScopeRef, group.qualifiedName, group.arity),
		scope: { documentRef, revisionRef, sourceRef },
		qualifiedName: group.qualifiedName,
		arity: group.arity,
		calls: [...group.calls].sort(
			(left, right) => left.source.start.offset - right.source.start.offset,
		),
		requiredDecisions: [
			'behavior',
			'effect',
			'parameter-names',
			'input-types',
			'null-handling',
			'output-type',
			'test-vectors',
		],
	});
}

function requestRefFor(discoveryScopeRef: string, qualifiedName: string, arity: number): string {
	return `module-request-${createStableId(
		discoveryScopeRef,
		`missing-operation:${qualifiedName}/${arity}`,
	)}`;
}

function observeArgument(
	sourceFile: ts.SourceFile,
	sourceRef: string,
	argument: ts.Expression,
	index: number,
): OperationCallObservationV1['arguments'][number] {
	const literal = jsonLiteralValue(argument);
	return {
		index,
		text: argument.getText(sourceFile),
		source: sourceSpanForNode(sourceFile, sourceRef, argument),
		typeHint: literalTypeHint(literal),
		...(literal.known ? { literalValue: literal.value } : {}),
	};
}

type LiteralObservation =
	| { known: true; value: JsonValue }
	| {
			known: false;
			typeHint?: OperationCallObservationV1['arguments'][number]['typeHint'];
	  };

function jsonLiteralValue(expression: ts.Expression, depth = 0): LiteralObservation {
	if (depth > 8) return { known: false };
	if (ts.isStringLiteralLike(expression)) return { known: true, value: expression.text };
	if (ts.isNumericLiteral(expression)) return finiteNumericLiteral(Number(expression.text));
	if (expression.kind === ts.SyntaxKind.TrueKeyword) return { known: true, value: true };
	if (expression.kind === ts.SyntaxKind.FalseKeyword) return { known: true, value: false };
	if (expression.kind === ts.SyntaxKind.NullKeyword) return { known: true, value: null };
	if (
		ts.isPrefixUnaryExpression(expression) &&
		(expression.operator === ts.SyntaxKind.MinusToken ||
			expression.operator === ts.SyntaxKind.PlusToken) &&
		ts.isNumericLiteral(expression.operand)
	) {
		const value = Number(expression.operand.text);
		return finiteNumericLiteral(expression.operator === ts.SyntaxKind.MinusToken ? -value : value);
	}
	if (ts.isParenthesizedExpression(expression))
		return jsonLiteralValue(expression.expression, depth + 1);
	if (ts.isArrayLiteralExpression(expression)) {
		const values: JsonValue[] = [];
		for (const element of expression.elements) {
			if (ts.isSpreadElement(element) || ts.isOmittedExpression(element)) return { known: false };
			const item = jsonLiteralValue(element, depth + 1);
			if (!item.known) return { known: false, typeHint: 'array' };
			values.push(item.value);
		}
		return { known: true, value: values };
	}
	if (ts.isObjectLiteralExpression(expression)) {
		const value: Record<string, JsonValue> = {};
		for (const property of expression.properties) {
			if (!ts.isPropertyAssignment(property)) return { known: false };
			const key = staticPropertyName(property.name);
			if (key === undefined || !isSafeJsonObjectKey(key)) return { known: false };
			const item = jsonLiteralValue(property.initializer, depth + 1);
			if (!item.known) return { known: false, typeHint: 'object' };
			value[key] = item.value;
		}
		return { known: true, value };
	}
	return { known: false };
}

function finiteNumericLiteral(value: number): LiteralObservation {
	return Number.isFinite(value) ? { known: true, value } : { known: false, typeHint: 'number' };
}

function literalTypeHint(
	literal: LiteralObservation,
): OperationCallObservationV1['arguments'][number]['typeHint'] {
	if (!literal.known) return literal.typeHint ?? 'unknown';
	if (literal.value === null) return 'null';
	if (Array.isArray(literal.value)) return 'array';
	if (typeof literal.value === 'object') return 'object';
	if (typeof literal.value === 'number') return 'number';
	if (typeof literal.value === 'string') return 'string';
	return 'boolean';
}

function staticPropertyName(name: ts.PropertyName): string | undefined {
	return ts.isIdentifier(name) || ts.isStringLiteralLike(name) || ts.isNumericLiteral(name)
		? name.text
		: undefined;
}

function isSafeQualifiedSegment(value: string): boolean {
	return (
		/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(value) &&
		!['__proto__', 'prototype', 'constructor'].includes(value)
	);
}

function isSafeJsonObjectKey(value: string): boolean {
	return value.length <= 128 && !['__proto__', 'prototype', 'constructor'].includes(value);
}
