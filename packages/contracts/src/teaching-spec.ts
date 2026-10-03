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
 *
 * ---
 *
 * **对应关系（v2 加的，是「执行到哪一步，三视图跟着走」的唯一凭据）**
 *
 * 屏幕上那三样从前是各说各的：流程图的节点是模型起的名字、积木是一棵不相干的树、
 * 代码是一整段文本。设备一跑，没有任何一处说得清「跑到的是图上哪个框」。所以这一版把
 * **指向声明里哪一步**变成规格里必须写出来的一栏，三处共用**同一个口径**：
 *
 * 1. 流程节点：`planPath` —— 它讲的是声明里哪一步（`start` / `end` 两步不是执行步骤，
 *    所以不许带这一栏）。取值是**执行路径**（`0`、`1.then.0` 这种），与设备报上来的
 *    `runningPlanPath`、`nodeAtPlanPath` 是同一份口径（见 `apps/studio/src/views/shared/plan-structure.ts`）。
 * 2. 块树的每一块：`planPath` = **它属于哪个流程节点**（节点 id，不是执行路径）——
 *    积木是流程图的下钻，锚在流程节点上，三个视图才有一根共同的轴。
 * 3. 代码：`codeSegments` —— 一段文字 + 它属于哪个流程节点 + 它在整段里的行范围。
 *
 * 为什么第 3 样选「分段给文字」而不是「整段文字 + 行号」：行号那套要求模型**自己数行**，
 * 而它同时还在写那段文字——两份独立的产出必须逐行对上，错一位就整段错位，而我们没有任何
 * 机械判据能发现它错了（行号指得到行，指的却可能是错的那几行）。分段那套里行范围是**推出来的**，
 * 模型只产出「这一段属于哪一步」这一件事，错不了位。所以 `code` 这个字段不再由模型写：
 * 它是分段文本拼出来的（`codeOfSegments`），唯一真相是那几段。
 */
import { z } from 'zod';
// 只借它的**类型**：对账要拿声明判「这条路径指得到哪一步」。值层面没有依赖
// （`import type` 编译后什么都不剩），所以两个模块不会绕成一圈。
import type { WorkflowDeclaration, WorkflowNode } from './workflow';

/** 规格版本。模型要照这个数写；改了形状就加一。 */
export const TEACHING_SPEC_VERSION = 2;

/** 一个标识符式的键（节点 id、实参名）。限死在 ASCII 上，免得图里出现两个长得一样的 id。 */
const keySchema = z
	.string()
	.trim()
	.min(1)
	.max(64)
	.regex(/^[A-Za-z_][A-Za-z0-9_]*$/, '只能由字母、数字、下划线组成，且以字母或下划线开头');

// ---------------------------------------------------------------------------
// 零、执行路径（三处对应关系的共同口径）
// ---------------------------------------------------------------------------

/**
 * 执行路径：**顶层下标 + `then` / `else` 臂 + 臂内下标**，例如 `0`、`1.then.0`、`1.then.0.else.1`。
 *
 * 这个口径不是这里发明的：设备报的 `runningPlanPath`、`nodeAtPlanPath` 的入参、
 * 执行侧 `robot3d/roboframe/plan.ts` 组出来的 `path` 都是它。规格里那一栏跟着它走，
 * 「图上这个框」与「设备跑到的那一格」才能逐字比。
 *
 * 段数必须是奇数（下标开头、下标结尾）：偶数段的写法（`1.then`）停在臂上，不是一个位置。
 */
export const PLAN_PATH_PATTERN = /^\d+(?:\.(?:then|else)\.\d+)*$/;

/** 路径字符串 → 它指的段；形状不对就是 `null`（**不抛**：校验把它变成一条 issue）。 */
export const planPathSegments = (path: string): readonly string[] | null => {
	const trimmed = path.trim();
	if (!PLAN_PATH_PATTERN.test(trimmed)) return null;
	return trimmed.split('.');
};

/** 一条路径的**语法**对不对。语法之外还有一层「声明里真有这一步」，那要声明在手边才判得了。 */
export const isPlanPathSyntax = (path: string): boolean => planPathSegments(path) !== null;

/** 路径末段的那个下标：它在**它那一层**里是第几个（0 基）。 */
export const planPathTailIndex = (path: string): number | null => {
	const segments = planPathSegments(path);
	if (segments === null) return null;
	return Number(segments[segments.length - 1]);
};

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
		/**
		 * 这个节点讲的是**声明里的哪一步**（执行路径，见 `PLAN_PATH_PATTERN`）。
		 *
		 * 动作 / 分支 / 等待三种节点**必须**有（它们讲的就是一步）；`start` / `end` 不许有
		 * ——那两个框不是执行步骤，给它一个路径就是编的。语法之外还有一层「声明里真有这一步」，
		 * 那一层由 `findTeachingSpecIssues` 拿着声明判（见文件头）。
		 */
		planPath: z.string().trim().min(1).max(64).optional(),
	})
	.strict()
	.superRefine((node, ctx) => {
		const needsStep = node.kind !== 'start' && node.kind !== 'end';
		if (needsStep && node.planPath === undefined) {
			ctx.addIssue({
				code: 'custom',
				path: ['planPath'],
				message: `${node.kind} 节点 ${node.id} 没写 planPath：它讲的是声明里的哪一步，不写就对不上设备跑到的那一格`,
			});
			return;
		}
		if (!needsStep && node.planPath !== undefined) {
			ctx.addIssue({
				code: 'custom',
				path: ['planPath'],
				message: `${node.kind} 节点 ${node.id} 不该有 planPath：它不是声明里的一步`,
			});
			return;
		}
		if (node.planPath !== undefined && !isPlanPathSyntax(node.planPath)) {
			ctx.addIssue({
				code: 'custom',
				path: ['planPath'],
				message: `planPath「${node.planPath}」不是一条执行路径（样子是 0、1.then.0 这种：顶层下标，接 then/else 再接下标）`,
			});
		}
	});
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

		/*
		 * 一个步骤只许有一个框：两个框指着同一步，设备跑到那一步时两处一起亮（或谁亮说不清），
		 * 而「当前在哪」只有一个答案。这一条只拦**同一个路径**；同一个节点被两条不同路径走到
		 * （两条臂汇到同一步）要拿着声明才判得了，那在 `findTeachingSpecIssues` 里。
		 */
		const byPlanPath = new Map<string, string>();
		for (const node of graph.nodes) {
			if (node.planPath === undefined) continue;
			const owner = byPlanPath.get(node.planPath);
			if (owner !== undefined) {
				ctx.addIssue({
					code: 'custom',
					path: ['nodes'],
					message: `节点 ${owner} 与 ${node.id} 都指着同一步 ${node.planPath}：设备跑到那一步时该亮哪一个说不清`,
				});
				continue;
			}
			byPlanPath.set(node.planPath, node.id);
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
	/**
	 * 这块积木**属于哪个流程节点**（流程节点的 id，不是执行路径）。
	 *
	 * 积木是流程图的下钻：一个框点了之后看它里面那几块。所以锚在流程节点上而不是直接锚在步骤上
	 * ——锚在步骤上，模型就得把「哪一块属于哪一步」与「哪个框讲哪一步」各写一遍，两份说法迟早不一致。
	 * 顶层块必须有；**嵌在肚子里的块不写就跟着父块走**（`blockAnchors` 落这份继承）。
	 */
	readonly planPath?: string;
}

const statementChain = (): z.ZodType<readonly TeachingBlock[]> => z.array(teachingBlockSchema).min(1);

export const teachingBlockSchema: z.ZodType<TeachingBlock> = z.lazy(() =>
	z.discriminatedUnion('kind', [
		z
			.object({
				kind: z.literal('call'),
				label: z.string().trim().min(1).max(64),
				args: z.array(teachingCallArgumentSchema).max(8),
				planPath: keySchema.optional(),
			})
			.strict(),
		z
			.object({
				kind: z.literal('if'),
				condition: teachingValueBlockSchema,
				body: statementChain(),
				otherwise: statementChain().optional(),
				planPath: keySchema.optional(),
			})
			.strict(),
		z
			.object({
				kind: z.literal('repeat'),
				times: teachingValueBlockSchema,
				body: statementChain(),
				planPath: keySchema.optional(),
			})
			.strict(),
		z.object({ kind: z.literal('wait'), seconds: teachingValueBlockSchema, planPath: keySchema.optional() }).strict(),
		z.object({ kind: z.literal('note'), text: z.string().trim().min(1).max(200), planPath: keySchema.optional() }).strict(),
	]),
);

/**
 * 一棵块树 → **每一块锚在哪个流程节点上**（`flattenTeachingBlocks` 那个序，一格对一格）。
 *
 * `undefined` = 这一块没有归属（顶层没写 `planPath`，或者写的那个 id 不在图里）。
 * 嵌套块不写就跟着父块走；写了就用自己的——「不许猜一个对应顶上」在这儿的落法是：
 * **没归属就是没归属**，视图那边据此不点亮它，而不是就近认一个。
 */
export const blockAnchors = (blocks: readonly TeachingBlock[]): readonly (string | undefined)[] => {
	const out: (string | undefined)[] = [];
	const visit = (block: TeachingBlock, inherited: string | undefined): void => {
		const anchor = block.planPath ?? inherited;
		out.push(anchor);
		if (block.kind === 'call') return;
		if (block.kind === 'if') {
			for (const child of block.body ?? []) visit(child, anchor);
			for (const child of block.otherwise ?? []) visit(child, anchor);
			return;
		}
		if (block.kind === 'repeat') {
			for (const child of block.body ?? []) visit(child, anchor);
		}
	};
	for (const block of blocks) visit(block, undefined);
	return out;
};

/**
 * 一棵块树 → 每一块的锚，**与 `flattenTeachingBlocks` 严格同序**（含实参值块）。
 *
 * 值块不是语句块（模型没法给它写 `planPath`），所以它跟着**拥有它的那个调用块**：
 * 一块积木插进哪个调用块的槽里，讲的就是那一步——这也是 `flattenTeachingBlocks` 那个序
 * 把值块排在它的调用块后面的原因。
 */
export const flattenedBlockAnchors = (
	blocks: readonly TeachingBlock[],
): readonly (string | undefined)[] => {
	const anchors = blockAnchors(blocks);
	// 语句块的锚（`blockAnchors` 只走语句块）；值块按 `flattenTeachingBlocks` 的序补上。
	const out: (string | undefined)[] = [];
	let cursor = 0;
	const take = (): string | undefined => anchors[cursor++] ?? undefined;
	const pushValue = (block: TeachingValueBlock, anchor: string | undefined): void => {
		out.push(anchor);
		for (const argument of block.args ?? []) pushValue(argument.value, anchor);
	};
	const visit = (block: TeachingBlock): void => {
		const anchor = take();
		out.push(anchor);
		if (block.kind === 'call') for (const argument of block.args ?? []) pushValue(argument.value, anchor);
		if (block.kind === 'if') {
			if (block.condition !== undefined) pushValue(block.condition, anchor);
			for (const child of block.body ?? []) visit(child);
			for (const child of block.otherwise ?? []) visit(child);
		}
		if (block.kind === 'repeat') {
			if (block.times !== undefined) pushValue(block.times, anchor);
			for (const child of block.body ?? []) visit(child);
		}
		if (block.kind === 'wait' && block.seconds !== undefined) pushValue(block.seconds, anchor);
	};
	for (const block of blocks) visit(block);
	return out;
};

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
 * 教学代码：**模型写的一整段文本**（不是我们从块树生成的），按步骤**分段**交过来。
 *
 * 为什么不让渲染层从块树生成：块树是「机器动作」的形状，代码要讲的是**这件事本身**
 * ——注释、为什么这么做、失败怎么办。让渲染层去拼，拼出来的只是块树的另一种写法，
 * 「教学」两个字就没了。所以字仍然是模型写的，一个字都不在这里拼。
 *
 * 为什么是**分段**而不是「一整段 + 每段起止行号」（这一版要接「执行到哪一步，代码切到哪几行」，
 * 两种形状都做得到，选分段是有据的）：
 *
 * - 行号那套要模型**自己数行**，而它同时还在写那些行。两份独立的产出必须逐行对上，
 *   错一位就整段错位；更坏的是**我们查不出来**——行号指得到行，只是指错了行，
 *   而「这几行讲的是不是这一步」没有机械判据。屏幕上是「证据确凿地亮错了行」。
 * - 分段那套里行范围是**推出来的**（`segmentLineRanges`）。模型只产出「这一段属于哪一步」
 *   这一件事，位置由我们数，错不了位。归属写错还可能，错位不可能。
 *
 * 代价说清楚：段与段之间不能插空行（空行属于某一行的末尾，不单独成段）。
 * 那点排版自由度换「错位不可能」，值。
 */
export const codeSegmentSchema = z
	.object({
		/** 这一段讲的是哪个流程节点（流程节点的 id）。 */
		planPath: keySchema,
		/** 这一段那几行（至少一行；空串是允许的——空行有时是段内的呼吸）。 */
		lines: z.array(z.string().max(400)).min(1).max(120),
	})
	.strict();
export type CodeSegment = z.infer<typeof codeSegmentSchema>;

/**
 * 分段 → 整段文本。**`code` 这个字段不由模型写**，由它拼出来（见上）。
 *
 * 末尾的连续空行折掉：面板那一栏数的行数是 `codeLinesOf`（它本来就折末尾空行——
 * 「末尾多几个换行」对读者是同一个东西），播开队列按它切。不在这儿折一次，
 * 两处数的行数就会差最后那几个空行——而这一版选分段，为的就是**行数不漂**。
 */
export const codeOfSegments = (segments: readonly CodeSegment[]): string =>
	segments
		.flatMap((segment) => [...segment.lines])
		.join('\n')
		.replace(/\n+$/, '');

/** 分段 → 每一段在整段里的行范围（0 基、闭区间）。行号是**数出来的**，不是模型写的。 */
export interface CodeSegmentRange {
	readonly planPath: string;
	readonly from: number;
	readonly to: number;
}

export const segmentLineRanges = (segments: readonly CodeSegment[]): readonly CodeSegmentRange[] => {
	const ranges: CodeSegmentRange[] = [];
	let cursor = 0;
	for (const segment of segments) {
		const from = cursor;
		const to = cursor + segment.lines.length - 1;
		ranges.push({ planPath: segment.planPath, from, to });
		cursor = to + 1;
	}
	return ranges;
};

// ---------------------------------------------------------------------------
// 规格
// ---------------------------------------------------------------------------

/**
 * 一条对账问题：**人的话** + 它是不是致命的。
 *
 * 「致命」这一栏是有用的信息，不是修饰：`指到一个不存在的步` 会让这一份规格整个不能用
 * （设备跑到哪儿都对不上，屏幕上却没有一个字说得出为什么），而 `顶层块没写归属`
 * 只是那条联动不生效——图照画，人也照看，错只错在少了一样东西。两件事的处置不一样，
 * 就不能都塞进同一个「有问题」桶里。
 */
export interface TeachingSpecIssue {
	readonly message: string;
	readonly fatal: boolean;
}

/**
 * 一份规格的**三段对应关系**逐条对账（拿着声明判）。
 *
 * 分成两步是有原因的：`flowNodeSchema` / `teachingBlockSchema` 是纯形状（不知道声明是什么），
 * 所以文件头第 1 条那件「这个 planPath 指得到声明里的一步吗」的事只能在这里做——
 * 而这件事正是这一版最要紧的判据：**指到一个不存在的步 = 拒**（不是「忽略」）。
 * 忽略掉的话，设备跑到第 3 步、三处一个都不亮，而屏幕上没有任何字说得出为什么。
 */
export const findTeachingSpecIssues = (
	spec: TeachingSpec,
	declaration: WorkflowDeclaration,
	/** 执行路径 → 那一步的节点。语法对不对由 `flowNodeSchema` 先判过。 */
	nodeAtPlanPath: (path: string) => WorkflowNode | null,
): readonly TeachingSpecIssue[] => {
	const issues: TeachingSpecIssue[] = [];
	const fatal = (message: string): void => {
		issues.push({ message, fatal: true });
	};
	const warn = (message: string): void => {
		issues.push({ message, fatal: false });
	};
	const flowIds = new Set(spec.flow.nodes.map((node) => node.id));

	// 一、流程节点 → 声明里的一步。
	const stepNodeOf = new Map<string, string>();
	for (const node of spec.flow.nodes) {
		const planPath = node.planPath;
		if (planPath === undefined) continue;
		if (!isPlanPathSyntax(planPath)) continue; // 语法那一条 `flowNodeSchema` 已经报过了。
		const step = nodeAtPlanPath(planPath);
		if (step === null) {
			fatal(
				`flow.nodes.${node.id}.planPath：这条路径在这次的声明里没有对应的步骤（${planPath}）——指到不存在的步，设备跑到哪儿都对不上`,
			);
			continue;
		}
		const owner = stepNodeOf.get(step.id);
		if (owner !== undefined) {
			fatal(`flow.nodes.${node.id}.planPath：节点 ${owner} 与 ${node.id} 指的是同一步（${planPath}）——一个步骤只许有一个框`);
			continue;
		}
		stepNodeOf.set(step.id, node.id);
	}

	// 二、块树 → 流程节点。指到一个不存在的节点 = 拒；没写 = 那块没有归属（照画，不点亮）。
	const checkAnchor = (block: TeachingBlock, where: string): void => {
		const anchor = block.planPath;
		if (anchor === undefined) return;
		if (!flowIds.has(anchor)) {
			fatal(`${where}.planPath：${anchor} 不是这张流程图上的节点——这一块没有归属，也就跟不了当前步`);
		}
	};
	const walkBlocks = (blocks: readonly TeachingBlock[], prefix: string): void => {
		blocks.forEach((block, index) => {
			const where = `${prefix}[${index}]`;
			checkAnchor(block, where);
			if (block.kind === 'if') {
				walkBlocks(block.body ?? [], `${where}.body`);
				walkBlocks(block.otherwise ?? [], `${where}.otherwise`);
				return;
			}
			if (block.kind === 'repeat') walkBlocks(block.body ?? [], `${where}.body`);
		});
	};
	walkBlocks(spec.blocks, 'blocks');
	// 顶层一块都没锚：整棵块树与流程图脱钩，设备跑到哪一块都不亮。这不是拒的理由（照样画），
	// 但要说出来——否则屏幕上只有「什么都没亮」，没人知道是模型没写还是这一步恰好没有块。
	if (!spec.blocks.some((block) => block.planPath !== undefined)) {
		warn('blocks：顶层一块都没写 planPath——积木画布跟不了当前步（照画，只是不点亮）');
	}

	// 三、代码分段 → 流程节点。每一段都要指到一个真的节点，否则那一段永远切不过去。
	const seenSegments = new Set<string>();
	let lastSegment: string | null = null;
	spec.codeSegments.forEach((segment, index) => {
		if (!flowIds.has(segment.planPath)) {
			fatal(`codeSegments[${index}].planPath：${segment.planPath} 不是这张流程图上的节点——这一段永远切不过去`);
		}
		// 同一步的文字要是**连着的一段**：中间插了别的步，这一步的行就被劈成两截，
		// 高亮只能亮一半，而「切到那几行」说的是一段连续的行。
		if (seenSegments.has(segment.planPath) && lastSegment !== segment.planPath) {
			fatal(`codeSegments[${index}].planPath：${segment.planPath} 的文字被别的步隔开了——同一步的代码要连着写`);
		}
		seenSegments.add(segment.planPath);
		lastSegment = segment.planPath;
	});

	return issues;
};

export const teachingSpecSchema = z
	.object({
		version: z.literal(TEACHING_SPEC_VERSION),
		/** 这次教学的名字（一行）。 */
		title: z.string().trim().min(1).max(80),
		flow: flowGraphSchema,
		blocks: z.array(teachingBlockSchema).min(1),
		codeSegments: z.array(codeSegmentSchema).min(1).max(80),
	})
	.strict()
	.superRefine((spec, ctx) => {
		if (teachingBlockCount(spec.blocks) < 2) {
			ctx.addIssue({
				code: 'custom',
				path: ['blocks'],
				message: '整棵块树只有一块——一个动作不许一块包全部，至少要拆成调用块与实参值块',
			});
		}
	});

/**
 * 模型交过来的规格：`code` 不在里面——它是分段拼出来的（见 `codeOfSegments`）。
 * 屏幕上那三样读的是这一份，`code` 由 `parseTeachingSpec` 填。
 */
export type TeachingSpecInput = z.infer<typeof teachingSpecSchema>;

/** 屏幕上那三样读的规格：形状 + 拼出来的 `code`。 */
export type TeachingSpec = TeachingSpecInput & { readonly code: string };

/** 一次「这份规格能不能用」的判定（调用方只认这一个入口，与 `loadTaskJson` 同一个口径）。 */
export type TeachingSpecParse =
	| {
			readonly ok: true;
			readonly spec: TeachingSpec;
			/** 能用、但有一处话要说（例如「顶层块没写归属，联动不生效」）。没有就是空表。 */
			readonly warnings: readonly string[];
	  }
	| { readonly ok: false; readonly message: string; readonly issues: readonly string[] };

/**
 * 对账要的三样：声明、以及「执行路径 → 那一步」那一次换算。
 *
 * 为什么不在这里自己实现一遍路径换算：那份口径属于计划结构（分支的两条臂怎么走、
 * 臂里那一步的下标怎么数），实现它在 `apps/studio/src/views/shared/plan-structure.ts`，
 * 与设备报的 `runningPlanPath`、`nodeAtPlanPath` 是同一份。这里再写一遍，就是第二份真相。
 */
export interface TeachingSpecContext {
	readonly declaration: WorkflowDeclaration;
	readonly nodeAtPlanPath: (declaration: WorkflowDeclaration, path: string) => WorkflowNode | null;
}

/**
 * 文本 → 教学规格。剥围栏、解析、过 schema、再拿声明对一次账，全在这一处。
 *
 * 失败时把**每一条 issue 的路径与话**都交回去：模型下一轮要照着改的就是这些字，
 * 界面上「为什么没画出来」也说不出一句比它更准的。
 *
 * `context` 没给时只判形状（对账那一层拿着声明才判得了）；**生成那条路一定要给**
 * ——不给的话「模型指了一个不存在的步」会被放过去，屏幕上就是三处一个都不亮而没人说得清为什么。
 * 形状不过就到此为止，不再往对账走（那时连图长什么样都不知道）。
 */
export const parseTeachingSpec = (text: string, context?: TeachingSpecContext): TeachingSpecParse => {
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
	if (!parsed.success) {
		return {
			ok: false,
			message: '模型给的规格形状不对',
			issues: parsed.error.issues.map((issue) => `${issue.path.join('.') || '(根)'}：${issue.message}`),
		};
	}

	const spec: TeachingSpec = { ...parsed.data, code: codeOfSegments(parsed.data.codeSegments) };
	// 没给声明：只判形状，对账那一层拿着声明才判得了（生成那条路一定会给，见上面）。
	if (context === undefined) return { ok: true, spec, warnings: [] };

	const issues = findTeachingSpecIssues(spec, context.declaration, (path) =>
		context.nodeAtPlanPath(context.declaration, path),
	);
	if (issues.some((issue) => issue.fatal)) {
		// 对账不过与形状不过是同一件事的两面：这一份不能用，理由逐条交回去。
		return { ok: false, message: '模型给的规格与这次的声明对不上', issues: issues.map((issue) => issue.message) };
	}
	// 只有「那条联动不生效」那种非致命问题：规格能用，话照说（见 `TeachingSpecParse` 的 warnings）。
	return {
		ok: true,
		spec,
		warnings: issues.map((issue) => issue.message),
	};
};
