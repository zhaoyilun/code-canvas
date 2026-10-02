/**
 * 两份真实目录的**冒烟断言**——薄得故意：问「渲染得出来吗」，
 * 外加一条把目录们过一遍 schema（目录是不是一份目录，不由渲染器的表现决定）。
 *
 * 为什么薄：`phase1-robot.ts` 是**示意目录**（一期协议只规定「做什么」），
 * `roboframe/` 是**真实上游目录**（技能模板的 `primitive_sequence` 就是执行器会下发的东西）——
 * 两份都还会变。所以这里只问「渲染得出来吗」，不问「渲染成了什么」——
 * 内容断言一旦写在这里，目录一改就集体失效。具体内容对不对归两处：
 * - 各目录自己的 `test/catalog.test.ts`：schema、原语存在性、`param` 可解析；
 * - 渲染规则的逐字断言：`render.test.ts`（用夹具目录，形状固定）。
 *
 * 判据是 **error 诊断**，不是「零诊断」：真实实现里出现经得起解释的 `warning` 不算坏
 * （例如实参引用的名字在本节点取不到值，渲染器会如实说并给占位符，而不是编一个数）。
 */
import { describe, expect, it } from 'vitest';
import { PHASE1_ROBOT_CATALOG, ROBOFRAME_SO101_CATALOG } from '@codecanvas/capabilities';
import { capabilityCatalogSchema, type CapabilityCatalog, type JsonObject } from '@codecanvas/contracts';
import { renderImplementation } from '../src/index';
import { FIXTURE_CATALOG, fixtureDeclarationOf, fixtureNode } from './fixtures';

const CATALOGS: readonly { readonly name: string; readonly catalog: CapabilityCatalog }[] = [
	{ name: 'phase1_robot（示意实现）', catalog: PHASE1_ROBOT_CATALOG },
	{ name: 'roboframe_so101_single_arm（上游 RoboFrame 真实技能库）', catalog: ROBOFRAME_SO101_CATALOG },
];

/** 按能力参数表造一个「参数齐全」的节点，让实现里的每个 `param` 都取得到值。 */
const nodeFor = (catalog: CapabilityCatalog, capabilityRef: string): JsonObject => {
	const capability = catalog.capabilities.find((item) => item.capabilityRef === capabilityRef);
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
			case 'json':
				parameters[parameter.name] = {};
				break;
		}
	}
	return parameters;
};

describe.each(CATALOGS)('$name 的冒烟：改了内容也站得住', ({ catalog }) => {
	it('目录过 schema（它是不是一份目录，不由渲染器的表现决定）', () => {
		expect(capabilityCatalogSchema.safeParse(catalog).success).toBe(true);
	});

	it('渲染不出 error 诊断：每个能力都过一遍，一条 error 都不许有', () => {
		const errors: string[] = [];
		for (const capability of catalog.capabilities) {
			const node = fixtureNode(nodeFor(catalog, capability.capabilityRef));
			const program = renderImplementation({
				node,
				catalog,
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
		expect(catalog.capabilities.length).toBeGreaterThan(0);
		for (const capability of catalog.capabilities) {
			const program = renderImplementation({
				node: fixtureNode(nodeFor(catalog, capability.capabilityRef)),
				catalog,
				declaration: fixtureDeclarationOf([fixtureNode({})]),
			});
			expect(program.lines.length, capability.capabilityRef).toBeGreaterThan(0);
			expect(program.steps.length, capability.capabilityRef).toBe(capability.implementation.length);
			expect(program.steps[0]?.path, capability.capabilityRef).toBe('0');
			expect(program.lines[0]?.kind).not.toBe('unsupported');
		}
	});
});

describe('夹具目录也过同一道 schema 闸', () => {
	it('夹具目录是一份合法目录', () => {
		expect(capabilityCatalogSchema.safeParse(FIXTURE_CATALOG).success).toBe(true);
	});
});
