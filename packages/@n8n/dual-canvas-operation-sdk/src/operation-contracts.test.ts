import { describe, expect, it } from 'vitest';

import {
	createOperationModuleTemplateV1,
	finalizeOperationModuleSpecV1,
	moduleScaffoldRequestV1Schema,
	operationArgumentObservationV1Schema,
	operationExpressionV1Schema,
	operationModuleAdmissionV1Schema,
	operationModuleSpecV1Schema,
	operationModuleTemplateV1Schema,
	type ModuleScaffoldRequestV1,
	type OperationExpressionV1,
} from './operation-contracts';

const span = {
	sourceRef: 'source.main',
	start: { line: 3, column: 16, offset: 58 },
	end: { line: 3, column: 31, offset: 73 },
} as const;

const request: ModuleScaffoldRequestV1 = {
	apiVersion: 1,
	requestRef: 'module-request.1',
	scope: {
		documentRef: 'lesson.score-normalizer',
		revisionRef: 'revision.1',
		sourceRef: 'source.main',
	},
	qualifiedName: 'clamp',
	arity: 3,
	calls: [
		{
			callRef: 'call.1',
			callText: 'clamp(12, 0, 10)',
			source: span,
			arguments: [
				{
					index: 0,
					text: '12',
					source: {
						...span,
						start: { line: 3, column: 22, offset: 64 },
						end: { line: 3, column: 24, offset: 66 },
					},
					typeHint: 'number',
					literalValue: 12,
				},
				{
					index: 1,
					text: '0',
					source: {
						...span,
						start: { line: 3, column: 26, offset: 68 },
						end: { line: 3, column: 27, offset: 69 },
					},
					typeHint: 'number',
					literalValue: 0,
				},
				{
					index: 2,
					text: '10',
					source: {
						...span,
						start: { line: 3, column: 29, offset: 71 },
						end: { line: 3, column: 31, offset: 73 },
					},
					typeHint: 'number',
					literalValue: 10,
				},
			],
		},
	],
	requiredDecisions: [
		'behavior',
		'effect',
		'parameter-names',
		'input-types',
		'null-handling',
		'output-type',
		'test-vectors',
	],
};

function validSpec(expression: OperationExpressionV1 = clampExpression()) {
	const template = createOperationModuleTemplateV1(request);
	return finalizeOperationModuleSpecV1({
		apiVersion: 1,
		requestRef: 'module-request.1',
		operationRef: template.identity.operationRef,
		implementationRef: null,
		qualifiedName: 'clamp',
		arity: 3,
		version: '1.0.0',
		behaviorSummary: 'Bounds a finite numeric value between the supplied lower and upper limits.',
		execution: 'synchronous',
		determinism: 'deterministic',
		effects: 'none',
		dataFlow: 'json-to-json',
		parameters: [
			{ parameterRef: 'arg.0', name: 'value', type: 'number', nullPolicy: 'reject' },
			{ parameterRef: 'arg.1', name: 'minimum', type: 'number', nullPolicy: 'reject' },
			{ parameterRef: 'arg.2', name: 'maximum', type: 'number', nullPolicy: 'reject' },
		],
		output: { type: 'number', nullPolicy: 'reject' },
		expression,
		testVectors: [
			{ name: 'below', arguments: [-1, 0, 10], expected: 0 },
			{ name: 'inside', arguments: [5, 0, 10], expected: 5 },
			{ name: 'above', arguments: [12, 0, 10], expected: 10 },
		],
	});
}

function clampExpression(): OperationExpressionV1 {
	return {
		kind: 'conditional',
		condition: {
			kind: 'binary',
			operator: 'lt',
			left: { kind: 'parameter', parameterRef: 'arg.0' },
			right: { kind: 'parameter', parameterRef: 'arg.1' },
		},
		whenTrue: { kind: 'parameter', parameterRef: 'arg.1' },
		whenFalse: {
			kind: 'conditional',
			condition: {
				kind: 'binary',
				operator: 'gt',
				left: { kind: 'parameter', parameterRef: 'arg.0' },
				right: { kind: 'parameter', parameterRef: 'arg.2' },
			},
			whenTrue: { kind: 'parameter', parameterRef: 'arg.2' },
			whenFalse: { kind: 'parameter', parameterRef: 'arg.0' },
		},
	};
}

describe('operation module contracts', () => {
	it('parses a complete evidence-only scaffold request and rejects extra fields', () => {
		expect(moduleScaffoldRequestV1Schema.safeParse(request).success).toBe(true);
		expect(
			moduleScaffoldRequestV1Schema.safeParse({ ...request, guessedBehavior: 'clamp' }).success,
		).toBe(false);
	});

	it('creates the same strict AI shell for the same request', () => {
		const first = createOperationModuleTemplateV1(request);
		const second = createOperationModuleTemplateV1(request);

		expect(second).toEqual(first);
		expect(operationModuleTemplateV1Schema.safeParse(first).success).toBe(true);
		expect(first).toMatchObject({
			identity: {
				qualifiedName: 'clamp',
				arity: 3,
				version: '1.0.0',
				implementationRef: null,
			},
			parameters: [
				{ parameterRef: 'arg.0', type: null, nullPolicy: null },
				{ parameterRef: 'arg.1', type: null, nullPolicy: null },
				{ parameterRef: 'arg.2', type: null, nullPolicy: null },
			],
			expression: null,
			testVectors: [],
			routeIfIneligible: 'capability-plugin',
		});
	});

	it('admits a strict pure JSON operation with at least three vectors', () => {
		expect(operationModuleSpecV1Schema.safeParse(validSpec()).success).toBe(true);
		expect(operationModuleAdmissionV1Schema.safeParse({ request, spec: validSpec() }).success).toBe(
			true,
		);
		expect(
			operationModuleSpecV1Schema.safeParse({ ...validSpec(), arbitraryCode: 'return value' })
				.success,
		).toBe(false);
		expect(
			operationModuleSpecV1Schema.safeParse({
				...validSpec(),
				testVectors: validSpec().testVectors.slice(0, 2),
			}).success,
		).toBe(false);
	});

	it('binds admitted spec identity and arity to the scaffold request', () => {
		expect(operationModuleSpecV1Schema.safeParse({ ...validSpec(), arity: 2 }).success).toBe(false);
		expect(
			operationModuleAdmissionV1Schema.safeParse({
				request,
				spec: { ...validSpec(), requestRef: 'module-request.other' },
			}).success,
		).toBe(false);
		expect(
			operationModuleAdmissionV1Schema.safeParse({
				request,
				spec: { ...validSpec(), operationRef: 'operation.unstable' },
			}).success,
		).toBe(false);
		expect(
			operationModuleAdmissionV1Schema.safeParse({
				request,
				spec: {
					...validSpec(),
					implementationRef: 'implementation-00000000-0000-0000-0000-000000000000',
				},
			}).success,
		).toBe(false);
		const changedSlot = validSpec({ kind: 'literal', value: 5 });
		changedSlot.parameters[0] = { ...changedSlot.parameters[0], parameterRef: 'arg.changed' };
		changedSlot.testVectors = changedSlot.testVectors.map((vector) => ({ ...vector, expected: 5 }));
		const changedSlotAdmission = operationModuleAdmissionV1Schema.safeParse({
			request,
			spec: changedSlot,
		});
		expect(changedSlotAdmission.success).toBe(false);
		if (!changedSlotAdmission.success) {
			expect(
				changedSlotAdmission.error.issues.some((issue) =>
					issue.message.includes('deterministic template slot'),
				),
			).toBe(true);
		}
	});

	it('executes declared vectors at the admission boundary', () => {
		const incorrect = validSpec();
		incorrect.testVectors[2] = { name: 'above', arguments: [12, 0, 10], expected: 9 };
		const result = operationModuleAdmissionV1Schema.safeParse({ request, spec: incorrect });

		expect(result.success).toBe(false);
		if (!result.success) {
			expect(result.error.issues.some((issue) => issue.message.includes('produced 10'))).toBe(true);
		}
	});

	it('rejects undeclared parameter references and wrong vector arity', () => {
		const undeclared = operationModuleSpecV1Schema.safeParse({
			...validSpec(),
			expression: { kind: 'parameter', parameterRef: 'arg.99' },
		});
		expect(undeclared.success).toBe(false);
		if (!undeclared.success) {
			expect(
				undeclared.error.issues.some((issue) => issue.message.includes('undeclared parameter')),
			).toBe(true);
		}

		const wrongArity = validSpec();
		wrongArity.testVectors[0] = { name: 'wrong', arguments: [1], expected: 1 };
		expect(operationModuleSpecV1Schema.safeParse(wrongArity).success).toBe(false);
	});

	it('rejects duplicate parameter names, refs, and object expression keys', () => {
		const duplicateNames = validSpec();
		duplicateNames.parameters[1] = { ...duplicateNames.parameters[1], name: 'value' };
		expect(operationModuleSpecV1Schema.safeParse(duplicateNames).success).toBe(false);

		const duplicateRefs = validSpec();
		duplicateRefs.parameters[1] = {
			...duplicateRefs.parameters[1],
			parameterRef: 'arg.0',
		};
		expect(operationModuleSpecV1Schema.safeParse(duplicateRefs).success).toBe(false);

		const duplicateObjectKeys: OperationExpressionV1 = {
			kind: 'object',
			properties: [
				{ key: 'value', value: { kind: 'literal', value: 1 } },
				{ key: 'value', value: { kind: 'literal', value: 2 } },
			],
		};
		expect(
			operationModuleSpecV1Schema.safeParse({
				...validSpec(),
				expression: duplicateObjectKeys,
			}).success,
		).toBe(false);
	});

	it('enforces expression depth and node-count limits', () => {
		let deep: OperationExpressionV1 = { kind: 'parameter', parameterRef: 'arg.0' };
		for (let index = 0; index < 17; index += 1) {
			deep = { kind: 'unary', operator: 'negate', value: deep };
		}
		expect(
			operationModuleSpecV1Schema.safeParse({ ...validSpec(), expression: deep }).success,
		).toBe(false);

		const wide: OperationExpressionV1 = {
			kind: 'array',
			values: Array.from({ length: 64 }, () => ({
				kind: 'binary' as const,
				operator: 'add' as const,
				left: { kind: 'literal' as const, value: 1 },
				right: { kind: 'literal' as const, value: 2 },
			})),
		};
		expect(
			operationModuleSpecV1Schema.safeParse({ ...validSpec(), expression: wide }).success,
		).toBe(false);
	});

	it('rejects extremely deep untrusted JSON without overflowing the parser stack', () => {
		let expression: unknown = { kind: 'parameter', parameterRef: 'arg.0' };
		for (let index = 0; index < 5000; index += 1) {
			expression = { kind: 'unary', operator: 'negate', value: expression };
		}
		let result: ReturnType<typeof operationModuleSpecV1Schema.safeParse> | undefined;
		expect(() => {
			result = operationModuleSpecV1Schema.safeParse({ ...validSpec(), expression });
		}).not.toThrow();
		expect(result?.success).toBe(false);

		expect(() => operationExpressionV1Schema.safeParse(expression)).not.toThrow();
		expect(operationExpressionV1Schema.safeParse(expression).success).toBe(false);

		const cyclic: { kind: 'unary'; operator: 'negate'; value?: unknown } = {
			kind: 'unary',
			operator: 'negate',
		};
		cyclic.value = cyclic;
		expect(() => operationExpressionV1Schema.safeParse(cyclic)).not.toThrow();
		expect(operationExpressionV1Schema.safeParse(cyclic).success).toBe(false);
	});

	it('guards deep literal values at request and admission public entry points', () => {
		let literalValue: unknown = null;
		for (let index = 0; index < 5000; index += 1) literalValue = [literalValue];
		const firstCall = request.calls[0];
		const firstArgument = firstCall?.arguments[0];
		if (firstCall === undefined || firstArgument === undefined) {
			throw new Error('test scaffold call is incomplete');
		}
		const deepArgument = { ...firstArgument, literalValue };
		const deepRequest = {
			...request,
			calls: [
				{
					...firstCall,
					arguments: [deepArgument, ...firstCall.arguments.slice(1)],
				},
			],
		};

		expect(() => operationArgumentObservationV1Schema.safeParse(deepArgument)).not.toThrow();
		expect(operationArgumentObservationV1Schema.safeParse(deepArgument).success).toBe(false);
		expect(() => moduleScaffoldRequestV1Schema.safeParse(deepRequest)).not.toThrow();
		expect(moduleScaffoldRequestV1Schema.safeParse(deepRequest).success).toBe(false);
		expect(() =>
			operationModuleAdmissionV1Schema.safeParse({ request: deepRequest, spec: validSpec() }),
		).not.toThrow();
		expect(
			operationModuleAdmissionV1Schema.safeParse({ request: deepRequest, spec: validSpec() })
				.success,
		).toBe(false);
	});
});
