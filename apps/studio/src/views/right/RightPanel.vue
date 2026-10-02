<script setup lang="ts">
/**
 * 右栏 = **虚拟设备**（上）+ **代码 / 任务 JSON**（下，tab 切换）。
 *
 * 为什么上半要大：虚拟设备是这台机器「长什么样、什么状态」的位置——将来要放真的 3D
 * 或状态图，那一块得先有地方。所以它拿掉了一半以上（`flex` 5:4，约 55%），
 * 下半块留给「这份声明是什么」的两种看法。
 *
 * 为什么下半是 tab 而不是再分一块：代码与任务 JSON 是**同一件事的两种看法**
 * （编译产物 / 还原出来的输入），并排摆会把两块都压扁。tab 让当前看的那一份拿到整块高度。
 * 代码面板的内容一个字没改，只是从「固定常驻」变成 tab 里的一个（spec §4.1 的编译产物）。
 *
 * 上面那块现在**如实为空**：虚拟表示要显示一台真实设备的状态，设备没连上就没有可显示的东西。
 * 唯一能显示的是**已经登记在册的设备目录**（那是真的：目录就在 `@codecanvas/capabilities` 里），
 * 以及入口带当前选的是哪一台。不画占位假数据，也不写「即将上线」。
 */
import { computed, ref } from 'vue';
import IconBase from '../../shell/IconBase.vue';
import { useStudioDevices } from '../../shell/devices';
import { CodePanel } from '../code-panel';
import { TaskJsonPanel } from './task-json';

type RightTab = 'code' | 'json';

const TABS = [
	{ id: 'code' as RightTab, label: '代码', testid: 'right-tab-code' },
	{ id: 'json' as RightTab, label: '任务 JSON', testid: 'right-tab-json' },
] as const;

const activeTab = ref<RightTab>('code');

const devices = useStudioDevices();
const selectedCatalog = computed(() => devices.selectedCatalog.value);
const capabilityCount = computed(() => selectedCatalog.value?.capabilities.length ?? 0);
const primitiveCount = computed(() => selectedCatalog.value?.primitives.length ?? 0);

/** 左右方向键在 tab 之间走——tablist 的常规键位，不额外造一套。 */
function moveTab(event: KeyboardEvent, step: number): void {
	event.preventDefault();
	const index = TABS.findIndex((tab) => tab.id === activeTab.value);
	const next = TABS[(index + step + TABS.length) % TABS.length];
	if (next !== undefined) activeTab.value = next.id;
}
</script>

<template>
	<section class="right-panel" data-testid="right-panel">
		<!-- 虚拟设备：拿掉一半以上高度，给将来的 3D / 状态图留地方 -->
		<section class="device" data-testid="virtual-device">
			<header class="panel-header">
				<IconBase name="device" :size="20" />
				<span class="panel-title">虚拟设备</span>
				<span class="panel-tag" data-testid="virtual-device-tag">设备层未接入</span>
			</header>

			<div class="device-body" data-testid="virtual-device-note">
				<!-- 这段是真的：目录确实存在，且入口带上选的就是它。 -->
				<dl v-if="selectedCatalog !== null" class="device-facts" data-testid="virtual-device-facts">
					<div class="fact-row">
						<dt class="fact-name">当前设备</dt>
						<dd class="fact-value" data-testid="virtual-device-name">
							{{ selectedCatalog.displayName }}
						</dd>
					</div>
					<div class="fact-row">
						<dt class="fact-name">目录</dt>
						<dd class="fact-value fact-mono" data-testid="virtual-device-catalog-ref">
							{{ selectedCatalog.catalogRef }} · {{ selectedCatalog.revisionRef }}
						</dd>
					</div>
					<div class="fact-row">
						<dt class="fact-name">目录里的动作</dt>
						<dd class="fact-value fact-mono">
							{{ capabilityCount }} 个能力 · {{ primitiveCount }} 个原语
						</dd>
					</div>
				</dl>

				<p class="panel-text">
					上面三行是目录里的事实（能力目录由设备侧提供）。这里将来放的是同一台设备的
					虚拟表示——它当前的状态，以及它报出来的能力。设备层还没接上，没有设备可表示，
					所以除了目录之外这块是空着的：不画占位图，也不给假状态。
				</p>
				<p class="panel-footnote">后置：设备协议定稿、设备层接上之后才有内容</p>
			</div>
		</section>

		<!-- 下半块：同一件事的两种看法，tab 切换 -->
		<section class="inspector">
			<div class="inspector-tabs" role="tablist" aria-label="右栏视图">
				<button
					v-for="tab in TABS"
					:key="tab.id"
					type="button"
					class="tab"
					:class="{ 'is-active': activeTab === tab.id }"
					role="tab"
					:aria-selected="activeTab === tab.id"
					:data-testid="tab.testid"
					:tabindex="activeTab === tab.id ? 0 : -1"
					@click="activeTab = tab.id"
					@keydown.left="moveTab($event, -1)"
					@keydown.right="moveTab($event, 1)"
				>
					{{ tab.label }}
				</button>
			</div>

			<div
				v-if="activeTab === 'code'"
				class="panel-code"
				data-testid="right-panel-code"
				role="tabpanel"
			>
				<CodePanel />
			</div>
			<div v-else class="panel-code" data-testid="right-panel-json" role="tabpanel">
				<TaskJsonPanel />
			</div>
		</section>
	</section>
</template>

<style scoped>
.right-panel {
	display: flex;
	flex-direction: column;
	height: 100%;
	min-height: 0;
}

/*
 * 虚拟设备：占右栏的 5/9（≈55%，去掉 tab 条之后约 52%）——「至少一半以上」那一档。
 * 用 flex-grow 的比例而不是 max-height 封顶：两块的分界是稳定的，内容多少都不改变比例，
 * 各自内部滚动（min-height: 0 是滚动生效的前提）。
 */
.device {
	display: flex;
	flex-direction: column;
	flex: 5 1 0;
	min-height: 0;
	border-bottom: 1px solid var(--cc-line);
}

.panel-header {
	display: flex;
	align-items: center;
	gap: var(--cc-space-2);
	flex: 0 0 auto;
	padding: var(--cc-space-3) var(--cc-space-4);
	color: var(--cc-text-dim);
	border-bottom: 1px solid var(--cc-line);
}

.panel-title {
	font-size: var(--cc-fs-md);
	font-weight: 600;
	color: var(--cc-text);
}

.panel-tag {
	margin-left: auto;
	padding: 2px var(--cc-space-2);
	font-family: var(--cc-font-mono);
	font-size: var(--cc-fs-xs);
	letter-spacing: 0.06em;
	color: var(--cc-text-faint);
	background: var(--cc-surface-sunken);
	border: 1px solid var(--cc-line-strong);
	border-radius: var(--cc-radius-sm);
}

.device-body {
	display: flex;
	flex-direction: column;
	gap: var(--cc-space-3);
	flex: 1 1 auto;
	min-height: 0;
	padding: var(--cc-space-3) var(--cc-space-4);
	overflow-y: auto;
}

/* 目录事实：名字与读数分居两端，跟流程卡片的参数行同一套排版语言。 */
.device-facts {
	display: flex;
	flex-direction: column;
	gap: var(--cc-space-1);
	margin: 0;
}

.fact-row {
	display: flex;
	align-items: baseline;
	justify-content: space-between;
	gap: var(--cc-space-2);
	padding: 2px var(--cc-space-2);
	background: var(--cc-surface-sunken);
	border: 1px solid var(--cc-line);
	border-radius: var(--cc-radius-sm);
}

.fact-name {
	font-size: var(--cc-fs-sm);
	color: var(--cc-text-dim);
}

.fact-value {
	margin: 0;
	font-size: var(--cc-fs-sm);
	color: var(--cc-text);
	text-align: right;
	overflow-wrap: anywhere;
}

.fact-mono {
	font-family: var(--cc-font-mono);
	font-size: var(--cc-fs-xs);
	color: var(--cc-accent);
}

.panel-text {
	margin: 0;
	font-size: var(--cc-fs-sm);
	line-height: 1.6;
	color: var(--cc-text-dim);
}

.panel-footnote {
	margin: 0;
	font-family: var(--cc-font-mono);
	font-size: var(--cc-fs-xs);
	color: var(--cc-text-faint);
}

/* 下半块：4/9。tab 条定高，面板吃满剩下的。 */
.inspector {
	display: flex;
	flex-direction: column;
	flex: 4 1 0;
	min-height: 0;
}

.inspector-tabs {
	display: flex;
	align-items: stretch;
	gap: var(--cc-space-1);
	flex: 0 0 auto;
	padding: var(--cc-space-1) var(--cc-space-3) 0;
	background: var(--cc-surface);
	border-bottom: 1px solid var(--cc-line);
}

/*
 * tab：常态是一条安静的字，选中那条压在强调色 veil 上并带一条下边框——
 * 与三处序号徽标同一套「安静 / 选中」两档，不引第二种强调色。
 */
.tab {
	padding: var(--cc-space-1) var(--cc-space-3);
	font-size: var(--cc-fs-sm);
	font-weight: 600;
	letter-spacing: 0.02em;
	color: var(--cc-text-dim);
	background: transparent;
	border: none;
	border-bottom: 2px solid transparent;
	cursor: pointer;
}

.tab:hover {
	color: var(--cc-text);
}

.tab.is-active {
	color: var(--cc-accent-strong);
	background: var(--cc-accent-veil);
	border-bottom-color: var(--cc-highlight);
}

.tab:focus-visible {
	outline: 1px solid var(--cc-highlight);
	outline-offset: -1px;
}

/*
 * 面板的槽位。用 grid 而不是 flex：单行单列的轨道会把子元素拉到满高满宽，
 * 面板内部的 height:100% 也就有了确定的基准，不会只画出半截。
 */
.panel-code {
	display: grid;
	grid-template-columns: minmax(0, 1fr);
	grid-template-rows: minmax(0, 1fr);
	flex: 1 1 auto;
	min-height: 0;
	overflow: hidden;
}
</style>
