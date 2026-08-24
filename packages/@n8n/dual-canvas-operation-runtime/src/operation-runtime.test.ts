import { describe, expect, it } from 'vitest';

import {
	createOperationBlockDescriptorV1,
	createOperationBlockTypeV1,
	createOperationImplementationRefV1,
	createOperationModuleCatalogV1,
	evaluateOperationModuleV1,
	finalizeOperationModuleSpecV1,
	OPERATION_JSON_MAX_DEPTH,
	OperationModuleRuntimeError,
	operationJsonValueSchema,
	operationModuleCatalogV1Schema,
	operationModuleSpecV1Schema,
	resolveOperationModuleV1,
	verifyOperationModuleTestVectorsV1,
	type OperationModuleSpecV1,
} from './operation-runtime';

function clampModule(): OperationModuleSpecV1 {
	return finalizeOperationModuleSpecV1({
		apiVersion: 1,
		requestRef: 'module-request.clamp',
		operationRef: 'operation.clamp.v1',
		implementationRef: null,
		qualifiedName: 'clampScore',
		arity: 3,
		version: '1.0.0',
		behaviorSummary: 'Bounds a number between inclusive minimum and maximum values.',
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
		expression: {
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
		},
		testVectors: [
			{ name: 'below', arguments: [-5, 0, 100], expected: 0 },
			{ name: 'inside', arguments: [68, 0, 100], expected: 68 },
			{ name: 'above', arguments: [125, 0, 100], expected: 100 },
		],
	});
}

function identityModule(qualifiedName: string, operationRef: string): OperationModuleSpecV1 {
	return finalizeOperationModuleSpecV1({
		apiVersion: 1,
		requestRef: `request.${qualifiedName}`,
		operationRef,
		implementationRef: null,
		qualifiedName,
		arity: 1,
		version: '1.0.0',
		behaviorSummary: `Returns the ${qualifiedName} input unchanged.`,
		execution: 'synchronous',
		determinism: 'deterministic',
		effects: 'none',
		dataFlow: 'json-to-json',
		parameters: [{ parameterRef: 'arg.0', name: 'value', type: 'json', nullPolicy: 'allow' }],
		output: { type: 'json', nullPolicy: 'allow' },
		expression: { kind: 'parameter', parameterRef: 'arg.0' },
		testVectors: [
			{ name: 'number', arguments: [1], expected: 1 },
			{ name: 'text', arguments: ['lesson'], expected: 'lesson' },
			{ name: 'null', arguments: [null], expected: null },
		],
	});
}

describe('operation runtime', () => {
	it('evaluates and verifies the declarative clamp module', () => {
		const module = clampModule();

		expect(evaluateOperationModuleV1(module, [-5, 0, 100])).toBe(0);
		expect(evaluateOperationModuleV1(module, [68, 0, 100])).toBe(68);
		expect(evaluateOperationModuleV1(module, [125, 0, 100])).toBe(100);
		expect(verifyOperationModuleTestVectorsV1(module)).toEqual({
			apiVersion: 1,
			operationRef: module.operationRef,
			implementationRef: module.implementationRef,
			version: '1.0.0',
			verifiedVectorCount: 3,
		});
	});

	it('rejects a module whose declared behavior and vector disagree', () => {
		const module = clampModule();
		module.testVectors[2] = { name: 'above', arguments: [125, 0, 100], expected: 99 };

		expect(() => verifyOperationModuleTestVectorsV1(module)).toThrow(
			'test vector "above" expected 99 but produced 100',
		);
		expect(() => createOperationModuleCatalogV1({ apiVersion: 1, modules: [module] })).toThrow(
			'test vector "above"',
		);
	});

	it('rejects duplicate module identities instead of choosing one', () => {
		const first = identityModule('normalize', 'operation.normalize.first');
		const sameName = identityModule('normalize', 'operation.normalize.second');

		expect(() =>
			createOperationModuleCatalogV1({
				apiVersion: 1,
				modules: [first, structuredClone(first)],
			}),
		).toThrow('operationRef, implementationRef, and version collision');
		expect(() =>
			createOperationModuleCatalogV1({ apiVersion: 1, modules: [first, sameName] }),
		).toThrow('qualified name, arity, and version collision');
	});

	it('sorts, freezes, and resolves a catalog by exact qualified name and arity', () => {
		const zeta = identityModule('zeta', 'operation.zeta');
		const alpha = identityModule('alpha', 'operation.alpha');
		const catalog = createOperationModuleCatalogV1({ apiVersion: 1, modules: [zeta, alpha] });

		expect(catalog.modules.map((module) => module.qualifiedName)).toEqual(['alpha', 'zeta']);
		expect(Object.isFrozen(catalog)).toBe(true);
		expect(Object.isFrozen(catalog.modules)).toBe(true);
		expect(Object.isFrozen(catalog.modules[0])).toBe(true);
		expect(resolveOperationModuleV1(catalog, 'alpha', 1)?.operationRef).toBe('operation.alpha');
		expect(resolveOperationModuleV1(catalog, 'alpha', 2)).toBeUndefined();
		expect(resolveOperationModuleV1(catalog, 'Alpha', 1)).toBeUndefined();
	});

	it('derives deterministic legal block types and plain-data descriptors', () => {
		const module = clampModule();
		const first = createOperationBlockTypeV1(
			module.operationRef,
			module.implementationRef,
			module.version,
		);
		const second = createOperationBlockTypeV1(
			module.operationRef,
			module.implementationRef,
			module.version,
		);
		const descriptor = createOperationBlockDescriptorV1(module);

		expect(second).toBe(first);
		expect(first).toMatch(/^n8n_operation_[a-z0-9_]+$/);
		expect(descriptor).toMatchObject({
			blockType: first,
			implementationRef: module.implementationRef,
			qualifiedName: 'clampScore',
			inputs: [
				{ inputName: 'ARG0', name: 'value', check: 'Number' },
				{ inputName: 'ARG1', name: 'minimum', check: 'Number' },
				{ inputName: 'ARG2', name: 'maximum', check: 'Number' },
			],
			output: { check: 'Number' },
		});
		expect(Object.isFrozen(descriptor.inputs)).toBe(true);
	});

	it('rejects reserved keys at the declarative expression and vector boundaries', () => {
		const module = clampModule();
		module.expression = {
			kind: 'object',
			properties: [{ key: '__proto__', value: { kind: 'literal', value: 1 } }],
		};
		expect(operationModuleSpecV1Schema.safeParse(module).success).toBe(false);

		const withReservedVector = identityModule('preserve', 'operation.preserve');
		withReservedVector.testVectors[0] = {
			name: 'reserved',
			arguments: [{ constructor: 1 }],
			expected: 1,
		};
		expect(operationModuleSpecV1Schema.safeParse(withReservedVector).success).toBe(false);
		const withOwnProto = Object.create(null) as Record<string, unknown>;
		Object.defineProperty(withOwnProto, '__proto__', { enumerable: true, value: 1 });
		expect(operationJsonValueSchema.safeParse(withOwnProto).success).toBe(false);
		expect(operationJsonValueSchema.safeParse({ nested: { prototype: 1 } }).success).toBe(false);
	});

	it('enforces parameter, output, and propagate null contracts', () => {
		const base = identityModule('maybeValue', 'operation.maybe-value');
		const module = finalizeOperationModuleSpecV1({
			...base,
			implementationRef: null,
			parameters: [{ ...base.parameters[0], type: 'number', nullPolicy: 'propagate' }],
			output: { type: 'number', nullPolicy: 'allow' },
			testVectors: [
				{ name: 'one', arguments: [1], expected: 1 },
				{ name: 'two', arguments: [2], expected: 2 },
				{ name: 'null', arguments: [null], expected: null },
			],
		});

		expect(evaluateOperationModuleV1(module, [null])).toBeNull();
		expect(() => evaluateOperationModuleV1(module, ['1'])).toThrow('must have type number');
		expect(verifyOperationModuleTestVectorsV1(module).verifiedVectorCount).toBe(3);

		const rejectingOutput = structuredClone(module);
		rejectingOutput.output = { type: 'number', nullPolicy: 'reject' };
		expect(operationModuleSpecV1Schema.safeParse(rejectingOutput).success).toBe(false);
		expect(
			operationModuleSpecV1Schema.safeParse({
				...module,
				output: { type: 'number', nullPolicy: 'propagate' },
			}).success,
		).toBe(false);
	});

	it('derives implementation identity only from the canonical semantic projection', () => {
		const module = clampModule();
		const reordered = {
			testVectors: [...module.testVectors].reverse(),
			behaviorSummary: 'Different explanation for the same implementation.',
			requestRef: 'module-request.other',
			expression: module.expression,
			output: module.output,
			parameters: module.parameters,
			dataFlow: module.dataFlow,
			effects: module.effects,
			determinism: module.determinism,
			execution: module.execution,
			version: module.version,
			arity: module.arity,
			qualifiedName: module.qualifiedName,
			operationRef: module.operationRef,
			apiVersion: module.apiVersion,
			implementationRef: null,
		};
		const sameImplementation = finalizeOperationModuleSpecV1(reordered);

		expect(sameImplementation.implementationRef).toBe(module.implementationRef);
		expect(createOperationImplementationRefV1(reordered)).toBe(module.implementationRef);
		expect(
			createOperationImplementationRefV1({
				...module,
				expression: { kind: 'literal', value: { second: 2, first: 1 } },
			}),
		).toBe(
			createOperationImplementationRefV1({
				...module,
				expression: { kind: 'literal', value: { first: 1, second: 2 } },
			}),
		);
		expect(
			createOperationImplementationRefV1({
				...module,
				expression: { kind: 'literal', value: [1, 2] },
			}),
		).not.toBe(
			createOperationImplementationRefV1({
				...module,
				expression: { kind: 'literal', value: [2, 1] },
			}),
		);
	});

	it('rejects stale implementation references and separates block types for changed semantics', () => {
		const first = clampModule();
		const changed = finalizeOperationModuleSpecV1({
			...first,
			implementationRef: null,
			expression: { kind: 'literal', value: 50 },
			testVectors: first.testVectors.map((vector) => ({ ...vector, expected: 50 })),
		});
		const stale = { ...changed, implementationRef: first.implementationRef };
		const firstDescriptor = createOperationBlockDescriptorV1(
			createOperationModuleCatalogV1({ apiVersion: 1, modules: [first] }).modules[0],
		);
		const changedDescriptor = createOperationBlockDescriptorV1(
			createOperationModuleCatalogV1({ apiVersion: 1, modules: [changed] }).modules[0],
		);

		expect(changed.operationRef).toBe(first.operationRef);
		expect(changed.implementationRef).not.toBe(first.implementationRef);
		expect(firstDescriptor.blockType).not.toBe(changedDescriptor.blockType);
		expect(() =>
			createOperationModuleCatalogV1({ apiVersion: 1, modules: [first, changed] }),
		).toThrow('qualified name, arity, and version collision');
		expect(operationModuleSpecV1Schema.safeParse(stale).success).toBe(false);
		expect(() => finalizeOperationModuleSpecV1(stale)).toThrow(
			'OPERATION_IMPLEMENTATION_IDENTITY_MISMATCH',
		);
		expect(() => createOperationModuleCatalogV1({ apiVersion: 1, modules: [stale] })).toThrow(
			'OPERATION_IMPLEMENTATION_IDENTITY_MISMATCH',
		);
	});

	it('rejects oversized modules and catalogs before persistence', () => {
		const oversizedModule = identityModule('largeValue', 'operation.large-value');
		oversizedModule.testVectors = Array.from({ length: 32 }, (_, index) => ({
			name: `large-${index}`,
			arguments: ['x'.repeat(2048)],
			expected: 'x'.repeat(2048),
		}));
		expect(operationModuleSpecV1Schema.safeParse(oversizedModule).success).toBe(false);

		const modules = Array.from({ length: 200 }, (_, index) =>
			identityModule(`identity${index}`, `operation.identity-${index}`),
		);
		expect(operationModuleCatalogV1Schema.safeParse({ apiVersion: 1, modules }).success).toBe(
			false,
		);
	});

	it('turns deep and cyclic runtime arguments into a structured contract error', () => {
		const tooDeep: Record<string, unknown> = {};
		let cursor = tooDeep;
		for (let depth = 0; depth < OPERATION_JSON_MAX_DEPTH; depth += 1) {
			const child: Record<string, unknown> = {};
			cursor.value = child;
			cursor = child;
		}
		const cyclic: Record<string, unknown> = {};
		cyclic.self = cyclic;

		for (const value of [tooDeep, cyclic]) {
			try {
				evaluateOperationModuleV1(identityModule('bounded', 'operation.bounded'), [value]);
				throw new Error('expected a bounded argument error');
			} catch (error) {
				expect(error).toBeInstanceOf(OperationModuleRuntimeError);
				expect((error as OperationModuleRuntimeError).code).toBe(
					'OPERATION_ARGUMENT_COUNT_INVALID',
				);
			}
		}
	});
});
