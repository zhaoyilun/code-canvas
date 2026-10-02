/**
 * 执行路径 → 节点（`nodeAtPlanPath`）的验收用例。
 *
 * 素材是**真目录里的技能**拼出来的技能计划（`__fixtures__/branch-plan.ts`，
 * 技能名与参数都得过 `validateSkillPlan` 那一关），经真实的导入路径变成声明：
 * 判据是结构本身，所以素材必须是一份真声明，手写的假节点测不到要测的东西。
 *
 * 单独钉这个函数，是因为两个视图都靠它把「设备跑到哪一格」认成「哪一张卡」：
 * 右栏的步骤行（点它 = 选中那一步）与流程画布的运行标记。口径只有这一份，就在这儿钉死。
 */
import { describe, expect, it } from 'vitest';
import { ROBOFRAME_SO101_CATALOG } from '@codecanvas/capabilities';
import type { WorkflowDeclaration, WorkflowNode } from '@codecanvas/contracts';
import { findTaskFormat } from '@codecanvas/task-import';
import { BRANCH_PLAN_JSON, MIXED_STEPS_PLAN_JSON, NESTED_NO_ELSE_PLAN_JSON } from '../flow/__fixtures__/branch-plan';
import { isPlanLayerNode, isPrimitiveNode, nodeAtPlanPath, planStructureOf } from './plan-structure';

/** 走真实导入路径：JSON → 声明（技能名照目录判，假名字在这儿就会被拒）。 */
const parse = (json: string): WorkflowDeclaration => {
	const result = findTaskFormat('skill_plan').parse(json, { catalog: ROBOFRAME_SO101_CATALOG });
	if (!result.ok) throw new Error(`素材没通过导入：${result.diagnostics.map((d) => d.code).join(', ')}`);
	return result.declaration;
};

/** 看一眼桌面 → 分支（成/没成各一步）→ 往前走一点 */
const BRANCH = parse(BRANCH_PLAN_JSON);
/** 跳个舞 → 分支（没有否则，then 臂里再嵌一层分支）→ 庆祝 */
const NESTED = parse(NESTED_NO_ELSE_PLAN_JSON);

/** 声明里那一步（按名字找，断言读起来是「哪一步」而不是一串 id）。 */
const stepNamed = (declaration: WorkflowDeclaration, name: string): WorkflowNode => {
	const node = declaration.nodes.find((candidate) => candidate.name === name);
	if (node === undefined) throw new Error(`声明里没有「${name}」这一步`);
	return node;
};

/** 那一步调用的技能名（节点参数里那一个，不是视图里另写的一份）。 */
const skillOf = (declaration: WorkflowDeclaration, name: string): string => {
	const action = stepNamed(declaration, name).parameters['action'];
	return typeof action === 'string' ? action : '';
};

/**
 * 断言「这条路径指的就是声明里这一步」——三层：
 * 拿到的是声明里**那个节点对象**（id 相等）、名字对得上、而且它调的技能在真目录里。
 */
const expectStep = (declaration: WorkflowDeclaration, path: string, name: string): WorkflowNode => {
	const node = nodeAtPlanPath(declaration, path);
	expect(node?.id).toBe(stepNamed(declaration, name).id);
	expect(node?.name).toBe(name);
	if (node === null) throw new Error(`${path} 应当指到「${name}」`);
	return node;
};

describe('执行路径 → 节点 · 顶层 / then / else', () => {
	it('顶层：`0` / `2` 是顶层那两个下标，不是声明里第 0 / 第 2 个节点', () => {
		// 声明顺序是「观察 / 分支 / 关闭 / 打开 / 往前」——顶层第 2 步（下标 2）是**往前一点**，
		// 而 `declaration.nodes[2]` 是臂里的「关闭夹爪」。这条路径口径不按声明顺序走。
		expectStep(BRANCH, '0', '1. 观察桌面');
		expectStep(BRANCH, '1', '2. 分支');
		expectStep(BRANCH, '2', '5. 往前一点');
		expect(stepNamed(BRANCH, '5. 往前一点').id).not.toBe(BRANCH.nodes[2]?.id);
	});

	it('then 臂：`1.then.0` 是分支 then 臂里的第一步', () => {
		expectStep(BRANCH, '1.then.0', '3. 关闭夹爪');
		// 技能名照目录写（不是编的）
		expect(skillOf(BRANCH, '3. 关闭夹爪')).toBe('close_gripper_skill');
		expect(ROBOFRAME_SO101_CATALOG.capabilities.map((c) => c.capabilityRef)).toContain('close_gripper_skill');
	});

	it('else 臂：`1.else.0` 是分支 else 臂里的第一步', () => {
		expectStep(BRANCH, '1.else.0', '4. 打开夹爪');
		expect(skillOf(BRANCH, '4. 打开夹爪')).toBe('open_gripper_skill');
	});
});

describe('执行路径 → 节点 · 嵌套与推不出来的那些', () => {
	it('嵌套：臂里的分支再带一条臂（`1.then.1.else.0`）也认得出来', () => {
		// 顶层：跳舞（0）/ 分支（1）/ 庆祝（2）；then 臂：关闭夹爪（0）、内层分支（1）
		expectStep(NESTED, '0', '1. 跳舞');
		expectStep(NESTED, '1.then.0', '3. 关闭夹爪');
		expectStep(NESTED, '1.then.1', '4. 分支');
		expectStep(NESTED, '1.then.1.then.0', '5. 点头');
		expectStep(NESTED, '1.then.1.else.0', '6. 摇头');
		expect(skillOf(NESTED, '6. 摇头')).toBe('shake_no');

		// 层数对得上：`planStructureOf` 那棵树里，这三步一层套一层（不是声明顺序）
		const structure = planStructureOf(NESTED);
		expect(structure.steps.map((step) => step.node.name)).toEqual(['1. 跳舞', '2. 分支', '7. 庆祝']);
	});

	it('越界：下标超出这一层 → null（不夹到最后一个，也不回卷）', () => {
		expect(nodeAtPlanPath(BRANCH, '9')).toBeNull();
		expect(nodeAtPlanPath(BRANCH, '1.then.9')).toBeNull();
		expect(nodeAtPlanPath(NESTED, '1.then.1.else.2')).toBeNull();
		// 没有否则的那条臂：路径指着一个不存在的位置，同样不猜
		expect(nodeAtPlanPath(NESTED, '1.else.0')).toBeNull();
	});

	it('悬空：指着一个不存在的格子 → null（技能步后面接臂、停臂上、臂名不认识）', () => {
		// 顶层第一步是技能步，没有臂
		expect(nodeAtPlanPath(BRANCH, '0.then.0')).toBeNull();
		// 停在臂上：`1.then` 说的是「then 这条臂」，不是一个位置
		expect(nodeAtPlanPath(BRANCH, '1.then')).toBeNull();
		// 臂名只有 then / else 两个
		expect(nodeAtPlanPath(BRANCH, '1.main.0')).toBeNull();
		expect(nodeAtPlanPath(BRANCH, '')).toBeNull();
		// 没有声明就没有位置可言
		expect(nodeAtPlanPath(null, '0')).toBeNull();
	});
});

/** 素材里的技能名确实是目录里的那些（防止哪天有人把假名字写进 fixture 还过得去）。 */
describe('执行路径 → 节点 · 素材用的是真目录', () => {
	it('两份素材里每一步的技能都在 SO-101 目录里', () => {
		const refs = new Set(ROBOFRAME_SO101_CATALOG.capabilities.map((capability) => capability.capabilityRef));
		const skills = [BRANCH, NESTED].flatMap((declaration) =>
			declaration.nodes.flatMap((node) => {
				const action = node.parameters['action'];
				return typeof action === 'string' ? [action] : [];
			}),
		);
		expect(skills.length).toBeGreaterThan(0);
		for (const skill of skills) expect(refs).toContain(skill);
	});
});

// ---------------------------------------------------------------------------
// 原语步（`task.primitive`）：执行路径认得出它，它也是**计划层**节点
// ---------------------------------------------------------------------------

/** 「看一眼 → 直接张开夹爪 → 等两秒 → 分叉 → 往前挪一点」：四类步混排。 */
const MIXED = parse(MIXED_STEPS_PLAN_JSON);

describe('执行路径 → 节点 · 原语步与计划层判据', () => {
	it('原语步在路径里就是一个普通位置：`1` 是它自己，臂里的原语是 `3.then.0`', () => {
		expectStep(MIXED, '0', '1. 观察桌面');
		expectStep(MIXED, '1', '2. 张开夹爪');
		expectStep(MIXED, '2', '3. 等待 2 秒');
		expectStep(MIXED, '3', '4. 分支');
		expectStep(MIXED, '3.then.0', '5. 闭合夹爪');
		expectStep(MIXED, '3.else.0', '6. 打招呼');
		expectStep(MIXED, '4', '7. 往前一点');
	});

	it('原语步是**计划层**节点（与分支、等待一样没有实现可看），技能步不是', () => {
		const primitive = stepNamed(MIXED, '2. 张开夹爪');
		const skill = stepNamed(MIXED, '1. 观察桌面');
		expect(isPrimitiveNode(primitive)).toBe(true);
		expect(isPlanLayerNode(primitive)).toBe(true);
		expect(isPlanLayerNode(skill)).toBe(false);
		// 臂里的原语步同样是计划层节点（判据只看节点类型，不看它在哪一格）
		expect(isPlanLayerNode(stepNamed(MIXED, '5. 闭合夹爪'))).toBe(true);
	});

	it('原语步没有臂：路径里给它接一段臂就是悬空，不猜一个位置', () => {
		expect(nodeAtPlanPath(MIXED, '1.then.0')).toBeNull();
		expect(nodeAtPlanPath(MIXED, '1.then')).toBeNull();
	});

	it('素材里的原语名都在真目录里（没有编出来的假原语）', () => {
		const refs = new Set(ROBOFRAME_SO101_CATALOG.primitives.map((primitive) => primitive.primitiveRef));
		const used = MIXED.nodes.flatMap((node) => {
			const ref = node.parameters['primitive'];
			return typeof ref === 'string' ? [ref] : [];
		});
		expect(used.length).toBeGreaterThan(0);
		for (const ref of used) expect(refs).toContain(ref);
	});
});
