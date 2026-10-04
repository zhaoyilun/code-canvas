/**
 * 教学规格这一条线的状态：**第二次调用的产出**，以及三张画布「画到第几格了」。
 *
 * 为什么单开一份 state 而不是塞进 `document.ts`：那是**机器要吃的那份**（任务 JSON / 声明）
 * ——3D 运行、下发 bridge、真机都读它，它的写路径只有一道闸。教学规格是**给人看的那三样**，
 * 模型画的，与声明对不上也不拦（导演定的「模型赢」）。两种寿命与两种权威混成一份，
 * 读的人就再也分不清「屏幕上这句话是机器要执行的，还是模型在讲解」。
 * 所以这一份**只读声明、从不写声明**：`document.ts` 那条真相通道一个字节都不碰。
 *
 * 节奏（为什么要有播放队列）与拍子（130ms/格、1600ms 封顶、40ms 地板）都在
 * `shell/step-playback.ts` 里，这里只负责**把哪份序列交给它**：
 *
 * - 流程图：`flowDrawOrder`（从开始节点出发，节点先、出边后）；
 * - 积木：`flattenTeachingBlocks`（嵌套块树的深度优先序，先父后子）；
 * - 代码：一行一格。
 *
 * 三条序列**同时开铺**，于是「积木铺到第 4 块、代码铺到第 4 行」在屏幕上说的是同一件事。
 *
 * 失败与进行中都要有字：`status` 加 `failure` 就是全部状态，视图照着说。
 * 三张画布**都不许**在失败时退回「从目录推的实现」——那套已经不是屏幕上的真相了，
 * 拿它顶上等于把「模型没画出来」这句话藏起来。
 */
import { computed, ref, shallowRef, watch, type ComputedRef, type Ref } from 'vue';
import {
	flattenTeachingBlocks,
	flattenedBlockAnchors,
	segmentLineRanges,
	type CodeSegmentRange,
	type FlowEdge,
	type FlowGraph,
	type FlowNode,
	type TeachingBlock,
	type TeachingSpec,
	type TeachingValueBlock,
	type WorkflowDeclaration,
} from '@codecanvas/contracts';
import { createStepPlayback, PHASE_DELAY_MS, type StepPlayback } from '../shell/step-playback';
import { runningPlanPath } from '../shell/device-run';
import { generateTeachingSpec } from '../shell/teaching-generation';
import { readTaskEndpoint } from '../shell/llm-endpoint';
import { nodeAtPlanPath, planPathOf, planPathsOf } from '../views/shared/plan-structure';
import { useStudioDocument } from './document';

export type TeachingStatus = 'idle' | 'drawing' | 'ready' | 'failed';

/**
 * 这一份规格**我们机械修过哪几处**（`teaching-repair.ts` 的产物，成功那一支带回来的）。
 *
 * 为什么要在界面上说出来：修补层会替模型摘掉多余的字、把 `"3"` 还原成 `3`、把编出来的路径摘掉——
 * 那些改动**改变了屏幕上这句话的来路**。不留痕就是欺骗：用户会以为模型说对了，
 * 而实际上是我们替它圆了一句。改过就说改过，没改就是空表。
 */
const repairs = ref<readonly string[]>([]);

/** 一次失败的实情：模型说的话（message）、逐条形状问题（issues）、已经收到的原文（text）。 */
export interface TeachingFailure {
	readonly message: string;
	readonly issues: readonly string[];
	readonly text: string | null;
	readonly attempts: number;
}

/** 铺开序里的一格（流程图）：一个节点，或一条边。 */
export interface FlowDrawItem {
	readonly key: string;
	readonly kind: 'node' | 'edge';
	readonly node?: FlowNode;
	readonly edge?: FlowEdge;
}

export const flowNodeKey = (id: string): string => `node:${id}`;
export const flowEdgeKey = (edge: FlowEdge): string => `edge:${edge.from}->${edge.to}:${edge.arm ?? 'main'}`;

/**
 * 流程图铺开的顺序：从开始节点出发的广度优先，**节点先、它的出边随后**。
 *
 * 为什么是这个顺序：一笔一笔画出来的图，先有框再有线才看得懂。出边的次序是
 * 「无臂的在前，then 再 else」——一个分支的两条臂于是总是「是」先落、「否」后落。
 * 走不到的节点（校验会拦，但这里也不许漏画）按声明顺序排在最后：宁可画在末尾，
 * 也不因为推不出顺序就少画一个。
 */
export const flowDrawOrder = (graph: FlowGraph): readonly FlowDrawItem[] => {
	const start = graph.nodes.find((node) => node.kind === 'start');
	const order: FlowDrawItem[] = [];
	const seenNodes = new Set<string>();
	const seenEdges = new Set<string>();

	const visit = (node: FlowNode): void => {
		if (seenNodes.has(node.id)) return;
		seenNodes.add(node.id);
		order.push({ key: flowNodeKey(node.id), kind: 'node', node });
		const outgoing = graph.edges
			.map((edge, index) => ({ edge, index }))
			.filter((item) => item.edge.from === node.id)
			.sort((first, second) => armRank(first.edge) - armRank(second.edge) || first.index - second.index);
		for (const { edge } of outgoing) {
			const key = flowEdgeKey(edge);
			if (seenEdges.has(key)) continue;
			seenEdges.add(key);
			order.push({ key, kind: 'edge', edge });
			const next = graph.nodes.find((candidate) => candidate.id === edge.to);
			if (next !== undefined) visit(next);
		}
	};

	if (start !== undefined) visit(start);
	for (const node of graph.nodes) {
		if (seenNodes.has(node.id)) continue;
		order.push({ key: flowNodeKey(node.id), kind: 'node', node });
		seenNodes.add(node.id);
	}
	return order;
};

/** 无臂 → 0、then → 1、else → 2：分支的两条臂「是」在前。 */
const armRank = (edge: FlowEdge): number => (edge.arm === undefined ? 0 : edge.arm === 'then' ? 1 : 2);

const spec = shallowRef<TeachingSpec | null>(null);
const status = ref<TeachingStatus>('idle');
const failure = shallowRef<TeachingFailure | null>(null);
/** 生成途中已经收到的字数（界面上那行「模型正在写… N 字」；不是进度条，是"它还活着"）。 */
const streamedChars = ref(0);
/** 这一轮是第几次尝试（重试时界面要说得出「正在重试」）。 */
const attempt = ref(0);

/** 三条铺开队列：流程图 / 积木 / 代码行。拍子全在 `step-playback.ts` 里。 */
const flowPlayback: StepPlayback<FlowDrawItem> = createStepPlayback<FlowDrawItem>({
	delayMs: PHASE_DELAY_MS.flow,
});
const blockPlayback: StepPlayback<TeachingBlock | TeachingValueBlock> =
	createStepPlayback<TeachingBlock | TeachingValueBlock>({ delayMs: PHASE_DELAY_MS.blocks });
const codePlayback: StepPlayback<string> = createStepPlayback<string>({ delayMs: PHASE_DELAY_MS.code });
const revealedFlowItems: ComputedRef<readonly FlowDrawItem[]> = flowPlayback.revealed;
const revealedBlockItems: ComputedRef<readonly (TeachingBlock | TeachingValueBlock)[]> = blockPlayback.revealed;
const revealedCodeLines: ComputedRef<readonly string[]> = codePlayback.revealed;

/** 「这一格放出来了没有」按**对象身份**问（序列里的就是规格树里的那些对象）。 */
const revealedBlockSet = computed<ReadonlySet<TeachingBlock | TeachingValueBlock>>(
	() => new Set(revealedBlockItems.value),
);
const revealedFlowKeys = computed<ReadonlySet<string>>(
	() => new Set(revealedFlowItems.value.map((item) => item.key)),
);

/** 代码全文按行切开：空行也算一格（不然空行会挤在一起，看不出段落的落点）。 */
export const codeLinesOf = (code: string): readonly string[] => code.replace(/\n+$/, '').split('\n');

/**
 * 动效偏好：关掉动画时**整份一次出来**，不留一个空画布等着。
 *
 * 这不是「动画的降级开关」而已：铺开队列是时间驱动的，对不喜欢动效的人（以及
 * 读屏、截图、自动化）来说，一张要等一秒半才长齐的图是纯粹的障碍。所以这里直接
 * 把三条队列的计数推到满——`revealed` 是序列的前缀，推到满就是「全都在这儿」。
 */
const prefersReducedMotion = (): boolean =>
	typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true;

/** 换一份规格：三条队列**各自重置**后再铺——不 reset 就会把新内容当成「已经画过的前缀」。 */
const applySpec = (next: TeachingSpec): void => {
	spec.value = next;
	flowPlayback.reset();
	blockPlayback.reset();
	codePlayback.reset();
	const flow = flowDrawOrder(next.flow);
	const blocks = flattenTeachingBlocks(next.blocks);
	const lines = codeLinesOf(next.code);
	flowPlayback.aim(flow);
	blockPlayback.aim(blocks);
	codePlayback.aim(lines);
	if (prefersReducedMotion()) {
		flowPlayback.revealedCount.value = flow.length;
		blockPlayback.revealedCount.value = blocks.length;
		codePlayback.revealedCount.value = lines.length;
	}
	status.value = 'ready';
	failure.value = null;
};

/**
 * 等三条铺开队列**都落定**（这一轮画完）。
 *
 * 为什么单独开出来：三张画布是**错峰**开的（流程图 0 / 积木 200 / 代码 400），
 * 于是"规格到手"与"画完"之间隔着 400ms 以上。断言"画布上有什么"的测试必须先等它——
 * 否则量的是"还没开始铺"的那一刻（实测：代码面板一行都还没有）。
 * 产品代码不用它：界面上有 `status` 与三条 `revealed`，不需要 await。
 */
export const whenDrawn = async (): Promise<void> => {
	await Promise.all([flowPlayback.whenSettled(), blockPlayback.whenSettled(), codePlayback.whenSettled()]);
};

/**
 * 把这一条线清回「什么都没有」：规格撤下、三条队列清空、状态回 `idle`。
 *
 * `runTeaching` 开头那段撤规格就是这个函数（撤下来的理由写在那里）。单独开出来是因为
 * **它自己就是一条状态迁移**：声明换了一份而新一轮还没回来时，屏幕上该有的样子正是它。
 * 导出是给测试用的（模块级单例，不重置就会把上一条用例的规格带进下一条）。
 */
export const clearTeaching = (): void => {
	spec.value = null;
	flowPlayback.reset();
	blockPlayback.reset();
	codePlayback.reset();
	status.value = 'idle';
	failure.value = null;
	streamedChars.value = 0;
	attempt.value = 0;
};

/** 这一轮之后的结果还算不算数：新一轮一开始，在途的旧结果就不许再写状态。 */
let runToken = 0;
let controller: AbortController | null = null;

/** 声明 → 提示词里的那段「任务 JSON」：键序稳定、缩进可读，内容就是声明本身。 */
const declarationTextOf = (declaration: WorkflowDeclaration): string => JSON.stringify(declaration, null, 2);

export interface RunTeachingOptions {
	/** 覆盖「任务 JSON」那段文本（生成那条路可以给它模型吐出来的原文）。 */
	readonly declarationText?: string;
}

/**
 * 让模型画一次。**这是唯一一个会让 `spec` 变的入口。**
 *
 * 没有声明或没有目录时什么都不做（`idle`）：材料都凑不齐，发出去只会得到一份编的东西。
 * 走之前先 `abort` 上一轮——用户连点两次生成时，旧的那一轮必须停在原地，
 * 它带回来的规格属于上一份声明。
 */
export async function runTeaching(options: RunTeachingOptions = {}): Promise<void> {
	const doc = useStudioDocument();
	const declaration = doc.declaration.value;
	const catalog = doc.declarationCatalog.value;
	if (declaration === null || catalog === null) {
		status.value = 'idle';
		return;
	}

	controller?.abort();
	controller = new AbortController();
	const token = (runToken += 1);
	/*
	 * 开跑就把上一份规格**撤下来**（连同三条队列）。
	 *
	 * 为什么不留着上一份图直到新的到手：那份图是**上一份声明**的规格。声明换了这个事实
	 * 不会因为新调用还没回来而消失，留着它就是把一张属于上一个任务的图摆在这个任务旁边
	 * ——「模型赢」说的是「模型与这份 JSON 对不上也不拦」，不是「可以拿另一份 JSON 的图顶上」。
	 * 撤下来之后三张画布会照实说「正在画…」，那才是这一刻的真话。
	 */
	clearTeaching();
	status.value = 'drawing';

	const result = await generateTeachingSpec({
		endpoint: readTaskEndpoint(),
		declaration,
		catalog,
		deviceRef: catalog.catalogRef,
		formatRef: doc.declarationFormatRef.value ?? '',
		declarationText: options.declarationText ?? declarationTextOf(declaration),
		// 对应关系那两样：一张「有哪些执行路径」的表（材料里给模型照抄），
		// 和一个「这条路径对不对」的判据（解析时对账）。两个一起给，见 `TeachingGenerationOptions`。
		planPaths: planPathsOf(declaration),
		nodeAtPlanPath,
		signal: controller.signal,
		onDelta: (accumulated) => {
			if (token !== runToken) return;
			streamedChars.value = accumulated.length;
		},
	});

	// 这一轮已经作废（又点了一次生成 / 组件卸载）：一个字都不许写。
	if (token !== runToken) return;

	if (!result.ok) {
		if (result.kind === 'aborted') {
			// 主动放弃不是失败：状态回到「等下一次」，画布上留着的还是上一份定稿。
			status.value = spec.value === null ? 'idle' : 'ready';
			return;
		}
		status.value = 'failed';
		failure.value = {
			message: result.message,
			issues: result.issues,
			text: result.text,
			attempts: result.attempts,
		};
		return;
	}

	attempt.value = result.attempts;
	repairs.value = result.repairs;
	applySpec(result.spec);
}

/**
 * 挂上「声明一换就重画」这条线。**由外壳在挂载时调一次**（`App.vue`），不在这里自动跑：
 * 模块级 `watch` 会在任何 import 到这份状态的测试里也跑起来，那时它只会去打一个不存在的接口。
 *
 * `immediate` 是有意的：挂载这一刻声明**可能是空的**（开局什么都不灌，见 `App.vue`），
 * 那时它什么都不做——而用户第一次生成完，这条线要能立刻接上，不必再挂一次。
 */
export function startTeachingWatch(): void {
	watch(
		[() => useStudioDocument().declaration.value, () => useStudioDocument().declarationCatalog.value],
		() => {
			void runTeaching();
		},
		{ immediate: true },
	);
}

export function useTeaching(): {
	readonly spec: Ref<TeachingSpec | null>;
	readonly status: Ref<TeachingStatus>;
	readonly failure: Ref<TeachingFailure | null>;
	readonly streamedChars: Ref<number>;
	readonly attempt: Ref<number>;
	readonly revealedFlowKeys: ComputedRef<ReadonlySet<string>>;
	readonly revealedBlockItems: ComputedRef<readonly (TeachingBlock | TeachingValueBlock)[]>;
	readonly revealedBlockSet: ComputedRef<ReadonlySet<TeachingBlock | TeachingValueBlock>>;
	readonly revealedCodeLines: ComputedRef<readonly string[]>;
	readonly drawing: ComputedRef<boolean>;
	/** 这一份规格我们机械修过哪几处（没修就是空表）。界面上照实摆出来。 */
	readonly repairs: Ref<readonly string[]>;
	/**
	 * 三张画布**各自的入场延迟**（毫秒）：流程图 0 / 积木 200 / 代码 400。
	 *
	 * 与三条铺开队列读的是同一个常量（`PHASE_DELAY_MS`）——两处各写一个数早晚对不上，
	 * 那时画布会"先亮起来、后落下来"，看起来像卡了一下。
	 */
	readonly phaseDelayMs: typeof PHASE_DELAY_MS;
	run: (options?: RunTeachingOptions) => Promise<void>;
} {
	return {
		spec,
		status,
		failure,
		repairs,
		phaseDelayMs: PHASE_DELAY_MS,
		streamedChars,
		attempt,
		revealedFlowKeys,
		revealedBlockItems,
		revealedBlockSet,
		revealedCodeLines,
		/** 还在铺（有东西没放出来）：视图据此决定要不要挂入场动画。 */
		drawing: computed(() => status.value === 'drawing' || flowPlayback.playing.value),
		run: runTeaching,
	};
}

// ---------------------------------------------------------------------------
// 联动：设备执行到哪一步 → 那一步在规格里是哪个流程节点
// ---------------------------------------------------------------------------

/**
 * 现在讲的是**哪一步**（执行路径，或者 `null` = 没有谈到任何一步）。
 *
 * 两个来源，**先设备、后选中**，两条都走同一份路径口径（`planPathsOf` / `nodeAtPlanPath`）：
 *
 * 1. `runningPlanPath`（`shell/device-run.ts`）：设备此刻在那一步。它是硬事实，所以最优先；
 * 2. 用户在计划里的选中（`document.ts` 的 `selectedNodeId`）——**选中也是「某一步」**，
 *    与设备报的那条是同一个空间里的一个位置（右栏面板跑的时候正是用 `nodeAtPlanPath`
 *    把路径反推成选中的，所以两条常常相等，但一跑完运行标记就灭了、选中还停在那儿）。
 *
 * 为什么不用 `selectedStepIndex`：那是**选中那个模块的实现里第几条语句**，
 * 与「计划里的哪一步」不是一个空间（见 `document.ts` 那段注释）。拿它对流程节点，
 * 对出来的是一个恰好相等的数，不是一条对应关系。
 */
const currentPlanPath = computed<string | null>(() => {
	const running = runningPlanPath.value;
	if (running !== null) return running;
	return planPathOf(useStudioDocument().declaration.value, useStudioDocument().selectedNodeId.value);
});

/**
 * 当前那一步**在规格的流程图上**是哪个框——三处联动的唯一交汇点。
 *
 * 判据是**节点身份**，不是路径字符串相等：规格里那条 `planPath` 与设备报的那条路
 * 有可能是两条不同的路径走到同一个节点（两条臂汇到同一步）。比身份，两条路说同一件事时仍然对得上。
 */
const currentFlowNodeId = computed<string | null>(() => {
	const declaration = useStudioDocument().declaration.value;
	const specNow = spec.value;
	if (specNow === null) return null;

	// 设备报的那条路径说了算；没在跑就看选中（两条路都在 `currentPlanPath` 里）。
	const path = currentPlanPath.value;
	if (path === null) return null;
	const step = nodeAtPlanPath(declaration, path);
	if (step === null) return null; // 路径推不出步骤：什么都别亮，不拿另一条顶上。

	const owner = specNow.flow.nodes.find(
		(node) => node.planPath !== undefined && nodeAtPlanPath(declaration, node.planPath)?.id === step.id,
	);
	return owner?.id ?? null;
});

/**
 * 这一份规格里有没有一条**真能用的**联动路径：三处对应关系只要有一处就够点亮一处。
 */
const linkageOf = (specNow: TeachingSpec | null): LinkageState => {
	if (specNow === null) return 'none';
	const declaration = useStudioDocument().declaration.value;
	if (declaration === null) return 'none';
	const resolvable = (path: string | undefined): boolean =>
		path !== undefined && nodeAtPlanPath(declaration, path) !== null;
	return specNow.flow.nodes.some((node) => resolvable(node.planPath)) ? 'linked' : 'none';
};

/**
 * 积木那一条对应关系在不在：**顶层块有没有写归属，而且写的那个 id 真在图上**。
 *
 * 单独一个判据（而不是复用 `linkage`）：三条对应关系是各自独立的，流程那条好着
 * 而积木那条整个漏掉——那正是这一版最可能出的错（模型只写了图那一栏）。
 * 那一栏漏了，画布上就永远切不动，而别的两处照常动；不单独说，屏幕上就没有一个字解释得清。
 */
const blockLinkageOf = (specNow: TeachingSpec | null): boolean => {
	if (specNow === null) return false;
	const flowIds = new Set(specNow.flow.nodes.map((node) => node.id));
	return specNow.blocks.some((block) => block.planPath !== undefined && flowIds.has(block.planPath));
};

/**
 * 三处的联动状态。**这一栏是给「照实说」用的**：没有对应关系时三张画布照常画，
 * 但屏幕上必须有一句话说明「跟不了当前步」，而不是让用户盯着一张不动的图猜。
 */
export type LinkageState = 'none' | 'linked' | 'unlinked';

export function useTeachingLinkage(): {
	readonly currentPlanPath: ComputedRef<string | null>;
	readonly currentNodeId: ComputedRef<string | null>;
	readonly blockAnchorsOf: ComputedRef<readonly (string | undefined)[]>;
	readonly codeRangesOf: ComputedRef<readonly CodeSegmentRange[]>;
	readonly linkage: ComputedRef<LinkageState>;
	readonly note: ComputedRef<string>;
	/** 积木那一条对应关系在不在（不在时说一句，见 `blockLinkageOf`）。 */
	readonly blockNote: ComputedRef<string>;
	/** 我们替模型修过哪几处（没修就是空串）。与两条 note 分开：那两条说"联动"，这条说"改过手"。 */
	readonly repairNote: ComputedRef<string>;
	readonly activeNodeId: ComputedRef<string>;
} {
	/** 这一块的锚（与 `flatBlocks` 同序、一格对一格）；规格没到就是空表。 */
	const blockAnchorsOf = computed<readonly (string | undefined)[]>(() =>
		spec.value === null ? [] : flattenedBlockAnchors(spec.value.blocks),
	);

	/** 每一段代码的行范围（推出来的，不是模型写的）。 */
	const codeRangesOf = computed<readonly CodeSegmentRange[]>(() =>
		spec.value === null ? [] : segmentLineRanges(spec.value.codeSegments),
	);

	/**
	 * 联动现在是什么状态。
	 *
	 * `linked` = 规格里至少有一个框指着一条**真的**路径（这一份规格接得上设备）；
	 * `unlinked` = 有图、有规格，但一个都指不到（模型没写、或写的都不在这次的声明里）；
	 * `none` = 还没有规格（那不是说联动坏了，是说还没有东西可联动）。
	 */
	const linkage = computed<LinkageState>(() => linkageOf(spec.value));

	const note = computed<string>(() => {
		if (linkage.value === 'linked') return '';
		if (linkage.value === 'none') return '';
		return '这份规格没有「哪一块对应任务里哪一步」的对应关系，所以三张画布跟不了设备的当前步。';
	});

	/**
	 * 积木那一栏的话：**只在这一栏真的漏了时说**（有规格、但一块归属都没有）。
	 * 与 `note` 分开，因为两件事：整份规格都没对应关系 vs 只有积木这一栏漏了。
	 */
	const blockNote = computed<string>(() => {
		const specNow = spec.value;
		if (specNow === null) return '';
		if (blockLinkageOf(specNow)) return '';
		return '这份规格里的积木没写「属于哪个流程节点」，所以积木画布跟不了设备的当前步。';
	});

	const activeNodeId = computed<string>(() => currentFlowNodeId.value ?? '');

	/**
	 * 「这一份有几处是我们改过的」。
	 *
	 * 为什么必须说出来：修补层摘掉的可能是模型编出来的一条路径——用户有权知道
	 * 屏幕上这句话不完全是模型的原话。只是给一句汇总（逐条在中栏那份失败报告里有先例），
	 * 页脚放不下十几条。
	 */
	const repairNote = computed<string>(() => {
		const list = repairs.value;
		if (list.length === 0) return '';
		return `这一份有 ${String(list.length)} 处是自动修的（模型的话不完全是原样）：${list[0] ?? ''}`;
	});

	return {
		currentPlanPath,
		currentNodeId: currentFlowNodeId,
		blockAnchorsOf,
		codeRangesOf,
		linkage,
		note,
		blockNote,
		repairNote,
		activeNodeId,
	};
}
