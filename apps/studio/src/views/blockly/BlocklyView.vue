<script setup lang="ts">
// 左栏：积木画布（占位）。M2 换成 Blockly + 自有主题，本阶段只占位。
</script>

<template>
	<section class="placeholder view-blockly" data-testid="view-blockly">
		<header class="placeholder-header">
			<span class="placeholder-title">积木画布</span>
			<span class="placeholder-tag">BLOCKLY</span>
			<span class="placeholder-tag">唯一可写</span>
		</header>
		<div class="placeholder-body">
			<p class="placeholder-text">
				任务被拆成的积木块会画在这里。<br />
				三个视图里只有这块能改，改完编译回同一份 workflow 声明。
			</p>
		</div>
		<p class="placeholder-note">M2 接入：Blockly 12 + zelos 渲染器 + 由校验器推导的积木定义</p>
	</section>
</template>

<style scoped src="../placeholder.css"></style>
