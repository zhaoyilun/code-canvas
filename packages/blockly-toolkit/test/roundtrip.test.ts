/**
 * 双向转换：声明 → 工作区 → 声明。
 * 只改 parameters 是硬要求，往返之间身份字段必须一字不动，非法值必须被拒。
 */
import { beforeEach, afterEach, describe, expect, it } from 'vitest';
import * as Blockly from 'blockly';
import { ALLOWED_ACTIONS, createDeterministicIdFactory, type WorkflowDeclaration } from '@codecanvas/contracts';
import { compileWorkspace, taskPayloadFromDeclaration } from '../src/compile';
import { actionFromParameters, collectChainBlocks, renderDeclaration, type RenderResult } from '../src/render';
import { identityOfBlock } from '../src/identity';
import { actionBlockType, registerActionBlocks } from '../src/blocks';
import { fixtureDeclaration } from './fixtures';

const ID_FACTORY = createDeterministicIdFactory({ seed: 'blockly-roundtrip' });

let workspace: Blockly.Workspace;
let base: WorkflowDeclaration;
let rendered: RenderResult;

const blockOfNode = (nodeId: string): Blockly.Block => {
	const identity = rendered.index.byNodeId.get(nodeId);
	if (identity === undefined) throw new Error(`没有节点 ${nodeId} 对应的积木`);
	const block = workspace.getBlockById(identity.blockId);
	if (block === null) throw new Error(`工作区里没有积木 ${identity.blockId}`);
	return block;
};

const blockOfStep = (stepId: string): Blockly.Block => {
	const node = base.nodes.find((candidate) => candidate.parameters['step_id'] === stepId);
	if (node === undefined) throw new Error(`没有步骤 ${stepId}`);
	return blockOfNode(node.id);
};

beforeEach(() => {
	registerActionBlocks();
	base = fixtureDeclaration();
	workspace = new Blockly.Workspace();
	rendered = renderDeclaration({ workspace, declaration: base, idFactory: ID_FACTORY });
});

afterEach(() => {
	workspace.dispose();
});

describe('声明 → 工作区', () => {
	it('七个 step 七块积木，按数组顺序串成一条链', () => {
		expect(rendered.diagnostics).toEqual([]);
		expect(workspace.getTopBlocks(false)).toHaveLength(1);

		const chain = collectChainBlocks(workspace);
		const expectedTypes = base.nodes.map((node) => {
			const action = actionFromParameters(node.parameters);
			if (action === null) throw new Error('夹具声明的动作都应当是七种之一');
			return actionBlockType(action);
		});
		expect(chain.map((block) => block.type)).toEqual(expectedTypes);
		expect(chain).toHaveLength(base.nodes.length);
		// 链是 next 串起来的：每块的下一个就是数组里的下一块。
		for (let index = 0; index < chain.length - 1; index += 1) {
			expect(chain[index]?.getNextBlock()?.id).toBe(chain[index + 1]?.id);
		}
	});

	it('字段值就是声明里的参数', () => {
		const move = blockOfStep('s1');
		expect(move.getFieldValue('linear')).toBe(0.2);
		expect(move.getFieldValue('angular')).toBe(0);
		expect(move.getFieldValue('duration')).toBe(5.0);
		// 传感器数组展开成勾选框：声明里有 /scan0 → 勾上，没有 /scan1 → 空着。
		const obstacle = blockOfStep('s2');
		expect(obstacle.getFieldValue('sensor_scan0')).toBe('TRUE');
		expect(obstacle.getFieldValue('sensor_scan1')).toBe('FALSE');
		expect(obstacle.getFieldValue('distance')).toBe(0.5);
		expect(blockOfStep('s7').getFieldValue('joint6')).toBe(50);
	});

	it('单位小标签与数值字段并存，且不参与序列化（写回只认协议字段）', () => {
		const move = blockOfStep('s1');
		// 单位是紧跟输入框的只读小标签，数值字段照旧。
		expect(move.getField('unit_linear')?.getText()).toBe('m/s');
		expect(move.getField('linear')?.getText()).toBe('0.2');
		const state = Blockly.serialization.blocks.save(move);
		if (state === null) throw new Error('积木应当能序列化出状态');
		expect(Object.keys(state.fields ?? {}).sort()).toEqual(['angular', 'duration', 'linear']);

		const compiled = compileWorkspace({ workspace, base, idFactory: ID_FACTORY });
		const parameters = compiled.declaration?.nodes[0]?.parameters ?? {};
		expect(Object.keys(parameters).some((key) => key.startsWith('unit_'))).toBe(false);
	});

	it('blockId ↔ nodeId ↔ stepId 三个 id 都对得上，块 id 由工厂分配', () => {
		const identity = rendered.index.byNodeId.get(base.nodes[0]?.id ?? '');
		expect(identity?.nodeId).toBe(base.nodes[0]?.id);
		expect(identity?.stepId).toBe('s1');
		expect(identity?.blockId.startsWith('bl_')).toBe(true);
		expect(blockOfStep('s1').id).toBe(identity?.blockId);
		expect(identityOfBlock(blockOfStep('s1'))).toEqual(identity);
	});

	it('重画沿用分配表，块 id 不漂', () => {
		const again = renderDeclaration({
			workspace,
			declaration: base,
			idFactory: ID_FACTORY,
			blockIds: rendered.blockIds,
		});
		expect(again.index.order).toEqual(rendered.index.order);
	});

	it('动作不是七种之一时画不出来，并且明说', () => {
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
		const result = renderDeclaration({ workspace, declaration: broken, idFactory: ID_FACTORY });
		expect(result.index.order).toHaveLength(0);
		expect(workspace.getAllBlocks(false)).toHaveLength(0);
		expect(result.diagnostics.map((diagnostic) => diagnostic.code)).toContain('blockly.render.unknown_action');
	});
});

describe('工作区 → 声明', () => {
	it('往返一致：除了参数外的身份字段一字不动，摘要也一样', () => {
		const compiled = compileWorkspace({ workspace, base, idFactory: ID_FACTORY });
		expect(compiled.diagnostics).toEqual([]);
		expect(compiled.ok).toBe(true);
		const declaration = compiled.declaration;
		if (declaration === null) throw new Error('应当编译出声明');

		expect(declaration.id).toBe(base.id);
		expect(declaration.name).toBe(base.name);
		expect(declaration.formatVersion).toBe(base.formatVersion);
		expect(declaration.meta).toEqual(base.meta);
		expect(declaration.digest).toBe(base.digest);

		declaration.nodes.forEach((node, index) => {
			const original = base.nodes[index];
			expect(node.id).toBe(original?.id);
			expect(node.name).toBe(original?.name);
			expect(node.type).toBe(original?.type);
			expect(node.typeVersion).toBe(original?.typeVersion);
			expect(node.position).toEqual(original?.position);
			expect(node.disabled).toBe(original?.disabled);
			expect(node.parameters).toEqual(original?.parameters);
		});
		expect(declaration.connections).toEqual(base.connections);
	});

	it('改一个字段（duration）→ 参数跟着变，身份与连线不动', () => {
		blockOfStep('s1').setFieldValue(9, 'duration');
		const compiled = compileWorkspace({ workspace, base, idFactory: ID_FACTORY });
		expect(compiled.diagnostics).toEqual([]);
		const declaration = compiled.declaration;
		if (declaration === null) throw new Error('改出合法值时应当编译出声明');

		expect(declaration.nodes[0]?.parameters['duration']).toBe(9);
		expect(declaration.nodes[0]?.id).toBe(base.nodes[0]?.id);
		expect(declaration.nodes[0]?.position).toEqual(base.nodes[0]?.position);
		expect(declaration.nodes[1]?.parameters).toEqual(base.nodes[1]?.parameters);
		expect(declaration.connections).toEqual(base.connections);
		// 内容变了，摘要必须跟着变；否则「这份产物是不是从那份声明来的」就答不出来。
		expect(declaration.digest).not.toBe(base.digest);
	});

	it('distance = 0 → 拒绝写出声明，只给诊断', () => {
		blockOfStep('s2').setFieldValue(0, 'distance');
		const compiled = compileWorkspace({ workspace, base, idFactory: ID_FACTORY });
		expect(compiled.ok).toBe(false);
		expect(compiled.declaration).toBeNull();
		const diagnostic = compiled.diagnostics.find((item) => item.code === 'step.stop_if_obstacle.distance.range');
		expect(diagnostic?.severity).toBe('error');
		expect(diagnostic?.path).toBe('steps[1].distance');
		expect(diagnostic?.message).toBe('distance must be between 0 and 2 meters');
	});

	it('joint_id = 9 → 拒绝写出声明，只给诊断', () => {
		blockOfStep('s6').setFieldValue(9, 'joint_id');
		const compiled = compileWorkspace({ workspace, base, idFactory: ID_FACTORY });
		expect(compiled.ok).toBe(false);
		expect(compiled.declaration).toBeNull();
		expect(compiled.diagnostics.map((item) => item.code)).toContain('step.arm_joint.joint_id.range');
	});

	it('超出任务限值（linear > max_linear）也拒', () => {
		blockOfStep('s1').setFieldValue(0.9, 'linear');
		const compiled = compileWorkspace({ workspace, base, idFactory: ID_FACTORY });
		expect(compiled.ok).toBe(false);
		expect(compiled.diagnostics.map((item) => item.code)).toContain('step.move.linear.range');
	});

	it('勾掉全部传感器 → sensors 为空数组，校验器拒', () => {
		const obstacle = blockOfStep('s2');
		obstacle.setFieldValue(false, 'sensor_scan0');
		const compiled = compileWorkspace({ workspace, base, idFactory: ID_FACTORY });
		expect(compiled.ok).toBe(false);
		expect(compiled.diagnostics.map((item) => item.code)).toContain('step.stop_if_obstacle.sensors.invalid');
	});

	it('删掉末尾一块 → 链与连线按剩余顺序重建，其余节点身份不动', () => {
		blockOfStep('s7').dispose(false);
		const compiled = compileWorkspace({ workspace, base, idFactory: ID_FACTORY });
		expect(compiled.ok).toBe(true);
		const declaration = compiled.declaration;
		if (declaration === null) throw new Error('删块后仍应是合法声明');
		expect(declaration.nodes.map((node) => node.parameters['step_id'])).toEqual(['s1', 's2', 's3', 's4', 's5', 's6']);
		expect(declaration.nodes[0]?.id).toBe(base.nodes[0]?.id);
		expect(declaration.nodes.at(-1)?.id).toBe(base.nodes.at(-2)?.id);
		expect(Object.keys(declaration.connections)).toHaveLength(5);
		declaration.nodes.forEach((node, index) => {
			expect(node.parameters).toEqual(base.nodes[index]?.parameters);
		});
	});

	it('删掉中间一块 → Blockly 的语义是连同下面整条尾巴一起删（可从垃圾桶撤销）', () => {
		blockOfStep('s3').dispose(false);
		const compiled = compileWorkspace({ workspace, base, idFactory: ID_FACTORY });
		expect(compiled.ok).toBe(true);
		const declaration = compiled.declaration;
		if (declaration === null) throw new Error('删块后仍应是合法声明');
		// 这条断言记录的是 Blockly 自己的删除语义，不是我们另加的策略：
		// 想留下后半段，得先把它拖成独立一条链再删。
		expect(declaration.nodes.map((node) => node.parameters['step_id'])).toEqual(['s1', 's2']);
		expect(Object.keys(declaration.connections)).toHaveLength(1);
		expect(declaration.nodes[1]?.id).toBe(base.nodes[1]?.id);
	});

	it('新拖进来的块 → 新节点拿新 id、不重名的名字，老节点名字不动', () => {
		Blockly.serialization.blocks.append({ id: 'bl_new_block', type: actionBlockType('move'), x: 0, y: 400 }, workspace);
		const compiled = compileWorkspace({ workspace, base, idFactory: ID_FACTORY });
		expect(compiled.diagnostics).toEqual([]);
		const declaration = compiled.declaration;
		if (declaration === null) throw new Error('新块默认值应当合法');

		expect(declaration.nodes).toHaveLength(base.nodes.length + 1);
		const added = declaration.nodes.at(-1);
		expect(added?.id.startsWith('nd_')).toBe(true);
		expect(base.nodes.some((node) => node.id === added?.id)).toBe(false);
		expect(added?.parameters['step_id']).toBe(added?.id);
		expect(added?.name).toBe(`${base.nodes.length + 1}. move`);
		const names = declaration.nodes.map((node) => node.name);
		expect(new Set(names).size).toBe(names.length);
		// 原有节点一个都没动。
		base.nodes.forEach((node, index) => {
			expect(declaration.nodes[index]?.name).toBe(node.name);
			expect(declaration.nodes[index]?.parameters).toEqual(node.parameters);
		});
	});

	it('画布上的积木类型集合仍然是协议那七种', () => {
		const types = rendered.index.order
			.map((identity) => workspace.getBlockById(identity.blockId)?.type)
			.filter((type): type is string => type !== undefined)
			.sort();
		expect(types).toEqual([...ALLOWED_ACTIONS].map(actionBlockType).sort());
	});
});

describe('任务载荷', () => {
	it('从声明还原出的任务 JSON 能再次过校验器（与导入时同一套规则）', () => {
		const compiled = compileWorkspace({ workspace, base, idFactory: ID_FACTORY });
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
