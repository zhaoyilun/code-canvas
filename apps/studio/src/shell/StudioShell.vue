<script setup lang="ts">
/**
 * 固定分区外壳：顶部品牌条 + 输入带 → 三栏（积木 / 流程 / 右栏）。
 *
 * 原本底下还有一条状态条（六段流水线 + RUN / STOP 占位），整块已去掉：
 * 那三段可达的段位与两个按钮都只是标签与占位，本阶段不执行任何东西，留着反而像功能。
 * 去掉后不留空底栏——空容器会带出一条没人要的分隔线。
 *
 * 这里**没有 tab**：三栏是同时可见的固定布局，不存在「切下面显示什么」这回事，
 * 所以既没有 tab 条也没有图标栏——不摆点了没用的控件。
 *
 * 右栏（虚拟设备 + 代码面板）自管内容，此处只摆放。
 *
 * 三栏之间留 `--cc-col-gap` 的空隙：那片空隙是**连线的过道**（见下一条），
 * 线从一栏边缘出来、横穿空隙、贴到下一栏元素的边缘上——紧贴的 grid 里线会压在内容上。
 */
import TaskInputBand from './TaskInputBand.vue';
import BlocklyView from '../views/blockly/BlocklyView.vue';
import FlowView from '../views/flow/FlowView.vue';
import RightPanel from '../views/right/RightPanel.vue';
</script>

<template>
	<div class="shell">
		<header class="topbar">
			<span class="brand">CodeCanvas</span>
		</header>
		<TaskInputBand />
		<div class="studio-body">
			<main class="workspace">
				<section class="pane pane-canvas">
					<BlocklyView />
				</section>
				<section class="pane pane-flow">
					<FlowView />
				</section>
				<aside class="pane pane-inspector">
					<RightPanel />
				</aside>

				<!--
					跨栏连线层（M3 的 LinkOverlay）**已关掉**，连带它的三个测试文件（`views/mapping/`）。

					为什么关：那三条箭头画的是「同一份声明的同一个节点，在王栏里分别长什么样」——
					它靠「声明 + 目录」推位置。三个视图改成模型画规格之后，屏幕上那三样**不再从声明派生**：
					流程图的节点是模型起的名字（与声明的 node id 没有对应关系，也不该由我们编一个），
					积木画的是教学块树，代码是模型写的一段文本。这时再画那三条线，
					画的就是一个**已经不存在的对应关系**——那比不画坏得多。
					真要接回来，得先有一份「规格里的哪一块对应声明里的哪一步」的事实，
					而那是模型没给、我们也不许编的东西。见 `views/mapping/index.ts` 的文件头。
				-->
			</main>
		</div>
	</div>
</template>

<style scoped>
.shell {
	display: flex;
	flex-direction: column;
	height: 100%;
	min-height: 0;
	background: var(--cc-bg);
}

.topbar {
	display: flex;
	align-items: center;
	gap: var(--cc-space-2);
	flex: 0 0 auto;
	height: var(--cc-topbar-h);
	padding: 0 var(--cc-space-4) 0 var(--cc-space-3);
	background: var(--cc-surface);
	border-bottom: 1px solid var(--cc-line);
}

.brand {
	font-size: var(--cc-fs-lg);
	font-weight: 650;
	letter-spacing: 0.01em;
	color: var(--cc-text);
}

.studio-body {
	display: flex;
	flex: 1 1 auto;
	min-height: 0;
}

.workspace {
	display: grid;
	grid-template-columns: minmax(320px, 1fr) minmax(320px, 1fr) var(--cc-right-w);
	/*
	 * 栏间空隙：连线要过道。26px 是「够线走、又不吃掉栏宽」的那一档——
	 * 1920 宽下左栏仍有 ~620px；1280 宽下走下面的窄窗退化，栏宽下限另行给足。
	 */
	gap: 0 var(--cc-col-gap);
	/*
	 * overlay 的定位基准。它铺满整个工作区（含空隙），从任何一栏元素的边缘量到的工作区局部坐标
	 * 都能直接当 SVG 坐标用。`position: relative` 不改任何一栏的宽度与滚动。
	 */
	position: relative;
	flex: 1 1 auto;
	min-width: 0;
	min-height: 0;
	background: var(--cc-stage);
}

.pane {
	display: flex;
	flex-direction: column;
	min-width: 0;
	min-height: 0;
	overflow: hidden;
}

.pane-flow {
	border-left: 1px solid var(--cc-line);
}

.pane-inspector {
	border-left: 1px solid var(--cc-line);
	background: var(--cc-surface);
}

/*
 * 窄窗退化：三栏不再挤成一团。给工作区一个下限宽度并允许横向滚动，
 * 外壳本身不塌（页面仍可见顶部 + 底部）。
 *
 * ⚠ 空隙进了这条退化路径的宽度账：三栏 + 两条空隙要一起算。
 * 空隙这里收到 16px——窄窗下每一像素都该给栏，线照画，只是过道窄一点。
 *
 * ⚠ 右栏的下限是**按内容定的**，不再是一个可以随便压的数：它上半是 3D 画面
 * （`views/right/VirtualDevicePanel.vue`），扣掉面板内边距后画面要 ≥420 宽才看得清机械臂。
 * 所以这里给 440px 而不是旧的 320px——压到 320 那会儿，右栏里还没有真东西可看。
 * 上限仍走 `--cc-right-w`：宽屏下不跟着长，多余的宽度给两张画布。
 */
@media (max-width: 1400px) {
	.workspace {
		grid-template-columns: minmax(300px, 1fr) minmax(300px, 1fr) minmax(440px, var(--cc-right-w));
		gap: 0 var(--cc-col-gap-tight);
		overflow-x: auto;
	}
}
</style>
