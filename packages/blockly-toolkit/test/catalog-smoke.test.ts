/**
 * 真实目录（`PHASE1_ROBOT_CATALOG`）的**冒烟断言**——薄得故意：两条问「画得出来吗」，
 * 外加一条把它和夹具目录一起过一遍 schema（目录是不是一份目录，不由画布的表现决定）。
 *
 * 为什么薄：`packages/capabilities/src/phase1-robot.ts` 是**示意目录**，等 RoboFrame 给出真实实现就整份替换
 * （数据结构不变）。所以这里只问「这份目录画得出来吗」，不问「它画成了什么形状」——
 * 形状断言一旦写在这里，目录一改就集体失效（`blocks.test.ts` / `roundtrip.test.ts` 用的是夹具目录，形状固定）。
 * 目录的内容对不对归 `packages/capabilities/test/catalog.test.ts`。
 *
 * 判据是 **error 诊断**，不是「零诊断」：真实实现里的 `warning`（例如某处的实参引用取不到值）不算坏。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as Blockly from 'blockly';
import { PHASE1_ROBOT_CATALOG } from '@codecanvas/capabilities';
import {
	capabilityCatalogSchema,
	computeWorkflowDigest,
	WORKFLOW_FORMAT_VERSION,
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
const declarationForCatalog = (): WorkflowDeclaration => {
	const nodes = PHASE1_ROBOT_CATALOG.capabilities.map((capability, index) => nodeFor(capability, index));
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

describe('真实目录的冒烟：改了内容也站得住', () => {
	it('真实目录与夹具目录都过 schema（它们是不是一份目录，不由画布的表现决定）', () => {
		expect(capabilityCatalogSchema.safeParse(PHASE1_ROBOT_CATALOG).success).toBe(true);
		expect(capabilityCatalogSchema.safeParse(FIXTURE_CATALOG).success).toBe(true);
	});

	it('每个能力都注册得成积木（推导不抛，类型名互不相同）', () => {
		const types = registerImplementationBlocks(PHASE1_ROBOT_CATALOG);
		expect(types.length).toBe(describeCatalogImplementations(PHASE1_ROBOT_CATALOG).length);
		expect(new Set(types).size).toBe(types.length);
	});

	it('遍历它的每一个能力都能画出来，且没有 error 诊断', () => {
		const declaration = declarationForCatalog();
		expect(declaration.nodes.length).toBe(PHASE1_ROBOT_CATALOG.capabilities.length);

		const errors: string[] = [];
		for (const node of declaration.nodes) {
			const rendered = renderDeclaration({
				workspace,
				declaration,
				catalog: PHASE1_ROBOT_CATALOG,
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
