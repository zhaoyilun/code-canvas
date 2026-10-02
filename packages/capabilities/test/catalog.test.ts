/**
 * 能力目录的自检。
 *
 * 目录是手写的，所以这里钉住三件容易写歪的事：
 *  1. 它符合契约 schema；
 *  2. 实现里引用的原语真的存在；
 *  3. 实现里引用的参数名，既在该能力的参数表里，也在该原语的参数表里。
 *
 * 等 RoboFrame 交来真实目录时，这三条同样适用——那时它们就是接收数据的闸。
 */
import { describe, expect, it } from 'vitest';
import { capabilityCatalogSchema, findPrimitive } from '@codecanvas/contracts';
import { PHASE1_ROBOT_CATALOG } from '../src/index';

const catalog = PHASE1_ROBOT_CATALOG;

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

	it('实现的每一步都指向一个真实存在的原语', () => {
		for (const capability of catalog.capabilities) {
			for (const step of capability.implementation) {
				expect(
					findPrimitive(catalog, step.step),
					`${capability.capabilityRef} 引用了不存在的原语 ${step.step}`,
				).toBeDefined();
			}
		}
	});

	it('实现里的 $占位都能在该能力的参数表里找到', () => {
		for (const capability of catalog.capabilities) {
			const declared = new Set(capability.parameters.map((parameter) => parameter.name));
			for (const step of capability.implementation) {
				for (const value of Object.values(step.arguments)) {
					if (typeof value !== 'string' || !value.startsWith('$')) continue;
					expect(
						declared.has(value.slice(1)),
						`${capability.capabilityRef} 引用了未声明的参数 ${value}`,
					).toBe(true);
				}
			}
		}
	});

	it('实参名必须是该原语声明的参数名', () => {
		for (const capability of catalog.capabilities) {
			for (const step of capability.implementation) {
				const primitive = findPrimitive(catalog, step.step);
				if (primitive === undefined) continue;
				const declared = new Set(primitive.parameters.map((parameter) => parameter.name));
				for (const key of Object.keys(step.arguments)) {
					expect(
						declared.has(key),
						`${capability.capabilityRef} → ${step.step} 传了未声明的实参 ${key}`,
					).toBe(true);
				}
			}
		}
	});

	it('每个能力的实现都非空（穿透才有东西可看）', () => {
		for (const capability of catalog.capabilities) {
			expect(capability.implementation.length, capability.capabilityRef).toBeGreaterThan(0);
		}
	});
});
