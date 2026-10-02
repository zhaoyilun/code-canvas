/**
 * 真实目录（`PHASE1_ROBOT_CATALOG`）的**冒烟断言**——薄得故意：两条问「显示得出来吗」，
 * 外加一条把它和夹具目录一起过一遍 schema（目录是不是一份目录，不由界面的表现决定）。
 *
 * 为什么薄：`packages/capabilities/src/phase1-robot.ts` 是**示意目录**，等 RoboFrame 给出真实实现就整份替换
 * （数据结构不变）。所以这里只问「这份目录在界面上显示得出来吗」，不问「它显示成了什么」——
 * 内容断言一旦写在这里，目录一改就集体失效（那是这次解耦要消灭的耦合）。
 * 界面形状的断言用夹具目录，见 `code-panel/CodePanel.test.ts` 与 `blockly/implementation.test.ts`。
 *
 * 判据是 **error 与「查不到能力」**，不是「零诊断」：真实实现里出现经得起解释的 warning 不算坏。
 *
 * ⚠ 这个文件**故意不 mock** `@codecanvas/capabilities`：它量的就是真实目录那一份。
 */
import { mount } from '@vue/test-utils';
import { beforeEach, describe, expect, it } from 'vitest';
import { PHASE1_ROBOT_CATALOG } from '@codecanvas/capabilities';
import { renderImplementation } from '@codecanvas/code-render';
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
import { setSelectedDevice } from '../shell/devices';
import { loadSampleTask, useStudioDocument } from '../state/document';
import { FIXTURE_CATALOG } from './__fixtures__/catalog';
import CodePanel from './code-panel/CodePanel.vue';

const doc = useStudioDocument();

beforeEach(() => {
	// 样例跟着**设备格式**走（默认那台说的是技能计划），而这里量的是这份一期样例，
	// 所以先站到一期那台设备上。
	setSelectedDevice('phase1_robot');
	expect(loadSampleTask()).toBe(true);
	doc.select(null);
	doc.selectStep(null);
});

/** 按能力参数表造一个「参数齐全」的节点：每个 `param` 都取得到值，诊断就只剩渲染器自己的话。 */
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

describe('真实目录的冒烟：改了内容也站得住', () => {
	it('代码面板拿真实目录渲染得出来：有代码行，也没有「查不到能力」那类 error', () => {
		const wrapper = mount(CodePanel);

		expect(wrapper.findAll('li.cp-line').length).toBeGreaterThan(0);
		// 「查不到能力 / 查不到原语」会画成说明行（`unsupported`）——真实目录不该走到那儿。
		expect(wrapper.find('li.cp-line[data-kind="unsupported"]').exists()).toBe(false);
		expect(wrapper.get('[data-testid="code-title"]').text()).toContain('实现');
	});

	it('遍历它的每一个能力都能渲染出来，且没有 error 诊断', () => {
		const nodes = PHASE1_ROBOT_CATALOG.capabilities.map((capability, index) => nodeFor(capability, index));
		const draft: WorkflowDeclarationDraft = {
			formatVersion: WORKFLOW_FORMAT_VERSION,
			id: 'wf_smoke',
			name: '冒烟声明',
			nodes,
			connections: {},
			meta: { limits: { max_linear: 0.3, max_angular: 1.2, max_duration: 30, require_confirmation: true } },
		};
		const declaration: WorkflowDeclaration = { ...draft, digest: computeWorkflowDigest(draft) };

		const errors: string[] = [];
		for (const node of nodes) {
			// 与 `CodePanel.vue` 里那一次渲染是同一条调用路径。
			const program = renderImplementation({ node, catalog: PHASE1_ROBOT_CATALOG, declaration });
			const ref = String(node.parameters['action']);
			expect(program.lines.length, ref).toBeGreaterThan(0);
			expect(program.lines[0]?.kind, ref).not.toBe('unsupported');
			for (const diagnostic of program.diagnostics) {
				if (diagnostic.severity === 'error') errors.push(`${ref}: ${diagnostic.code}`);
			}
		}
		expect(errors).toEqual([]);
	});

	it('夹具目录本身也得是一份合法目录（它坏了，形状断言量的就是别的东西）', () => {
		expect(capabilityCatalogSchema.safeParse(PHASE1_ROBOT_CATALOG).success).toBe(true);
		expect(capabilityCatalogSchema.safeParse(FIXTURE_CATALOG).success).toBe(true);
	});
});
