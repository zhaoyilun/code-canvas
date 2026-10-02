<script setup lang="ts">
/**
 * 上层入口带：品牌条与三栏之间那一条，**程序的入口**。
 *
 * 入口是两件事：**选设备**（给谁下指令）+ **说一句话**（干什么）。点「生成」把这两样
 * POST 给可配置的生成接口，拿回来的任务 JSON 交给 `useStudioDocument().loadTaskJson`——
 * 跟粘贴、拖入走的是**同一个函数**，没有第二条校验路径。
 *
 * 三条设计决定：
 *
 * 1. **入口矮。** 上一版在这里摆一个巨大的任务 JSON 文本框 + 接口地址 + 获取按钮，
 *    一条「入口」占掉小半屏，把工作区挤掉了。现在常态只有一行（下拉 + 一句话 + 生成），
 *    高度由 `--cc-entryband-h` 钉住。JSON 本身不在这里编辑——它有自己的家（右栏的任务 JSON tab）。
 * 2. **两样次要入口收起来，但不删。** 接口地址是联调用的（填一次记进 localStorage），
 *    手工灌 JSON 是接口还没就绪时的兜底——两者都折进小按钮，点开才占地方，且都不再占主位。
 * 3. **失败只出诊断。** 网络、HTTP 非 2xx、响应不是 JSON、JSON 不合协议，四类都摆在入口下方，
 *    不弹窗、不动已有的声明（真相一个字节都不改）。
 *
 * 右半的转译链不是装饰：生成进行中它逐段点亮，成功后全亮一小会儿再回常态并留下「已完成」标记，
 * 失败则停在出错的那一段（染成危险色）。
 */
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import type { Diagnostic } from '@codecanvas/contracts';
import { findTaskFormat, type TaskFormatRef } from '@codecanvas/task-import';
import { useStudioDocument } from '../state/document';
import { useStudioDevices } from './devices';
import { DEFAULT_LLM_ENDPOINT, DEFAULT_LLM_MODEL } from './llm-json';
import { generateTask, generationDiagnostic } from './task-generation';

const doc = useStudioDocument();
const devices = useStudioDevices();

/** 设备下拉绑的就是共享的选中设备——右栏的虚拟设备那块读的是同一个数。 */
const deviceRef = computed<string>({
	get: () => devices.selectedDeviceRef.value,
	set: (value) => {
		devices.setSelectedDevice(value);
	},
});

/**
 * 当前设备与它的格式。**任务格式是设备属性**（见 `shell/devices.ts`）：
 * 选哪台设备就决定了这一句话要收成什么形状、按哪把尺子校验，所以要显示出来。
 */
const selectedDevice = computed(() => devices.selectedDevice.value);
const formatRef = computed<TaskFormatRef | null>(() => selectedDevice.value?.formatRef ?? null);
const formatLabel = computed(() => (formatRef.value === null ? '' : findTaskFormat(formatRef.value).label));

/**
 * 粘贴框里的例子**跟着当前设备的格式走**。
 *
 * 写死一期那份形状是有害的：占位符是用户照着抄的东西，抄进去当场被拒，
 * 而错在他抄的是我们给的例子——那比空着还坏。
 */
const PASTE_EXAMPLE: Readonly<Record<TaskFormatRef, string>> = {
	phase1_task: '{ "schema_version": "1.0", "task_id": "task-1", "steps": [ ... ] }',
	skill_plan: '{ "schemaVersion": 1, "robot": "so101_single_arm", "plan": [ { "step": "skill", "skill": "…" } ] }',
};
const pastePlaceholder = computed(() =>
	formatRef.value === null ? '' : PASTE_EXAMPLE[formatRef.value],
);

/**
 * 真机还是仿真：设备名里也有括号说明，但那是一串长文字里的一部分，容易被略过。
 * 这一行是**单独说的**——发给仿真还是发给真机，是这条链上最要紧的一个区别。
 */
const deviceNote = computed(() => {
	const device = selectedDevice.value;
	if (device === null) return '没有可用设备';
	return device.virtual ? '虚拟设备 · 仿真' : '真机';
});

/**
 * 接口地址记在本地。联调时那个地址要反复填，刷新一次就没了最烦人；
 * 但它不是真相的一部分，所以只进 localStorage，不进 store。
 *
 * 默认 `/llm` 是**同源相对路径**：dev server 把它反代到 LLM 服务并在服务端注入 key，
 * 所以浏览器里从来没有密钥。联调时改成设备组的基地址即可——见 `task-generation.ts`。
 */
const ENDPOINT_STORAGE_KEY = 'codecanvas.task-endpoint';
const DEFAULT_ENDPOINT = DEFAULT_LLM_ENDPOINT;
const INSTRUCTION_PLACEHOLDER = '前进1米，避障后停止';

const readEndpoint = (): string => {
	try {
		const stored = window.localStorage.getItem(ENDPOINT_STORAGE_KEY);
		return stored === null || stored.trim() === '' ? DEFAULT_ENDPOINT : stored;
	} catch {
		// 隐私模式下 localStorage 会直接抛。地址记不住是小事，不该把整条入口弄挂。
		return DEFAULT_ENDPOINT;
	}
};

/** 用户这一句话。它只活在输入框里——生成之后真相里没有「原始输入」这回事。 */
const instruction = ref('');
const endpoint = ref(readEndpoint());
/** 接口设置与粘贴兜底：折叠着，点开才占地方。 */
const showEndpoint = ref(false);
const showPaste = ref(false);
const pasteText = ref('');
const status = ref<'idle' | 'ok' | 'failed'>('idle');
/** 这一份是怎么进来的：生成接口给的，还是手工灌进来的（成功那句话要说得准）。 */
const lastPath = ref<'generate' | 'paste'>('generate');
/** 失败时说清坏在哪一步：传输 / 协议 / 手工转换。 */
const failureLabel = ref('生成失败');
const dragging = ref(false);
const sourceName = ref('');
/** 正在生成 / 正在点亮链路。这期间「生成」按钮禁用，一次只跑一条。 */
const busy = ref(false);

/**
 * 传输层自己那几条失败（网络、HTTP 非 2xx、响应形状不对）。
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
/** 成功时的终态字：生成接口给的 vs 手工灌的，不能混着说。 */
const okLabel = computed(() => (lastPath.value === 'generate' ? '已生成' : '已导入'));
/** 不能生成：没写指令，或没有设备可选（没有设备就没有「发给谁」和「按哪把尺子编」）。 */
const generateDisabled = computed(
	() => busy.value || instruction.value.trim() === '' || selectedDevice.value === null,
);

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
 * 任何新动作（生成 / 转换 / 清空）都会把 runId 推进一格，在途的那条自己会退出——
 * 否则「生成中」的回调会把用户后来手动转出来的结果覆盖掉。
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
		// 存不下就存不下：地址留不住不影响这一次生成。
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

/** 换真相那一步。生成与粘贴两条路都走它，失败时真相一个字节都不动。 */
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
	failureLabel.value = '转换失败';
	lastPath.value = 'paste';
	chainFailAt.value = 0;
	status.value = loadInto(pasteText.value) ? 'ok' : 'failed';
}

function clear(): void {
	runId += 1;
	pasteText.value = '';
	sourceName.value = '';
	status.value = 'idle';
	transportDiagnostics.value = null;
	resetChain();
}

/**
 * 生成：把 `{ deviceRef, formatRef, catalogRef, instruction }`（连同 LLM 那几个字段）POST 给生成接口，
 * 拿回任务 JSON。
 *
 * 设备那三件缺一不可：`deviceRef` 说发给谁，`formatRef` 说按哪把尺子编（提示词也跟着它切），
 * `catalogRef` 说词汇表是哪一份——技能计划那条路的技能名与参数全靠目录，写死一份就错一份。
 *
 * 只有这一条路真正花时间，链路就在这段时间里亮着。**校验不在这一层**：
 * `generateTask` 拿到文本后交给 `accept`，而 `accept` 就是 `doc.loadTaskJson`——
 * 唯一那条导入路。它说不行就再试一次（默认两次尝试），试完还不行就把诊断摆在入口下方。
 */
async function generate(): Promise<void> {
	const url = endpoint.value.trim();
	const text = instruction.value.trim();
	const device = selectedDevice.value;
	if (url === '' || text === '' || device === null || busy.value) return;

	const mine = (runId += 1);
	busy.value = true;
	transportDiagnostics.value = null;
	status.value = 'idle';
	failureLabel.value = '生成失败';
	lastPath.value = 'generate';
	chainPhase.value = 'running';
	chainStep.value = 1;
	chainFailAt.value = 0;
	chainNote.value = '生成中…';

	/*
	 * 整条流程包在 try 里，`busy` 在 finally 里无条件放下。
	 * 中途被别的动作打断（runId 变了）时下面几个 `return` 就直接走掉——
	 * 要是各自负责收尾，漏一条「生成」按钮就永远禁用了。
	 * 这里无条件清是安全的：只有本函数会把它立起来，而它开头就被 `busy` 挡着。
	 */
	try {
		const result = await generateTask({
			endpoint: url,
			deviceRef: device.deviceRef,
			formatRef: device.formatRef,
			catalog: device.catalog,
			instruction: text,
			/*
			 * 唯一那条导入路：成功才换真相，失败只留诊断。
			 *
			 * 中途被打断（用户又点了一次、或手工灌了一份）时这里直接当「成了」收场——
			 * 下面的 runId 检查会把整条流程丢掉，于是**在途的那一份进不了真相**，
			 * 界面一个字节都不动（这一手不能省：`loadTaskJson` 一跑就换真相了）。
			 */
			accept: (body) => {
				if (runId !== mine) return true;
				return doc.loadTaskJson(body);
			},
			onAttempt: (attempt, total) => {
				if (runId !== mine) return;
				chainNote.value = total > 1 && attempt > 1 ? `生成中… 第 ${attempt}/${total} 次` : '生成中…';
			},
		});

		if (runId !== mine) return;

		// 拿到什么就让人看得见：原文落进兜底框（点开「直接粘贴 JSON」就是它）。
		if (result.ok || result.text !== null) {
			pasteText.value = result.text ?? '';
			sourceName.value = '';
		}

		if (!result.ok) {
			if (result.kind === 'rejected') {
				// 取回来了，但协议不过：诊断由 loadTaskJson 给，红灯停在没过的那一段。
				failureLabel.value = '生成结果不合协议';
				const failAt = failStage();
				chainStep.value = failAt;
				chainFailAt.value = failAt;
				chainPhase.value = 'failed';
				chainNote.value = `失败 · 停在第 ${String(failAt)} 段`;
			} else {
				// 传输 / 响应形状坏掉：这一层的诊断（含重试次数），红灯停在第 1 段。
				failureLabel.value = '生成失败';
				transportDiagnostics.value = [
					generationDiagnostic(`${result.message}（已尝试 ${String(result.attempts)} 次）`, url),
				];
				chainStep.value = 1;
				chainFailAt.value = 1;
				chainPhase.value = 'failed';
				chainNote.value = '生成失败 · 停在第 1 段';
			}
			status.value = 'failed';
			return;
		}

		// 转换是同步的，先把结论拿到手，再让链路把「积木 / 流程 / 代码」逐段点亮到该满的地方。
		for (let index = 2; index <= CHAIN_STEPS; index += 1) {
			chainStep.value = index;
			await wait(CHAIN_STEP_MS);
			if (runId !== mine) return;
		}

		status.value = settleChain(true, 0) ? 'ok' : 'failed';
	} finally {
		busy.value = false;
	}
}

function toggleEndpoint(): void {
	showEndpoint.value = !showEndpoint.value;
}

function togglePaste(): void {
	showPaste.value = !showPaste.value;
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
	// 读进来先落到兜底框，再走和「转换」按钮同一个函数——拖入只是另一种粘贴。
	showPaste.value = true;
	pasteText.value = await file.text();
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
		class="entry-band"
		:class="{ 'is-dragging': dragging }"
		data-testid="task-input-band"
		@dragover.prevent="onDragOver"
		@dragleave="onDragLeave"
		@drop.prevent="onDrop"
	>
		<div class="band-row">
			<!-- 入口本体：设备 + 一句话 + 生成。常态就这一行。 -->
			<div class="entry">
				<header class="entry-head">
					<span class="entry-title">程序入口</span>
					<span class="entry-hint">选设备 → 说一句话 → 生成</span>
					<span class="entry-meta">
						<!-- 顺利时不占第二行：带子高度由变量钉住，失败或带诊断才往下长 -->
						<span
							v-if="status === 'ok' && diagnostics.length === 0"
							class="feedback-state ok"
							data-testid="task-input-status"
						>
							{{ okLabel }} · {{ nodeCount }} 个节点
						</span>
						<span v-if="sourceName !== ''" class="entry-file" data-testid="task-input-file">
							{{ sourceName }}
						</span>
					</span>
				</header>

				<div class="entry-row">
					<label class="field field-device">
						<span class="field-label">设备</span>
						<select
							v-model="deviceRef"
							class="field-select"
							data-testid="device-select"
							aria-label="设备"
						>
							<!-- 值用 deviceRef（请求里带的就是它），显示用 label；仿真那条额外带个标记。 -->
							<option
								v-for="device in devices.devices"
								:key="device.deviceRef"
								:value="device.deviceRef"
								:data-virtual="device.virtual ? 'true' : 'false'"
							>
								{{ device.label }}
							</option>
						</select>
						<!-- 真机 / 仿真单独说一行：label 里的括号在一串字里，太容易略过 -->
						<span class="field-note" data-testid="device-note">{{ deviceNote }}</span>
					</label>

					<label class="field field-instruction">
						<span class="field-label">指令</span>
						<input
							v-model="instruction"
							type="text"
							class="field-text"
							data-testid="instruction-input"
							aria-label="一句话指令"
							spellcheck="false"
							:placeholder="INSTRUCTION_PLACEHOLDER"
							@keydown.enter.prevent="generate"
						/>
					</label>

					<button
						type="button"
						class="btn btn-generate"
						data-testid="task-generate"
						:disabled="generateDisabled"
						@click="generate"
					>
						{{ busy ? '生成中…' : '生成' }}
					</button>
				</div>

				<!-- 次要入口（一）：接口设置。折叠着，填一次记进 localStorage。 -->
				<div class="entry-toggles">
					<button
						type="button"
						class="link-btn"
						data-testid="task-endpoint-toggle"
						:aria-expanded="showEndpoint"
						@click="toggleEndpoint"
					>
						接口设置
					</button>
					<span class="toggle-sep" aria-hidden="true">·</span>
					<button
						type="button"
						class="link-btn"
						data-testid="task-paste-toggle"
						:aria-expanded="showPaste"
						@click="togglePaste"
					>
						直接粘贴 JSON
					</button>
					<span class="toggle-note">接口联调前，粘贴这条路照样能把任务灌进来</span>
				</div>

				<div v-if="showEndpoint" class="settings-row" data-testid="task-endpoint-row">
					<label class="field field-endpoint">
						<span class="field-label">生成接口</span>
						<input
							v-model="endpoint"
							type="url"
							class="field-text field-mono"
							data-testid="task-endpoint-input"
							aria-label="生成接口地址"
							spellcheck="false"
							:placeholder="DEFAULT_ENDPOINT"
						/>
					</label>
					<span class="settings-note">
						POST {{ endpoint.trim() || DEFAULT_ENDPOINT }}/chat/completions · model {{ DEFAULT_LLM_MODEL }}
					</span>
				</div>

				<!--
					这一请求发给谁、按哪把尺子编：设备名 + 任务格式名（格式决定收什么形状的 JSON），
					目录名放在最后——技能名与参数都照它判，联调时对不上账最先要看的就是它。
				-->
				<div v-if="showEndpoint" class="settings-facts" data-testid="task-endpoint-device">
					<span>设备 {{ selectedDevice?.label ?? '（没有可用设备）' }}</span>
					<span>格式 {{ formatLabel === '' ? '（未知）' : formatLabel }}</span>
					<span class="settings-note">目录 {{ selectedDevice?.catalog.catalogRef ?? '—' }}</span>
				</div>

				<div v-if="showPaste" class="paste-row" data-testid="task-paste-row">
					<textarea
						v-model="pasteText"
						class="paste-text"
						data-testid="task-json-input"
						aria-label="任务 JSON"
						spellcheck="false"
						:placeholder="pastePlaceholder"
					></textarea>
					<div class="paste-actions">
						<button
							type="button"
							class="btn btn-convert"
							data-testid="task-convert"
							:disabled="pasteText.trim() === ''"
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
				<span class="chain-note">生成接口负责「一句话 → 任务 JSON」；这里只把它取回来</span>
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
							? `${okLabel} · ${nodeCount} 个节点`
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
/*
 * 入口带：常态只有一行控制 + 一行折起来的小开关，高度由 --cc-entryband-h 兜住。
 * 折起来的两块（接口设置 / 粘贴兜底）点开时带子自然长高——那是用户自己要的，不是常态。
 */
.entry-band {
	display: flex;
	flex-direction: column;
	gap: var(--cc-space-2);
	flex: 0 0 auto;
	min-height: var(--cc-entryband-h);
	padding: var(--cc-space-2) var(--cc-space-3);
	background: var(--cc-surface);
	border-bottom: 1px solid var(--cc-line);
}

.band-row {
	display: grid;
	grid-template-columns: minmax(0, 1fr) auto;
	gap: var(--cc-space-4);
	align-items: start;
	min-height: 0;
}

/* 入口本体：虚线框，明示「这里可以拖东西进来」。 */
.entry {
	display: flex;
	flex-direction: column;
	gap: var(--cc-space-1);
	min-width: 0;
	padding: var(--cc-space-2);
	background: var(--cc-surface-sunken);
	border: 1px dashed var(--cc-line-strong);
	border-radius: var(--cc-radius);
	transition:
		border-color 0.15s ease,
		background 0.15s ease;
}

.entry-band.is-dragging .entry {
	border-color: var(--cc-accent);
	background: var(--cc-accent-veil);
}

.entry-head {
	display: flex;
	align-items: baseline;
	gap: var(--cc-space-2);
	flex: 0 0 auto;
	min-width: 0;
	/* 钉死行高：默认的 normal 会按继承来的 13px 字号算，比这一行的 11px 字高出一截。 */
	line-height: 1.2;
}

.entry-title {
	font-size: var(--cc-fs-sm);
	font-weight: 600;
	color: var(--cc-text);
}

.entry-hint {
	min-width: 0;
	overflow: hidden;
	font-size: var(--cc-fs-xs);
	color: var(--cc-text-faint);
	text-overflow: ellipsis;
	white-space: nowrap;
}

.entry-meta {
	display: flex;
	align-items: baseline;
	gap: var(--cc-space-2);
	margin-left: auto;
	flex: 0 0 auto;
}

.entry-file {
	font-family: var(--cc-font-mono);
	font-size: var(--cc-fs-xs);
	color: var(--cc-accent);
	max-width: 220px;
	overflow: hidden;
	text-overflow: ellipsis;
	white-space: nowrap;
}

/*
 * 入口那一行：设备下拉按内容宽（最宽 260px），指令吃掉剩下的宽，生成按钮贴右端。
 * 一行放得下就是这一行；放不下时窄窗媒体查询会把它折成两行。
 */
.entry-row {
	display: grid;
	grid-template-columns: minmax(0, 260px) minmax(0, 1fr) auto;
	align-items: center;
	gap: var(--cc-space-2);
	flex: 0 0 auto;
	min-width: 0;
}

.field {
	display: flex;
	align-items: center;
	gap: var(--cc-space-2);
	min-width: 0;
}

.field-label {
	flex: 0 0 auto;
	font-size: var(--cc-fs-xs);
	color: var(--cc-text-dim);
	white-space: nowrap;
}

.field-device,
.field-instruction {
	min-width: 0;
}

/*
 * 真机 / 仿真那一行小字：紧挨着下拉，**不参与收缩**——它一共就几个字，
 * 让位的结果是把「仿真」这两个字截掉，那这一行就白放了。要挤先挤下拉（原生下拉截断不影响选）。
 */
.field-note {
	flex: 0 0 auto;
	font-size: var(--cc-fs-xs);
	color: var(--cc-text-faint);
	white-space: nowrap;
}

.field-select,
.field-text {
	width: 100%;
	min-width: 0;
	padding: 5px var(--cc-space-2);
	line-height: 1.2;
	font-family: var(--cc-font);
	font-size: var(--cc-fs-md);
	color: var(--cc-text);
	background: var(--cc-bg);
	border: 1px solid var(--cc-line);
	border-radius: var(--cc-radius-sm);
}

.field-mono {
	font-family: var(--cc-font-mono);
	font-size: var(--cc-fs-sm);
}

.field-select:focus,
.field-text:focus {
	outline: none;
	border-color: var(--cc-accent-dim);
	box-shadow: 0 0 0 1px var(--cc-accent-glow) inset;
}

.field-text::placeholder {
	color: var(--cc-text-faint);
}

/* 折起来的那两个入口：小字按钮，不占主位。 */
.entry-toggles {
	display: flex;
	align-items: baseline;
	gap: var(--cc-space-1);
	flex: 0 0 auto;
	min-width: 0;
	line-height: 1.2;
}

.link-btn {
	padding: 0;
	font-size: var(--cc-fs-xs);
	color: var(--cc-text-dim);
	background: transparent;
	border: none;
	border-bottom: 1px dashed var(--cc-line-strong);
	cursor: pointer;
}

.link-btn:hover {
	color: var(--cc-accent);
	border-bottom-color: var(--cc-accent-dim);
}

.link-btn[aria-expanded='true'] {
	color: var(--cc-accent);
}

.toggle-sep {
	font-size: var(--cc-fs-xs);
	color: var(--cc-line-strong);
}

.toggle-note {
	min-width: 0;
	overflow: hidden;
	font-size: var(--cc-fs-xs);
	color: var(--cc-text-faint);
	text-overflow: ellipsis;
	white-space: nowrap;
}

.settings-row,
.paste-row {
	display: grid;
	grid-template-columns: minmax(0, 1fr) auto;
	align-items: center;
	gap: var(--cc-space-2);
	flex: 0 0 auto;
	min-width: 0;
}

.settings-note {
	font-family: var(--cc-font-mono);
	font-size: var(--cc-fs-xs);
	color: var(--cc-text-faint);
	white-space: nowrap;
}

/* 这一请求发给谁、按哪把尺子编：小字一行，折得下就折，不占主位。 */
.settings-facts {
	display: flex;
	flex-wrap: wrap;
	gap: var(--cc-space-1) var(--cc-space-3);
	flex: 0 0 auto;
	min-width: 0;
	font-size: var(--cc-fs-xs);
	color: var(--cc-text-dim);
}

/*
 * 粘贴兜底：接口没就绪时手工灌一份 JSON。高一点的文本框，但只在点开时才占地方
 * （拖动文件进来会自动展开它——拖入就是粘贴的另一种手势）。
 */
.paste-text {
	width: 100%;
	height: 96px;
	min-width: 0;
	padding: var(--cc-space-1) var(--cc-space-2);
	font-family: var(--cc-font-mono);
	font-size: var(--cc-fs-sm);
	line-height: 1.5;
	color: var(--cc-text);
	background: var(--cc-bg);
	border: 1px solid var(--cc-line);
	border-radius: var(--cc-radius-sm);
	resize: vertical;
}

.paste-text::placeholder {
	color: var(--cc-text-faint);
}

.paste-text:focus {
	outline: none;
	border-color: var(--cc-accent-dim);
	box-shadow: 0 0 0 1px var(--cc-accent-glow) inset;
}

.paste-actions {
	display: flex;
	flex-direction: column;
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

/* 生成是这一带上唯一的实心按钮：把两样输入变成声明的那一下。 */
.btn-generate {
	min-width: 72px;
	color: var(--cc-surface-sunken);
	background: var(--cc-accent);
	border-color: var(--cc-accent-strong);
	box-shadow: 0 0 12px var(--cc-accent-glow);
}

.btn-generate:hover:not(:disabled) {
	filter: brightness(1.1);
}

.btn-generate:disabled {
	color: var(--cc-disabled-text);
	background: var(--cc-disabled-surface);
	border-color: var(--cc-line);
	box-shadow: none;
	cursor: not-allowed;
}

.btn-convert {
	min-width: 58px;
	color: var(--cc-accent-strong);
	background: var(--cc-accent-veil);
	border-color: var(--cc-accent-dim);
}

.btn-convert:hover:not(:disabled) {
	filter: brightness(1.15);
}

.btn-convert:disabled {
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

/* 诊断：与积木侧那份同一形状（左侧色条区分严重度），摆在入口下方 */
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

/* 窄窗：先舍注释，再舍整条链——入口永远留着，它才是这一带的功能 */
@media (max-width: 1180px) {
	.chain-note,
	.toggle-note {
		display: none;
	}
}

/* 再窄一点：字段名也舍掉，控件本身留着（placeholder 与 aria-label 还在） */
@media (max-width: 1020px) {
	.field-label {
		display: none;
	}

	.entry-row {
		grid-template-columns: minmax(0, 200px) minmax(0, 1fr) auto;
	}
}

/* 最窄：入口折成两行——设备与生成一行，指令一行 */
@media (max-width: 900px) {
	.chain {
		display: none;
	}

	.entry-row {
		grid-template-columns: minmax(0, 1fr) auto;
		grid-template-rows: auto auto;
	}

	.field-instruction {
		grid-column: 1 / -1;
		grid-row: 2;
	}
}
</style>
