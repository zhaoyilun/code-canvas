<script setup lang="ts">
// 中栏：流程画布（占位）。M2 换成节点链 + 失败态占位。
</script>

<template>
	<section class="placeholder view-flow" data-testid="view-flow">
		<header class="placeholder-header">
			<span class="placeholder-title">流程画布</span>
			<span class="placeholder-tag">WORKFLOW</span>
			<span class="placeholder-tag">只读</span>
		</header>
		<div class="placeholder-body">
			<p class="placeholder-text">
				步骤按顺序连成一条链画在这里：顺序是什么、现在跑到哪、哪一步失败。<br />
				它只读，答案全都来自那份 workflow 声明。
			</p>
		</div>
		<p class="placeholder-note">M2 接入：节点链 + 跨栏映射虚线（M3）</p>
	</section>
</template>

<style scoped src="../placeholder.css"></style>
