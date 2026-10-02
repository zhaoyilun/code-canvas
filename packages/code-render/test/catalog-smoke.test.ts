/**
 * 真实目录（`PHASE1_ROBOT_CATALOG`）的**冒烟断言**——薄得故意：两条问「渲染得出来吗」，
 * 外加一条把它和夹具目录一起过一遍 schema（目录是不是一份目录，不由渲染器的表现决定）。
 *
 * 为什么薄：`packages/capabilities/src/phase1-robot.ts` 是**示意目录**，等 RoboFrame 给出真实实现就整份替换
 * （数据结构不变）。所以这里只问「这份目录渲染得出来吗」，不问「它渲染成了什么」——
 * 内容断言一旦写在这里，目录一改就集体失效。具体内容对不对归两处：
 * - `packages/capabilities/test/catalog.test.ts`：schema、原语存在性、`param` 可解析；
 * - 渲染规则的逐字断言：`render.test.ts`（用夹具目录，形状固定）。
 *
 * 判据是 **error 诊断**，不是「零诊断」：真实实现里出现经得起解释的 `warning` 不算坏
 * （例如实参引用的名字在本节点取不到值，渲染器会如实说并给占位符，而不是编一个数）。
 */
import { describe, expect, it } from 'vitest';
import { PHASE1_ROBOT_CATALOG } from '@codecanvas/capabilities';
import { capabilityCatalogSchema, type JsonObject } from '@codecanvas/contracts';
import { renderImplementation } from '../src/index';
import { FIXTURE_CATALOG, fixtureDeclarationOf, fixtureNode } from './fixtures';

/** 按能力参数表造一个「参数齐全」的节点，让实现里的每个 `param` 都取得到值。 */
const nodeFor = (capabilityRef: string): JsonObject => {
	const capability = PHASE1_ROBOT_CATALOG.capabilities.find((item) => item.capabilityRef === capabilityRef);
	if (capability === undefined) throw new Error(`目录里没有 ${capabilityRef}`);
	const parameters: JsonObject = { step_id: 's1', action: capabilityRef };
	for (const parameter of capability.parameters) {
		switch (parameter.type) {
			case 'number':
				parameters[parameter.name] = 1;
				break;
			case 'boolean':
				parameters[parameter.name] = true;
				break;
			case 'sensor':
				parameters[parameter.name] = ['/scan0'];
				break;
			case 'string':
			case 'pose':
				parameters[parameter.name] = 'x';
				break;
		}
	}
	return parameters;
};

describe('真实目录的冒烟：改了内容也站得住', () => {
	it('真实目录与夹具目录都过 schema（它们是不是一份目录，不由渲染器的表现决定）', () => {
		expect(capabilityCatalogSchema.safeParse(PHASE1_ROBOT_CATALOG).success).toBe(true);
		expect(capabilityCatalogSchema.safeParse(FIXTURE_CATALOG).success).toBe(true);
	});

	it('渲染不出 error 诊断：每个能力都过一遍，一条 error 都不许有', () => {
		const errors: string[] = [];
		for (const capability of PHASE1_ROBOT_CATALOG.capabilities) {
			const node = fixtureNode(nodeFor(capability.capabilityRef));
			const program = renderImplementation({
				node,
				catalog: PHASE1_ROBOT_CATALOG,
				declaration: fixtureDeclarationOf([node]),
			});
			for (const diagnostic of program.diagnostics) {
				if (diagnostic.severity === 'error') errors.push(`${capability.capabilityRef}: ${diagnostic.code}`);
			}
			expect(program.title).toBe(`${capability.label} · 实现`);
		}
		expect(errors).toEqual([]);
	});

	it('遍历它的每一个能力都能渲染出来（至少一行，且第一行指向真实语句）', () => {
		expect(PHASE1_ROBOT_CATALOG.capabilities.length).toBeGreaterThan(0);
		for (const capability of PHASE1_ROBOT_CATALOG.capabilities) {
			const program = renderImplementation({
				node: fixtureNode(nodeFor(capability.capabilityRef)),
				catalog: PHASE1_ROBOT_CATALOG,
				declaration: fixtureDeclarationOf([fixtureNode({})]),
			});
			expect(program.lines.length, capability.capabilityRef).toBeGreaterThan(0);
			expect(program.steps.length, capability.capabilityRef).toBe(capability.implementation.length);
			expect(program.steps[0]?.path, capability.capabilityRef).toBe('0');
			expect(program.lines[0]?.kind).not.toBe('unsupported');
		}
	});
});
