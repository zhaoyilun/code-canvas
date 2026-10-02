/**
 * 新模型的端到端口径（无头工作区，跑的是视图用的那一条路径）。
 *
 * 浏览器里的手工验收（积木真的画出来了、点卡片真的换了模块）由交付报告里的实机结果负责；
 * 这里把**同一批断言**钉在无头环境里，免得下次改动把它们悄悄弄坏：
 *   1. 页面加载 → 积木区是第一个模块（前进）的实现：三块积木、字段是节点参数的实际值 0.2 / 0 / 5；
 *   2. 选中「避障停止」→ 换成它的实现，而且长成一棵**语句树**：赋值块 + C 形 if 块，
 *      条件里嵌比较块，比较两侧是引用块（reading）与数字块（0.5 ← 节点参数 distance），
 *      if 的语句口里嵌刹停；
 *   3. 改 if 里那个数字 → 写回**节点的 parameters**（走 `store.applyDeclaration`），
 *      流程卡片上那一行的读数跟着变，而**实现结构不变**；
 *   4. 点树里任意一块 → 推出它所属的**顶层语句下标**（`selectedStepIndex`）；选中步 → 那一步的顶层积木；
 *   5. 非法值写不进真相（唯一写路径仍然有两道闸）。
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
	collectImplementationBlocks,
	compileWorkspace,
	registerImplementationBlocks,
	renderDeclaration,
	resolveSelection,
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

/** 按树里的下标路径找那块积木（嵌在输入里的也在）。 */
const blockAtPath = (stepPath: string): Blockly.Block => {
	const found = collectImplementationBlocks(workspace).find(
		(block) => (JSON.parse(block.data ?? '{}') as { stepPath?: string }).stepPath === stepPath,
	);
	if (found === undefined) throw new Error(`画布上没有 ${stepPath} 那块积木`);
	return found;
};

const blockAt = (index: number): Blockly.Block => {
	const block = chain()[index];
	if (block === undefined) throw new Error(`链上没有第 ${String(index + 1)} 块`);
	return block;
};

/** 画布上这条实现的「坐标」：能力 / 节点标签 / 下标路径——三个视图共用的那份身份。 */
const implementationOf = (rendered: RenderResult): readonly string[] =>
	rendered.index.order.map((entry) => `${entry.capabilityRef}@${entry.stepPath}:${entry.nodeTag}`);

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
		expect(implementationOf(rendered)).toEqual([
			'move@0:call_stmt',
			'move@1:call_stmt',
			'move@2:call_stmt',
		]);
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
	it('点「避障停止」→ 换成它的实现，长成赋值块 + C 形 if，条件里嵌比较、两侧是引用与数字', () => {
		const node = nodeOfStep('s2');
		// 流程卡片点过来时走的就是这两个动作：store 记下选中，画布按它重画。
		store.select(node.id);
		const rendered = renderSelected(store.selectedNodeId.value);

		expect(rendered.nodeId).toBe(node.id);
		expect(rendered.capability?.label).toBe('避障停止');
		// 顶层两条语句：赋值，然后条件。
		expect(implementationOf(rendered)).toEqual([
			'stop_if_obstacle@0:set',
			'stop_if_obstacle@0.value:call_value',
			'stop_if_obstacle@1:if',
			'stop_if_obstacle@1.condition:bin_lt',
			'stop_if_obstacle@1.condition.left:ref_read',
			'stop_if_obstacle@1.condition.right:ref_num',
			'stop_if_obstacle@1.then.0:call_stmt',
		]);
		expect(chain().map((block) => block.type.split('#').slice(2).join('#'))).toEqual(['set#0', 'if#1']);

		// 赋值：设 reading 为 读取激光（传感器勾选框）。
		const scan = blockAtPath('0.value');
		expect(scan.getFieldValue('sensor_scan0')).toBe('TRUE');
		expect(scan.getFieldValue('sensor_scan1')).toBe('FALSE');
		// 条件：局部变量 reading 只读，阈值 0.5 来自节点参数 distance。
		expect(blockAtPath('1.condition.left').getField('name')?.getText()).toBe('reading');
		expect(blockAtPath('1.condition.right').getFieldValue('value')).toBe(0.5);
		// if 的语句口里是刹停。
		expect(blockAtPath('1.then.0').getNextBlock()).toBeNull();
		// 上一个模块的三块积木不该留在画布上。
		expect(collectImplementationBlocks(workspace)).toHaveLength(7);
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
		expect(implementationOf(afterWrite)).toEqual([
			'move@0:call_stmt',
			'move@1:call_stmt',
			'move@2:call_stmt',
		]);
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

	it('改 if 里那个数字（它绑节点参数 distance）→ 写回该参数，卡片读数跟着变', () => {
		store.select(nodeOfStep('s2').id);
		renderSelected(store.selectedNodeId.value);
		expect(cardReading('s2', 'distance')).toBe('0.5');

		// 用户改的是**嵌在条件里**的那块：写回必须走完整棵树。
		blockAtPath('1.condition.right').setFieldValue(0.7, 'value');
		const compiled = compileWorkspace({ workspace, base: declaration(), catalog: PHASE1_ROBOT_CATALOG });
		expect(compiled.diagnostics).toEqual([]);
		const next = compiled.declaration;
		if (next === null) throw new Error('0.7 是合法阈值，应当编译出声明');
		expect(store.applyDeclaration(next)).toBe(true);

		expect(store.declaration.value?.nodes[1]?.parameters['distance']).toBe(0.7);
		expect(cardReading('s2', 'distance')).toBe('0.7');
		// 传感器数组没被顺手改掉。
		expect(store.declaration.value?.nodes[1]?.parameters['sensors']).toEqual(['/scan0']);
	});

	it('点树里的任意一块 → 推出所属的顶层语句下标；选中步 → 那一步的顶层积木', () => {
		store.select(nodeOfStep('s2').id);
		const rendered = renderSelected(store.selectedNodeId.value);

		// 点嵌在条件里的数字块：它属于「第 2 步」（顶层语句下标 1）。
		const threshold = rendered.index.byStepPath.get('1.condition.right');
		if (threshold === undefined) throw new Error('画布上应当有阈值那块');
		const identity = resolveSelection(rendered.index, threshold.blockId, null);
		expect(identity?.stepIndex).toBe(1);

		// 组件侧就是这么用的：认出块 → select(nodeId, blockId) + selectStep(顶层下标)。
		store.select(identity?.nodeId ?? null, identity?.blockId ?? null);
		store.selectStep(identity?.stepIndex ?? null);
		expect(store.selectedStepIndex.value).toBe(1);
		expect(store.selectedBlockId.value).toBe(threshold.blockId);

		// 反过来：选中步 → 那一步的顶层积木（组件用它 workspace.highlightBlock）。
		expect(rendered.index.byTopLevelStep.get(1)?.blockId).toBe(rendered.index.byStepPath.get('1')?.blockId);
		// 代码面板点第 1 行（stepIndex 0）也是同一条线。
		store.selectStep(0);
		expect(rendered.index.byTopLevelStep.get(0)?.blockId).toBe(rendered.index.byStepPath.get('0')?.blockId);

		// 换模块时选中步被清掉：跨模块谈「第几步」没有意义。
		store.select(nodeOfStep('s1').id);
		expect(store.selectedStepIndex.value).toBeNull();
	});

	it('非法值（距离 = 0）只留诊断，真相不动', () => {
		store.select(nodeOfStep('s2').id);
		renderSelected(store.selectedNodeId.value);
		blockAtPath('1.condition.right').setFieldValue(0, 'value');

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
