/**
 * 能力目录的自检。
 *
 * 目录是手写的，所以这里钉住几件容易写歪的事：
 *  1. 它符合契约 schema；
 *  2. 实现里引用的原语真的存在（要**递归遍历语句树**，包括 if 的两个分支）；
 *  3. 每个 `{kind:'param', name}` 都能解析——要么是本能力实现里 `set` 过的局部变量，要么是本能力的参数；
 *  4. 实参名确实是那个原语声明的参数名。
 *
 * 等 RoboFrame 交来真实目录时，这四条同样适用——那时它们就是接收数据的闸。
 */
import { describe, expect, it } from 'vitest';
import {
	type CapabilitySpec,
	type ImplArgument,
	type ImplExpression,
	type ImplStatement,
	capabilityCatalogSchema,
	findPrimitive,
} from '@codecanvas/contracts';
import { PHASE1_ROBOT_CATALOG } from '../src/index';

const catalog = PHASE1_ROBOT_CATALOG;

/** 深度优先遍历语句树里的每条语句。 */
const eachStatement = (statements: readonly ImplStatement[], visit: (s: ImplStatement) => void): void => {
	for (const statement of statements) {
		visit(statement);
		if (statement.kind === 'if') {
			eachStatement(statement.then, visit);
			if (statement.else !== undefined) eachStatement(statement.else, visit);
		}
	}
};

/** 深度优先遍历表达式树。 */
const eachExpression = (expression: ImplExpression, visit: (e: ImplExpression) => void): void => {
	visit(expression);
	if (expression.kind === 'binary') {
		eachExpression(expression.left, visit);
		eachExpression(expression.right, visit);
	}
	if (expression.kind === 'unary') eachExpression(expression.value, visit);
};

/** 走进任意实参：字面量就到头，表达式继续下钻。 */
const eachArgument = (argument: ImplArgument, visit: (e: ImplExpression) => void): void => {
	if (typeof argument === 'object' && !Array.isArray(argument) && 'kind' in argument) {
		eachExpression(argument, visit);
	}
};

/** 每条语句里出现的所有表达式（含实参里的）。 */
const expressionsOf = (statement: ImplStatement): ImplExpression[] => {
	const found: ImplExpression[] = [];
	const collectArgs = (args: Record<string, ImplArgument>) => {
		for (const argument of Object.values(args)) eachArgument(argument, (e) => found.push(e));
	};
	if (statement.kind === 'call') collectArgs(statement.arguments);
	if (statement.kind === 'set') found.push(statement.value);
	if (statement.kind === 'if') found.push(statement.condition);
	return found;
};

const statementArguments = (statement: ImplStatement): Record<string, ImplArgument> | null =>
	statement.kind === 'call' ? statement.arguments : null;

const capabilityRefs = (capability: CapabilitySpec): Set<string> => {
	const locals = new Set<string>();
	eachStatement(capability.implementation, (statement) => {
		if (statement.kind === 'set') locals.add(statement.target);
	});
	return locals;
};

describe('一期设备目录', () => {
	it('符合契约 schema', () => {
		const parsed = capabilityCatalogSchema.safeParse(catalog);
		if (!parsed.success) {
			throw new Error(`catalog invalid: ${JSON.stringify(parsed.error.issues.slice(0, 3))}`);
		}
		expect(parsed.success).toBe(true);
	});

	it('一期协议的七种动作都在目录里', () => {
		const refs = catalog.capabilities.map((capability) => capability.capabilityRef);
		for (const action of [
			'move',
			'turn',
			'stop',
			'stop_if_obstacle',
			'get_status',
			'arm_joint',
			'arm6_joints',
		]) {
			expect(refs, `missing capability: ${action}`).toContain(action);
		}
	});

	it('实现里引用的原语都存在（含 if 分支里的）', () => {
		for (const capability of catalog.capabilities) {
			eachStatement(capability.implementation, (statement) => {
				const refs: string[] = [];
				if (statement.kind === 'call') refs.push(statement.primitiveRef);
				if (statement.kind === 'set') {
					eachExpression(statement.value, (e) => {
						if (e.kind === 'call') refs.push(e.primitiveRef);
					});
				}
				for (const ref of refs) {
					expect(
						findPrimitive(catalog, ref),
						`${capability.capabilityRef} 引用了不存在的原语 ${ref}`,
					).toBeDefined();
				}
			});
		}
	});

	it('每个 param 引用都能解析（局部变量或能力参数）', () => {
		for (const capability of catalog.capabilities) {
			const locals = capabilityRefs(capability);
			const parameters = new Set(capability.parameters.map((parameter) => parameter.name));
			eachStatement(capability.implementation, (statement) => {
				for (const expression of expressionsOf(statement)) {
					eachExpression(expression, (e) => {
						if (e.kind !== 'param') return;
						expect(
							locals.has(e.name) || parameters.has(e.name),
							`${capability.capabilityRef} 引用了未定义的名字 ${e.name}`,
						).toBe(true);
					});
					// 实参里嵌的表达式也要查
					eachExpression(expression, (e) => {
						if (e.kind !== 'call') return;
						for (const argument of Object.values(e.arguments)) {
							eachArgument(argument, (inner) => {
								eachExpression(inner, (deep) => {
									if (deep.kind !== 'param') return;
									expect(
										locals.has(deep.name) || parameters.has(deep.name),
										`${capability.capabilityRef} 实参里引用了未定义的名字 ${deep.name}`,
									).toBe(true);
								});
							});
						}
					});
				}
			});
		}
	});

	it('实参名必须是该原语声明的参数名', () => {
		for (const capability of catalog.capabilities) {
			eachStatement(capability.implementation, (statement) => {
				const args = statementArguments(statement);
				if (args === null) return;
				const primitive = findPrimitive(catalog, statement.kind === 'call' ? statement.primitiveRef : '');
				if (primitive === undefined) return;
				const declared = new Set(primitive.parameters.map((parameter) => parameter.name));
				for (const key of Object.keys(args)) {
					expect(
						declared.has(key),
						`${capability.capabilityRef} → ${primitive.primitiveRef} 传了未声明的实参 ${key}`,
					).toBe(true);
				}
			});
		}
	});

	it('每个能力的实现都非空（穿透才有东西可看）', () => {
		for (const capability of catalog.capabilities) {
			expect(capability.implementation.length, capability.capabilityRef).toBeGreaterThan(0);
		}
	});

	it('至少有一个能力带条件分支（树结构不是摆设）', () => {
		const withBranch = catalog.capabilities.filter((capability) => {
			let found = false;
			eachStatement(capability.implementation, (statement) => {
				if (statement.kind === 'if') found = true;
			});
			return found;
		});
		expect(withBranch.map((capability) => capability.capabilityRef)).toContain('stop_if_obstacle');
	});
});
