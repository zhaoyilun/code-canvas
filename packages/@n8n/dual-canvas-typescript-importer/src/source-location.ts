import type { DiagnosticV1, SourcePointV1, SourceSpanV1 } from '@n8n/dual-canvas-core';
import type ts from 'typescript';

export function sourceSpanForNode(
	sourceFile: ts.SourceFile,
	sourceRef: string,
	node: ts.Node,
): SourceSpanV1 {
	return sourceSpanForRange(sourceFile, sourceRef, node.getStart(sourceFile), node.getEnd());
}

export function sourceSpanForRange(
	sourceFile: ts.SourceFile,
	sourceRef: string,
	start: number,
	end: number,
): SourceSpanV1 {
	const boundedStart = Math.max(0, Math.min(start, sourceFile.text.length));
	const boundedEnd = Math.max(boundedStart, Math.min(end, sourceFile.text.length));
	return {
		sourceRef,
		start: sourcePoint(sourceFile, boundedStart),
		end: sourcePoint(sourceFile, boundedEnd),
	};
}

export function diagnosticForNode(
	code: string,
	message: string,
	sourceFile: ts.SourceFile,
	sourceRef: string,
	node: ts.Node,
): DiagnosticV1 {
	return diagnosticForSpan(code, message, sourceSpanForNode(sourceFile, sourceRef, node));
}

export function diagnosticForRange(
	code: string,
	message: string,
	sourceFile: ts.SourceFile,
	sourceRef: string,
	start: number,
	length: number,
): DiagnosticV1 {
	return diagnosticForSpan(
		code,
		message,
		sourceSpanForRange(sourceFile, sourceRef, start, start + Math.max(0, length)),
	);
}

function diagnosticForSpan(code: string, message: string, span: SourceSpanV1): DiagnosticV1 {
	return {
		apiVersion: 1,
		code,
		severity: 'error',
		message,
		ref: span.sourceRef,
		path: `source.${span.start.line}.${span.start.column}`,
		details: {
			sourceRef: span.sourceRef,
			line: span.start.line,
			column: span.start.column,
			endLine: span.end.line,
			endColumn: span.end.column,
			startOffset: span.start.offset,
			endOffset: span.end.offset,
		},
	};
}

function sourcePoint(sourceFile: ts.SourceFile, offset: number): SourcePointV1 {
	const position = sourceFile.getLineAndCharacterOfPosition(offset);
	return {
		line: position.line + 1,
		column: position.character,
		offset,
	};
}
