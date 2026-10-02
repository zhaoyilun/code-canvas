/**
 * 积木画布的全部接线（spec §4.1）：这是**唯一一条写路径**。
 *
 * 画布画的是**当前选中模块的实现**：节点 → `parameters.action`（能力引用）→ 目录里的
 * `implementation`（一棵语句树）→ 递归长成积木（赋值块、C 形条件块、嵌进去的比较与数字）。
 * 没选中任何节点时显示第一个（否则画布空着，用户不知道要干什么）。换了模块才重画；
 * 同一个模块内点积木只换高亮。
 *
 * 读：`store.declaration` 变了、或选中的模块换了 → 重画工作区。
 * 写：工作区里字段变了 → 防抖 → `compileWorkspace`（只给这一个节点的 parameters 打补丁，
 *     再跑声明校验 + 任务协议校验）→ 过了才 `store.applyDeclaration`，没过就只留诊断、真相不动。
 *     实现结构由目录给，画布改不了它——块拖不动、删不掉，字段照旧可写。
 *
 * 选中步（`store.selectedStepIndex`）：实现是一棵树，能谈「第几处」的只有**顶层语句**。
 *   点积木 → 从它的 `data.stepPath` 推出所属的顶层语句下标 → `store.selectStep(...)`；
 *   反过来 `selectedStepIndex` 变了 → `workspace.highlightBlock` 高亮那一步的顶层积木，
 *   辉光色就是三栏共用的 `--cc-highlight`（主题侧读同一个变量）。代码面板那边接的是同一根线：
 *   它按行号给出 stepIndex，这边就把对应的积木点亮。
 *
 * 另外给画布补上它与另外两栏共用的标记：**序号徽标**（数的是实现里的第几步，只数顶层语句）、
 * 积木元素上的 `data-node-id`（跨栏连线的锚点）与 `data-cc-step-path`（树里的位置，调试与验收用）。
 *
 * 视图只负责摆放 DOM 与显示状态，Blockly 的用法都在 `@codecanvas/blockly-toolkit` 里。
 */
import * as Blockly from 'blockly';
import { computed, onBeforeUnmount, onMounted, ref, shallowRef, watch, type ComputedRef, type Ref } from 'vue';
import type { Diagnostic, WorkflowDeclaration } from '@codecanvas/contracts';
import { findCapability } from '@codecanvas/contracts';
import { PHASE1_ROBOT_CATALOG } from '@codecanvas/capabilities';
import {
	PARAMETER_EVENT_TYPES,
	activeNodeOf,
	capabilityRefFromParameters,
	compileWorkspace,
	createCanvasWorkspace,
	fitWorkspaceToContent,
	highlightBlock,
	paletteFromDocument,
	renderDeclaration,
	resolveSelection,
	topLevelStepIndexOf,
	type BlockIndex,
	type ThemePalette,
} from '@codecanvas/blockly-toolkit';
import { useStudioDocument } from '../../state/document';
import {
	NODE_ID_ATTRIBUTE,
	badgeOfBlockElement,
	badgePalette,
	createBadgeElement,
	placeBadge,
	updateBadge,
} from '../shared/sequence-badge';

/** 一次字段编辑会连着来好几个事件（Blockly 自己也会补发），攒一下再编译。 */
const WRITE_DEBOUNCE_MS = 120;

/** 积木元素上记「它在实现树里的位置」的属性——验收与调试都读它，不靠肉眼认积木。 */
export const STEP_PATH_ATTRIBUTE = 'data-cc-step-path';
/** 块种类标签（`call_stmt` / `if` / `ref_num`…），同样是 DOM 上可核对的证据。 */
export const NODE_TAG_ATTRIBUTE = 'data-cc-node-tag';
/** 当前选中步的那块顶层积木上的标记（高亮语言与另外两栏同源）。 */
export const STEP_ACTIVE_ATTRIBUTE = 'data-cc-step-active';

export type CanvasStatus = 'idle' | 'synced' | 'written' | 'rejected' | 'broken' | 'failed';

export interface DiagnosticRow {
	readonly diagnostic: Diagnostic;
	/** 诊断从哪来：积木/编译侧，还是 store 的声明校验侧。 */
	readonly source: 'compile' | 'declaration';
}

export interface UseBlocklyCanvasResult {
	readonly hostRef: Ref<HTMLElement | null>;
	readonly diagnostics: ComputedRef<readonly DiagnosticRow[]>;
	readonly status: Ref<CanvasStatus>;
	readonly statusText: ComputedRef<string>;
	readonly failure: Ref<string | null>;
	readonly blockCount: Ref<number>;
	readonly writeSuspended: ComputedRef<boolean>;
	readonly selectedBlockId: Ref<string | null>;
	/** 画布上带了 `data-node-id` 的积木元素（含那个属性与徽标的当前状态），给验收与调试用。 */
	readonly decoratedBlocks: Ref<readonly DecoratedBlock[]>;
	/** 画布当前显示的模块（节点 id）与它的标题。 */
	readonly activeNodeId: ComputedRef<string | null>;
	/** 顶部标题：「<能力的 label> · 实现」。 */
	readonly moduleTitle: ComputedRef<string>;
	/** 此刻选中的是模块内部第几步（顶层语句下标）；没选中就没有。 */
	readonly activeStepIndex: ComputedRef<number | null>;
	/** 此刻被点亮的积木（顶层那一步的块）。 */
	readonly highlightedBlockId: Ref<string | null>;
}

export interface DecoratedBlock {
	readonly nodeId: string;
	readonly blockId: string;
	readonly element: Element;
	/** 在实现树里的下标路径（`"1.then.0"` 这种）。 */
	readonly stepPath: string;
	/** 顶层语句下标（0 基）；只有顶层块有徽标。 */
	readonly stepIndex: number;
	readonly topLevel: boolean;
	readonly nodeTag: string;
	readonly badge: SVGGElement | null;
}

export function useBlocklyCanvas(): UseBlocklyCanvasResult {
	const store = useStudioDocument();

	const hostRef = ref<HTMLElement | null>(null);
	const workspace = shallowRef<Blockly.WorkspaceSvg | null>(null);
	const blockIndex = shallowRef<BlockIndex | null>(null);
	const renderDiagnostics = ref<Diagnostic[]>([]);
	const compileDiagnostics = ref<Diagnostic[]>([]);
	const status = ref<CanvasStatus>('idle');
	const failure = ref<string | null>(null);
	const blockCount = ref(0);
	const selectedBlockId = ref<string | null>(null);
	const highlightedBlockId = ref<string | null>(null);
	const decoratedBlocks = ref<readonly DecoratedBlock[]>([]);
	/** 已经画出来的模块：选中变了但模块没变时，只换高亮、不重画。 */
	let renderedNodeId: string | null = null;

	/** blockKey（`nodeId#stepPath`）→ blockId：块 id 分配一次就固定，重画时沿用。 */
	const blockIds = new Map<string, string>();
	/** blockId → 已经被挂上徽标与属性的那个积木元素（重扫时用来摘掉过期的）。 */
	const decorated = new Map<string, Element>();
	/** 调色板只读一次：徽标色值来自 `--cc-*`，与积木主题同源。 */
	let badgeColors: ReturnType<typeof badgePalette> | null = null;
	/** 画布当前代表的声明摘要：外部换了声明（摘要变）才重画，也是「内容没变就不写」的判据。 */
	let syncedDigest: string | null = null;
	/** 重画期间 Blockly 会补发一堆事件，那段里的变更不算用户操作。 */
	let rendering = false;
	let timer: ReturnType<typeof setTimeout> | null = null;
	let stopObserving: (() => void) | null = null;
	let resizeObserver: ResizeObserver | null = null;
	/** 自适应还没量成（容器当时没尺寸）——留给 ResizeObserver 补一次。 */
	let needsFit = false;
	let fitFrame: number | null = null;
	/** 标记同步排的这一帧。 */
	let decorationFrame: number | null = null;

	const writeSuspended = computed(() => renderDiagnostics.value.some((item) => item.severity === 'error'));

	const diagnostics = computed<readonly DiagnosticRow[]>(() => {
		const rows: DiagnosticRow[] = [];
		const seen = new Set<string>();
		const push = (source: DiagnosticRow['source'], items: readonly Diagnostic[]): void => {
			for (const diagnostic of items) {
				const key = `${source}|${diagnostic.severity}|${diagnostic.code}|${diagnostic.path ?? ''}|${diagnostic.message}`;
				if (seen.has(key)) continue;
				seen.add(key);
				rows.push({ diagnostic, source });
			}
		};
		push('compile', renderDiagnostics.value);
		push('compile', compileDiagnostics.value);
		push('declaration', store.diagnostics.value);
		return rows;
	});

	const statusText = computed<string>(() => {
		switch (status.value) {
			case 'idle':
				return '还没有声明——导入一份任务 JSON，积木就会画在这里';
			case 'synced':
				return '与声明一致';
			case 'written':
				return '已写回声明';
			case 'rejected':
				return '写回被拒：非法值只留诊断，真相没动';
			case 'broken':
				return '这个模块画不出来（原因见下），写回已暂停';
			case 'failed':
				return '画布起不来（原因见下）';
		}
	});

	const moduleTitle = computed<string>(() => {
		if (store.declaration.value === null) return '还没有模块';
		const capability = activeCapability.value;
		return capability === null ? '未知模块 · 实现' : `${capability.label} · 实现`;
	});

	/** 当前该显示哪个模块：选中的那个，没选中就是第一个（与渲染器同一份口径）。 */
	const activeNode = computed(() => activeNodeOf(store.declaration.value, store.selectedNodeId.value));
	const activeNodeId = computed<string | null>(() => activeNode.value?.id ?? null);
	/** 这个模块指向的能力。标题不依赖画布起没起来——它只读声明与目录。 */
	const activeCapability = computed(() => {
		const parameters = activeNode.value?.parameters;
		const ref = parameters === undefined ? null : capabilityRefFromParameters(parameters);
		return ref === null ? null : (findCapability(PHASE1_ROBOT_CATALOG, ref) ?? null);
	});

	/**
	 * 当前选中的是**第几步**：store 里的 `selectedStepIndex` 是权威（代码面板点行也是它），
	 * 没有它时从选中的那块积木的 `data.stepPath` 推——两条路问的是同一件事。
	 */
	const activeStepIndex = computed<number | null>(() => {
		const explicit = store.selectedStepIndex.value;
		if (explicit !== null) return explicit;
		const blockId = store.selectedBlockId.value;
		if (blockId === null) return null;
		const block = workspace.value?.getBlockById(blockId) ?? null;
		return block === null ? null : (identityPayload(block)?.stepIndex ?? null);
	});

	/** 现在高亮/亮徽标的是哪一块：选中那一步的**顶层**积木，其次选中的那块，再其次模块的第一块。 */
	const highlightTarget = (): string | null => {
		const index = blockIndex.value;
		const step = activeStepIndex.value;
		if (index !== null && step !== null) {
			const identity = index.byTopLevelStep.get(step);
			if (identity !== undefined) return identity.blockId;
		}
		if (index === null) return null;
		return resolveSelection(index, store.selectedBlockId.value, store.selectedNodeId.value)?.blockId ?? null;
	};

	/**
	 * 画布 → 两处标记（M3 的「框」）+ 树的位置。一次遍历干四件事，都是幂等的：
	 *   1. 给每块积木挂 `data-node-id`（跨栏连线只认这个属性，不关心它是积木、卡片还是代码行）；
	 *   2. 挂 `data-cc-step-path` / `data-cc-node-tag`——这块积木在实现树里的位置与种类，
	 *      验收与调试读它，不用靠肉眼认；
	 *   3. 只给**顶层语句**挂/更新序号徽标（徽标数的是「实现里的第几步」，嵌套节点不数步），
	 *      亮的是当前选中那一步的那块；
	 *   4. 摘掉已经不在画布上的积木留下的徽标。
	 */
	function syncDecorations(): void {
		const current = workspace.value;
		if (current === null) return;
		const palette = badgeColors;
		if (palette === null) return;
		const active = highlightTarget();
		const activeStep = activeStepIndex.value;
		const seen = new Set<Element>();
		const rows: DecoratedBlock[] = [];

		for (const block of current.getAllBlocks(false)) {
			const identity = identityPayload(block);
			if (identity === null) continue; // 不是这次渲染画出来的块：没有 nodeId，不硬编一个
			const element = block.getSvgRoot();
			if (!(element instanceof Element)) continue;

			element.setAttribute(NODE_ID_ATTRIBUTE, identity.nodeId);
			element.setAttribute(STEP_PATH_ATTRIBUTE, identity.stepPath);
			element.setAttribute(NODE_TAG_ATTRIBUTE, identity.nodeTag);
			if (identity.topLevel && activeStep !== null && identity.stepIndex === activeStep) {
				element.setAttribute(STEP_ACTIVE_ATTRIBUTE, 'true');
			} else {
				element.removeAttribute(STEP_ACTIVE_ATTRIBUTE);
			}
			seen.add(element);

			// 徽标只挂顶层语句：它就是「实现里的第几步」，嵌套里的数字块不数步。
			let badge: SVGGElement | null = null;
			if (identity.topLevel) {
				const box = block.getHeightWidth();
				badge = badgeOfBlockElement(element);
				if (badge === null && box.width > 0) {
					badge = createBadgeElement(palette, identity.stepIndex + 1);
					element.append(badge);
				}
				if (badge !== null) {
					placeBadge(badge, box);
					updateBadge(badge, palette, identity.stepIndex + 1, block.id === active);
				}
			}

			rows.push({
				nodeId: identity.nodeId,
				blockId: block.id,
				element,
				stepPath: identity.stepPath,
				stepIndex: identity.stepIndex,
				topLevel: identity.topLevel,
				nodeTag: identity.nodeTag,
				badge,
			});
		}

		for (const [blockId, element] of decorated) {
			if (seen.has(element)) continue;
			badgeOfBlockElement(element)?.remove();
			decorated.delete(blockId);
		}
		// 同一个模块的每块积木都挂同一个 nodeId，所以这张表按 blockId 去重（nodeId 会重复）。
		for (const row of rows) decorated.set(row.blockId, row.element);
		decoratedBlocks.value = rows;
	}

	/**
	 * 把标记同步排到下一帧。
	 *
	 * 选中态是 Blockly 那边先落定的：`setHighlighted` 走的是 `queueRender()`，
	 * 这一帧里元素上还没有 `blocklyHighlighted`。同一帧同步跟上去，徽标就会慢半拍
	 * （积木亮了、它上面的徽标还是常态）——排到下一帧，两边说的才是同一件事。
	 */
	function scheduleDecorations(): void {
		if (decorationFrame !== null) return;
		decorationFrame = requestAnimationFrame(() => {
			decorationFrame = null;
			syncDecorations();
		});
	}

	/** 声明 + 当前模块 → 工作区。 */
	function render(declaration: WorkflowDeclaration): void {
		const current = workspace.value;
		if (current === null) return;
		rendering = true;
		try {
			const result = renderDeclaration({
				workspace: current,
				declaration,
				catalog: PHASE1_ROBOT_CATALOG,
				selectedNodeId: store.selectedNodeId.value,
				blockIds,
			});
			for (const [key, blockId] of result.blockIds) blockIds.set(key, blockId);
			blockIndex.value = result.index;
			renderDiagnostics.value = [...result.diagnostics];
			blockCount.value = result.index.order.length;
			renderedNodeId = result.nodeId;
			syncedDigest = declaration.digest;
			status.value = writeSuspended.value ? 'broken' : 'synced';
			Blockly.svgResize(current);
			// 重画之后把这条实现链量一遍：按内容定一个装得下、又不会小到看不清的比例，并居中。
			// 只在这里（以及第一次量到容器尺寸时）做——用户自己缩放/拖动过的视图不会被抢回去。
			requestFit(current);
		} finally {
			rendering = false;
		}
		// 重画会换掉全部积木元素，徽标与 `data-node-id` 得重新挂一遍。
		syncSelectionFromStore();
		syncDecorations();
	}

	/**
	 * 自适应要等排版落定：`onMounted` 那一刻容器可能还是零尺寸，积木也还没算出几何，
	 * 这时候量出来是 0，比例就定不下来。所以放到下一帧再量，并留一个「还没量成」的标记，
	 * 由 ResizeObserver 在第一次真正拿到尺寸时补一次。量成之后就不再动视口。
	 */
	function requestFit(current: Blockly.WorkspaceSvg): void {
		needsFit = true;
		if (fitFrame !== null) cancelAnimationFrame(fitFrame);
		fitFrame = requestAnimationFrame(() => {
			fitFrame = null;
			Blockly.svgResize(current);
			if (fitWorkspaceToContent(current) !== null) needsFit = false;
			// 几何这一刻才算准（块高、字段宽都定了），贴角的徽标按这个尺寸再摆一次。
			syncDecorations();
		});
	}

	/** 工作区 → 声明（唯一写路径）。 */
	function commit(): void {
		const current = workspace.value;
		const base = store.declaration.value;
		if (current === null || base === null || writeSuspended.value) return;

		const result = compileWorkspace({ workspace: current, base, catalog: PHASE1_ROBOT_CATALOG });
		blockIndex.value = result.index;
		compileDiagnostics.value = [...result.diagnostics];

		if (!result.ok || result.declaration === null) {
			status.value = 'rejected';
			return;
		}
		if (result.declaration.digest === syncedDigest) {
			// 内容没变（比如只是点了一下字段）：不打扰真相。
			status.value = 'synced';
			syncDecorations();
			return;
		}

		if (store.applyDeclaration(result.declaration)) {
			syncedDigest = result.declaration.digest;
			status.value = 'written';
			syncDecorations();
			return;
		}
		// store 那道闸也没过：把它的诊断摆出来，真相依旧不动。
		status.value = 'rejected';
		compileDiagnostics.value = [...store.diagnostics.value];
	}

	function schedule(): void {
		if (timer !== null) clearTimeout(timer);
		timer = setTimeout(() => {
			timer = null;
			commit();
		}, WRITE_DEBOUNCE_MS);
	}

	/**
	 * 积木被选中 → 推给 store（模块 + 块 + **第几步**）。
	 *
	 * 实现是一棵树，所以「第几步」只能是它所属的**顶层语句**下标：点嵌在条件里的数字块，
	 * 说的也是「这条 if 是第 2 步」。代码面板按同一个数对齐行，两边才对得上。
	 *
	 * **只认认得出的块**：Blockly 在「取消高亮一块积木」时发的也是 `newElementId` 为空的
	 * `Selected` 事件——与「点了画布空白处」形状完全一样，分不出来（实测：切换模块时的
	 * 取消高亮会发这么一条）。旧模型里把它当「取消选中」只是掉个高亮；新模型下选中决定
	 * **画布显示哪个模块**，误判一次的后果是画布自己跳回第一个模块——那是猜的，不是用户意思。
	 * 所以这道门只往里走：认得出的块才改选中，其余一概不动 store。
	 */
	function applySelection(blockId: string | null): void {
		const index = blockIndex.value;
		const identity = index === null ? null : resolveSelection(index, blockId, null);
		if (identity === null) return;
		selectedBlockId.value = identity.blockId;
		const already =
			identity.nodeId === store.selectedNodeId.value &&
			identity.blockId === store.selectedBlockId.value &&
			identity.stepIndex === store.selectedStepIndex.value;
		if (already) return;
		store.select(identity.nodeId, identity.blockId);
		store.selectStep(identity.stepIndex);
	}

	/** store 的选中 → 画布高亮；没给 blockId 时按 nodeId 找（流程画布、代码面板点过来的那种）。 */
	function syncSelectionFromStore(): void {
		const current = workspace.value;
		if (current === null) return;
		const index = blockIndex.value;
		selectedBlockId.value =
			index === null
				? null
				: (resolveSelection(index, store.selectedBlockId.value, store.selectedNodeId.value)?.blockId ?? null);
		const target = highlightTarget();
		highlightedBlockId.value = target;
		highlightBlock(current, target);
		// 徽标的选中态跟 `blocklyHighlighted` 是同一次选中推出来的，但那个 class 要等 Blockly 渲染完才落
		// （见 `scheduleDecorations`），所以这一帧只排队。
		scheduleDecorations();
	}

	/** 选中的模块换了才重画；同一模块内换高亮（或换步）不算重画。 */
	function syncModuleFromStore(): void {
		const declaration = store.declaration.value;
		const wanted = activeNodeId.value;
		if (declaration === null || wanted === renderedNodeId) {
			syncSelectionFromStore();
			return;
		}
		render(declaration);
	}

	onMounted(() => {
		const host = hostRef.value;
		if (host === null) return;
		try {
			// 主题色从 theme.css 的 --cc-* 变量读；缺变量就抛，画布不画。
			const palette: ThemePalette = paletteFromDocument();
			badgeColors = badgePalette(palette);
			const current = createCanvasWorkspace(host, palette, PHASE1_ROBOT_CATALOG);
			workspace.value = current;
			stopObserving = observe(current);
			resizeObserver = new ResizeObserver(() => {
				Blockly.svgResize(current);
				// 第一次真正量到尺寸时补一次自适应（挂载那一刻容器还没排版）。
				if (needsFit && fitWorkspaceToContent(current) !== null) needsFit = false;
				syncDecorations();
			});
			resizeObserver.observe(host);

			const declaration = store.declaration.value;
			if (declaration === null) status.value = 'idle';
			else render(declaration);
			syncSelectionFromStore();
		} catch (error) {
			// 起不来就说起不来：调色板缺变量、容器坏掉，都在这时落到界面上。
			status.value = 'failed';
			failure.value = error instanceof Error ? error.message : String(error);
		}
	});

	onBeforeUnmount(() => {
		if (timer !== null) clearTimeout(timer);
		if (fitFrame !== null) cancelAnimationFrame(fitFrame);
		if (decorationFrame !== null) cancelAnimationFrame(decorationFrame);
		stopObserving?.();
		resizeObserver?.disconnect();
		workspace.value?.dispose();
		workspace.value = null;
		decorated.clear();
		decoratedBlocks.value = [];
	});

	/** 工作区事件 → 三类反应：参数变了要编译、选中变了要推给 store、块增删了要把标记补齐。 */
	function observe(current: Blockly.WorkspaceSvg): () => void {
		const listener = (event: Blockly.Events.Abstract): void => {
			if (event instanceof Blockly.Events.Selected) {
				if (!rendering) applySelection(event.newElementId ?? null);
				return;
			}
			// 纯外观的视口事件（缩放、滚动）不进这里：它们不改声明，也不改标记。
			if (event instanceof Blockly.Events.BlockChange && event.element !== 'field') return;
			if (!PARAMETER_EVENT_TYPES.has(event.type)) return;

			// 块刚建出来那一刻它的 `<g>` 还没进工作区（Blockly 把属性挂在我们拿到元素之后），
			// 所以补标记放到微任务里做，别在这一帧里抢。
			queueMicrotask(() => {
				if (!rendering) syncDecorations();
			});
			if (!rendering) schedule();
		};
		current.addChangeListener(listener);
		return () => {
			current.removeChangeListener(listener);
		};
	}

	// 外部换声明（导入新任务、别处写回）：摘要不同才重画。
	watch(store.declaration, (declaration) => {
		if (declaration === null) return;
		if (declaration.digest === syncedDigest) return;
		render(declaration);
	});

	// 选中变了：模块换了就重画（画布画的是这个模块的实现），模块没换只挪高亮。
	watch([store.selectedNodeId, store.selectedBlockId], () => {
		syncModuleFromStore();
	});

	// 选中「步」变了（点代码面板某一行也是这条）：高亮那一步的顶层积木，不重画。
	watch(store.selectedStepIndex, () => {
		syncSelectionFromStore();
	});

	return {
		hostRef,
		diagnostics,
		status,
		statusText,
		failure,
		blockCount,
		writeSuspended,
		selectedBlockId,
		decoratedBlocks,
		activeNodeId,
		moduleTitle,
		activeStepIndex,
		highlightedBlockId,
	};
}

interface BlockIdentityPayload {
	readonly nodeId: string;
	readonly stepPath: string;
	readonly stepIndex: number;
	readonly topLevel: boolean;
	readonly nodeTag: string;
}

/**
 * 从积木的 `data` 里读回 nodeId 与它在实现树里的位置。
 *
 * `@codecanvas/blockly-toolkit` 的 `identityOfBlock` 走的是同一份 `data`，
 * 但这里必须**不依赖 Blockly 的 Block 实例**——徽标与属性是 DOM 上的事。
 */
function identityPayload(block: Blockly.Block): BlockIdentityPayload | null {
	const parsed = parseBlockData(block.data);
	if (parsed === null) return null;
	const stepIndex = topLevelStepIndexOf(parsed.stepPath);
	if (stepIndex === null) return null;
	return {
		nodeId: parsed.nodeId,
		stepPath: parsed.stepPath,
		stepIndex,
		topLevel: !parsed.stepPath.includes('.'),
		nodeTag: parsed.nodeTag,
	};
}

/** 解析 `block.data`（与 toolkit 的 `parseBlockData` 同形，这里只需要三个字段）。 */
function parseBlockData(
	data: string | null | undefined,
): { readonly nodeId: string; readonly stepPath: string; readonly nodeTag: string } | null {
	if (data === null || data === undefined || data.length === 0) return null;
	try {
		const parsed: unknown = JSON.parse(data);
		if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
		const record = parsed as Record<string, unknown>;
		const nodeId = record['nodeId'];
		const stepPath = record['stepPath'];
		const nodeTag = record['nodeTag'];
		if (typeof nodeId !== 'string' || nodeId.length === 0) return null;
		if (typeof stepPath !== 'string' || stepPath.length === 0) return null;
		return { nodeId, stepPath, nodeTag: typeof nodeTag === 'string' ? nodeTag : '' };
	} catch {
		return null;
	}
}
