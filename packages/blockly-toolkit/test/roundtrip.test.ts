/**
 * 双向转换：声明 + 能力目录 → 工作区 → 声明。
 *
 * 新模型下的硬要求变了：画布只画**当前选中模块的实现**，写回**只改这个节点的 parameters**——
 * 实现来自目录，画布碰不到结构。所以这里钉住三件事：
 *   1. 画对（选中哪个模块就画哪个，字段值是节点参数的实际值）；
 *   2. 写窄（只动参数，身份/位置/连线/别的节点一字不动）；
 *   3. 挡住（非法值、来路不明的块一律不给声明，只给诊断）。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as Blockly from 'blockly';
import type { WorkflowDeclaration } from '@codecanvas/contracts';
import { compileWorkspace, taskPayloadFromDeclaration } from '../src/compile';
import {
	activeNodeOf,
	collectChainBlocks,
	renderDeclaration,
	type RenderResult,
} from '../src/render';
import { identityOfBlock } from '../src/identity';
import { implementationBlockType, registerImplementationBlocks } from '../src/blocks';
import { BROKEN_CATALOG, FIXTURE_CATALOG, FIXTURE_ID_FACTORY, fixtureDeclaration, nodeOfStep } from './fixtures';

let workspace: Blockly.Workspace;
let base: WorkflowDeclaration;
let rendered: RenderResult;

/** 画某个模块的实现：传 null 走「没选中就是第一个」那条路。 */
const renderSelected = (nodeId: string | null): RenderResult => {
	const result = renderDeclaration({
		workspace,
		declaration: base,
		catalog: FIXTURE_CATALOG,
		selectedNodeId: nodeId,
		idFactory: FIXTURE_ID_FACTORY,
	});
	rendered = result;
	return result;
};

const chain = (): readonly Blockly.Block[] => collectChainBlocks(workspace);

const blockAt = (index: number): Blockly.Block => {
	const block = chain()[index];
	if (block === undefined) throw new Error(`链上没有第 ${String(index + 1)} 块`);
	return block;
};

const blockOfNode = (nodeId: string): Blockly.Block => {
	const identity = rendered.index.byNodeId.get(nodeId);
	if (identity === undefined) throw new Error(`没有节点 ${nodeId} 对应的积木`);
	const block = workspace.getBlockById(identity.blockId);
	if (block === null) throw new Error(`工作区里没有积木 ${identity.blockId}`);
	return block;
};

beforeEach(() => {
	registerImplementationBlocks(FIXTURE_CATALOG);
	base = fixtureDeclaration();
	workspace = new Blockly.Workspace();
	rendered = renderSelected(null);
});

afterEach(() => {
	workspace.dispose();
});

describe('选中模块 → 工作区', () => {
	it('没选中任何节点时画第一个模块：move 的实现是三块积木，串成一条链', () => {
		expect(rendered.diagnostics).toEqual([]);
		expect(rendered.nodeId).toBe(base.nodes[0]?.id);
		expect(rendered.capability?.label).toBe('前进');
		expect(workspace.getTopBlocks(false)).toHaveLength(1);

		const blocks = chain();
		expect(blocks.map((block) => block.type)).toEqual([
			implementationBlockType(FIXTURE_CATALOG.catalogRef, 'move', 'set_velocity', 0),
			implementationBlockType(FIXTURE_CATALOG.catalogRef, 'move', 'wait', 1),
			implementationBlockType(FIXTURE_CATALOG.catalogRef, 'move', 'stop_motion', 2),
		]);
		// 链是 next 串起来的：每一块的下一个就是实现里的下一块。
		for (let index = 0; index < blocks.length - 1; index += 1) {
			expect(blocks[index]?.getNextBlock()?.id).toBe(blocks[index + 1]?.id);
		}
		// 「没选中就是第一个」这条口径只有一份（渲染器与视图共用它）。
		expect(activeNodeOf(base, null)?.id).toBe(base.nodes[0]?.id);
		expect(activeNodeOf(base, 'nd_不存在')?.id).toBe(base.nodes[0]?.id);
	});

	it('字段值是节点参数的实际值（0.2 / 0 / 5），单位小标签并存且不参与序列化', () => {
		const [velocity, wait] = chain();
		expect(velocity?.getFieldValue('linear')).toBe(0.2);
		expect(velocity?.getFieldValue('angular')).toBe(0);
		expect(wait?.getFieldValue('seconds')).toBe(5.0);
		// 单位是紧跟输入框的只读小标签，数值字段照旧。
		expect(velocity?.getField('unit_linear')?.getText()).toBe('m/s');
		expect(wait?.getField('unit_seconds')?.getText()).toBe('s');

		const state = velocity === undefined ? null : Blockly.serialization.blocks.save(velocity);
		if (state === null) throw new Error('积木应当能序列化出状态');
		expect(Object.keys(state.fields ?? {}).sort()).toEqual(['angular', 'linear']);
	});

	it('换一个模块 → 换成它的实现（避障停止：读取激光 / 判断小于 / 刹停），字段跟着换', () => {
		rendered = renderSelected(nodeOfStep(base, 's2').id);

		expect(rendered.diagnostics).toEqual([]);
		expect(rendered.capability?.label).toBe('避障停止');
		expect(chain().map((block) => block.type)).toEqual([
			implementationBlockType(FIXTURE_CATALOG.catalogRef, 'stop_if_obstacle', 'read_scan', 0),
			implementationBlockType(FIXTURE_CATALOG.catalogRef, 'stop_if_obstacle', 'compare_below', 1),
			implementationBlockType(FIXTURE_CATALOG.catalogRef, 'stop_if_obstacle', 'brake', 2),
		]);
		const [scan, compare] = chain();
		// 传感器数组展开成勾选框：声明里有 /scan0 → 勾上，没有 /scan1 → 空着。
		expect(scan?.getFieldValue('sensor_scan0')).toBe('TRUE');
		expect(scan?.getFieldValue('sensor_scan1')).toBe('FALSE');
		expect(compare?.getFieldValue('threshold')).toBe(0.5);
		// 上一个模块的积木不该留在画布上。
		expect(workspace.getAllBlocks(false)).toHaveLength(3);
	});

	it('字面量实参照目录原样显示：turn 的 linear = 0 是只读标签', () => {
		rendered = renderSelected(nodeOfStep(base, 's3').id);
		const [velocity] = chain();
		expect(velocity?.getField('literal_linear')?.getText()).toBe('0');
		expect(velocity?.getFieldValue('angular')).toBe(0.8);
		// 只读字段没有可写的数值字段跟着它。
		expect(velocity?.getField('linear')).toBeNull();
	});

	it('blockId ↔ nodeId ↔ 实现位置三个坐标都对得上，块 id 由工厂分配且重画不漂', () => {
		const first = base.nodes[0]?.id ?? '';
		const identity = rendered.index.byNodeId.get(first);
		expect(identity?.nodeId).toBe(first);
		expect(identity?.stepId).toBe('s1');
		expect(identity?.capabilityRef).toBe('move');
		expect(identity?.primitiveRef).toBe('set_velocity');
		expect(identity?.stepIndex).toBe(0);
		expect(identity?.blockId.startsWith('bl_')).toBe(true);
		expect(identityOfBlock(blockOfNode(first))).toEqual(identity);
		// 一个节点在画布上是一串积木：序列表从第一块走到最后一块。
		expect(rendered.index.order.map((entry) => entry.stepIndex)).toEqual([0, 1, 2]);
		expect(new Set(rendered.index.order.map((entry) => entry.nodeId))).toEqual(new Set([first]));

		// 重画（同一个模块）沿用分配表，块 id 不漂。
		const again = renderDeclaration({
			workspace,
			declaration: base,
			catalog: FIXTURE_CATALOG,
			selectedNodeId: null,
			idFactory: FIXTURE_ID_FACTORY,
			blockIds: rendered.blockIds,
		});
		expect(again.index.order).toEqual(rendered.index.order);
	});

	it('结构只读：积木删不掉（也没有垃圾桶）；拖位置不构成结构编辑', () => {
		for (const block of chain()) {
			expect(block.isDeletable(), block.type).toBe(false);
			// 故意仍可拖动：位置既不改实现也不进声明，而 Blockly 只在可拖动时才挂
			// `blocklyDraggable`——跨栏连线的积木锚点选择器认那个类（见 render.ts 的说明）。
			expect(block.isMovable(), block.type).toBe(true);
		}
	});
});

describe('工作区 → 声明（只改参数）', () => {
	it('没动字段时往返一致：身份字段、位置、连线、摘要全都一字不动', () => {
		const compiled = compileWorkspace({ workspace, base, catalog: FIXTURE_CATALOG });
		expect(compiled.diagnostics).toEqual([]);
		expect(compiled.ok).toBe(true);
		const declaration = compiled.declaration;
		if (declaration === null) throw new Error('应当编译出声明');

		expect(declaration.digest).toBe(base.digest);
		expect(declaration.nodes).toEqual(base.nodes);
		expect(declaration.connections).toEqual(base.connections);
		expect(declaration.id).toBe(base.id);
		expect(declaration.name).toBe(base.name);
		expect(declaration.meta).toEqual(base.meta);
	});

	it('改「等待」的时长 → 节点的 parameters.duration 跟着变，实现结构与别的节点不动', () => {
		const before = base.nodes[0];
		blockAt(1).setFieldValue(9, 'seconds');
		const compiled = compileWorkspace({ workspace, base, catalog: FIXTURE_CATALOG });
		expect(compiled.diagnostics).toEqual([]);
		const declaration = compiled.declaration;
		if (declaration === null) throw new Error('改出合法值时应当编译出声明');

		expect(declaration.nodes[0]?.parameters['duration']).toBe(9);
		// 同一个节点里别的参数没被顺手改掉。
		expect(declaration.nodes[0]?.parameters['linear']).toBe(0.2);
		expect(declaration.nodes[0]?.parameters['angular']).toBe(0);
		// 身份、位置、禁用位、名字都是原文：
		expect(declaration.nodes[0]?.id).toBe(before?.id);
		expect(declaration.nodes[0]?.name).toBe(before?.name);
		expect(declaration.nodes[0]?.type).toBe(before?.type);
		expect(declaration.nodes[0]?.typeVersion).toBe(before?.typeVersion);
		expect(declaration.nodes[0]?.position).toEqual(before?.position);
		expect(declaration.nodes[0]?.disabled).toBe(before?.disabled);
		// 别的节点一个都没动，连线也没动（画布换模块不改链）。
		expect(declaration.nodes.slice(1)).toEqual(base.nodes.slice(1));
		expect(declaration.connections).toEqual(base.connections);
		// 内容变了，摘要必须跟着变；否则「这份产物是不是从那份声明来的」就答不出来。
		expect(declaration.digest).not.toBe(base.digest);
	});

	it('只读的字面量字段写不回节点参数', () => {
		rendered = renderSelected(nodeOfStep(base, 's3').id);
		const turn = base.nodes[2];
		blockAt(0).setFieldValue(0.9, 'angular');
		const compiled = compileWorkspace({ workspace, base, catalog: FIXTURE_CATALOG });
		const declaration = compiled.declaration;
		if (declaration === null) throw new Error('应当编译出声明');

		expect(declaration.nodes[2]?.parameters['angular']).toBe(0.9);
		// turn 的能力参数表里没有 linear：目录里那个 0 是原语自己的实参，不该出现在节点上。
		expect(Object.keys(declaration.nodes[2]?.parameters ?? {})).toEqual(Object.keys(turn?.parameters ?? {}));
		expect(declaration.nodes[2]?.parameters['linear']).toBeUndefined();
	});

	it('画布上把块从链里摘掉也不改结构：声明里的节点数还是那么多', () => {
		// 结构只读，删块只是画布上的事——步骤由目录与声明决定，不由画布决定。
		blockAt(2).dispose(false);
		const compiled = compileWorkspace({ workspace, base, catalog: FIXTURE_CATALOG });
		expect(compiled.ok).toBe(true);
		const declaration = compiled.declaration;
		if (declaration === null) throw new Error('应当编译出声明');
		expect(declaration.nodes).toHaveLength(base.nodes.length);
		expect(declaration.digest).toBe(base.digest);
	});

	it('distance = 0 → 拒绝写出声明，只给诊断', () => {
		rendered = renderSelected(nodeOfStep(base, 's2').id);
		blockAt(1).setFieldValue(0, 'threshold');
		const compiled = compileWorkspace({ workspace, base, catalog: FIXTURE_CATALOG });
		expect(compiled.ok).toBe(false);
		expect(compiled.declaration).toBeNull();
		const diagnostic = compiled.diagnostics.find((item) => item.code === 'step.stop_if_obstacle.distance.range');
		expect(diagnostic?.severity).toBe('error');
		expect(diagnostic?.path).toBe('steps[1].distance');
		expect(diagnostic?.message).toBe('distance must be between 0 and 2 meters');
	});

	it('joint_id = 9 → 拒绝写出声明，只给诊断', () => {
		rendered = renderSelected(nodeOfStep(base, 's6').id);
		blockAt(0).setFieldValue(9, 'joint_id');
		const compiled = compileWorkspace({ workspace, base, catalog: FIXTURE_CATALOG });
		expect(compiled.ok).toBe(false);
		expect(compiled.declaration).toBeNull();
		expect(compiled.diagnostics.map((item) => item.code)).toContain('step.arm_joint.joint_id.range');
	});

	it('超出任务限值（linear > max_linear）也拒', () => {
		blockAt(0).setFieldValue(0.9, 'linear');
		const compiled = compileWorkspace({ workspace, base, catalog: FIXTURE_CATALOG });
		expect(compiled.ok).toBe(false);
		expect(compiled.diagnostics.map((item) => item.code)).toContain('step.move.linear.range');
	});

	it('勾掉全部传感器 → sensors 为空数组，校验器拒', () => {
		rendered = renderSelected(nodeOfStep(base, 's2').id);
		blockAt(0).setFieldValue(false, 'sensor_scan0');
		const compiled = compileWorkspace({ workspace, base, catalog: FIXTURE_CATALOG });
		expect(compiled.ok).toBe(false);
		expect(compiled.diagnostics.map((item) => item.code)).toContain('step.stop_if_obstacle.sensors.invalid');
	});

	it('画布上出现认不出来的块（没有 data）→ 拒，不把来路不明的东西并进真相', () => {
		Blockly.serialization.blocks.append(
			{ id: 'bl_unknown', type: implementationBlockType(FIXTURE_CATALOG.catalogRef, 'move', 'wait', 1), x: 0, y: 400 },
			workspace,
		);
		const compiled = compileWorkspace({ workspace, base, catalog: FIXTURE_CATALOG });
		expect(compiled.ok).toBe(false);
		expect(compiled.declaration).toBeNull();
		expect(compiled.diagnostics.map((item) => item.code)).toContain('blockly.compile.unknown_block');
	});
});

describe('目录查不到时（画布如实说，不猜）', () => {
	it('能力不在目录里 → 空画布 + unknown_capability', () => {
		const broken: WorkflowDeclaration = {
			...base,
			connections: {},
			nodes: [
				{
					id: 'nd_orphan',
					name: '1. fly',
					type: 'task.action',
					typeVersion: 1,
					parameters: { step_id: 's1', action: 'fly' },
					position: { x: 0, y: 0 },
					disabled: false,
				},
			],
		};
		const result = renderDeclaration({ workspace, declaration: broken, catalog: FIXTURE_CATALOG });
		expect(result.index.order).toHaveLength(0);
		expect(result.nodeId).toBe('nd_orphan');
		expect(result.capability).toBeNull();
		expect(workspace.getAllBlocks(false)).toHaveLength(0);
		expect(result.diagnostics.map((diagnostic) => diagnostic.code)).toContain('blockly.render.unknown_capability');
	});

	it('目录缺原语 → 那一步画不出来，其余步骤照画', () => {
		const capability = FIXTURE_CATALOG.capabilities[0];
		const step = capability?.implementation[1];
		if (capability === undefined || step === undefined) throw new Error('夹具目录应当有 move');
		// 把目录里 wait 这个原语抽掉，实现里第二步就画不出来。
		const holed = {
			...FIXTURE_CATALOG,
			primitives: FIXTURE_CATALOG.primitives.filter((primitive) => primitive.primitiveRef !== step.step),
		};
		const result = renderDeclaration({ workspace, declaration: base, catalog: holed });
		expect(chain().map((block) => block.type)).toEqual([
			implementationBlockType(FIXTURE_CATALOG.catalogRef, 'move', 'set_velocity', 0),
			implementationBlockType(FIXTURE_CATALOG.catalogRef, 'move', 'stop_motion', 2),
		]);
		expect(result.diagnostics.map((diagnostic) => diagnostic.code)).toContain('blockly.render.unknown_primitive');
	});

	it('节点参数缺值时按协议默认值显示，并给一条警告', () => {
		const sparse: WorkflowDeclaration = {
			...base,
			nodes: base.nodes.map((node, index) =>
				index === 0
					? {
							...node,
							parameters: { step_id: 's1', action: 'move', angular: 0 },
						}
					: node,
			),
		};
		const result = renderDeclaration({ workspace, declaration: sparse, catalog: FIXTURE_CATALOG });
		expect(blockAt(0).getFieldValue('linear')).toBe(0);
		expect(blockAt(1).getFieldValue('seconds')).toBe(1);
		expect(result.diagnostics.map((diagnostic) => diagnostic.code)).toContain('blockly.render.missing_parameter');
		expect(result.diagnostics.every((diagnostic) => diagnostic.severity === 'warning')).toBe(true);
	});

	it('目录自身有毛病时：悬空引用、漏给实参、缺原语各报各的，画得出的一块不少', () => {
		const result = renderDeclaration({ workspace, declaration: base, catalog: BROKEN_CATALOG });
		const codes = result.diagnostics.map((diagnostic) => diagnostic.code);
		expect(codes).toContain('blockly.render.dangling_argument');
		expect(codes).toContain('blockly.render.unbound_argument');
		expect(codes).toContain('blockly.render.unknown_primitive');
		// 前两条是目录的毛病（warning），第三条才是画不出来（error）——写回因此被暂停。
		expect(result.diagnostics.filter((diagnostic) => diagnostic.severity === 'error')).toHaveLength(1);
		// 三条能画的步骤一块不少（四条实现里只有一条原语缺失）。
		expect(chain()).toHaveLength(3);
	});

	it('声明里一个节点都没有 → 空画布 + no_node（不是崩）', () => {
		const empty: WorkflowDeclaration = { ...base, nodes: [], connections: {} };
		const result = renderDeclaration({ workspace, declaration: empty, catalog: FIXTURE_CATALOG });
		expect(result.nodeId).toBeNull();
		expect(result.capability).toBeNull();
		expect(result.index.order).toEqual([]);
		expect(result.diagnostics.map((diagnostic) => diagnostic.code)).toContain('blockly.render.no_node');
	});
});

describe('任务载荷', () => {
	it('从声明还原出的任务 JSON 能再次过校验器（与导入时同一套规则）', () => {
		const compiled = compileWorkspace({ workspace, base, catalog: FIXTURE_CATALOG });
		if (compiled.declaration === null) throw new Error('应当编译出声明');
		const payload = taskPayloadFromDeclaration(compiled.declaration);
		expect(payload.ok).toBe(true);
		if (!payload.ok) return;
		expect(payload.task).toMatchObject({ task_id: 'task-blockly-001', schema_version: '1.0' });
	});

	it('meta 缺任务元数据时不硬编，直接报缺失', () => {
		const payload = taskPayloadFromDeclaration({ ...base, meta: {} });
		expect(payload.ok).toBe(false);
		if (payload.ok) return;
		expect(payload.diagnostics.map((item) => item.code)).toEqual([
			'blockly.compile.missing_task_metadata',
			'blockly.compile.missing_task_metadata',
			'blockly.compile.missing_task_metadata',
		]);
	});
});
