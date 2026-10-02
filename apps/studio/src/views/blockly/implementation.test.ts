/**
 * 新模型的端到端口径（无头工作区，跑的是视图用的那一条路径）。
 *
 * 浏览器里的手工验收（积木真的画出来了、点卡片真的换了模块）由交付报告里的实机结果负责；
 * 这里把**同一批断言**钉在无头环境里，免得下次改动把它们悄悄弄坏：
 *   1. 页面加载 → 积木区是第一个模块（前进）的实现：三块积木、字段是节点参数的实际值 0.2 / 0 / 5；
 *   2. 选中「避障停止」→ 换成它的实现（读取激光 → 判断小于 → 刹停），字段跟着换成 0.5；
 *   3. 改积木上的数值 → 写回**节点的 parameters**（走 `store.applyDeclaration`），
 *      流程卡片上那一行的读数跟着变，而**实现结构不变**；
 *   4. 非法值写不进真相（唯一写路径仍然有两道闸）。
 *
 * 用的目录是应用真正用的那一份（`@codecanvas/capabilities` 的一期目录），
 * 任务用的是应用自带的示例任务——所以这里断言的数字就是界面上会看到的数字。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as Blockly from 'blockly';
import { PHASE1_ROBOT_CATALOG } from '@codecanvas/capabilities';
import {
	activeNodeOf,
	collectChainBlocks,
	compileWorkspace,
	registerImplementationBlocks,
	renderDeclaration,
	type RenderResult,
} from '@codecanvas/blockly-toolkit';
import { loadSampleTask, useStudioDocument } from '../../state/document';
import { summarizeNodeParameters, nodeAction } from '../flow/summary';

const store = useStudioDocument();

let workspace: Blockly.Workspace;

beforeEach(() => {
	expect(loadSampleTask()).toBe(true);
	registerImplementationBlocks(PHASE1_ROBOT_CATALOG);
	workspace = new Blockly.Workspace();
});

afterEach(() => {
	workspace.dispose();
});

const declaration = (): NonNullable<ReturnType<typeof useStudioDocument>['declaration']['value']> => {
	const value = store.declaration.value;
	if (value === null) throw new Error('示例任务应当已经载入');
	return value;
};

const nodeOfStep = (stepId: string) => {
	const node = declaration().nodes.find((candidate) => candidate.parameters['step_id'] === stepId);
	if (node === undefined) throw new Error(`示例任务里没有步骤 ${stepId}`);
	return node;
};

/** 视图侧那一次渲染：选中哪个节点就画哪个，没选中就是第一个。 */
const renderSelected = (nodeId: string | null): RenderResult =>
	renderDeclaration({
		workspace,
		declaration: declaration(),
		catalog: PHASE1_ROBOT_CATALOG,
		selectedNodeId: nodeId,
	});

const chain = (): readonly Blockly.Block[] => collectChainBlocks(workspace);

/** 画布上这条实现链的「坐标」：能力/原语/第几步——三个视图共用的那份身份。 */
const implementationOf = (rendered: RenderResult): readonly string[] =>
	rendered.index.order.map((entry) => `${entry.capabilityRef}/${entry.primitiveRef}#${String(entry.stepIndex)}`);

const blockAt = (index: number): Blockly.Block => {
	const block = chain()[index];
	if (block === undefined) throw new Error(`链上没有第 ${String(index + 1)} 块`);
	return block;
};

/** 流程卡片上那一行读数的显示值（与卡片同一个函数、同一份参数）。 */
const cardReading = (stepId: string, parameter: string): string | undefined => {
	const node = nodeOfStep(stepId);
	return summarizeNodeParameters(node.parameters, nodeAction(node))
		.find((row) => row.name === parameter)?.value;
};

describe('页面加载后的第一个模块', () => {
	it('前进的实现是三块积木：下发速度 → 等待 → 停止运动，字段是节点参数的实际值', () => {
		// 没选中任何节点时，画布画的是第一个模块——这就是用户打开页面看到的那一屏。
		expect(store.selectedNodeId.value).toBeNull();
		expect(activeNodeOf(declaration(), store.selectedNodeId.value)?.parameters['step_id']).toBe('s1');

		const rendered = renderSelected(store.selectedNodeId.value);
		expect(rendered.diagnostics).toEqual([]);
		expect(rendered.capability?.label).toBe('前进');
		expect(implementationOf(rendered)).toEqual(['move/set_velocity#0', 'move/wait#1', 'move/stop_motion#2']);
		// 三块串成一条链，不是三根散块。
		expect(workspace.getTopBlocks(false)).toHaveLength(1);
		expect(blockAt(0)?.getNextBlock()?.id).toBe(blockAt(1)?.id);
		expect(blockAt(1)?.getNextBlock()?.id).toBe(blockAt(2)?.id);

		// 字段值 = 示例任务里那三个数（0.2 / 0 / 5）。
		expect(blockAt(0)?.getFieldValue('linear')).toBe(0.2);
		expect(blockAt(0)?.getFieldValue('angular')).toBe(0);
		expect(blockAt(1)?.getFieldValue('seconds')).toBe(5);
	});
});

describe('选中另一个模块', () => {
	it('点「避障停止」→ 换成它的实现（读取激光 → 判断小于 → 刹停），字段换成 0.5', () => {
		const node = nodeOfStep('s2');
		// 流程卡片点过来时走的就是这两个动作：store 记下选中，画布按它重画。
		store.select(node.id);
		const rendered = renderSelected(store.selectedNodeId.value);

		expect(rendered.nodeId).toBe(node.id);
		expect(rendered.capability?.label).toBe('避障停止');
		expect(implementationOf(rendered)).toEqual([
			'stop_if_obstacle/read_scan#0',
			'stop_if_obstacle/compare_below#1',
			'stop_if_obstacle/brake#2',
		]);
		expect(blockAt(0)?.getFieldValue('sensor_scan0')).toBe('TRUE');
		expect(blockAt(1)?.getFieldValue('threshold')).toBe(0.5);
		// 上一个模块的三块积木不该留在画布上。
		expect(workspace.getAllBlocks(false)).toHaveLength(3);
	});
});

describe('改积木上的数值', () => {
	it('改「等待」的时长 → 写回节点的 parameters，卡片读数跟着变，实现结构不变', () => {
		renderSelected(store.selectedNodeId.value);
		expect(cardReading('s1', 'duration')).toBe('5');

		blockAt(1)?.setFieldValue(9, 'seconds');
		const compiled = compileWorkspace({ workspace, base: declaration(), catalog: PHASE1_ROBOT_CATALOG });
		expect(compiled.diagnostics).toEqual([]);
		const next = compiled.declaration;
		if (next === null) throw new Error('9 是合法时长，应当编译出声明');

		// 唯一写路径：过了 store 那两道闸才算数。
		expect(store.applyDeclaration(next)).toBe(true);
		expect(store.declaration.value?.nodes[0]?.parameters['duration']).toBe(9);
		// 流程卡片上那一行的读数跟着动（同一个节点、同一份声明）。
		expect(cardReading('s1', 'duration')).toBe('9');

		// 实现结构不变：还是那三步，节点数、连线、别的参数一个没动。
		const afterWrite = renderSelected(store.selectedNodeId.value);
		expect(implementationOf(afterWrite)).toEqual(['move/set_velocity#0', 'move/wait#1', 'move/stop_motion#2']);
		expect(store.declaration.value?.nodes).toHaveLength(4);
		expect(Object.keys(store.declaration.value?.connections ?? {})).toHaveLength(3);
		expect(Object.keys(store.declaration.value?.nodes[0]?.parameters ?? {}).sort()).toEqual([
			'action',
			'angular',
			'duration',
			'linear',
			'step_id',
		]);
	});

	it('非法值（距离 = 0）只留诊断，真相不动', () => {
		store.select(nodeOfStep('s2').id);
		renderSelected(store.selectedNodeId.value);
		blockAt(1)?.setFieldValue(0, 'threshold');

		const compiled = compileWorkspace({ workspace, base: declaration(), catalog: PHASE1_ROBOT_CATALOG });
		expect(compiled.ok).toBe(false);
		expect(compiled.declaration).toBeNull();
		expect(compiled.diagnostics.map((diagnostic) => diagnostic.code)).toContain(
			'step.stop_if_obstacle.distance.range',
		);
		// 真相里那个数还是 0.5：写回被拒时声明不动。
		expect(store.declaration.value?.nodes[1]?.parameters['distance']).toBe(0.5);
		expect(cardReading('s2', 'distance')).toBe('0.5');
	});
});
