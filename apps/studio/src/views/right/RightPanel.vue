<script setup lang="ts">
/**
 * 右栏 = **虚拟设备**（上，占大头）+ **代码 / 任务 JSON**（下，tab 切换）。
 *
 * 为什么上半要大：虚拟设备那块现在装的是**真的 3D 设备**——`@codecanvas/robot3d` 的执行器
 * 挂在 `<VirtualDevicePanel>` 里（画面、执行、步骤日志都在它里面）。3D 是这一栏里最吃地方的东西，
 * 所以它拿掉七成以上（`flex` 8:3），下半块只留「这份声明是什么」的两种看法够用的高度。
 *
 * 为什么下半是 tab 而不是再分一块：代码与任务 JSON 是**同一件事的两种看法**
 * （编译产物 / 还原出来的输入），并排摆会把两块都压扁。tab 让当前看的那一份拿到整块高度。
 *
 * 设备**事实**那几行（名字、真机还是仿真、目录、能力数、出处）仍在 `VirtualDevicePanel` 里：
 * 「选的是哪一台」和「它能不能跑 3D」是同一个问题的两半，拆成两个组件只会让两边各存一份判断。
 *
 * 右栏自身的宽度在 `theme.css` 的 `--cc-right-w` 上（3D 那块要 ≥420 宽才立得住），
 * 组件里不写死像素。
 */
import { computed, ref } from 'vue';
import { useStudioDevices } from '../../shell/devices';
import { useStudioDocument } from '../../state/document';
import { CodePanel } from '../code-panel';
import { TaskJsonPanel } from './task-json';
import VirtualDevicePanel from './VirtualDevicePanel.vue';

type RightTab = 'code' | 'json';

const TABS = [
	{ id: 'code' as RightTab, label: '代码', testid: 'right-tab-code' },
	{ id: 'json' as RightTab, label: '任务 JSON', testid: 'right-tab-json' },
] as const;

const activeTab = ref<RightTab>('code');

const devices = useStudioDevices();
const doc = useStudioDocument();
/** 选中的是**设备**（名字 + 真机/仿真 + 目录 + 任务格式），不再只是一个目录。 */
const selectedDevice = computed(() => devices.selectedDevice.value);
/** 还原成技能计划用的尺子：声明**出生时**那把（没导入过时退到当前设备，那种情况下是空状态）。 */
const declarationFormatRef = computed(() => doc.declarationFormatRef.value);

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
		<!--
			虚拟设备：拿掉大头，3D 画面在里面。
			`key` 绑设备引用：换设备时让这个组件整块重建，旧的 3D 在 `onBeforeUnmount` 里 dispose，
			新的在 `onMounted` 里挂——不把「设备迁移」这件事塞进组件内部当状态机。
		-->
		<VirtualDevicePanel
			:key="selectedDevice?.deviceRef ?? 'none'"
			:device="selectedDevice"
			:format-ref="declarationFormatRef"
		/>

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
 * 下半块。tab 条定高，面板吃满剩下的。
 *
 * `flex-basis: 0` + `min-height`：块高按内容**至少**要这么多（tab 条 + 220px 面板），
 * 有富余时上下块按 8:3 分。上一版只写比例（`flex: 3 1 0`），在 900px 高的窗口里
 * 下面这块被压到 209px——比面板自己的下限还矮，于是面板只能自己滚，那是「保底不够用」。
 */
.inspector {
	display: flex;
	flex-direction: column;
	flex: 3.25 1 0;
	min-height: calc(var(--cc-tabs-h) + 232px);
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
