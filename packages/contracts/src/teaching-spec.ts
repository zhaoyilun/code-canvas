/**
 * **教学规格**：第二次模型调用的产出，也是屏幕上那三样东西的唯一依据。
 *
 * 为什么要有这一层：任务 JSON（`workflow.ts` 的声明）是**给机器吃的**契约——3D 运行、
 * 下发 bridge、真机都吃它，它不认识「怎么讲」。而屏幕上那三张图（流程图 / 积木 / 教学代码）
 * 要回答的是「这台机器为了做这件事，一步步在干什么」——`inspect_scene` 在声明里只有
 * `move_to_named_pose(pose_name="observe_table")` 一条原语，光看那一行没什么可教的。
 *
 * 谁写它：**模型**（第二次调用：任务 JSON + 目录 → 这份规格）。不是我们从目录推的——
 * 从目录推的那套（`plan-structure` / `code-render`）曾经是屏幕上的真相，现在不是了：
 * 它讲不出「视觉定位 → 规划 → 靠近 → 合爪 → 抬起 → 验证」这种执行侧内部的管线，
 * 那正是教学要讲的东西。
 *
 * 三条纪律（提示词里写着同一份，写在代码里的是它们为什么成立）：
 *
 * 1. **目录里有的必须照目录说**（技能名、原语名、参数、坐标、到位值都从目录来）；
 *    目录里没有的（执行侧内部怎么做的）可以讲，但**不许编具体数值**。
 * 2. **不许一块包全部**：一个动作至少要拆成调用块 + 实参值块；有 `if` 就是 C 形块 +
 *    里面嵌一条语句链。这条不是「好看」——一块包全部，积木画布上就只有一块，
 *    教学一句话就讲完了。
 * 3. **模型赢**：这份规格与任务 JSON 对不上也不拦（校验只拦「形状不成话」，
 *    见下面的 `superRefine`），界面上也不做任何区分标注。真相通道
 *    （`state/document.ts` 的声明）一个字节都不因为这份规格而改变。
 *
 * 校验的边界要说清楚：这里只校验**形状**（引用存在、图连得通、块树成棵、拆得开），
 * 不校验「它说的是不是事实」——那件事没有机器可核的判据，只有目录可对照，
 * 而对照的结果在屏幕上是**并列显示**，不是自动否决。
 */
import { z } from 'zod';

/** 规格版本。模型要照这个数写；改了形状就加一。 */
export const TEACHING_SPEC_VERSION = 1;

/** 一个标识符式的键（节点 id、实参名）。限死在 ASCII 上，免得图里出现两个长得一样的 id。 */
const keySchema = z
	.string()
	.trim()
	.min(1)
	.max(64)
	.regex(/^[A-Za-z_][A-Za-z0-9_]*$/, '只能由字母、数字、下划线组成，且以字母或下划线开头');

// ---------------------------------------------------------------------------
// 一、流程图
// ---------------------------------------------------------------------------

/**
 * 节点种类：动作/技能、条件分支、等待、开始、结束。
 *
 * 这五种就是全部——多一种渲染层就得多画一种形状，而每多一种都得说得出它跟已有那种的区别。
 */
export const flowNodeKindSchema = z.enum(['start', 'end', 'action', 'decision', 'wait']);
export type FlowNodeKind = z.infer<typeof flowNodeKindSchema>;

export const flowNodeSchema = z
	.object({
		id: keySchema,
		kind: flowNodeKindSchema,
		/** 节点上那一行字（一个人话的动作名，例如「移动到观察位」）。 */
		title: z.string().trim().min(1).max(64),
		/** 第二行：参数摘要 / 判据 / 说明。没有就不写。 */
		detail: z.string().trim().min(1).max(120).optional(),
	})
	.strict();
export type FlowNode = z.infer<typeof flowNodeSchema>;

/**
 * 分支臂：一条出边从哪个口子出来。
 *
 * `then` / `else` 只出现在**条件分支**的出边上（「是」那一路与「否」那一路）；
 * 其余节点的出边不带臂（`arm` 缺省）。渲染层按它决定箭头从节点下方还是右侧出来，
 * 以及要不要在线上标一句「是 / 否」。
 */
export const flowArmSchema = z.enum(['then', 'else']);
export type FlowArm = z.infer<typeof flowArmSchema>;

export const flowEdgeSchema = z
	.object({
		from: keySchema,
		to: keySchema,
		arm: flowArmSchema.optional(),
		/** 线上的字（可选）。分支臂没给时渲染层写「是 / 否」，给了就用给的那句。 */
		label: z.string().trim().min(1).max(24).optional(),
	})
	.strict();
export type FlowEdge = z.infer<typeof flowEdgeSchema>;

/**
 * 流程图：节点 + 带方向的边。
 *
 * 这些不是「顺手校验一下」的装饰：布局（dagre）要一张真正的有向图才排得出层次，
 * 边的两端落空、id 重名、开始节点不止一个，画出来都是错的东西。
 * 排在开始节点后面走不到的节点同样是错的——它在图上一定画得出来，却哪条路都到不了。
 */
export const flowGraphSchema = z
	.object({
		nodes: z.array(flowNodeSchema).min(2),
		edges: z.array(flowEdgeSchema),
	})
	.strict()
	.superRefine((graph, ctx) => {
		const byId = new Map<string, FlowNode>();
		for (const [index, node] of graph.nodes.entries()) {
			if (byId.has(node.id)) {
				ctx.addIssue({
					code: 'custom',
					path: ['nodes', index, 'id'],
					message: `节点 id ${node.id} 重复了`,
				});
				continue;
			}
			byId.set(node.id, node);
		}

		const starts = graph.nodes.filter((node) => node.kind === 'start');
		if (starts.length !== 1) {
			ctx.addIssue({ code: 'custom', path: ['nodes'], message: `开始节点要正好一个，这里有 ${starts.length} 个` });
		}
		if (!graph.nodes.some((node) => node.kind === 'end')) {
			ctx.addIssue({ code: 'custom', path: ['nodes'], message: '一个结束节点都没有' });
		}

		for (const [index, edge] of graph.edges.entries()) {
			const from = byId.get(edge.from);
			const to = byId.get(edge.to);
			if (from === undefined) {
				ctx.addIssue({ code: 'custom', path: ['edges', index, 'from'], message: `边的起点 ${edge.from} 不在节点里` });
			}
			if (to === undefined) {
				ctx.addIssue({ code: 'custom', path: ['edges', index, 'to'], message: `边的终点 ${edge.to} 不在节点里` });
			}
			if (edge.from === edge.to) {
				ctx.addIssue({ code: 'custom', path: ['edges', index], message: `边 ${edge.from} → ${edge.to} 自己连自己` });
			}
			// 臂只属于条件分支的出边：别的节点带臂，画出来是一条没有出处的「是 / 否」。
			if (from !== undefined && (from.kind === 'decision') !== (edge.arm !== undefined)) {
				ctx.addIssue({
					code: 'custom',
					path: ['edges', index],
					message:
						from.kind === 'decision'
							? `条件分支 ${from.id} 的出边要标 arm（then / else）`
							: `${from.kind} 节点 ${from.id} 的出边不该带 arm`,
				});
			}
		}

		// 同一个分支的两条出边不许同臂：那样两条边在图上是一回事，画出来却要分两路。
		for (const node of graph.nodes) {
			if (node.kind !== 'decision') continue;
			const arms = graph.edges.filter((edge) => edge.from === node.id).map((edge) => edge.arm);
			if (new Set(arms).size !== arms.length) {
				ctx.addIssue({ code: 'custom', path: ['nodes'], message: `条件分支 ${node.id} 的两条出边用了同一条臂` });
			}
		}

		// 走得到的才算图上的一部分：开始节点出发做一次广度优先。
		const start = starts[0];
		if (start !== undefined) {
			const outgoing = new Map<string, string[]>();
			for (const edge of graph.edges) {
				if (!byId.has(edge.from) || !byId.has(edge.to)) continue;
				outgoing.set(edge.from, [...(outgoing.get(edge.from) ?? []), edge.to]);
			}
			const seen = new Set<string>([start.id]);
			const queue = [start.id];
			while (queue.length > 0) {
				for (const next of outgoing.get(queue.shift() as string) ?? []) {
					if (seen.has(next)) continue;
					seen.add(next);
					queue.push(next);
				}
			}
			const unreachable = graph.nodes.filter((node) => !seen.has(node.id)).map((node) => node.id);
			if (unreachable.length > 0) {
				ctx.addIssue({
					code: 'custom',
					path: ['nodes'],
					message: `从开始节点走不到：${unreachable.join('、')}`,
				});
			}
		}
	});
export type FlowGraph = z.infer<typeof flowGraphSchema>;

// ---------------------------------------------------------------------------
// 二、积木（一棵可嵌套的块树）
// ---------------------------------------------------------------------------

/**
 * 实参值块：插在调用块的**槽位**里的那一块东西。
 *
 * 为什么调用块的实参必须是**块**而不是一段文本：积木画布上「参数」是插进去的一块，
 * 不是写在块上的一行字——只有这样才能嵌（一个调用块的值槽里放另一个调用块）。
 */
export interface TeachingValueBlock {
	readonly kind: 'number' | 'text' | 'bool' | 'call';
	/** 数字 / 文本 / 布尔的取值；`call` 时没有。 */
	readonly value?: number | string | boolean;
	/** `call` 的块面文字（例如「读当前末端位姿」）。 */
	readonly label?: string;
	/** `call` 的实参（最多三层，够了：值块里的调用再嵌值块，教学讲不到更深处）。 */
	readonly args?: readonly TeachingCallArgument[];
}

export interface TeachingCallArgument {
	readonly name: string;
	readonly value: TeachingValueBlock;
}

export const teachingValueBlockSchema: z.ZodType<TeachingValueBlock> = z.lazy(() =>
	z
		.discriminatedUnion('kind', [
			z.object({ kind: z.literal('number'), value: z.number() }).strict(),
			z.object({ kind: z.literal('text'), value: z.string().trim().min(1).max(120) }).strict(),
			z.object({ kind: z.literal('bool'), value: z.boolean() }).strict(),
			z
				.object({
					kind: z.literal('call'),
					label: z.string().trim().min(1).max(64),
					args: z.array(teachingCallArgumentSchema).max(6),
				})
				.strict(),
		])
		.superRefine((block, ctx) => {
			if (block.kind !== 'call') return;
			const names = (block.args ?? []).map((argument) => argument.name);
			if (new Set(names).size !== names.length) {
				ctx.addIssue({ code: 'custom', path: ['args'], message: `实参名重复：${names.join('、')}` });
			}
		}),
);

export const teachingCallArgumentSchema: z.ZodType<TeachingCallArgument> = z.lazy(() =>
	z.object({ name: keySchema, value: teachingValueBlockSchema }).strict(),
);

/**
 * 语句块：能串成一条链、能嵌进 C 形块肚子里的那一类。
 *
 * 五种：
 * - `call`：一次调用（一个技能、一条原语、或执行侧管线里的一步），可带实参值块；
 * - `if`：C 形条件块（判据是值块，两条链嵌在肚子里）——**这一种是「不许一块包全部」的判据**；
 * - `repeat`：C 形重复块（重复 N 次，肚子里一条链）；
 * - `wait`：等待块（等 N 秒，秒数是值块）；
 * - `note`：说明块（只讲一句话，不做动作）——执行侧内部那种讲得出、目录里没有的环节，
 *   用它与调用块交替着写，别把它塞进某个块的字段里。
 */
export interface TeachingBlock {
	readonly kind: 'call' | 'if' | 'repeat' | 'wait' | 'note';
	/** `call` 的块面文字。 */
	readonly label?: string;
	/** `call` 的实参值块。 */
	readonly args?: readonly TeachingCallArgument[];
	/** `if` 的判据。 */
	readonly condition?: TeachingValueBlock;
	/** `if` / `repeat` 肚子里的那条链。 */
	readonly body?: readonly TeachingBlock[];
	/** `if` 的否则那一臂。 */
	readonly otherwise?: readonly TeachingBlock[];
	/** `repeat` 的重复次数。 */
	readonly times?: TeachingValueBlock;
	/** `wait` 等多少秒。 */
	readonly seconds?: TeachingValueBlock;
	/** `note` 的那句话。 */
	readonly text?: string;
}

const statementChain = (): z.ZodType<readonly TeachingBlock[]> => z.array(teachingBlockSchema).min(1);

export const teachingBlockSchema: z.ZodType<TeachingBlock> = z.lazy(() =>
	z.discriminatedUnion('kind', [
		z
			.object({
				kind: z.literal('call'),
				label: z.string().trim().min(1).max(64),
				args: z.array(teachingCallArgumentSchema).max(8),
			})
			.strict(),
		z
			.object({
				kind: z.literal('if'),
				condition: teachingValueBlockSchema,
				body: statementChain(),
				otherwise: statementChain().optional(),
			})
			.strict(),
		z.object({ kind: z.literal('repeat'), times: teachingValueBlockSchema, body: statementChain() }).strict(),
		z.object({ kind: z.literal('wait'), seconds: teachingValueBlockSchema }).strict(),
		z.object({ kind: z.literal('note'), text: z.string().trim().min(1).max(200) }).strict(),
	]),
);

/**
 * 数一棵块树里一共有几块（含嵌在实参槽里的值块）。
 *
 * 它是「不许一块包全部」那条硬要求的**机械面**：一块包全部时这个数是 1。
 * 阈值定在 2 是有意的低——判据要拦的是「一个技能画成光秃秃一块」，
 * 不是规定每个技能至少拆几块（那件事目录里没有依据，是讲法，不是事实）。
 */
export const teachingBlockCount = (blocks: readonly TeachingBlock[]): number => {
	let count = 0;
	const countValue = (block: TeachingValueBlock): void => {
		count += 1;
		for (const argument of block.args ?? []) countValue(argument.value);
	};
	const walk = (block: TeachingBlock): void => {
		count += 1;
		if (block.kind === 'call') for (const argument of block.args ?? []) countValue(argument.value);
		if (block.kind === 'if') {
			if (block.condition !== undefined) countValue(block.condition);
			for (const child of block.body ?? []) walk(child);
			for (const child of block.otherwise ?? []) walk(child);
		}
		if (block.kind === 'repeat') {
			if (block.times !== undefined) countValue(block.times);
			for (const child of block.body ?? []) walk(child);
		}
		if (block.kind === 'wait' && block.seconds !== undefined) countValue(block.seconds);
	};
	for (const block of blocks) walk(block);
	return count;
};

/**
 * 一棵块树 → 铺开用的**深度优先序**（先父后子，实参值块跟在它那个调用块后面）。
 *
 * 节奏器（`step-playback.ts` 的 `flattenSteps`）要的就是这个序：先摆外框，再往肚子里填。
 * 这里比通用版多一件事——**值块也是块**，它插进槽里的那一刻也该是一格，
 * 否则「一块块落进来」在实参那一层就断了。
 */
export const flattenTeachingBlocks = (
	blocks: readonly TeachingBlock[],
): readonly (TeachingBlock | TeachingValueBlock)[] => {
	const out: (TeachingBlock | TeachingValueBlock)[] = [];
	const pushValue = (block: TeachingValueBlock): void => {
		out.push(block);
		for (const argument of block.args ?? []) pushValue(argument.value);
	};
	const visit = (block: TeachingBlock): void => {
		out.push(block);
		if (block.kind === 'call') for (const argument of block.args ?? []) pushValue(argument.value);
		if (block.kind === 'if') {
			if (block.condition !== undefined) pushValue(block.condition);
			for (const child of block.body ?? []) visit(child);
			for (const child of block.otherwise ?? []) visit(child);
		}
		if (block.kind === 'repeat') {
			if (block.times !== undefined) pushValue(block.times);
			for (const child of block.body ?? []) visit(child);
		}
		if (block.kind === 'wait' && block.seconds !== undefined) pushValue(block.seconds);
	};
	for (const block of blocks) visit(block);
	return out;
};

// ---------------------------------------------------------------------------
// 三、教学代码
// ---------------------------------------------------------------------------

/**
 * 教学代码：**模型写的一整段文本**（不是我们从块树生成的）。
 *
 * 为什么不让渲染层从块树生成：块树是「机器动作」的形状，代码要讲的是**这件事本身**
 * ——注释、为什么这么做、失败怎么办。让渲染层去拼，拼出来的只是块树的另一种写法，
 * 「教学」两个字就没了。所以这里就是一个字符串，屏幕上原样显示。
 */
export const teachingCodeSchema = z.string().trim().min(1).max(8000);

// ---------------------------------------------------------------------------
// 规格
// ---------------------------------------------------------------------------

export const teachingSpecSchema = z
	.object({
		version: z.literal(TEACHING_SPEC_VERSION),
		/** 这次教学的名字（一行）。 */
		title: z.string().trim().min(1).max(80),
		flow: flowGraphSchema,
		blocks: z.array(teachingBlockSchema).min(1),
		code: teachingCodeSchema,
	})
	.strict()
	.superRefine((spec, ctx) => {
		// 「不许一块包全部」的机械面（见 `teachingBlockCount`）。
		if (teachingBlockCount(spec.blocks) < 2) {
			ctx.addIssue({
				code: 'custom',
				path: ['blocks'],
				message: '整棵块树只有一块——一个动作不许一块包全部，至少要拆成调用块与实参值块',
			});
		}
	});

export type TeachingSpec = z.infer<typeof teachingSpecSchema>;

/** 一次「这份规格能不能用」的判定（调用方只认这一个入口，与 `loadTaskJson` 同一个口径）。 */
export type TeachingSpecParse =
	| { readonly ok: true; readonly spec: TeachingSpec }
	| { readonly ok: false; readonly message: string; readonly issues: readonly string[] };

/**
 * 文本 → 教学规格。剥围栏、解析、过 schema，全在这一处。
 *
 * 失败时把**每一条 issue 的路径与话**都交回去：模型下一轮要照着改的就是这些字，
 * 界面上「为什么没画出来」也说不出一句比它更准的。
 */
export const parseTeachingSpec = (text: string): TeachingSpecParse => {
	let value: unknown;
	try {
		value = JSON.parse(text);
	} catch (error) {
		return {
			ok: false,
			message: `模型给的不是 JSON：${error instanceof Error ? error.message : String(error)}`,
			issues: [],
		};
	}
	const parsed = teachingSpecSchema.safeParse(value);
	if (parsed.success) return { ok: true, spec: parsed.data };
	return {
		ok: false,
		message: '模型给的规格形状不对',
		issues: parsed.error.issues.map((issue) => `${issue.path.join('.') || '(根)'}：${issue.message}`),
	};
};
