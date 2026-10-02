/**
 * 积木画布的全部接线（spec §4.1）：这是**唯一一条写路径**。
 *
 * 读：`store.declaration` 变了就重画工作区。
 * 写：工作区里字段/块变了 → 防抖 → `compileWorkspace`（跑声明校验 + 任务协议校验）
 *     → 过了才 `store.applyDeclaration`，没过就只留诊断、真相不动。
 *
 * 视图只负责摆放 DOM 与显示状态，Blockly 的用法都在 `@codecanvas/blockly-toolkit` 里。
 */
import * as Blockly from 'blockly';
import { computed, onBeforeUnmount, onMounted, ref, shallowRef, watch, type ComputedRef, type Ref } from 'vue';
import type { Diagnostic, WorkflowDeclaration } from '@codecanvas/contracts';
import {
	compileWorkspace,
	createCanvasWorkspace,
	fitWorkspaceToContent,
	highlightBlock,
	observeWorkspace,
	paletteFromDocument,
	renderDeclaration,
	resolveSelection,
	type BlockIndex,
} from '@codecanvas/blockly-toolkit';
import { useStudioDocument } from '../../state/document';

/** 一次字段编辑会连着来好几个事件（Blockly 自己也会补发），攒一下再编译。 */
const WRITE_DEBOUNCE_MS = 120;

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

	/** nodeId → blockId：块 id 分配一次就固定，重画时沿用。 */
	const blockIds = new Map<string, string>();
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
				return '画布不完整：有些积木画不出来，写回已暂停';
			case 'failed':
				return '画布起不来（原因见下）';
		}
	});

	/** 声明 → 工作区。 */
	function render(declaration: WorkflowDeclaration): void {
		const current = workspace.value;
		if (current === null) return;
		rendering = true;
		try {
			const result = renderDeclaration({ workspace: current, declaration, blockIds });
			for (const [nodeId, blockId] of result.blockIds) blockIds.set(nodeId, blockId);
			blockIndex.value = result.index;
			renderDiagnostics.value = [...result.diagnostics];
			blockCount.value = result.index.order.length;
			syncedDigest = declaration.digest;
			status.value = writeSuspended.value ? 'broken' : 'synced';
			Blockly.svgResize(current);
			// 重画之后把整条链量一遍：按内容定一个装得下、又不会小到看不清的比例，并居中。
			// 只在这里（以及第一次量到容器尺寸时）做——用户自己缩放/拖动过的视图不会被抢回去。
			requestFit(current);
		} finally {
			rendering = false;
		}
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
		});
	}

	/** 工作区 → 声明（唯一写路径）。 */
	function commit(): void {
		const current = workspace.value;
		const base = store.declaration.value;
		if (current === null || base === null || writeSuspended.value) return;

		const result = compileWorkspace({ workspace: current, base });
		blockIndex.value = result.index;
		compileDiagnostics.value = [...result.diagnostics];

		if (!result.ok || result.declaration === null) {
			status.value = 'rejected';
			return;
		}
		if (result.declaration.digest === syncedDigest) {
			// 内容没变（比如只是拖了下位置）：不打扰真相。
			status.value = 'synced';
			return;
		}

		if (store.applyDeclaration(result.declaration)) {
			syncedDigest = result.declaration.digest;
			compileDiagnostics.value = [];
			status.value = 'written';
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

	function applySelection(blockId: string | null): void {
		const index = blockIndex.value;
		const identity = index === null ? null : resolveSelection(index, blockId, null);
		selectedBlockId.value = identity?.blockId ?? null;
		if (identity === null) {
			if (store.selectedNodeId.value !== null || store.selectedBlockId.value !== null) store.select(null, null);
			return;
		}
		if (identity.nodeId === store.selectedNodeId.value && identity.blockId === store.selectedBlockId.value) return;
		store.select(identity.nodeId, identity.blockId);
	}

	/** store 的选中 → 画布高亮；没给 blockId 时按 nodeId 找（流程画布点过来的那种）。 */
	function syncSelectionFromStore(): void {
		const current = workspace.value;
		if (current === null) return;
		const index = blockIndex.value;
		const identity =
			index === null ? null : resolveSelection(index, store.selectedBlockId.value, store.selectedNodeId.value);
		selectedBlockId.value = identity?.blockId ?? null;
		highlightBlock(current, identity?.blockId ?? null);
	}

	onMounted(() => {
		const host = hostRef.value;
		if (host === null) return;
		try {
			// 主题色从 theme.css 的 --cc-* 变量读；缺变量就抛，画布不画。
			const current = createCanvasWorkspace(host, paletteFromDocument());
			workspace.value = current;
			stopObserving = observeWorkspace(current, {
				onParametersChange: () => {
					if (!rendering) schedule();
				},
				onSelectionChange: (blockId) => {
					if (!rendering) applySelection(blockId);
				},
			});
			resizeObserver = new ResizeObserver(() => {
				Blockly.svgResize(current);
				// 第一次真正量到尺寸时补一次自适应（挂载那一刻容器还没排版）。
				if (needsFit && fitWorkspaceToContent(current) !== null) needsFit = false;
			});
			resizeObserver.observe(host);

			const declaration = store.declaration.value;
			if (declaration === null) status.value = 'idle';
			else render(declaration);
			syncSelectionFromStore();
		} catch (error) {
			// 起不来就说起不来：调色板缺变量、容器坏掉，都在这里落到界面上。
			status.value = 'failed';
			failure.value = error instanceof Error ? error.message : String(error);
		}
	});

	onBeforeUnmount(() => {
		if (timer !== null) clearTimeout(timer);
		if (fitFrame !== null) cancelAnimationFrame(fitFrame);
		stopObserving?.();
		resizeObserver?.disconnect();
		workspace.value?.dispose();
		workspace.value = null;
	});

	// 外部换声明（导入新任务、别处写回）：摘要不同才重画。
	watch(store.declaration, (declaration) => {
		if (declaration === null) return;
		if (declaration.digest === syncedDigest) return;
		render(declaration);
	});

	watch([store.selectedBlockId, store.selectedNodeId], () => {
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
	};
}
