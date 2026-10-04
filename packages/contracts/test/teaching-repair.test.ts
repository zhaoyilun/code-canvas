/**
 * 修补层（`src/teaching-repair.ts`）的**够用性**：判据不是"能修几个"，是
 * **换模型、换设备之后还够不够用**。
 *
 * 所以这一份分三段：
 *
 * 1. **真实那一份**：2026-10 把用户卡住的那次模型输出（「旋转360度」，逐字记在这里），
 *    它必须被修好——那是这一层存在的理由。
 * 2. **换个模型会怎么变**：把各家模型常见的表达差异逐条列出来（多键、数值写成字符串、
 *    真假写成字符串、给不存在的臂、发明节点、超长文本），一条一个用例。
 * 3. **不该修的绝不修**：真"说不通"的（缺开始节点、块树空、代码段拼不出来）**必须仍然被拒**——
 *    修补层不是把校验拆了，是把校验搬到"修完之后"。这一段的每一条都在守着这句话。
 */
import { describe, expect, it } from 'vitest';
import { repairTeachingSpec, reparsedAfterRepair } from '../src/teaching-repair';
import { teachingSpecSchema, type TeachingSpecInput } from '../src/teaching-spec';

/** 一份合格的规格：每个用例都从它出发，只改要测的那一处。 */
const spec = (): TeachingSpecInput => ({
	version: 2,
	title: '看一眼桌面',
	flow: {
		nodes: [
			{ id: 'start', kind: 'start', title: '开始' },
			{ id: 'look', kind: 'action', title: '看一眼', planPath: '0' },
			{ id: 'end', kind: 'end', title: '结束' },
		],
		edges: [
			{ from: 'start', to: 'look' },
			{ from: 'look', to: 'end' },
		],
	},
	blocks: [
		{
			kind: 'call',
			label: '看一眼',
			args: [{ name: 'frame', value: { kind: 'text', value: 'table' } }],
			planPath: 'look',
		},
	],
	codeSegments: [{ planPath: 'look', lines: ['看一眼()'] }],
});

const cloned = (): Record<string, unknown> => JSON.parse(JSON.stringify(spec())) as Record<string, unknown>;

const repairsOf = (raw: unknown, context: { knownPlanPaths?: readonly string[] } = {}): readonly string[] =>
	repairTeachingSpec(raw, context).repairs.map((repair) => `${repair.path}：${repair.what}`);

const repairedOk = (raw: unknown): boolean => reparsedAfterRepair(raw) !== null;

/** 这次任务会走到的路径：夹具那份声明只有 `0` 一条，所以用例里的 "look" 是块/段指的**流程节点 id**，不在这张表里。 */
const PLAN_PATHS = ['0'] as const;

describe('真实那一份：把用户卡住的那次输出修好', () => {
	/**
	 * 2026-10-04 的原文（截图里那段 JSON，逐字抄来，只截到出问题的那一层）。
	 *
	 * 病灶：任务只有一步，模型为了讲清楚加了个 `wait` 框"等旋转走完"，
	 * 并给它编了一个越界的 `planPath: "2"` —— 整份被拒，三块画布全空。
	 * 注意那份输出里**连"等"的实参都写成了字符串**（`"value": "1"` 那种写法在别的模型上很常见），
	 * 所以这个用例一次盖住两件事。
	 */
	const realOutput = {
		version: 2,
		title: '夹爪顺时针旋转 360 度：一步动作的完整教学',
		flow: {
			nodes: [
				{ id: 'start', kind: 'start', title: '开始' },
				{ id: 'n1', kind: 'action', title: '顺时针旋转夹爪 360 度', detail: 'rotate_gripper_cw(motion_distance=360)', planPath: '0' },
				{ id: 'n2', kind: 'wait', title: '等旋转走完', detail: '等待执行侧把 360 度转完再收尾', planPath: '2' },
				{ id: 'end', kind: 'end', title: '结束' },
			],
			edges: [
				{ from: 'start', to: 'n1' },
				{ from: 'n1', to: 'n2' },
				{ from: 'n2', to: 'end' },
			],
		},
		blocks: [
			{
				kind: 'call',
				label: 'rotate_gripper_cw',
				args: [{ name: 'motion_distance', value: { kind: 'number', value: '360' } }],
				planPath: 'n1',
			},
			{ kind: 'note', text: '这一步只做一件事：绕当前末端局部 Z 轴顺时针转 360 度。', planPath: 'n1' },
			{ kind: 'wait', seconds: { kind: 'number', value: 1 }, planPath: 'n2' },
		],
		codeSegments: [
			{ planPath: 'n1', lines: ['rotate_gripper_cw(motion_distance=360)'] },
			{ planPath: 'n2', lines: ['# 等它转完'] },
		],
	};

	it('修完就过：编出来的路径被摘掉、字符串数值还原成数、这个框变成纯讲解框', () => {
		// 这次任务只有一步，所以"真的会走到的路径"就一条：`0`。
		// 模型写的 `"2"` 语法合法、但声明里没有——**只判语法是抓不住它的**。
		const outcome = reparsedAfterRepair(realOutput, { knownPlanPaths: ['0'] });
		expect(outcome, `没修好，修补记录：\n${repairsOf(realOutput, { knownPlanPaths: ['0'] }).join('\n')}`).not.toBeNull();
		if (outcome === null) return;

		const notes = outcome.repairs.map((repair) => `${repair.path}：${repair.what}`);
		expect(notes.join('\n')).toContain('flow.nodes[2].planPath');
		expect(notes.join('\n')).toContain('摘掉这个框的联动');

		// 「等旋转走完」那个框还在（照画），只是不再假装自己跟着某一步走。
		const nodes = (outcome.spec as { flow: { nodes: readonly { id: string; planPath?: string }[] } }).flow.nodes;
		const wait = nodes.find((item) => item.id === 'n2');
		expect(wait).toBeDefined();
		expect(wait?.planPath).toBeUndefined();

		// 数值串被还原：不然执行侧拿到的是字符串 "360"。
		const blocks = (outcome.spec as { blocks: readonly { args?: readonly { value: { value: unknown } }[] }[] }).blocks;
		expect(blocks[0]?.args?.[0]?.value.value).toBe(360);
	});
});

describe('换一个模型会怎么变：表达差异逐条修', () => {
	it('块上多写了不认识的字（模型最爱在 call 上加 body）——摘掉，不拒', () => {
		const raw = cloned();
		(raw['blocks'] as Record<string, unknown>[])[0] = {
			kind: 'call',
			label: '看一眼',
			args: [{ name: 'frame', value: { kind: 'text', value: 'table' } }],
			planPath: 'look',
			body: [{ kind: 'note', text: '多余的' }],
		};
		expect(repairedOk(raw), repairsOf(raw).join('\n')).toBe(true);
		expect(repairsOf(raw).join('\n')).toContain('摘掉不认识的字：body');
	});

	it('节点上多写了不认识的字（description / type / x / y）——摘掉，不拒', () => {
		const raw = cloned();
		const nodes = (raw['flow'] as { nodes: Record<string, unknown>[] }).nodes;
		nodes[1] = { ...nodes[1], description: '说明', type: 'action', x: 0, y: 0 };
		expect(repairedOk(raw)).toBe(true);
		expect(repairsOf(raw).join('\n')).toContain('description、type、x、y');
	});

	it('数值写成字符串（"0.03" / "360"）——还原成数', () => {
		const raw = cloned();
		(raw['blocks'] as Record<string, unknown>[])[0] = {
			kind: 'call',
			label: '看一眼',
			args: [{ name: 'distance', value: { kind: 'number', value: '0.03' } }],
			planPath: 'look',
		};
		expect(repairedOk(raw)).toBe(true);
		const outcome = reparsedAfterRepair(raw);
		const blocks = (outcome?.spec as { blocks: readonly { args?: readonly { value: { value: unknown } }[] }[] }).blocks;
		expect(blocks[0]?.args?.[0]?.value.value).toBe(0.03);
	});

	it('带单位的数值串（"0.03 m"）**不动**——那要人判断，我们不猜', () => {
		const raw = cloned();
		(raw['blocks'] as Record<string, unknown>[])[0] = {
			kind: 'call',
			label: '看一眼',
			args: [{ name: 'distance', value: { kind: 'number', value: '0.03 m' } }],
			planPath: 'look',
		};
		// 修不了 ⇒ 仍然被拒（这一条守的是"只做有确定答案的修补"）。
		expect(repairedOk(raw)).toBe(false);
	});

	it('真假写成字符串（"true"）——还原成布尔', () => {
		const raw = cloned();
		raw['blocks'] = [{ kind: 'wait', seconds: { kind: 'bool', value: 'true' }, planPath: 'look' }];
		expect(repairedOk(raw)).toBe(true);
		const outcome = reparsedAfterRepair(raw);
		const blocks = (outcome?.spec as { blocks: readonly { seconds: { value: unknown } }[] }).blocks;
		expect(blocks[0]?.seconds.value).toBe(true);
	});

	it('给了一条没有的臂（arm: "yes"）——摘掉臂，边留下', () => {
		const raw = cloned();
		(raw['flow'] as { edges: Record<string, unknown>[] }).edges[1] = { from: 'look', to: 'end', arm: 'yes' };
		expect(repairedOk(raw)).toBe(true);
		expect(repairsOf(raw).join('\n')).toContain('臂 "yes" 不认识');
	});

	it('发明了一个不存在的步：语法合法（"9.then"）与语法不合法（"then.0"）都摘掉联动，框留下', () => {
		for (const invented of ['9.then', 'then.0']) {
			const raw = cloned();
			(raw['flow'] as { nodes: Record<string, unknown>[] }).nodes[1] = {
				...((raw['flow'] as { nodes: Record<string, unknown>[] }).nodes[1] ?? {}),
				planPath: invented,
			};
			expect(repairedOk(raw), invented).toBe(true);
		}

		// 也能拦住"语法合法、声明里没有"的那一种——用户那次的真实病灶。
		const raw = cloned();
		(raw['flow'] as { nodes: Record<string, unknown>[] }).nodes[1] = {
			...((raw['flow'] as { nodes: Record<string, unknown>[] }).nodes[1] ?? {}),
			planPath: '7',
		};
		expect(repairedOk(raw)).toBe(true);
		const outcome = reparsedAfterRepair(raw, { knownPlanPaths: PLAN_PATHS });
		const nodes = (outcome?.spec as { flow: { nodes: readonly { id: string; planPath?: string }[] } }).flow.nodes;
		expect(nodes.find((item) => item.id === 'look')?.planPath).toBeUndefined();
	});

	it('title / detail / 讲解词太长——截断，不拒（那是版面，不是判据）', () => {
		const raw = cloned();
		(raw['flow'] as { nodes: Record<string, unknown>[] }).nodes[1] = {
			...(raw['flow'] as { nodes: Record<string, unknown>[] }).nodes[1],
			title: '看'.repeat(200),
			detail: '说'.repeat(400),
		};
		expect(repairedOk(raw)).toBe(true);
		expect(repairsOf(raw).join('\n')).toContain('太长');
	});

	it('顶层与代码段上多写的字——摘掉', () => {
		const raw = cloned();
		raw['notes'] = '我自己加的';
		(raw['codeSegments'] as Record<string, unknown>[])[0] = { ...(raw['codeSegments'] as Record<string, unknown>[])[0], indent: 2 };
		expect(repairedOk(raw)).toBe(true);
		expect(repairsOf(raw).join('\n')).toContain('notes');
	});
});

describe('不该修的绝不修：真说不通的仍然被拒', () => {
	it('缺开始节点——拒（图上没有入口，画不出来）', () => {
		const raw = cloned();
		(raw['flow'] as { nodes: Record<string, unknown>[] }).nodes = (
			raw['flow'] as { nodes: Record<string, unknown>[] }
		).nodes.filter((node) => node['kind'] !== 'start');
		expect(repairedOk(raw)).toBe(false);
	});

	it('一个结束节点都没有——拒', () => {
		const raw = cloned();
		(raw['flow'] as { nodes: Record<string, unknown>[] }).nodes = (
			raw['flow'] as { nodes: Record<string, unknown>[] }
		).nodes.filter((node) => node['kind'] !== 'end');
		expect(repairedOk(raw)).toBe(false);
	});

	it('块树是空的——拒（讲不了一步）', () => {
		const raw = cloned();
		raw['blocks'] = [];
		expect(repairedOk(raw)).toBe(false);
	});

	it('代码段是空的——拒', () => {
		const raw = cloned();
		raw['codeSegments'] = [];
		expect(repairedOk(raw)).toBe(false);
	});

	it('分支节点没写 planPath——拒（修补层不替它猜是哪一步的成败）', () => {
		const raw = cloned();
		(raw['flow'] as { nodes: Record<string, unknown>[] }).nodes = [
			{ id: 'start', kind: 'start', title: '开始' },
			{ id: 'seen', kind: 'decision', title: '看到了吗' },
			{ id: 'end', kind: 'end', title: '结束' },
		];
		(raw['flow'] as { edges: Record<string, unknown>[] }).edges = [
			{ from: 'start', to: 'seen' },
			{ from: 'seen', to: 'end', arm: 'then' },
		];
		expect(repairedOk(raw)).toBe(false);
		const issues = teachingSpecSchema.safeParse(repairTeachingSpec(raw).value);
		expect(issues.success).toBe(false);
		if (!issues.success) expect(issues.error.issues.map((issue) => issue.message).join('\n')).toContain('没写 planPath');
	});
});

describe('修补层不动没坏的规格', () => {
	it('一份合格规格：零修补、逐字节不变', () => {
		const raw = cloned();
		const outcome = repairTeachingSpec(raw);
		expect(outcome.repairs).toEqual([]);
		expect(JSON.stringify(outcome.value)).toBe(JSON.stringify(raw));
	});

	it('修两遍与修一遍结果相同（修补是幂等的）', () => {
		const raw = cloned();
		(raw['blocks'] as Record<string, unknown>[])[0] = {
			kind: 'call',
			label: '看一眼',
			args: [{ name: 'frame', value: { kind: 'text', value: 'table' } }],
			planPath: 'look',
			body: [],
		};
		const once = repairTeachingSpec(raw).value;
		const twice = repairTeachingSpec(once).value;
		expect(JSON.stringify(twice)).toBe(JSON.stringify(once));
		expect(repairTeachingSpec(once).repairs).toEqual([]);
	});
});
