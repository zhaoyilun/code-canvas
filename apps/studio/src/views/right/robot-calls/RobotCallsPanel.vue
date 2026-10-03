<script setup lang="ts">
/**
 * 右栏的「发给机器人」视图：**这一句话编出来会变成哪些请求**。
 *
 * 这一屏是「接到真执行链」的可见证据，所以它只说两件事，且都不许含糊：
 *
 * 1. **每一步会发什么**：`execute` 摆出方法、路径与请求体（`task_id` / `skill` / `params` /
 *    `timeout_sec`，逐字对得上 bridge 的 `ExecuteRequest`），后面紧跟**轮询**那一行
 *    （`GET /v1/tasks/{id}`，间隔与余量来自编译期带的 `PollSpec`）；
 *    `wait` 与 `branch` 明写「本地」——**它们不发请求**，画成请求就是编。
 * 2. **送不出去的那一步也在**：原语步在 `calls` 里根本不存在（执行侧没有原语端点），
 *    所以它必须**在它本来的位置上**以危险色显示那条诊断。少一行是最坏的——
 *    看起来像计划里没有这一步（判断在 `robot-calls.ts` 里，这里只管画）。
 *
 * 每一行只摆结论（徽标那三个字 + 会发什么），**理由挂在 `title` 上**：这一块只有一百多像素高，
 * 把编译包那一份路由 note 铺成字，六步就能把面板撑出十屏滚动（真的量过：919px / 94px）。
 * note 全句照抄、不改写一个标点，只是改成「问它才说」。
 *
 * 判据一份都不在这里：步去哪儿读 `@codecanvas/robot-bridge` 的 `STEP_ROUTING`，
 * 技能在不在目录里由 `compilePlanToCalls` 说，条件的人话与流程卡共用 `conditionViewOf`。
 *
 * 三段状态如实分开：**没有声明**（先在上面写一句话生成任务）、**出生格式不是技能计划**
 * （一期设备那份不是这台设备产出的，编译不出请求，不硬套）、**计划过不了校验**（诊断原样摆出来）。
 * 与右栏「虚拟设备」按下运行时的拒接是同一套判据（同一个 `buildPlanFromDeclaration`）。
 *
 * 这一屏**只读**：没有一条写回路径——要改计划去积木画布。
 *
 * ## 下发：在那一列请求**旁边**加的一层，不是改那一列
 *
 * 上面那半（`robot-calls.ts`）说的是「会发出去的是什么」——那是**契约**，一个字节都不改。
 * 这一半把请求**真发一次**（`runCompiledPlan`），每一步的真实结果落在**它自己那一行**上：
 * 与那一步的请求并排，看得见一条条走完，而不是另开一个列表（另开一个列表，人和他对不上账）。
 *
 * 两条路必须一眼分得开（`DISPATCH_PATH_NOTE` 就挂在按钮旁边）：
 * 上面那块 3D 的「在虚拟设备上运行」跑的是**我们自己的仿真执行器**，一个网络请求都不发；
 * 这里的「下发」是**真的 HTTP** 发给 bridge 的基地址。一个是本机仿真，一个是真下发。
 *
 * 跑的时候按钮变成「取消」（`AbortController`），取消是**请求**不是结论：执行器那句
 * 「第 X 步的请求已经发出去了，设备那边可能还在跑——我们不替它下结论」照原样摆出来。
 */
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { probeBridge, runCompiledPlan, type BridgeProbe, type PlanRunEvent } from '@codecanvas/robot-bridge';
import { findTaskFormat } from '@codecanvas/task-import';
import IconBase from '../../../shell/IconBase.vue';
import { useStudioDevices } from '../../../shell/devices';
import { useStudioDocument } from '../../../state/document';
import {
	BLOCKED_ROW_RUN_NOTE,
	DEFAULT_BRIDGE_BASE_URL,
	DISPATCH_PATH_NOTE,
	DISPATCH_PATH_SHORT,
	RUN_STATE_FACE,
	RUN_STATE_MEANING,
	RUN_STATE_TONE,
	compiledOf,
	dispatchGateOf,
	orphanRunPaths,
	readBridgeBaseUrl,
	runStatesByStepPath,
	runVerdictOf,
	writeBridgeBaseUrl,
	BRIDGE_IDENTITY_NOTE,
	BRIDGE_IDENTITY_UNKNOWN,
	type RowRun,
	type RunVerdict,
} from './plan-run';
import {
	ROUTING_FACE,
	compileDeclarationToCalls,
	type RobotCallRow,
} from './robot-calls';

const doc = useStudioDocument();
const devices = useStudioDevices();

/**
 * 拿哪份目录判「技能在不在」：**声明该用的那份**（`document.ts` 的 `declarationCatalog`，
 * 出生格式优先），没有就退到当前设备的。这与右栏另两处同一把尺子——
 * 视图里再写死一份常量目录，换设备之后「查不到这个技能」看起来就会像目录缺了东西。
 */
const catalog = computed(() => doc.declarationCatalog.value ?? devices.selectedCatalog.value);

/** 这批调用是给哪台设备编的：`deviceRef` 进 `task_id` 的摘要，所以它必须是**真的那一台**。 */
const deviceRef = computed(() => devices.selectedDevice.value?.deviceRef ?? '');

/** 出生格式的标签：拒接时要说清「这份声明是哪种格式」，那句话说给读者听。 */
const bornFormatLabel = computed(() => {
	const ref = doc.declarationFormatRef.value;
	return ref === null ? '未知格式' : findTaskFormat(ref).label;
});

/**
 * 一屏 = 还原 + 编译 + 摊平。没有声明、没有目录、没有设备时 `null`——
 * 那几件事各自有自己的状态块说，不该落到「编译失败」那一档里去。
 */
const result = computed(() => {
	const declaration = doc.declaration.value;
	const currentCatalog = catalog.value;
	if (declaration === null || currentCatalog === null || deviceRef.value === '') return null;
	return compileDeclarationToCalls({
		declaration,
		// 出生格式：没导入过时退到当前设备的（与右栏另两处同一个退法）。
		formatRef: doc.declarationFormatRef.value ?? devices.selectedDevice.value?.formatRef ?? 'phase1_task',
		catalog: currentCatalog,
		deviceRef: deviceRef.value,
	});
});

const rows = computed<readonly RobotCallRow[]>(() => (result.value?.ok === true ? result.value.view.rows : []));
const summary = computed(() => (result.value?.ok === true ? result.value.view.summary : null));
const emptyReason = computed(() => (result.value?.ok === true ? result.value.view.emptyReason : null));
const floatingDiagnostics = computed(() =>
	result.value?.ok === true ? result.value.view.floatingDiagnostics : [],
);
/** 编译不了的那两种情形（一期声明 / 计划过不了校验）。`null`＝编译了。 */
const blocked = computed(() => (result.value !== null && !result.value.ok ? result.value : null));

/** 送不出去的那几行：面板顶部那行摘要里的「K 步送不出去」说的就是它们的条数。 */
const blockedRows = computed(() => rows.value.filter((row) => row.kind === 'blocked'));

/** 这一步在哪一格（`2.then.0`）：臂里的步也认得出自己属于哪一层。 */
const depthOf = (row: RobotCallRow): number =>
	row.stepPath.split('.').filter((segment) => segment === 'then' || segment === 'else').length;

const badgeOf = (row: RobotCallRow): string => ROUTING_FACE[row.routing.where];

/**
 * 读屏与 `title` 用的一句话：这一步是什么、会发什么，以及**它为什么是这个去向**。
 *
 * 去向那句 note 挂在 `title` 上而不是铺成一行字：它是**凭据**（全句照抄编译包那份清单），
 * 而这一块的高度只有一百多像素——一条一步的 note 铺开就是两三行，六步就是六百像素。
 * 徽标上那三个字（发给 bridge / 本地 / 送不出去）已经把结论说了，note 留给人问的时候再展开。
 * 它同时也是这一行「为什么长这样」的说明，所以与请求体那几栏同源、不需要另写一份。
 */
const describe = (row: RobotCallRow): string => {
	const where = `节点 ${String(row.nodeOrdinal)}（${row.stepPath}）`;
	const routing = `去向：${ROUTING_FACE[row.routing.where]} —— ${row.routing.note}`;
	if (row.kind === 'execute') return `${where}：${row.method} ${row.path} · ${routing}`;
	if (row.kind === 'wait') return `${where}：本地等 ${String(row.seconds)} 秒，不发请求 · ${routing}`;
	if (row.kind === 'branch') return `${where}：本地判断 ${row.conditionText}，不发请求 · ${routing}`;
	// 送不出去那一行两句话都给：诊断说这一步为什么发不了，note 说这个去向本身意味着什么
	// （原语那条 note 里写着「这不是我们还没做，是上游边界」——那句话正是这一屏要传达的）
	return `${where}：送不出去 · ${row.code} —— ${row.message} · ${routing}`;
};

/** `timeout_sec` 这一栏在不在：在，说明计划里写了；不在，说明按缺省算。轮询那行要说清是哪种。 */
const hasTimeout = (row: Extract<RobotCallRow, { kind: 'execute' }>): boolean =>
	row.body.some((field) => field.field === 'timeout_sec');

// ---------------------------------------------------------------------------
// 下发
// ---------------------------------------------------------------------------

/**
 * bridge 的基地址记在本地（照 `shell/TaskInputBand.vue` 那个 LLM 地址输入的做法：
 * 联调时反反复复要填，刷新一次就没了最烦人；但它不是真相的一部分，所以只进 localStorage）。
 */
const baseUrl = ref(readBridgeBaseUrl());
watch(baseUrl, (value) => {
	writeBridgeBaseUrl(value);
});

/** 这一次下发要发的那一份。`null`＝按不动（原因见 `gate`）。 */
const compiled = computed(() => compiledOf(result.value));

/**
 * 按不按得动、按不动为什么。判据在 `plan-run.ts` 里（纯函数，五档各有各的说法），
 * 这里只把 store 里那三样东西喂进去。
 */
const gate = computed(() =>
	dispatchGateOf({
		hasDeclaration: doc.hasDeclaration.value,
		result: result.value,
		baseUrl: baseUrl.value,
	}),
);

/** `null`＝没有在途的那一次。它同时是「按钮是不是取消」的判据与打断连接的那只手。 */
let inFlight: AbortController | null = null;
const running = ref(false);
/** 用户按过取消没有。它是「已请求取消」那句话的判据（取消是**请求**，不是结论）。 */
const cancelRequested = ref(false);
/** 这一次下发收到的全部事件，**按到达顺序**——行上只留最后一条，流水账在这里。 */
const runEvents = ref<readonly PlanRunEvent[]>([]);
const verdict = ref<RunVerdict | null>(null);

/**
 * 这一屏摆着的那份计划的身份：声明的内容摘要 + 目标设备。
 *
 * 它要回答的是「上一趟下发的**是这一份**吗」。只有 `stepPath` 认不出这件事——
 * 换了声明之后，新计划第 0 步的路径还是 `0`，上一趟那条结果会**正好落在**它上面，
 * 屏幕上于是显示「第 0 步已完成」，而这一步从没发出去过。
 * 摘要按内容算，所以改了任何一个字段都会换 key。
 */
const planKey = computed<string | null>(() => {
	const current = doc.declaration.value;
	return current === null ? null : `${current.digest}@${deviceRef.value}`;
});

/**
 * 换了计划就把上一趟的账清掉。
 *
 * 为什么不是留着 + 标注：留在屏幕上的「第 0 步已完成」会被当成**这一份**的结果读，
 * 而它说的是另一份计划。清掉之后那句话变成「这一份还没发过」，那是真的。
 *
 * **跑着的这一趟不清**：那是「下发途中上面换了一份声明」，事件确实发生过，也不许咽掉——
 * 那条路由 `orphanPaths` 如实摆出来（它本来就是为这件事写的）。
 */
watch(planKey, () => {
	if (running.value) return;
	runEvents.value = [];
	verdict.value = null;
});

/** 每一行现在是什么样：按 `stepPath` 对号（见 `plan-run.ts`）。 */
const runStates = computed<ReadonlyMap<string, RowRun>>(() => runStatesByStepPath(runEvents.value));

/** 对不上任何一行的事件路径。正常是空的——不空就说明下发途中上面换了一份声明，也不许咽掉。 */
const orphanPaths = computed(() => orphanRunPaths(runEvents.value, rows.value.map((row) => row.stepPath)));

/**
 * 屏幕上这几行里，有几行有结论了。跑的时候用它说「进行到哪儿了」。
 *
 * 数的是**行**，不是事件：下发途中上面换了一份声明时，事件账本里还留着上一份的那些，
 * 直接数事件会报出「5 / 3 步有结论」——分子比分母大，那句话自己就不成立。
 * 对不上行的事件由 `orphanPaths` 单独提出来，两件事不混进同一个数里。
 */
const settledCount = computed(
	() =>
		rows.value.filter((row) => {
			const state = runStates.value.get(row.stepPath);
			return state !== undefined && state.state !== 'running';
		}).length,
);

/**
 * 按下去：把**这一屏摆着的那一列调用**真的发出去。
 *
 * 一次性条件在按之前就挡住了（`gate`），这里再兜一道 `running`：一次只跑一条。
 * 包在 `try` 里是因为取消会在半路抛出去（`AbortSignal` 打断 fetch），
 * `finally` 无条件收尾——漏一条这里，「下发」就永远变不回按钮了。
 */
async function dispatch(): Promise<void> {
	const plan = compiled.value;
	if (plan === null || running.value) return;

	const controller = new AbortController();
	inFlight = controller;
	running.value = true;
	cancelRequested.value = false;
	runEvents.value = [];
	verdict.value = null;

	try {
		const outcome = await runCompiledPlan(plan, {
			baseUrl: baseUrl.value.trim(),
			signal: controller.signal,
			// 每来一条就落一次：行上的状态跟着事件长，不是等跑完一次性刷出来
			onStep: (event) => {
				runEvents.value = [...runEvents.value, event];
			},
		});
		// 被新一轮顶掉时（只可能是取消之后又按了一次）不落结论：那一轮的事不归这一次说
		if (inFlight !== controller) return;
		verdict.value = runVerdictOf({ outcome, cancelRequested: cancelRequested.value });
	} catch (error) {
		if (inFlight !== controller) return;
		// 执行器自己不该抛（它把每种失败都写成事件与 reason）。真抛了也不许咽掉：
		// 如实摆出来——「没抛」这个前提不成立时，人只该看到那句话，而不是一个空白的面板。
		verdict.value = {
			face: '下发本身出错了',
			detail: `执行器抛了一个异常（这不是「这一步失败」）：${error instanceof Error ? error.message : String(error)}`,
		};
	} finally {
		if (inFlight === controller) inFlight = null;
		running.value = false;
	}
}

/**
 * 取消：打断连接与等待。**只发请求，不下结论**——设备那边可能还在跑，
 * 替它说「失败了」或「停下了」都是编（那句结论由执行器给，见 `runVerdictOf`）。
 */
function cancel(): void {
	cancelRequested.value = true;
	inFlight?.abort();
}

onBeforeUnmount(() => {
	// 卸载即取消：组件没了还挂在一条一直轮询的请求上，只会往后写已经不存在的东西。
	inFlight?.abort();
	inFlight = null;
});

// ---------------------------------------------------------------------------
// 对面是谁（`GET /v1/health`）
// ---------------------------------------------------------------------------

/**
 * 对面自报的身份。`null` ＝ 还没问过（第一次问出来之前那一行不摆）。
 *
 * 为什么值得单独探一次：`POST /v1/skills/execute` 的 202 与终态只说明**有人接了这件活**，
 * 不说明接活的是谁。开发替身（`tools/fake-bridge`）没有机器人也没有夹爪，收到什么都会
 * 按时回 `success=true`——那份「走完了」是真 HTTP 换回来的，却不是一次真的动作。
 * 把对面自报的版本摆出来，看的人自己就能判断。
 */
const bridgeIdentity = ref<BridgeProbe | null>(null);
let identityProbe: AbortController | null = null;
/** 上一次问的结果对应哪个地址：地址改了但还没问出来时，屏幕上不许留着旧地址的答案。 */
let probedUrl: string | null = null;

const askWhoIsThere = async (): Promise<void> => {
	identityProbe?.abort();
	const controller = new AbortController();
	identityProbe = controller;
	const url = baseUrl.value.trim();
	const result = await probeBridge({ baseUrl: url, signal: controller.signal });
	// 期间地址又改了（或组件没了）：这一条答的是旧地址，丢掉，别摆上去
	if (controller.signal.aborted || identityProbe !== controller) return;
	probedUrl = url;
	bridgeIdentity.value = result;
};

/** 地址变了就把旧答案收起来，再问一次——留着旧答案等于把另一台的身份按在这一台上。 */
watch(baseUrl, () => {
	if (probedUrl !== null && probedUrl !== baseUrl.value.trim()) bridgeIdentity.value = null;
	void askWhoIsThere();
});

onMounted(() => {
	void askWhoIsThere();
});

/** 那一行摆什么。没问出来时**什么都不摆**——空白比一句猜的话好。 */
const bridgeIdentityLine = computed<string | null>(() => {
	const known = bridgeIdentity.value;
	if (known === null) return null;
	if (!known.ok) return `${BRIDGE_IDENTITY_UNKNOWN}：${known.detail}`;
	return `对面：${known.health.service} · ${known.health.version}`;
});

/** 一行 + 它现在的运行态。合成一对是为了让模板对同一个 map 只查一次，也不必写断言。 */
interface RowWithRun {
	readonly row: RobotCallRow;
	readonly run: RowRun | null;
}

const displayRows = computed<readonly RowWithRun[]>(() =>
	rows.value.map((row) => ({ row, run: runStates.value.get(row.stepPath) ?? null })),
);

/** 那枚状态徽标：观感与那句「它说的是什么事」都由 `plan-run.ts` 定（尤其 unreachable ≠ failed）。 */
const runFaceOf = (run: RowRun): string => RUN_STATE_FACE[run.state];
const runMeaningOf = (run: RowRun): string => RUN_STATE_MEANING[run.state];
const runToneOf = (run: RowRun): string => RUN_STATE_TONE[run.state];

/** 送不出去那一行不参与下发：这句话要挂在它自己身上（`describe` 是读屏与 `title` 用的）。 */
const blockedRowNote = BLOCKED_ROW_RUN_NOTE;
</script>

<template>
	<section class="robot-calls-panel" data-testid="robot-calls-panel">
		<header class="rc-header">
			<div class="rc-head-row">
				<IconBase name="device" :size="16" />
				<span class="rc-title">发给机器人</span>
				<span class="rc-tag" data-testid="robot-calls-target">{{ deviceRef }}</span>
				<!--
					汇总这一行走的是**编译结果的三个数**：请求看 `calls`、本地步看行、送不出去看诊断。
					没有可编的东西时这行不出现——摆一个 `0 条请求` 在那里，读起来像「编了，结果是零」。
				-->
				<span v-if="summary !== null" class="rc-summary" data-testid="robot-calls-summary">
					{{ summary.requests }} 条请求 · {{ summary.local }} 步在本地 ·
					{{ summary.blocked }} 步送不出去
				</span>
			</div>

			<!--
				下发那一行：地址 + 按钮。**两个动作两条路**那句话就挂在它下面——
				上面那块 3D 的「在虚拟设备上运行」跑的是本机仿真，这里是真的发 HTTP，
				不写清楚，人会把「跑通了」当成「机器人收到了」。
			-->
			<div class="rc-dispatch" data-testid="robot-calls-dispatch-row">
				<label class="rc-field">
					<span class="rc-field-label">bridge 地址</span>
					<input
						v-model="baseUrl"
						type="url"
						class="rc-input"
						data-testid="robot-calls-base-url"
						aria-label="bridge 基地址"
						spellcheck="false"
						:placeholder="DEFAULT_BRIDGE_BASE_URL"
					/>
				</label>

				<!-- 跑的时候它变成取消：同一格按钮，两种时候各说一件事 -->
				<button
					v-if="running"
					type="button"
					class="rc-btn rc-btn-cancel"
					data-testid="robot-calls-cancel"
					@click="cancel"
				>
					取消
				</button>
				<button
					v-else
					type="button"
					class="rc-btn rc-btn-dispatch"
					data-testid="robot-calls-dispatch"
					:disabled="!gate.allowed"
					@click="void dispatch()"
				>
					下发
				</button>
			</div>

			<!--
				对面是谁：bridge 自报的服务名与版本，原样照抄。
				为什么非摆不可——`202` 与终态只说明**有人接了这件活**：开发替身没有机器人，
				收到什么都会按时回 `success=true`。不把这一行摆出来，「走完了 3 / 3」就会被
				读成「机器人抓到了」，而那件事一次都没发生过。
			-->
			<p
				v-if="bridgeIdentityLine !== null"
				class="rc-identity"
				data-testid="robot-calls-bridge-identity"
				:title="BRIDGE_IDENTITY_NOTE"
			>
				{{ bridgeIdentityLine }}
			</p>

			<!--
				按不动就说清为什么：灰按钮自己不会解释（五档理由各说各的，判据在 plan-run.ts）。
				这一行只在按不动时占地方——能按时它不存在，那一格高度还给行列表。
			-->
			<p
				v-if="!running && !gate.allowed && gate.reason !== null"
				class="rc-gate"
				data-testid="robot-calls-gate"
			>
				{{ gate.reason }}
			</p>
			<!--
				两条路：摆的是**一行版**（全句在按钮的 `title` 里）。
				这一行是防误读的——不写它，人会把「这里跑通了」当成「机器人收到了」；
				写成两行则要吃掉行列表四成的高度（见 `DISPATCH_PATH_SHORT` 那段注释）。
			-->
			<p class="rc-path-note" data-testid="robot-calls-path-note" :title="DISPATCH_PATH_NOTE">
				{{ DISPATCH_PATH_SHORT }}
			</p>
		</header>

		<!-- 没有声明：说清先做什么，而不是摆一片空白 -->
		<div v-if="!doc.hasDeclaration.value" class="rc-empty" data-testid="robot-calls-empty">
			<p>还没有声明——先在上面写一句话生成任务（或直接粘贴一份计划），这里才有东西可编。</p>
		</div>

		<!-- 出生格式不是技能计划：**不硬套**，如实说这份声明不是这台设备产出的 -->
		<div v-else-if="blocked !== null && blocked.reason === 'format_mismatch'" class="rc-empty" data-testid="robot-calls-format">
			<p>
				这份声明的出生格式是「{{ bornFormatLabel }}」，不是技能计划——它不是这台设备产出的，
				编译不出请求。要发给机器人，先在入口带选一台说技能话的设备（SO-101 那两台），再生成一份计划。
			</p>
		</div>

		<!-- 格式对但计划过不了校验：诊断原样摆出来，一条请求都不编 -->
		<div v-else-if="blocked !== null" class="rc-empty" data-testid="robot-calls-invalid">
			<p>还原出来的计划过不了校验（{{ blocked.diagnostics.length }} 条诊断），没有请求可编：</p>
			<ul class="rc-diag-list">
				<li v-for="item in blocked.diagnostics" :key="`${item.code}@${item.path ?? ''}`">
					{{ item.code }}{{ item.path ? ` @ ${item.path}` : '' }} — {{ item.message }}
				</li>
			</ul>
		</div>

		<div v-else class="rc-body" data-testid="robot-calls-body">
			<!--
				零条请求也要说清为什么：整份计划都在本地做（等与判断），或者全卡在诊断上。
				这句话的来路是编译结果的三个数，不是面板自己猜的一个理由。
			-->
			<p v-if="emptyReason !== null" class="rc-nothing" data-testid="robot-calls-nothing">
				{{ emptyReason }}
			</p>

			<!--
				这一次下发的结论：跑完了 / 停了 / 已请求取消。`detail` 是执行器那句 reason，
				**原文照抄**（「第 X 步…我们不替它下结论」那种话是证据，改写了就不是了）。
			-->
			<div
				v-if="verdict !== null"
				class="rc-verdict"
				:class="{ 'is-cancelled': cancelRequested }"
				data-testid="robot-calls-verdict"
				:data-cancelled="cancelRequested ? 'true' : 'false'"
			>
				<span class="rc-verdict-face" data-testid="robot-calls-verdict-face">{{ verdict.face }}</span>
				<span class="rc-verdict-count">{{ settledCount }} / {{ rows.length }} 步有结论</span>
				<p class="rc-verdict-detail" data-testid="robot-calls-verdict-detail">{{ verdict.detail }}</p>
			</div>

			<!--
				对不上任何一行的事件：正常没有。真有就说明下发途中上面换了一份声明——
				咽掉它们，屏幕上就会显得「那几步没发生过」，而它们确实发生过。
			-->
			<p v-if="orphanPaths.length > 0" class="rc-orphan" data-testid="robot-calls-orphan">
				有 {{ orphanPaths.length }} 条下发事件对不上屏幕上的任何一行（{{ orphanPaths.join('、') }}）——
				多半是下发途中上面换了一份声明：它们在下面这些行里没有位置，但确实发生过，这里如实摆出来。
			</p>

			<ol class="rc-rows" data-testid="robot-calls-rows">
				<li
					v-for="entry in displayRows"
					:key="`${String(entry.row.line)}-${entry.row.stepPath}-${entry.row.kind}`"
					class="rc-row"
					:class="`is-${entry.row.kind}`"
					:data-testid="`robot-call-${entry.row.kind}`"
					:data-kind="entry.row.kind"
					:data-step-path="entry.row.stepPath"
					:data-node-ordinal="entry.row.nodeOrdinal"
					:data-where="entry.row.routing.where"
					:data-depth="depthOf(entry.row)"
					:style="{ '--rc-depth': depthOf(entry.row) }"
					:title="describe(entry.row)"
				>
					<div class="rc-row-head">
						<span class="rc-ln" aria-hidden="true">{{ entry.row.line }}</span>
						<span class="rc-step">节点 {{ entry.row.nodeOrdinal }}</span>
						<span class="rc-path">{{ entry.row.stepPath }}</span>
						<span class="rc-badge" :class="`is-${entry.row.routing.where}`">{{ badgeOf(entry.row) }}</span>
					</div>

					<!-- execute：方法 + 路径 + 请求体，后面紧跟轮询那一行 -->
					<template v-if="entry.row.kind === 'execute'">
						<div class="rc-request" data-testid="robot-call-execute-line">
							<span class="rc-method">{{ entry.row.method }}</span>
							<code class="rc-target-path">{{ entry.row.path }}</code>
						</div>
						<div class="rc-body-fields" data-testid="robot-call-body">
							<span
								v-for="field in entry.row.body"
								:key="field.field"
								class="rc-field"
								:data-field="field.field"
							>
								{{ field.field }}={{ field.value }}
							</span>
						</div>
						<div class="rc-poll" data-testid="robot-call-poll">
							轮询 <code class="rc-target-path">GET {{ entry.row.poll.path }}</code> —
							每 {{ entry.row.poll.intervalMs }}ms 一次 · 截止 {{ entry.row.poll.deadlineSec }}s（{{
								hasTimeout(entry.row)
									? '计划里的 timeout_sec'
									: `计划的缺省 ${entry.row.poll.defaultTimeoutSec}s`
							}} + {{ entry.row.poll.marginSec }}s 余量）；成败只在这里读得到
						</div>
					</template>

					<!-- wait：本地等，明写不发请求 -->
					<p v-else-if="entry.row.kind === 'wait'" class="rc-line" data-testid="robot-call-wait-line">
						本地等 {{ entry.row.seconds }} 秒 —— <strong class="rc-no-request">不发请求</strong>
					</p>

					<!-- branch：本地判断，明写不发请求 -->
					<p v-else-if="entry.row.kind === 'branch'" class="rc-line" data-testid="robot-call-branch-line">
						本地判断：{{ entry.row.conditionText }} —— <strong class="rc-no-request">不发请求</strong>
					</p>

					<!-- 送不出去：诊断在它本来的位置上，危险色 -->
					<template v-else>
						<p class="rc-line rc-blocked-line" data-testid="robot-call-blocked-line">
							<strong>送不出去</strong> · {{ entry.row.code }} —— {{ entry.row.message }}
						</p>
						<!--
							这一行**不参与下发**：编译期就没有请求可编，执行器的事件流里也没有它。
							不说这一句，看起来就像「下发漏了一步」——那是最坏的一种误读。
						-->
						<p class="rc-line rc-blocked-run" data-testid="robot-call-blocked-no-dispatch">
							{{ blockedRowNote }}
						</p>
					</template>

					<!--
						这一步的真实结果，落在**它自己这一行**上——与上面那条请求并排，
						看得见一条条走完，而不是另开一个列表让人自己对账。
						没有事件就是没走到（`v-if`），不摆一个「待下发」骗人：那一步可能永远不会到。
					-->
					<div
						v-if="entry.run !== null"
						class="rc-run"
						:class="`is-${runToneOf(entry.run)}`"
						:data-testid="`robot-call-run-${entry.row.kind}`"
						:data-run-state="entry.run.state"
						:title="runMeaningOf(entry.run)"
					>
						<span class="rc-run-badge" data-testid="robot-call-run-face">{{ runFaceOf(entry.run) }}</span>
						<span class="rc-run-meaning">{{ runMeaningOf(entry.run) }}</span>
						<!-- 诊断原文照抄执行器那一句（`detail` 空就不摆这一行，不替它编一句） -->
						<code v-if="entry.run.detail !== ''" class="rc-run-detail" data-testid="robot-call-run-detail">{{
							entry.run.detail
						}}</code>
						<code v-if="entry.run.taskId !== null" class="rc-run-task" data-testid="robot-call-run-task"
							>task_id {{ entry.run.taskId }}</code
						>
					</div>
				</li>
			</ol>

			<!-- 摆不出位置的诊断不丢：它们不属于哪一步，但也是编译期说的问题 -->
			<div v-if="floatingDiagnostics.length > 0" class="rc-floating" data-testid="robot-calls-floating">
				<p>以下是编译期说的问题，它们不对应具体某一步：</p>
				<ul class="rc-diag-list">
					<li v-for="item in floatingDiagnostics" :key="item.code">
						{{ item.code }} — {{ item.message }}
					</li>
				</ul>
			</div>
		</div>

		<footer v-if="blockedRows.length > 0" class="rc-footer" data-testid="robot-calls-footer">
			{{ blockedRows.length }} 步在这个工作台里发不出去：执行侧（bridge / CLI）只有技能端点，没有原语通路。
		</footer>
	</section>
</template>

<style scoped>
.robot-calls-panel {
	display: flex;
	flex-direction: column;
	height: 100%;
	min-height: 0;
	background: var(--cc-surface);
}

.rc-header {
	display: flex;
	flex-direction: column;
	gap: var(--cc-space-1);
	flex: 0 0 auto;
	padding: var(--cc-space-3) var(--cc-space-4);
	border-bottom: 1px solid var(--cc-line);
}

.rc-head-row {
	display: flex;
	align-items: center;
	gap: var(--cc-space-2);
	flex-wrap: wrap;
	color: var(--cc-text-dim);
}

.rc-title {
	font-size: var(--cc-fs-md);
	font-weight: 600;
	color: var(--cc-text);
}

.rc-tag {
	padding: 2px var(--cc-space-2);
	font-family: var(--cc-font-mono);
	font-size: var(--cc-fs-xs);
	color: var(--cc-accent);
	background: var(--cc-accent-veil);
	border: 1px solid var(--cc-accent-dim);
	border-radius: var(--cc-radius-sm);
}

/*
 * 摘要那三个数是这一屏的第一句实话：它与标题、设备引用同一行。
 * 右栏只有 360px 上下，放不下时 `flex-wrap` 让它自己掉到下一行——不写死换行位置。
 */
.rc-summary {
	margin-left: auto;
	font-family: var(--cc-font-mono);
	font-size: var(--cc-fs-sm);
	color: var(--cc-text);
	white-space: nowrap;
}

/*
 * 下发那一行：地址吃掉剩下的宽，按钮贴右端。
 * 与入口带的「接口设置」同一套控件写法（`field-label` + `field-text`），不引第二种输入框。
 */
.rc-dispatch {
	display: grid;
	grid-template-columns: minmax(0, 1fr) auto;
	align-items: center;
	gap: var(--cc-space-2);
	min-width: 0;
}

.rc-field {
	display: flex;
	align-items: center;
	gap: var(--cc-space-2);
	min-width: 0;
}

.rc-field-label {
	flex: 0 0 auto;
	font-size: var(--cc-fs-xs);
	color: var(--cc-text-dim);
	white-space: nowrap;
}

.rc-input {
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

.rc-input::placeholder {
	color: var(--cc-text-faint);
}

.rc-input:focus {
	outline: none;
	border-color: var(--cc-accent-dim);
	box-shadow: 0 0 0 1px var(--cc-accent-glow) inset;
}

.rc-btn {
	min-width: 58px;
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

/* 下发是这个面板上唯一的实心按钮：把「摆出来的请求」变成「真的发出去」的那一下。 */
.rc-btn-dispatch {
	color: var(--cc-surface-sunken);
	background: var(--cc-accent);
	border-color: var(--cc-accent-strong);
	box-shadow: 0 0 12px var(--cc-accent-glow);
}

.rc-btn-dispatch:hover:not(:disabled) {
	filter: brightness(1.1);
}

.rc-btn-dispatch:disabled {
	color: var(--cc-disabled-text);
	background: var(--cc-disabled-surface);
	border-color: var(--cc-line);
	box-shadow: none;
	cursor: not-allowed;
}

/* 取消不是危险动作，但它是**打断**：描边而不是实心，与「下发」分得开。 */
.rc-btn-cancel {
	color: var(--cc-danger-strong);
	background: var(--cc-danger-veil);
	border-color: var(--cc-danger);
}

.rc-btn-cancel:hover {
	filter: brightness(1.15);
}

/* 按不动的理由：灰按钮自己不解释，所以这句要跟着它。 */
.rc-identity {
	margin: 0;
	font-size: var(--cc-fs-xs);
	line-height: 1.5;
	/* 版本号是读数，用等宽体；它自报的名字照原样，一个字母都不改 */
	font-family: var(--cc-font-mono, ui-monospace, monospace);
	color: var(--cc-text-faint);
	overflow-wrap: anywhere;
}

.rc-gate {
	margin: 0;
	font-size: var(--cc-fs-xs);
	line-height: 1.5;
	color: var(--cc-text-dim);
	overflow-wrap: anywhere;
}

/*
 * 两条路那句：**这一块是防误读的**（上面那块 3D 是仿真，这里是真的发 HTTP），
 * 用虚线跟上面那几行控件分开——它不是控件，是一句要说清的话。
 */
.rc-path-note {
	margin: 0;
	padding-top: var(--cc-space-1);
	font-size: var(--cc-fs-xs);
	line-height: 1.5;
	color: var(--cc-text-faint);
	border-top: 1px dashed var(--cc-line-strong);
	overflow-wrap: anywhere;
}

.rc-empty {
	display: flex;
	flex-direction: column;
	gap: var(--cc-space-2);
	align-items: center;
	justify-content: center;
	flex: 1 1 auto;
	min-height: 0;
	padding: var(--cc-space-5);
	color: var(--cc-text-dim);
	text-align: center;
	overflow-y: auto;
}

.rc-empty p {
	max-width: 40ch;
	margin: 0;
	line-height: 1.7;
}

.rc-body {
	display: flex;
	flex-direction: column;
	gap: var(--cc-space-2);
	flex: 1 1 auto;
	min-height: 0;
	overflow-y: auto;
	padding: var(--cc-space-2) var(--cc-space-3);
}

.rc-nothing {
	margin: 0;
	padding: var(--cc-space-2);
	font-size: var(--cc-fs-xs);
	line-height: 1.6;
	color: var(--cc-text-dim);
	background: var(--cc-surface-sunken);
	border: 1px dashed var(--cc-line-strong);
	border-radius: var(--cc-radius-sm);
}

.rc-rows {
	display: flex;
	flex-direction: column;
	gap: var(--cc-space-2);
	margin: 0;
	padding: 0;
	list-style: none;
}

/*
 * 一行 = 计划里的一步。臂里的步靠 `--rc-depth` 缩进（与右栏步骤行同一套做法），
 * 于是「这一步在哪一层」不用读路径也看得出来。
 */
.rc-row {
	display: flex;
	flex-direction: column;
	gap: 3px;
	padding: var(--cc-space-2);
	margin-left: calc(var(--rc-depth, 0) * var(--cc-space-3));
	background: var(--cc-surface-sunken);
	border: 1px solid var(--cc-line);
	border-left: 3px solid var(--cc-line-strong);
	border-radius: var(--cc-radius-sm);
}

/* 发到 bridge 的那一步：左边一条强调色——「这一条真的会出去」 */
.rc-row.is-execute {
	border-left-color: var(--cc-accent);
}

/* 送不出去的那一步：整块染危险色。它在列表里**有位置**，只是发不出去 */
.rc-row.is-blocked {
	background: var(--cc-danger-veil);
	border-color: var(--cc-danger);
	border-left-color: var(--cc-danger);
}

.rc-row-head {
	display: flex;
	align-items: baseline;
	flex-wrap: wrap;
	gap: var(--cc-space-1) var(--cc-space-2);
	font-family: var(--cc-font-mono);
	font-size: var(--cc-fs-xs);
	color: var(--cc-text-dim);
}

.rc-ln {
	min-width: 2ch;
	text-align: right;
	color: var(--cc-text-faint);
}

.rc-step {
	color: var(--cc-text);
	font-weight: 600;
}

/* 路径是层级凭据（`2.then.0`），不是读数：压暗、跟在「第 N 步」后面 */
.rc-path {
	color: var(--cc-text-faint);
}

.rc-badge {
	margin-left: auto;
	padding: 1px var(--cc-space-1);
	border: 1px solid var(--cc-line-strong);
	border-radius: var(--cc-radius-sm);
	color: var(--cc-text-dim);
	white-space: nowrap;
}

.rc-badge.is-bridge {
	color: var(--cc-accent);
	border-color: var(--cc-accent-dim);
	background: var(--cc-accent-veil);
}

.rc-badge.is-nowhere {
	color: var(--cc-danger-strong);
	border-color: var(--cc-danger);
	background: var(--cc-danger-veil);
}

.rc-request {
	display: flex;
	align-items: baseline;
	gap: var(--cc-space-2);
	font-family: var(--cc-font-mono);
	font-size: var(--cc-fs-sm);
}

.rc-method {
	font-weight: 700;
	color: var(--cc-accent-strong);
}

.rc-target-path {
	color: var(--cc-text);
	overflow-wrap: anywhere;
}

.rc-body-fields {
	display: flex;
	flex-direction: column;
	gap: 1px;
	font-family: var(--cc-font-mono);
	font-size: var(--cc-fs-xs);
	color: var(--cc-text);
}

/* 请求体一行一栏：右栏窄，长值折行显示，不横向滚 */
.rc-field {
	overflow-wrap: anywhere;
}

.rc-poll {
	font-size: var(--cc-fs-xs);
	line-height: 1.5;
	color: var(--cc-text-dim);
	overflow-wrap: anywhere;
}

.rc-line {
	margin: 0;
	font-size: var(--cc-fs-sm);
	line-height: 1.5;
	color: var(--cc-text);
	overflow-wrap: anywhere;
}

/* 「不发请求」这四个字要跳出来：这一屏最容易被误读的地方就是它 */
.rc-no-request {
	color: var(--cc-text-dim);
	letter-spacing: 0.04em;
}

.rc-blocked-line {
	color: var(--cc-danger-strong);
}

/* 「不参与下发」那句：它是解释，不是报警——所以安静色，不跟上面那条诊断抢注意力 */
.rc-blocked-run {
	font-size: var(--cc-fs-xs);
	color: var(--cc-text-dim);
}

/*
 * 行上的运行态：与它上面那条请求**并排**在同一格里（同一行 = 同一步）。
 * 左边一条色条说档位，颜色只在 `is-*` 那几档里给——尤其
 * `is-unreachable`（没到，不是失败：安静色 + 虚线）与 `is-failed`（业务失败：危险色 + 实边）
 * 必须一眼分得开（判据在 `plan-run.ts` 的 `RUN_STATE_TONE` 上）。
 */
.rc-run {
	display: flex;
	flex-direction: column;
	gap: 2px;
	margin-top: var(--cc-space-1);
	padding: var(--cc-space-1) var(--cc-space-2);
	background: var(--cc-surface);
	border: 1px solid var(--cc-line);
	border-left: 3px solid var(--cc-line-strong);
	border-radius: var(--cc-radius-sm);
}

.rc-run.is-live {
	border-left-color: var(--cc-chain-live);
}

.rc-run.is-ok {
	border-left-color: var(--cc-accent);
}

/* 业务失败：报警。实边、危险色——它说的是「机器真的动了，结果没成」。 */
.rc-run.is-failed {
	background: var(--cc-danger-veil);
	border-color: var(--cc-danger);
	border-left-color: var(--cc-danger);
}

/*
 * 没到：**不染危险色**。请求根本没送出去，机器可能一步都没动——
 * 染成红的就会被读成「这一步试过了、没成」，而那正是要防的误读。
 * 虚线 + 安静色：显眼，但不像失败那样报警。
 */
.rc-run.is-unreachable {
	background: var(--cc-surface-sunken);
	border-style: dashed;
	border-color: var(--cc-line-strong);
	border-left-style: solid;
	border-left-color: var(--cc-text-dim);
}

.rc-run.is-skipped {
	border-left-color: var(--cc-text-faint);
}

.rc-run-badge {
	align-self: flex-start;
	padding: 1px var(--cc-space-1);
	font-family: var(--cc-font-mono);
	font-size: var(--cc-fs-xs);
	font-weight: 600;
	color: var(--cc-text-dim);
	border: 1px solid var(--cc-line-strong);
	border-radius: var(--cc-radius-sm);
}

.rc-run.is-live .rc-run-badge {
	color: var(--cc-chain-live);
	border-color: var(--cc-accent-dim);
	background: var(--cc-accent-veil);
	animation: rc-run-breathe 0.9s ease-in-out infinite;
}

.rc-run.is-ok .rc-run-badge {
	color: var(--cc-accent-strong);
	border-color: var(--cc-accent-dim);
	background: var(--cc-accent-veil);
}

.rc-run.is-failed .rc-run-badge {
	color: var(--cc-danger-strong);
	border-color: var(--cc-danger);
	background: var(--cc-danger-veil);
}

.rc-run.is-unreachable .rc-run-badge {
	color: var(--cc-text);
	border-style: dashed;
	border-color: var(--cc-text-dim);
}

/* 那一句「它说的是什么事」：unreachable 与 failed 的说明**不同**，这是分辨率所在 */
.rc-run-meaning {
	font-size: var(--cc-fs-xs);
	line-height: 1.5;
	color: var(--cc-text-dim);
	overflow-wrap: anywhere;
}

/* 执行器给的原文：等宽、不截断——它是证据，改写或截掉就不算了 */
.rc-run-detail,
.rc-run-task {
	font-family: var(--cc-font-mono);
	font-size: var(--cc-fs-xs);
	line-height: 1.5;
	color: var(--cc-text);
	overflow-wrap: anywhere;
}

.rc-run-task {
	color: var(--cc-text-faint);
}

@keyframes rc-run-breathe {
	0%,
	100% {
		opacity: 1;
	}

	50% {
		opacity: 0.45;
	}
}

/* 不要动效的人看到的是一枚常亮的状态徽标，信息一个不少（档位本来就不只靠动画区分） */
@media (prefers-reduced-motion: reduce) {
	.rc-run.is-live .rc-run-badge {
		animation: none;
	}
}

/* 一次下发的结论：跑完了 / 停了 / 已请求取消。排在行列表上面——它是这整列的结论。 */
.rc-verdict {
	display: flex;
	align-items: baseline;
	flex-wrap: wrap;
	gap: var(--cc-space-1) var(--cc-space-2);
	padding: var(--cc-space-2);
	background: var(--cc-surface-sunken);
	border: 1px solid var(--cc-line-strong);
	border-left: 3px solid var(--cc-chain-live);
	border-radius: var(--cc-radius-sm);
}

/* 取消不是失败：与「停下来」不同档，也不染危险色 */
.rc-verdict.is-cancelled {
	border-left-color: var(--cc-text-dim);
	border-style: dashed;
	border-left-style: solid;
}

.rc-verdict-face {
	font-size: var(--cc-fs-sm);
	font-weight: 650;
	color: var(--cc-text);
}

.rc-verdict-count {
	margin-left: auto;
	font-family: var(--cc-font-mono);
	font-size: var(--cc-fs-xs);
	color: var(--cc-text-faint);
}

.rc-verdict-detail {
	flex: 1 1 100%;
	margin: 0;
	font-size: var(--cc-fs-xs);
	line-height: 1.5;
	color: var(--cc-text-dim);
	overflow-wrap: anywhere;
}

/* 对不上任何一行的事件：正常没有。有就说清是哪几条，不咽掉 */
.rc-orphan {
	margin: 0;
	padding: var(--cc-space-2);
	font-size: var(--cc-fs-xs);
	line-height: 1.6;
	color: var(--cc-text-dim);
	background: var(--cc-surface-sunken);
	border: 1px dashed var(--cc-line-strong);
	border-radius: var(--cc-radius-sm);
	overflow-wrap: anywhere;
}

/* 去向的说明不铺在行里（见 `describe`）：徽标说结论，note 在 `title` 里等人问 */

.rc-floating {
	display: flex;
	flex-direction: column;
	gap: var(--cc-space-1);
	padding: var(--cc-space-2);
	font-size: var(--cc-fs-xs);
	color: var(--cc-text-dim);
	background: var(--cc-surface-sunken);
	border: 1px dashed var(--cc-line-strong);
	border-radius: var(--cc-radius-sm);
}

.rc-floating p {
	margin: 0;
}

.rc-diag-list {
	margin: 0;
	padding-left: var(--cc-space-4);
	text-align: left;
	font-family: var(--cc-font-mono);
	font-size: var(--cc-fs-xs);
	line-height: 1.6;
}

.rc-footer {
	flex: 0 0 auto;
	padding: var(--cc-space-2) var(--cc-space-4);
	font-size: var(--cc-fs-xs);
	line-height: 1.5;
	color: var(--cc-text-dim);
	border-top: 1px solid var(--cc-line);
	background: var(--cc-surface);
}
</style>
