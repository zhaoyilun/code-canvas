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
	type FlowEdge,
	type FlowGraph,
	type FlowNode,
	type TeachingBlock,
	type TeachingSpec,
	type TeachingValueBlock,
	type WorkflowDeclaration,
} from '@codecanvas/contracts';
import { createStepPlayback, type StepPlayback } from '../shell/step-playback';
import { generateTeachingSpec } from '../shell/teaching-generation';
import { readTaskEndpoint } from '../shell/llm-endpoint';
import { useStudioDocument } from './document';

export type TeachingStatus = 'idle' | 'drawing' | 'ready' | 'failed';

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
const flowPlayback: StepPlayback<FlowDrawItem> = createStepPlayback<FlowDrawItem>();
const blockPlayback: StepPlayback<TeachingBlock | TeachingValueBlock> =
	createStepPlayback<TeachingBlock | TeachingValueBlock>();
const codePlayback: StepPlayback<string> = createStepPlayback<string>();

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
	spec.value = null;
	flowPlayback.reset();
	blockPlayback.reset();
	codePlayback.reset();
	status.value = 'drawing';
	failure.value = null;
	streamedChars.value = 0;
	attempt.value = 0;

	const result = await generateTeachingSpec({
		endpoint: readTaskEndpoint(),
		declaration,
		catalog,
		deviceRef: catalog.catalogRef,
		formatRef: doc.declarationFormatRef.value ?? '',
		declarationText: options.declarationText ?? declarationTextOf(declaration),
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
	applySpec(result.spec);
}

/**
 * 挂上「声明一换就重画」这条线。**由外壳在挂载时调一次**（`App.vue`），不在这里自动跑：
 * 模块级 `watch` 会在任何 import 到这份状态的测试里也跑起来，那时它只会去打一个不存在的接口。
 *
 * `immediate` 是有意的：开机那份样例任务也要有图（否则三张画布空着，
 * 而用户看到的第一眼就是「这东西没做完」）。
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
	run: (options?: RunTeachingOptions) => Promise<void>;
} {
	return {
		spec,
		status,
		failure,
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
