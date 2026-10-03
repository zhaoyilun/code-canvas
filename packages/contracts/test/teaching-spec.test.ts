/**
 * 教学规格的**对应关系**（v2 加的那三栏）：流程节点 → 声明里的哪一步、
 * 积木 → 哪个流程节点、代码分段 → 哪个流程节点。
 *
 * 这一份守四件事：
 *
 * 1. **形状那一层**：动作/分支/等待节点必须写 `planPath`、start/end 不许写、路径要合语法；
 *    同一个路径不许被两个框指着（一个步骤只许有一个框）。
 * 2. **对账那一层**（拿着声明）：路径指不到声明里的任何一步 → **拒**；一个步骤被两个框指 → 拒；
 *    积木与代码段指到一个不在图上的节点 → 拒。
 * 3. **`code` 是拼出来的**：模型只交 `codeSegments`，`code` 由 `codeOfSegments` 拼——
 *    行范围是数出来的（`segmentLineRanges`），不是模型写的。
 * 4. **块树的归属**：顶层必须写、嵌套不写就跟着父块走、值块跟着它那个调用块
 *    （`flattenedBlockAnchors` 与铺开序严格同序）。
 *
 * 对账那一层用一份**手写的假声明**（不引 task-import，contracts 不认识它）：
 * 这里要量的是「路径推不推得到」，不是「技能计划导得对不对」。
 */
import { describe, expect, it } from 'vitest';
import { computeWorkflowDigest, type WorkflowDeclaration, type WorkflowNode } from '../src/workflow';
import {
	blockAnchors,
	codeOfSegments,
	flattenedBlockAnchors,
	flattenTeachingBlocks,
	findTeachingSpecIssues,
	isPlanPathSyntax,
	parseTeachingSpec,
	planPathSegments,
	segmentLineRanges,
	teachingSpecSchema,
	type TeachingSpecInput,
} from '../src/teaching-spec';

const node = (id: string, name: string, type = 'task.action', parameters: Record<string, unknown> = {}): WorkflowNode => ({
	id,
	name,
	type,
	typeVersion: 1,
	parameters: parameters as WorkflowNode['parameters'],
	position: { x: 0, y: 0 },
	disabled: false,
});

/**
 * 一份假声明：四步，第 2 步是个分支，两条臂各一步。
 *
 * 走得到的路径：`0`、`1`、`1.then.0`、`1.else.0`、`2`。
 */
const BRANCH_NODE = 'nd_branch';
const THEN_NODE = 'nd_then';
const ELSE_NODE = 'nd_else';
const FIRST_NODE = 'nd_first';
const LAST_NODE = 'nd_last';

const declaration = ((): WorkflowDeclaration => {
	const draft = {
		formatVersion: 1 as const,
		id: 'wf_test',
		name: '测试计划',
		nodes: [
			node(FIRST_NODE, '1. 看一眼'),
			node(BRANCH_NODE, '2. 分支', 'task.branch', { condition: { field: 'last.success', op: '==', value: false } }),
			node(THEN_NODE, '3. 合爪'),
			node(ELSE_NODE, '4. 张爪'),
			node(LAST_NODE, '5. 往前一点'),
		],
		connections: {
			[FIRST_NODE]: { main: [[{ node: BRANCH_NODE, input: 0 }]] },
			[BRANCH_NODE]: {
				main: [[{ node: THEN_NODE, input: 0 }], [{ node: ELSE_NODE, input: 0 }], [{ node: LAST_NODE, input: 0 }]],
			},
		},
		meta: {},
	};
	return { ...draft, digest: computeWorkflowDigest(draft) };
})();

/** 声明里那条路径是哪一步（这里手写一份，与 studio 那边的 `nodeAtPlanPath` 无关）。 */
const PATHS: Readonly<Record<string, string>> = {
	'0': FIRST_NODE,
	'1': BRANCH_NODE,
	'1.then.0': THEN_NODE,
	'1.else.0': ELSE_NODE,
	'2': LAST_NODE,
};

const nodeAtPlanPath = (_declaration: WorkflowDeclaration, path: string): WorkflowNode | null => {
	const id = PATHS[path];
	if (id === undefined) return null;
	return declaration.nodes.find((candidate) => candidate.id === id) ?? null;
};

/** 一份**合格**的规格：三栏对应关系都指得到（改哪一处就坏哪一处，下面的测试都从它改）。 */
const spec = (): TeachingSpecInput => ({
	version: 2,
	title: '看一眼桌面',
	flow: {
		nodes: [
			{ id: 'start', kind: 'start', title: '开始' },
			{ id: 'look', kind: 'action', title: '看一眼', planPath: '0' },
			{ id: 'seen', kind: 'decision', title: '看到了吗', planPath: '1' },
			{ id: 'grab', kind: 'action', title: '合上夹爪', planPath: '1.else.0' },
			{ id: 'end', kind: 'end', title: '结束' },
		],
		edges: [
			{ from: 'start', to: 'look' },
			{ from: 'look', to: 'seen' },
			{ from: 'seen', to: 'grab', arm: 'then' },
			{ from: 'seen', to: 'end', arm: 'else' },
			{ from: 'grab', to: 'end' },
		],
	},
	blocks: [
		{ kind: 'note', text: '先看一眼', planPath: 'look' },
		{ kind: 'call', label: '看一眼', args: [{ name: 'frame', value: { kind: 'text', value: 'table' } }], planPath: 'look' },
		{
			kind: 'if',
			condition: { kind: 'bool', value: true },
			body: [{ kind: 'call', label: '合上夹爪', args: [] }],
			planPath: 'seen',
		},
	],
	codeSegments: [
		{ planPath: 'look', lines: ['看一眼()'] },
		{ planPath: 'seen', lines: ['如果看到了：'] },
		{ planPath: 'grab', lines: ['    合上夹爪()'] },
	],
});

const issuesOf = (input: TeachingSpecInput): readonly string[] => {
	const parsed = teachingSpecSchema.parse(input);
	const specWithCode = { ...parsed, code: codeOfSegments(parsed.codeSegments) };
	return findTeachingSpecIssues(specWithCode, declaration, (path) => nodeAtPlanPath(declaration, path)).map(
		(issue) => `${issue.fatal ? '致命' : '提醒'}：${issue.message}`,
	);
};

// ---------------------------------------------------------------------------
// 一、形状（不拿声明也判得了的那一层）
// ---------------------------------------------------------------------------

describe('对应关系的形状', () => {
	it('合格的规格过得了形状这一层，而且三栏都在', () => {
		const parsed = teachingSpecSchema.safeParse(spec());
		expect(parsed.success).toBe(true);
	});

	it('动作 / 分支 / 等待节点没写 planPath：拒（它讲的是哪一步，不写就对不上）', () => {
		const broken = spec();
		const withoutPath = { ...broken, flow: { ...broken.flow, nodes: broken.flow.nodes.map((item) => ({ ...item })) } };
		delete (withoutPath.flow.nodes[1] as { planPath?: string }).planPath;
		const parsed = teachingSpecSchema.safeParse(withoutPath);
		expect(parsed.success).toBe(false);
		if (parsed.success) return;
		expect(parsed.error.issues.map((issue) => issue.message).join('\n')).toContain('没写 planPath');
	});

	it('start / end 写了 planPath：拒（那两个框不是执行步骤）', () => {
		const broken = spec();
		broken.flow.nodes[0] = { ...broken.flow.nodes[0]!, planPath: '0' };
		const parsed = teachingSpecSchema.safeParse(broken);
		expect(parsed.success).toBe(false);
		if (parsed.success) return;
		expect(parsed.error.issues.map((issue) => issue.message).join('\n')).toContain('不该有 planPath');
	});

	it('planPath 不合语法：拒（`1.then` 停在臂上，不是一个位置）', () => {
		for (const bad of ['1.then', 'then.0', '0.1', '-1', 'a', '']) {
			expect(isPlanPathSyntax(bad)).toBe(false);
			const broken = spec();
			broken.flow.nodes[1] = { ...broken.flow.nodes[1]!, planPath: bad };
			expect(teachingSpecSchema.safeParse(broken).success).toBe(false);
		}
		for (const good of ['0', '10', '1.then.0', '1.else.2.else.0']) {
			expect(isPlanPathSyntax(good)).toBe(true);
			expect(planPathSegments(good)).not.toBeNull();
		}
	});

	it('两个框指着同一步：拒（设备跑到那一步时该亮哪一个说不清）', () => {
		// 往图上再加一个框，它指的与 `look` 是同一步（`0`）。
		const broken = spec();
		broken.flow.nodes.push({ id: 'look2', kind: 'action', title: '又看一眼', planPath: '0' });
		broken.flow.edges.push({ from: 'look2', to: 'end' });
		const parsed = teachingSpecSchema.safeParse(broken);
		expect(parsed.success).toBe(false);
		if (parsed.success) return;
		expect(parsed.error.issues.map((issue) => issue.message).join('\n')).toContain('都指着同一步');
	});

	it('一块包全部那条判据没被对应关系挤掉：仍然拒', () => {
		const broken = spec();
		broken.blocks = [{ kind: 'call', label: '看一眼', args: [], planPath: 'look' }];
		const parsed = teachingSpecSchema.safeParse(broken);
		expect(parsed.success).toBe(false);
		if (parsed.success) return;
		expect(parsed.error.issues.map((issue) => issue.message).join('\n')).toContain('一块包全部');
	});
});

// ---------------------------------------------------------------------------
// 二、对账（拿着声明判的那一层）
// ---------------------------------------------------------------------------

describe('拿声明对账', () => {
	it('合格的一份：一条问题都没有', () => {
		expect(issuesOf(spec())).toEqual([]);
	});

	it('流程节点指到一条**不存在的路径**：拒（致命）', () => {
		const broken = spec();
		broken.flow.nodes[1] = { ...broken.flow.nodes[1]!, planPath: '7' };
		const issues = issuesOf(broken);
		expect(issues.some((issue) => issue.startsWith('致命') && issue.includes('没有对应的步骤'))).toBe(true);
	});

	it('流程节点指到**越界 / 悬空**的路径（那一步后面没有臂）：拒（致命）', () => {
		for (const bad of ['0.then.0', '9.else.0', '1.then.9']) {
			const broken = spec();
			broken.flow.nodes[1] = { ...broken.flow.nodes[1]!, planPath: bad };
			const issues = issuesOf(broken);
			expect(issues.some((issue) => issue.startsWith('致命') && issue.includes('没有对应的步骤'))).toBe(true);
		}
	});

	it('两个框指的是**同一个步骤**（两条路径走到同一个节点）：拒（致命）', () => {
		/*
		 * 两条不同的路径走到同一步——那份声明是坏的（校验会拦），但规格的判据不许因此松掉。
		 * 假声明里的路径唯一，所以这里把「路径 → 节点」那一层换成一份**多对一**的：
		 * `0` 与 `1.else.0` 都指向第一个节点（`look` 与 `grab` 于是指着同一步）。
		 */
		const aliased = (path: string): WorkflowNode | null => {
			if (path === '1.else.0') return declaration.nodes[0] ?? null;
			return nodeAtPlanPath(declaration, path);
		};
		const parsed = teachingSpecSchema.parse(spec());
		const issues = findTeachingSpecIssues(
			{ ...parsed, code: codeOfSegments(parsed.codeSegments) },
			declaration,
			aliased,
		);
		expect(issues.some((issue) => issue.fatal && issue.message.includes('指的是同一步'))).toBe(true);
	});

	it('积木指到一个不在图上的节点：拒（致命）', () => {
		const broken = spec();
		broken.blocks[0] = { ...broken.blocks[0]!, planPath: 'nope' };
		const issues = issuesOf(broken);
		expect(issues.some((issue) => issue.startsWith('致命') && issue.includes('不是这张流程图上的节点'))).toBe(true);
	});

	it('代码段指到一个不在图上的节点：拒（致命）', () => {
		const broken = spec();
		broken.codeSegments[0] = { ...broken.codeSegments[0]!, planPath: 'nope' };
		const issues = issuesOf(broken);
		expect(issues.some((issue) => issue.startsWith('致命') && issue.includes('永远切不过去'))).toBe(true);
	});

	it('同一步的代码被别的步隔开：拒（致命——那一段高亮只能亮一半）', () => {
		const broken = spec();
		broken.codeSegments = [
			{ planPath: 'look', lines: ['看一眼()'] },
			{ planPath: 'seen', lines: ['如果看到了：'] },
			{ planPath: 'look', lines: ['再看一眼()'] },
		];
		const issues = issuesOf(broken);
		expect(issues.some((issue) => issue.startsWith('致命') && issue.includes('要连着写'))).toBe(true);
	});

	it('顶层一块都没写归属：**不是**致命（照画，只是不点亮），但要说一声', () => {
		const broken = spec();
		broken.blocks = [
			{ kind: 'note', text: '先看一眼' },
			{ kind: 'call', label: '看一眼', args: [{ name: 'frame', value: { kind: 'text', value: 'table' } }] },
		];
		const issues = issuesOf(broken);
		expect(issues.some((issue) => issue.startsWith('提醒') && issue.includes('跟不了当前步'))).toBe(true);
		expect(issues.some((issue) => issue.startsWith('致命'))).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// 三、文本 → 规格（`parseTeachingSpec` 那个入口）
// ---------------------------------------------------------------------------

describe('parseTeachingSpec', () => {
	const json = (input: TeachingSpecInput): string => JSON.stringify(input);

	it('指不到步的那一份：**拒**，而且理由逐条交回去', () => {
		const broken = spec();
		broken.flow.nodes[1] = { ...broken.flow.nodes[1]!, planPath: '7' };
		const parsed = parseTeachingSpec(json(broken), { declaration, nodeAtPlanPath });
		expect(parsed.ok).toBe(false);
		if (parsed.ok) return;
		expect(parsed.message).toContain('对不上');
		expect(parsed.issues.join('\n')).toContain('没有对应的步骤');
	});

	it('合格的那一份：过，并且 `code` 由分段拼出来', () => {
		const parsed = parseTeachingSpec(json(spec()), { declaration, nodeAtPlanPath });
		expect(parsed.ok).toBe(true);
		if (!parsed.ok) return;
		expect(parsed.spec.code).toBe(['看一眼()', '如果看到了：', '    合上夹爪()'].join('\n'));
		expect(parsed.warnings).toEqual([]);
	});

	it('顶层没写归属：过，但带着一句提醒（不是致命）', () => {
		const broken = spec();
		broken.blocks = [
			{ kind: 'note', text: '先看一眼' },
			{ kind: 'call', label: '看一眼', args: [{ name: 'frame', value: { kind: 'text', value: 'table' } }] },
		];
		const parsed = parseTeachingSpec(json(broken), { declaration, nodeAtPlanPath });
		expect(parsed.ok).toBe(true);
		if (!parsed.ok) return;
		expect(parsed.warnings.join('\n')).toContain('跟不了当前步');
	});

	it('不给声明：只判形状，对账那一层不跑（生成那条路一定会给）', () => {
		const broken = spec();
		broken.flow.nodes[1] = { ...broken.flow.nodes[1]!, planPath: '7' };
		const parsed = parseTeachingSpec(json(broken));
		expect(parsed.ok).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// 四、块树的归属与代码分段的行范围
// ---------------------------------------------------------------------------

describe('块树的归属', () => {
	const blocks: TeachingSpecInput['blocks'] = [
		{ kind: 'note', text: '先看一眼', planPath: 'look' },
		{
			kind: 'call',
			label: '看一眼',
			planPath: 'look',
			args: [{ name: 'frame', value: { kind: 'text', value: 'table' } }],
		},
		{
			kind: 'if',
			condition: { kind: 'bool', value: true },
			body: [{ kind: 'call', label: '合上夹爪', args: [] }],
			otherwise: [{ kind: 'call', label: '张开夹爪', args: [], planPath: 'grab' }],
			planPath: 'seen',
		},
	];

	it('嵌套不写就跟着父块走；写了自己的就用自己那个', () => {
		expect(blockAnchors(blocks)).toEqual(['look', 'look', 'seen', 'seen', 'grab']);
	});

	it('铺开序与归属表**严格同序**（含插进槽里的值块）', () => {
		const flattened = flattenTeachingBlocks(blocks);
		const anchors = flattenedBlockAnchors(blocks);
		expect(anchors).toHaveLength(flattened.length);
		// 值块跟着它那个调用块：`frame` 那个文本值块排在第 2 块后面。
		expect(anchors[2]).toBe('look');
	});

	it('顶层没写就是没有归属（`undefined`），不许就近认一个', () => {
		expect(blockAnchors([{ kind: 'note', text: '一句话' }])).toEqual([undefined]);
	});
});

describe('代码分段的行范围', () => {
	it('行范围是**数出来的**：每一段接着上一段，末行对得上总行数', () => {
		const ranges = segmentLineRanges([
			{ planPath: 'look', lines: ['a'] },
			{ planPath: 'seen', lines: ['b', 'c'] },
			{ planPath: 'grab', lines: ['d'] },
		]);
		expect(ranges).toEqual([
			{ planPath: 'look', from: 0, to: 0 },
			{ planPath: 'seen', from: 1, to: 2 },
			{ planPath: 'grab', from: 3, to: 3 },
		]);
	});

	it('`code` 就是分段拼出来的（段之间不插空行；末尾的空行折掉）', () => {
		expect(codeOfSegments([{ planPath: 'a', lines: ['1', '2'] }, { planPath: 'b', lines: ['3'] }])).toBe('1\n2\n3');
		// 末段那几个空行折掉：面板数的行数与播开队列按同一份文本切，行数不漂。
		expect(codeOfSegments([{ planPath: 'a', lines: ['1'] }, { planPath: 'b', lines: ['2', '', ''] }])).toBe('1\n2');
		// 段内的空行留着（那是排版，不是结尾）。
		expect(codeOfSegments([{ planPath: 'a', lines: ['1', ''] }, { planPath: 'b', lines: ['2'] }])).toBe('1\n\n2');
	});
});
