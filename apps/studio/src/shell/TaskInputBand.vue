<script setup lang="ts">
/**
 * 上层输入带：品牌条与三栏之间那一条。
 *
 * 左半是本阶段**唯一的真实输入口**——任务 JSON。三条路都汇到同一个函数：
 * 粘贴、拖入、从接口取（`fetch` 读到文本后同样交给 `useStudioDocument().loadTaskJson`）。
 * 成功才换真相（三个视图跟着刷新），失败只把诊断摆在输入区下方，不弹窗、不 alert、
 * 不动已有的声明。
 *
 * 「生成任务」那一步不归这一层：上游生成器负责「自然语言 → 任务 JSON」（spec §0）。
 * 这里只把**已经生成好的**那份取回来——所以接口地址是个普通入口，不是生成器。
 * 取回来的原文会落进输入框，拿到的是什么看得见，改完还能照常「转换」。
 *
 * 右半的转译链不是装饰：获取 / 转换进行中它逐段点亮，成功后全亮一小会儿再回常态
 * 并留下「已完成」标记，失败则停在出错的那一段（染成危险色）。
 */
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import type { Diagnostic } from '@codecanvas/contracts';
import { useStudioDocument } from '../state/document';
import { SAMPLE_TASK_JSON } from '../state/sample-task';

const doc = useStudioDocument();

/**
 * 接口地址记在本地。联调时那个地址要反复填，刷新一次就没了最烦人；
 * 但它不是真相的一部分，所以只进 localStorage，不进 store。
 */
const ENDPOINT_STORAGE_KEY = 'codecanvas.task-endpoint';
const DEFAULT_ENDPOINT = 'http://localhost:8000/task';

const readEndpoint = (): string => {
	try {
		const stored = window.localStorage.getItem(ENDPOINT_STORAGE_KEY);
		return stored === null || stored.trim() === '' ? DEFAULT_ENDPOINT : stored;
	} catch {
		// 隐私模式下 localStorage 会直接抛。地址记不住是小事，不该把整条输入带弄挂。
		return DEFAULT_ENDPOINT;
	}
};

/** 预填示例任务：输入带一上来就是可转换的，改一个数字就能试。 */
const text = ref(SAMPLE_TASK_JSON);
const endpoint = ref(readEndpoint());
const status = ref<'idle' | 'ok' | 'failed'>('idle');
const dragging = ref(false);
const sourceName = ref('');
/** 正在取 / 正在点亮链路。这期间「获取」按钮禁用，一次只跑一条。 */
const busy = ref(false);

/**
 * 传输层自己那几条失败（网络、HTTP 非 2xx）。
 *
 * 非 null 时它就是当前唯一该显示的一份——**要盖住**上一次转换留下的诊断，
 * 否则「接口没连上」旁边还挂着前一次粘贴报的错，读的人会以为是同一件事。
 * 协议校验那几条不从这里出：它们由 `loadTaskJson` 给，这里只负责显示。
 */
const transportDiagnostics = ref<readonly Diagnostic[] | null>(null);

const diagnostics = computed<readonly Diagnostic[]>(
	() => transportDiagnostics.value ?? doc.diagnostics.value,
);
const nodeCount = computed(() => doc.nodes.value.length);
/** 失败的是哪一步：传输层失败说「获取」，其余说「转换」。 */
const failureLabel = computed(() => (transportDiagnostics.value === null ? '转换失败' : '获取失败'));

/** 链路四段：任务 JSON → 积木 / 流程 / 代码。 */
const CHAIN_STEPS = 4;
/** 逐段点亮每段的停留。三段加起来 ~0.4s——够看清「在推进」，不演。 */
const CHAIN_STEP_MS = 130;
/** 成功后全亮的停留，之后回常态；「已完成」标记留着不动。 */
const CHAIN_HOLD_MS = 1200;

type ChainPhase = 'idle' | 'running' | 'done' | 'failed';

const chainPhase = ref<ChainPhase>('idle');
/** 已点亮到第几段（0 = 没点亮，都没动过）。 */
const chainStep = ref(0);
/** 停在第几段（0 = 没失败）。失败时这一段染危险色。 */
const chainFailAt = ref(0);
/** 终态标记。空串 = 不显示。 */
const chainNote = ref('');

/**
 * 一次只跑一条。按钮在跑的时候是禁用的，这里再兜一道：
 * 任何新动作（获取 / 转换 / 清空）都会把 runId 推进一格，在途的那条自己会退出——
 * 否则「获取中」的回调会把用户后来手动转出来的结果覆盖掉。
 */
let runId = 0;
let timers: ReturnType<typeof setTimeout>[] = [];

const wait = (ms: number): Promise<void> =>
	new Promise((resolve) => {
		timers.push(setTimeout(resolve, ms));
	});

onBeforeUnmount(() => {
	runId += 1;
	for (const timer of timers) clearTimeout(timer);
	timers = [];
});

watch(endpoint, (value) => {
	try {
		window.localStorage.setItem(ENDPOINT_STORAGE_KEY, value);
	} catch {
		// 存不下就存不下：地址留不住不影响这一次获取。
	}
});

const PARSE_ERROR_CODE = 'task_import.json_parse_error';

/**
 * 转换没过时，链路该停在第几段。
 *
 * 文本根本不是 JSON → 第 1 段（任务 JSON 就没就绪）；
 * 是 JSON 但没过协议 → 第 2 段（任务 JSON 到手了，积木没能产出）。
 * 判据用 code，不匹配 message。调用前必须已经跑过 `loadTaskJson`。
 */
const failStage = (): number =>
	doc.diagnostics.value.some((d) => d.code === PARSE_ERROR_CODE) ? 1 : 2;

const reason = (error: unknown): string => (error instanceof Error ? error.message : String(error));

const resetChain = (): void => {
	chainPhase.value = 'idle';
	chainStep.value = 0;
	chainFailAt.value = 0;
	chainNote.value = '';
};

const chainClass = (index: number): Record<string, boolean> => ({
	'is-lit': chainStep.value >= index && chainFailAt.value !== index,
	'is-live': chainPhase.value === 'running' && chainStep.value >= index && chainFailAt.value === 0,
	'is-failed': chainFailAt.value === index,
});

/** 换真相那一步。三条输入路都走它，失败时真相一个字节都不动。 */
const loadInto = (body: string): boolean => {
	const converted = doc.loadTaskJson(body);
	return settleChain(converted, converted ? 0 : failStage());
};

/**
 * 把链路的终态摆出来。转换本身是同步的，没法真「逐段」——所以这里只报结论，
 * 让调用方在需要的时候先把点亮过程演到最后一格。
 *
 * 返回 `converted` 原值，省得调用方再记一次。
 */
const settleChain = (converted: boolean, failAt: number): boolean => {
	if (!converted) {
		chainStep.value = failAt;
		chainFailAt.value = failAt;
		chainPhase.value = 'failed';
		chainNote.value = `失败 · 停在第 ${String(failAt)} 段`;
		return false;
	}

	chainPhase.value = 'done';
	chainStep.value = CHAIN_STEPS;
	chainFailAt.value = 0;
	chainNote.value = `已完成 · ${String(nodeCount.value)} 个节点`;

	// 全亮只停一小会儿就回常态，不允许一直闪；「已完成」这四个字留在原地当终态。
	const mine = runId;
	void wait(CHAIN_HOLD_MS).then(() => {
		if (runId !== mine || chainPhase.value !== 'done') return;
		chainPhase.value = 'idle';
		chainStep.value = 0;
	});
	return true;
};

/** 手工入口（粘贴 / 拖入落定后点的那一下）。同步完成，链路直接把结论摆出来。 */
function convert(): void {
	runId += 1;
	transportDiagnostics.value = null;
	chainFailAt.value = 0;
	status.value = loadInto(text.value) ? 'ok' : 'failed';
}

function clear(): void {
	runId += 1;
	text.value = '';
	sourceName.value = '';
	status.value = 'idle';
	transportDiagnostics.value = null;
	resetChain();
}

/** 从接口取。只有这一条路真正花时间，链路就在这段时间里亮着。 */
async function fetchTask(): Promise<void> {
	const url = endpoint.value.trim();
	if (url === '' || busy.value) return;

	const mine = (runId += 1);
	busy.value = true;
	transportDiagnostics.value = null;
	status.value = 'idle';
	chainPhase.value = 'running';
	chainStep.value = 1;
	chainFailAt.value = 0;
	chainNote.value = '获取中…';

	/*
	 * 整条流程包在 try 里，`busy` 在 finally 里无条件放下。
	 * 中途被别的动作打断（runId 变了）时下面几个 `return` 就直接走掉——
	 * 要是各自负责收尾，漏一条「获取」按钮就永远禁用了。
	 * 这里无条件清是安全的：只有本函数会把它立起来，而它开头就被 `busy` 挡着。
	 */
	try {
		let body: string;
		try {
			const response = await fetch(url, { headers: { accept: 'application/json' } });
			// 非 2xx 也归到「网络失败」这一类：用户看到的都是「这个地址没取回任务 JSON」。
			if (!response.ok) throw new Error(`HTTP ${String(response.status)} ${response.statusText}`);
			body = await response.text();
		} catch (error) {
			if (runId !== mine) return;
			transportDiagnostics.value = [
				{
					code: 'task_input.fetch_failed',
					severity: 'error',
					message: `接口没取回任务 JSON：${reason(error)}`,
					ref: url,
				},
			];
			chainStep.value = 1;
			chainFailAt.value = 1;
			chainPhase.value = 'failed';
			chainNote.value = '获取失败 · 停在第 1 段';
			status.value = 'failed';
			return;
		}

		if (runId !== mine) return;

		// 取回来的原文先落进输入框：拿到的是什么，得让人看得见，也让人能接着改。
		text.value = body;
		sourceName.value = '';

		// 转换是同步的，先把结论拿到手，再让链路把「积木 / 流程 / 代码」逐段点亮到该停的地方。
		const converted = doc.loadTaskJson(body);
		const failAt = converted ? 0 : failStage();
		const lastLit = converted ? CHAIN_STEPS : failAt;

		for (let index = 2; index <= lastLit; index += 1) {
			chainStep.value = index;
			await wait(CHAIN_STEP_MS);
			if (runId !== mine) return;
		}

		status.value = settleChain(converted, failAt) ? 'ok' : 'failed';
	} finally {
		busy.value = false;
	}
}

// `.prevent` 是必须的：不拦 dragover 浏览器就把文件当导航打开了。
function onDragOver(): void {
	dragging.value = true;
}

function onDragLeave(): void {
	dragging.value = false;
}

async function onDrop(event: DragEvent): Promise<void> {
	dragging.value = false;
	const file = event.dataTransfer?.files?.[0];
	if (file === undefined) return;
	// 读进来先落到输入框，再走和「转换」按钮同一个函数——拖入只是另一种粘贴。
	text.value = await file.text();
	sourceName.value = file.name;
	convert();
}

const location = (diagnostic: Diagnostic): string => {
	const path = diagnostic.path ?? '';
	const ref = diagnostic.ref ?? '';
	if (path !== '' && ref !== '') return `${path} · ${ref}`;
	return path !== '' ? path : ref;
};
</script>

<template>
	<section
		class="input-band"
		:class="{ 'is-dragging': dragging }"
		data-testid="task-input-band"
		@dragover.prevent="onDragOver"
		@dragleave="onDragLeave"
		@drop.prevent="onDrop"
	>
		<div class="band-row">
			<div class="intake">
				<header class="intake-head">
					<span class="intake-title">任务 JSON</span>
					<span class="intake-hint">粘贴、拖入 .json，或从接口取</span>
					<span class="intake-meta">
						<!-- 顺利时不占第二行：带子高度由变量钉住，失败或带诊断才往下长 -->
						<span
							v-if="status === 'ok' && diagnostics.length === 0"
							class="feedback-state ok"
							data-testid="task-input-status"
						>
							已转换 · {{ nodeCount }} 个节点
						</span>
						<span v-if="sourceName !== ''" class="intake-file" data-testid="task-input-file">
							{{ sourceName }}
						</span>
					</span>
				</header>

				<!--
					接口入口：地址 + 获取。它跟粘贴/拖入是并列的第三条路，
					不是替代——接口不可用时那两条还得在，所以它占自己一行，不挤进按钮组。
				-->
				<div class="intake-fetch">
					<span class="fetch-label">接口地址</span>
					<input
						v-model="endpoint"
						type="url"
						class="fetch-url"
						data-testid="task-endpoint-input"
						aria-label="任务 JSON 接口地址"
						spellcheck="false"
						placeholder="http://localhost:8000/task"
					/>
					<button
						type="button"
						class="btn btn-fetch"
						data-testid="task-fetch"
						:disabled="busy || endpoint.trim() === ''"
						@click="fetchTask"
					>
						{{ busy ? '获取中…' : '获取' }}
					</button>
				</div>

				<div class="intake-row">
					<textarea
						v-model="text"
						class="intake-text"
						data-testid="task-json-input"
						aria-label="任务 JSON"
						spellcheck="false"
						placeholder='{ "schema_version": "1.0", "task_id": "task-1", "steps": [ ... ] }'
					></textarea>
					<div class="intake-actions">
						<button
							type="button"
							class="btn btn-convert"
							data-testid="task-convert"
							:disabled="text.trim() === ''"
							@click="convert"
						>
							转换
						</button>
						<button type="button" class="btn btn-clear" data-testid="task-clear" @click="clear">
							清空
						</button>
					</div>
				</div>
			</div>

			<div class="chain" data-testid="translation-chain">
				<div class="chain-head">
					<span class="chain-title">TRANSLATION</span>
					<!-- 终态标记：成功后一直留着，失败则指出停在哪一段。它不闪。 -->
					<span
						v-if="chainNote !== ''"
						class="chain-badge"
						:class="chainPhase"
						data-testid="translation-chain-state"
					>
						{{ chainNote }}
					</span>
				</div>
				<ol class="chain-list">
					<li class="chain-node chain-source" :class="chainClass(1)">
						<span class="chain-dot" aria-hidden="true"></span>任务 JSON
					</li>
					<li class="chain-arrow" aria-hidden="true">→</li>
					<li class="chain-node" :class="chainClass(2)">积木</li>
					<li class="chain-slash" aria-hidden="true">/</li>
					<li class="chain-node" :class="chainClass(3)">流程</li>
					<li class="chain-slash" aria-hidden="true">/</li>
					<li class="chain-node" :class="chainClass(4)">代码</li>
				</ol>
				<span class="chain-note">上游生成器负责「自然语言 → 任务 JSON」；这里只把它取回来</span>
			</div>
		</div>

		<div
			v-if="status === 'failed' || diagnostics.length > 0"
			class="feedback"
			data-testid="task-input-feedback"
		>
			<div class="feedback-head">
				<span class="feedback-state" :class="status" data-testid="task-input-status">
					{{
						status === 'ok'
							? `已转换 · ${nodeCount} 个节点`
							: `${failureLabel} · 声明未改动，三个视图保持原样`
					}}
				</span>
				<span v-if="diagnostics.length > 0" class="feedback-count">
					{{ diagnostics.length }} 条诊断
				</span>
			</div>
			<ul v-if="diagnostics.length > 0" class="feedback-list" data-testid="task-input-diagnostics">
				<li
					v-for="(diagnostic, index) in diagnostics"
					:key="`${index}-${diagnostic.code}-${diagnostic.path ?? ''}`"
					class="diagnostic"
					:class="diagnostic.severity"
					data-testid="task-input-diagnostic"
				>
					<span class="diagnostic-code">{{ diagnostic.code }}</span>
					<span class="diagnostic-message">{{ diagnostic.message }}</span>
					<span v-if="location(diagnostic) !== ''" class="diagnostic-where">
						{{ location(diagnostic) }}
					</span>
				</li>
			</ul>
		</div>
	</section>
</template>

<style scoped>
.input-band {
	display: flex;
	flex-direction: column;
	gap: var(--cc-space-2);
	flex: 0 0 auto;
	min-height: var(--cc-inputband-h);
	padding: var(--cc-space-2) var(--cc-space-3);
	background: var(--cc-surface);
	border-bottom: 1px solid var(--cc-line);
}

.band-row {
	display: grid;
	grid-template-columns: minmax(0, 1fr) auto;
	gap: var(--cc-space-4);
	align-items: stretch;
	/*
	 * 行高由变量钉死（减掉带子自己的内边距与下边框），带子总高才正好是 --cc-inputband-h。
	 * 不钉的话高度会被内容撑开：转译链是三层，输入区跟着长，一条「输入带」就厚成一块面板。
	 * 诊断出现时带子靠 min-height 自然长高，行高不受影响。
	 *
	 * 矮窗下 --cc-inputband-h 自己会变薄（它是 clamp(150px, 37vh, 340px)），这里跟着退——
	 * 三栏的可用高度就是这么让出来的。
	 */
	height: calc(var(--cc-inputband-h) - var(--cc-space-2) * 2 - 1px);
	/* 轨道钉成 1fr：不然行高会跟着子项的 min-content 长（输入区那 60px 的文本框说了算），
	   行比带子还高，内容就压到下面的画布上去了。 */
	grid-template-rows: minmax(0, 1fr);
	min-height: 0;
}

/* 输入区：虚线框，明示「这里可以拖东西进来」 */
.intake {
	display: flex;
	flex-direction: column;
	gap: var(--cc-space-1);
	min-width: 0;
	padding: var(--cc-space-2);
	min-height: 0;
	overflow: hidden;
	background: var(--cc-surface-sunken);
	border: 1px dashed var(--cc-line-strong);
	border-radius: var(--cc-radius);
	transition:
		border-color 0.15s ease,
		background 0.15s ease;
}

.input-band.is-dragging .intake {
	border-color: var(--cc-accent);
	background: var(--cc-accent-veil);
}

.intake-head {
	display: flex;
	align-items: baseline;
	gap: var(--cc-space-2);
	flex: 0 0 auto;
	min-width: 0;
	/* 钉死行高：默认的 normal 会按继承来的 13px 字号算，比这一行的 11px 字高出一截，
	   白吃掉输入框近一行的高度——这一带每一像素都该给文本框。 */
	line-height: 1.2;
}

.intake-title {
	font-size: var(--cc-fs-sm);
	font-weight: 600;
	color: var(--cc-text);
}

.intake-hint {
	min-width: 0;
	overflow: hidden;
	font-size: var(--cc-fs-xs);
	color: var(--cc-text-faint);
	text-overflow: ellipsis;
	white-space: nowrap;
}

.intake-meta {
	display: flex;
	align-items: baseline;
	gap: var(--cc-space-2);
	margin-left: auto;
	flex: 0 0 auto;
}

.intake-file {
	font-family: var(--cc-font-mono);
	font-size: var(--cc-fs-xs);
	color: var(--cc-accent);
	max-width: 220px;
	overflow: hidden;
	text-overflow: ellipsis;
	white-space: nowrap;
}

/* 接口一行：地址吃掉剩下的宽，获取按钮贴在右端，跟下面「转换 / 清空」同一列对齐观感 */
.intake-fetch {
	display: grid;
	grid-template-columns: auto minmax(0, 1fr) auto;
	align-items: center;
	gap: var(--cc-space-2);
	flex: 0 0 auto;
	min-width: 0;
}

.fetch-label {
	font-size: var(--cc-fs-xs);
	color: var(--cc-text-dim);
	white-space: nowrap;
}

.fetch-url {
	width: 100%;
	min-width: 0;
	padding: 5px var(--cc-space-2);
	line-height: 1.2;
	font-family: var(--cc-font-mono);
	font-size: var(--cc-fs-sm);
	color: var(--cc-text);
	background: var(--cc-bg);
	border: 1px solid var(--cc-line);
	border-radius: var(--cc-radius-sm);
}

.fetch-url::placeholder {
	color: var(--cc-text-faint);
}

.fetch-url:focus {
	outline: none;
	border-color: var(--cc-accent-dim);
	box-shadow: 0 0 0 1px var(--cc-accent-glow) inset;
}

.intake-row {
	display: grid;
	grid-template-columns: minmax(0, 1fr) auto;
	grid-template-rows: minmax(0, 1fr);
	gap: var(--cc-space-2);
	flex: 1 1 auto;
	min-height: 0;
}

/*
 * 输入框：撑满剩下的高度。带子按视口取 37vh（150–340px），扣掉标题行与接口行之后
 * 桌面高度上还有十行上下——一份完整任务 JSON 能看全，直接在里面改也行。矮窗跟着带子一起退。
 */
.intake-text {
	width: 100%;
	height: 100%;
	min-height: 0;
	padding: var(--cc-space-1) var(--cc-space-2);
	font-family: var(--cc-font-mono);
	font-size: var(--cc-fs-sm);
	line-height: 1.5;
	color: var(--cc-text);
	background: var(--cc-bg);
	border: 1px solid var(--cc-line);
	border-radius: var(--cc-radius-sm);
	resize: none;
}

.intake-text::placeholder {
	color: var(--cc-text-faint);
}

.intake-text:focus {
	outline: none;
	border-color: var(--cc-accent-dim);
	box-shadow: 0 0 0 1px var(--cc-accent-glow) inset;
}

.intake-actions {
	display: flex;
	align-items: center;
	gap: var(--cc-space-1);
}

.btn {
	padding: 5px var(--cc-space-2);
	line-height: 1.2;
	font-size: var(--cc-fs-sm);
	font-weight: 650;
	letter-spacing: 0.04em;
	border: 1px solid transparent;
	border-radius: var(--cc-radius-sm);
	cursor: pointer;
	transition:
		filter 0.15s ease,
		color 0.15s ease,
		background 0.15s ease;
}

.btn-convert {
	min-width: 58px;
	color: var(--cc-surface-sunken);
	background: var(--cc-accent);
	border-color: var(--cc-accent-strong);
	box-shadow: 0 0 12px var(--cc-accent-glow);
}

.btn-convert:hover:not(:disabled) {
	filter: brightness(1.1);
}

.btn-convert:disabled {
	color: var(--cc-disabled-text);
	background: var(--cc-disabled-surface);
	border-color: var(--cc-line);
	box-shadow: none;
	cursor: not-allowed;
}

/* 获取比转换轻一档：它是取料，转换才是换真相的那一步 */
.btn-fetch {
	min-width: 58px;
	color: var(--cc-accent-strong);
	background: var(--cc-accent-veil);
	border-color: var(--cc-accent-dim);
}

.btn-fetch:hover:not(:disabled) {
	filter: brightness(1.15);
}

.btn-fetch:disabled {
	color: var(--cc-disabled-text);
	background: var(--cc-disabled-surface);
	border-color: var(--cc-line);
	cursor: not-allowed;
}

.btn-clear {
	color: var(--cc-text-dim);
	background: transparent;
	border-color: var(--cc-line-strong);
}

.btn-clear:hover {
	color: var(--cc-text);
	background: var(--cc-surface-raised);
}

/* 转译链：与底部 PIPELINE 同一套观感（胶囊 + 箭头 + 淡色标题） */
.chain {
	display: flex;
	flex-direction: column;
	justify-content: center;
	gap: var(--cc-space-1);
	flex: 0 0 auto;
	min-height: 0;
	overflow: hidden;
	padding: 0 var(--cc-space-1) 0 var(--cc-space-2);
}

.chain-head {
	display: flex;
	align-items: baseline;
	gap: var(--cc-space-2);
	min-width: 0;
}

.chain-title {
	font-size: var(--cc-fs-xs);
	letter-spacing: 0.18em;
	color: var(--cc-text-faint);
}

/* 终态标记：安静的一行字，靠颜色说话，不靠闪 */
.chain-badge {
	min-width: 0;
	overflow: hidden;
	font-family: var(--cc-font-mono);
	font-size: var(--cc-fs-xs);
	color: var(--cc-text-faint);
	text-overflow: ellipsis;
	white-space: nowrap;
}

.chain-badge.running {
	color: var(--cc-chain-live);
}

.chain-badge.done {
	color: var(--cc-chain-lit);
}

.chain-badge.failed {
	color: var(--cc-chain-failed);
}

.chain-list {
	display: flex;
	align-items: center;
	gap: var(--cc-space-1);
	margin: 0;
	padding: 0;
	list-style: none;
}

.chain-node {
	display: flex;
	align-items: center;
	gap: var(--cc-space-2);
	padding: 3px var(--cc-space-2);
	font-size: var(--cc-fs-sm);
	color: var(--cc-text-dim);
	border: 1px solid var(--cc-line-strong);
	border-radius: 999px;
	white-space: nowrap;
	transition:
		color 0.12s ease,
		background 0.12s ease,
		border-color 0.12s ease,
		box-shadow 0.12s ease;
}

.chain-source {
	color: var(--cc-accent);
	background: var(--cc-accent-veil);
	border-color: var(--cc-accent-dim);
}

.chain-dot {
	width: 6px;
	height: 6px;
	border-radius: 50%;
	background: currentColor;
	opacity: 0.55;
}

/* 已点亮：这一段过了。安静版强调色，不发光。 */
.chain-node.is-lit {
	color: var(--cc-chain-lit);
	background: var(--cc-chain-lit-veil);
	border-color: var(--cc-chain-lit-border);
}

.chain-node.is-lit .chain-dot {
	opacity: 1;
}

/*
 * 进行中：唯一会动的东西。呼吸很浅（只改不透明度），动完就停——
 * 目的是「看得出在干活」，不是表演；全亮之后不会一直闪。
 */
.chain-node.is-live {
	color: var(--cc-chain-live);
	border-color: var(--cc-chain-lit);
	box-shadow: 0 0 10px var(--cc-accent-glow);
	animation: chain-breathe 0.9s ease-in-out infinite;
}

.chain-node.is-live .chain-dot {
	opacity: 1;
}

/* 停在出错的那一段 */
.chain-node.is-failed {
	color: var(--cc-chain-failed);
	background: var(--cc-chain-failed-veil);
	border-color: var(--cc-chain-failed-border);
}

.chain-node.is-failed .chain-dot {
	background: var(--cc-chain-failed);
	opacity: 1;
}

@keyframes chain-breathe {
	0%,
	100% {
		opacity: 1;
	}

	50% {
		opacity: 0.45;
	}
}

/* 降级：不要动效的人看到的是一段稳定常亮的灯，信息一个不少 */
@media (prefers-reduced-motion: reduce) {
	.chain-node.is-live {
		animation: none;
	}

	.chain-node {
		transition: none;
	}
}

.chain-arrow,
.chain-slash {
	font-size: var(--cc-fs-sm);
	color: var(--cc-line-strong);
}

.chain-note {
	font-size: var(--cc-fs-xs);
	color: var(--cc-text-faint);
}

/* 诊断：跟积木侧那份同一形状（左侧色条区分严重度），摆在输入区下方 */
.feedback {
	display: flex;
	flex-direction: column;
	gap: var(--cc-space-1);
	flex: 0 0 auto;
	min-width: 0;
}

.feedback-head {
	display: flex;
	align-items: baseline;
	gap: var(--cc-space-2);
}

.feedback-state {
	font-size: var(--cc-fs-sm);
	font-weight: 600;
}

.feedback-state.ok {
	color: var(--cc-accent);
}

.feedback-state.failed {
	color: var(--cc-danger-strong);
}

.feedback-count {
	font-family: var(--cc-font-mono);
	font-size: var(--cc-fs-xs);
	color: var(--cc-text-faint);
}

.feedback-list {
	display: flex;
	flex-direction: column;
	gap: var(--cc-space-1);
	max-height: 72px;
	margin: 0;
	padding: 0;
	overflow-y: auto;
	list-style: none;
}

.diagnostic {
	display: flex;
	align-items: baseline;
	gap: var(--cc-space-2);
	padding: var(--cc-space-1) var(--cc-space-2);
	background: var(--cc-surface-sunken);
	border: 1px solid var(--cc-line);
	border-left-width: 3px;
	border-radius: var(--cc-radius-sm);
}

.diagnostic.error {
	border-left-color: var(--cc-danger);
}

.diagnostic.warning {
	border-left-color: var(--cc-accent-dim);
}

.diagnostic.info {
	border-left-color: var(--cc-line-strong);
}

.diagnostic-code {
	flex: 0 0 auto;
	font-family: var(--cc-font-mono);
	font-size: var(--cc-fs-xs);
	color: var(--cc-text-dim);
}

.diagnostic.error .diagnostic-code {
	color: var(--cc-danger-strong);
}

.diagnostic-message {
	font-size: var(--cc-fs-sm);
	line-height: 1.5;
	color: var(--cc-text);
	overflow-wrap: anywhere;
}

.diagnostic-where {
	flex: 0 0 auto;
	margin-left: auto;
	font-family: var(--cc-font-mono);
	font-size: var(--cc-fs-xs);
	color: var(--cc-text-faint);
	overflow-wrap: anywhere;
}

/* 窄窗：先舍注释，再舍整条链——输入口永远留着，它才是这一带的功能 */
@media (max-width: 1180px) {
	.chain-note {
		display: none;
	}
}

/* 再窄一点：接口那一行的标签也舍掉，输入框本身留着 */
@media (max-width: 1020px) {
	.fetch-label {
		display: none;
	}

	.intake-fetch {
		grid-template-columns: minmax(0, 1fr) auto;
	}
}

@media (max-width: 900px) {
	.chain {
		display: none;
	}
}
</style>
