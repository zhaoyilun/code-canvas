/**
 * 两份真实目录的**冒烟断言**——薄得故意：问「画得出来吗」，
 * 外加一条把目录们过一遍 schema（目录是不是一份目录，不由画布的表现决定）。
 *
 * 为什么薄：`phase1-robot.ts` 是**示意目录**（一期协议只规定「做什么」），
 * `roboframe/` 是**上游真实技能库**（技能模板的 `primitive_sequence` 就是执行器会下发的东西）——
 * 两份都还会变。所以这里只问「这份目录画得出来吗」，不问「它画成了什么形状」——
 * 形状断言一旦写在这里，目录一改就集体失效（`blocks.test.ts` / `roundtrip.test.ts` 用夹具目录，形状固定）。
 * 目录的内容对不对归 `packages/capabilities/test/catalog.test.ts`。
 *
 * 判据是 **error 诊断**，不是「零诊断」：真实实现里的 `warning`（例如某处的实参引用取不到值）不算坏。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as Blockly from 'blockly';
import { PHASE1_ROBOT_CATALOG, ROBOFRAME_GRASP_CATALOG, ROBOFRAME_SO101_CATALOG } from '@codecanvas/capabilities';
import {
	capabilityCatalogSchema,
	computeWorkflowDigest,
	WORKFLOW_FORMAT_VERSION,
	type CapabilityCatalog,
	type CapabilitySpec,
	type JsonObject,
	type WorkflowDeclaration,
	type WorkflowDeclarationDraft,
	type WorkflowNode,
} from '@codecanvas/contracts';
import { describeCatalogImplementations, registerImplementationBlocks } from '../src/blocks';
import { renderDeclaration } from '../src/render';
import { FIXTURE_CATALOG, FIXTURE_ID_FACTORY } from './fixtures';

let workspace: Blockly.Workspace;

beforeEach(() => {
	workspace = new Blockly.Workspace();
});

afterEach(() => {
	workspace.dispose();
});

/** 按能力参数表造一个「参数齐全」的节点——每个 `param` 都取得到值，诊断才只剩渲染器自己的话。 */
const nodeFor = (capability: CapabilitySpec, index: number): WorkflowNode => {
	const parameters: JsonObject = { step_id: `s${String(index + 1)}`, action: capability.capabilityRef };
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
	return {
		id: `nd_smoke_${String(index)}`,
		name: `${String(index + 1)}. ${capability.label}`,
		type: 'task.action',
		typeVersion: 1,
		parameters,
		position: { x: 0, y: 0 },
		disabled: false,
	};
};

/** 一个能力一个节点：**遍历目录里的每一个能力**，不依赖任何一份写死的任务语料。 */
const declarationForCatalog = (catalog: CapabilityCatalog): WorkflowDeclaration => {
	const nodes = catalog.capabilities.map((capability, index) => nodeFor(capability, index));
	const draft: WorkflowDeclarationDraft = {
		formatVersion: WORKFLOW_FORMAT_VERSION,
		id: 'wf_smoke',
		name: '冒烟声明',
		nodes,
		connections: {},
		meta: { limits: { max_linear: 0.3, max_angular: 1.2, max_duration: 30, require_confirmation: true } },
	};
	return { ...draft, digest: computeWorkflowDigest(draft) };
};

const CATALOGS: readonly { readonly name: string; readonly catalog: CapabilityCatalog }[] = [
	{ name: 'phase1_robot（示意实现）', catalog: PHASE1_ROBOT_CATALOG },
	{ name: 'roboframe_so101_single_arm（上游 RoboFrame 真实技能库）', catalog: ROBOFRAME_SO101_CATALOG },
	{ name: 'roboframe_so101_handeye_realsense_grasp（含委托型抓取技能）', catalog: ROBOFRAME_GRASP_CATALOG },
];

describe.each(CATALOGS)('$name 的冒烟：改了内容也站得住', ({ catalog }) => {
	it('目录过 schema（它是不是一份目录，不由画布的表现决定）', () => {
		expect(capabilityCatalogSchema.safeParse(catalog).success).toBe(true);
	});

	it('每个能力都注册得成积木（推导不抛，类型名互不相同）', () => {
		const types = registerImplementationBlocks(catalog);
		expect(types.length).toBe(describeCatalogImplementations(catalog).length);
		expect(new Set(types).size).toBe(types.length);
	});

	it('遍历它的每一个能力都能画出来，且没有 error 诊断', () => {
		const declaration = declarationForCatalog(catalog);
		expect(declaration.nodes.length).toBe(catalog.capabilities.length);

		const errors: string[] = [];
		for (const node of declaration.nodes) {
			const rendered = renderDeclaration({
				workspace,
				declaration,
				catalog,
				selectedNodeId: node.id,
				idFactory: FIXTURE_ID_FACTORY,
			});
			const ref = String(node.parameters['action']);
			expect(rendered.nodeId, ref).toBe(node.id);
			expect(rendered.capability, ref).not.toBeNull();
			// 画出来了：这条实现的每个节点都在画布上（不是空画布，也不是只有占位块）。
			expect(rendered.index.order.length, ref).toBeGreaterThan(0);
			for (const diagnostic of rendered.diagnostics) {
				if (diagnostic.severity === 'error') errors.push(`${ref}: ${diagnostic.code}`);
			}
		}
		expect(errors).toEqual([]);
	});
});

describe('夹具目录也过同一道 schema 闸', () => {
	it('夹具目录是一份合法目录', () => {
		expect(capabilityCatalogSchema.safeParse(FIXTURE_CATALOG).success).toBe(true);
	});
});
