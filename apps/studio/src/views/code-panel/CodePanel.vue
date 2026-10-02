<script setup lang="ts">
/**
 * 右栏代码面板（spec §4.1）：**编译产物，只读**。
 *
 * - 文本由 `@codecanvas/code-render` 从声明渲染而来，规则追到校验器；这里不拼一个字符的调用。
 * - `selectedNodeId` 变化时高亮它渲染出的那几行，并把它滚进视野。
 * - 安全限值常驻底部——限值躺在 JSON 里没人知道，等于没有。
 * - 声明换了（改积木写回 → `applyDeclaration`）这里跟着重算，这就是「改参数 → 数字跟着变」。
 */
import { computed, nextTick, ref, watch } from 'vue';
import { renderDeclaration, spanOfNode } from '@codecanvas/code-render';
import { useStudioDocument } from '../../state/document';

const doc = useStudioDocument();

const program = computed(() => renderDeclaration(doc.declaration.value));
const hasDeclaration = computed(() => doc.declaration.value !== null);
const activeNodeId = computed(() => doc.selectedNodeId.value);
const selectedSpan = computed(() => {
	const id = activeNodeId.value;
	return id === null ? null : spanOfNode(program.value, id);
});

const isHighlighted = (nodeId: string | null): boolean => nodeId !== null && nodeId === activeNodeId.value;

const scroller = ref<HTMLElement | null>(null);

// 选中项可能在另一栏被点到，视线得跟过去；`block: 'nearest'` 保证不把面板整体滚飞。
// scrollIntoView 在测试用的 DOM 实现里可能没有，所以先探一下再调。
watch(
	() => selectedSpan.value?.startLine,
	async (line) => {
		if (line === undefined) return;
		await nextTick();
		const target = scroller.value?.querySelector(`[data-line="${line}"]`);
		if (target !== null && target !== undefined && typeof target.scrollIntoView === 'function') {
			target.scrollIntoView({ block: 'nearest' });
		}
	},
);

const limits = computed(() => program.value.limits);
const warnings = computed(() => program.value.diagnostics);
</script>

<template>
	<section class="code-panel" data-testid="code-panel">
		<header class="cp-header">
			<span class="cp-title">代码</span>
			<span class="cp-tag">编译产物</span>
			<span class="cp-tag cp-tag-readonly">只读</span>
			<span class="cp-count">{{ program.callCount }} 个调用</span>
		</header>

		<div v-if="!hasDeclaration" class="cp-empty">
			<p>还没有声明——导入一份任务 JSON 后这里会显示它编译出来的调用。</p>
		</div>

		<template v-else>
			<div ref="scroller" class="cp-code" data-testid="code-scroll">
				<ol class="cp-lines">
					<li
						v-for="line in program.lines"
						:key="line.line"
						class="cp-line"
						:class="{
							'is-call': line.kind === 'call',
							'is-unsupported': line.kind === 'unsupported',
							'is-active': isHighlighted(line.nodeId),
						}"
						:data-line="line.line"
						:data-node-id="line.nodeId ?? undefined"
						:data-kind="line.kind"
					>
						<span class="cp-ln" aria-hidden="true">{{ line.line }}</span>
						<code class="cp-src">{{ line.text === '' ? ' ' : line.text }}</code>
					</li>
				</ol>
			</div>

			<ul v-if="warnings.length > 0" class="cp-warnings" data-testid="code-warnings">
				<li v-for="(diagnostic, index) in warnings" :key="`${index}-${diagnostic.code}`">
					<span class="cp-warn-code">{{ diagnostic.code }}</span>
					{{ diagnostic.message }}
				</li>
			</ul>

			<section class="cp-limits" data-testid="code-limits">
				<header class="cp-limits-head">
					<span class="cp-limits-title">安全限值</span>
					<span v-if="!limits.present" class="cp-limits-note">声明里没有，显示协议安全上限</span>
				</header>
				<ul class="cp-limit-list">
					<li v-for="limit in limits.numeric" :key="limit.name" class="cp-limit">
						<span class="cp-limit-name">{{ limit.name }}</span>
						<span class="cp-limit-value">{{ limit.text }}</span>
						<span v-if="limit.tightened" class="cp-limit-flag" title="比协议安全上限更紧">已收紧</span>
						<span v-else class="cp-limit-flag cp-limit-flag-max" title="协议安全上限">上限</span>
					</li>
				</ul>
				<p class="cp-limit-confirm">
					运行前需确认：<strong>{{ limits.requireConfirmation ? '是' : '否' }}</strong>
				</p>
			</section>

			<footer class="cp-footer">
				<span v-if="selectedSpan !== null" class="cp-footer-selected">
					选中 {{ selectedSpan.nodeName }} · 第 {{ selectedSpan.startLine }} 行
				</span>
				<span v-else class="cp-footer-hint">在积木那侧改一个参数，这里跟着变</span>
			</footer>
		</template>
	</section>
</template>

<style scoped>
.code-panel {
	display: flex;
	flex-direction: column;
	height: 100%;
	min-height: 0;
	background: var(--cc-surface);
}

.cp-header {
	display: flex;
	align-items: baseline;
	gap: var(--cc-space-2);
	padding: var(--cc-space-3) var(--cc-space-4);
	border-bottom: 1px solid var(--cc-line);
}

.cp-title {
	font-size: var(--cc-fs-md);
	font-weight: 600;
	color: var(--cc-text);
}

.cp-tag {
	padding: 2px var(--cc-space-2);
	font-family: var(--cc-font-mono);
	font-size: var(--cc-fs-xs);
	letter-spacing: 0.06em;
	color: var(--cc-accent);
	background: var(--cc-accent-veil);
	border: 1px solid var(--cc-accent-dim);
	border-radius: var(--cc-radius-sm);
}

.cp-tag-readonly {
	color: var(--cc-text-dim);
	background: transparent;
	border-color: var(--cc-line-strong);
}

.cp-count {
	margin-left: auto;
	font-family: var(--cc-font-mono);
	font-size: var(--cc-fs-sm);
	color: var(--cc-text-faint);
}

.cp-empty {
	flex: 1 1 auto;
	display: flex;
	align-items: center;
	justify-content: center;
	padding: var(--cc-space-5);
	color: var(--cc-text-dim);
	text-align: center;
}

.cp-code {
	flex: 1 1 auto;
	min-height: 0;
	overflow: auto;
	padding: var(--cc-space-3) 0;
	background: var(--cc-surface-sunken);
}

.cp-lines {
	margin: 0;
	padding: 0;
	list-style: none;
	font-family: var(--cc-font-mono);
	font-size: var(--cc-fs-md);
	line-height: 1.9;
}

.cp-line {
	display: flex;
	align-items: flex-start;
	gap: var(--cc-space-2);
	padding: 0 var(--cc-space-3);
	border-left: 2px solid transparent;
}

/* 高亮：左侧亮条 + 底色，行号与代码一起变亮——`.is-active` 必须排在 `.is-call` 之后，
   否则同权重下调用行的常态色会盖掉高亮色。 */
.cp-line.is-active {
	background: var(--cc-accent-veil);
	border-left-color: var(--cc-accent);
}

.cp-ln {
	flex: 0 0 auto;
	min-width: 2ch;
	text-align: right;
	color: var(--cc-text-faint);
	user-select: none;
}

/* 右栏只有 360px：长调用折行显示，不横向滚动（折行不改行号，行 ↔ nodeId 仍然一一对应）。 */
.cp-src {
	flex: 1 1 auto;
	min-width: 0;
	color: var(--cc-text-dim);
	white-space: pre-wrap;
	overflow-wrap: anywhere;
}

.cp-line.is-call .cp-src {
	color: var(--cc-text);
}

.cp-line.is-unsupported .cp-src {
	color: var(--cc-danger-strong);
}

.cp-line.is-active .cp-ln,
.cp-line.is-active .cp-src {
	color: var(--cc-accent-strong);
}

.cp-warnings {
	margin: 0;
	padding: var(--cc-space-2) var(--cc-space-4);
	list-style: none;
	max-height: 96px;
	overflow-y: auto;
	font-size: var(--cc-fs-sm);
	color: var(--cc-danger-strong);
	background: var(--cc-danger-veil);
	border-top: 1px solid var(--cc-line);
}

.cp-warn-code {
	font-family: var(--cc-font-mono);
	color: var(--cc-text-faint);
	margin-right: var(--cc-space-2);
}

.cp-limits {
	padding: var(--cc-space-3) var(--cc-space-4);
	border-top: 1px solid var(--cc-line);
}

.cp-limits-head {
	display: flex;
	align-items: baseline;
	gap: var(--cc-space-2);
	margin-bottom: var(--cc-space-2);
}

.cp-limits-title {
	font-size: var(--cc-fs-sm);
	letter-spacing: 0.08em;
	color: var(--cc-text-dim);
}

.cp-limits-note {
	font-size: var(--cc-fs-xs);
	color: var(--cc-text-faint);
}

.cp-limit-list {
	margin: 0;
	padding: 0;
	list-style: none;
	display: grid;
	gap: var(--cc-space-1);
}

.cp-limit {
	display: flex;
	align-items: baseline;
	gap: var(--cc-space-2);
	font-family: var(--cc-font-mono);
	font-size: var(--cc-fs-sm);
}

.cp-limit-name {
	color: var(--cc-text-dim);
}

.cp-limit-value {
	color: var(--cc-accent);
}

.cp-limit-flag {
	margin-left: auto;
	padding: 0 var(--cc-space-1);
	font-size: var(--cc-fs-xs);
	color: var(--cc-accent-dim);
	border: 1px solid var(--cc-accent-dim);
	border-radius: var(--cc-radius-sm);
}

.cp-limit-flag-max {
	color: var(--cc-text-faint);
	border-color: var(--cc-line-strong);
}

.cp-limit-confirm {
	margin: var(--cc-space-2) 0 0;
	font-size: var(--cc-fs-sm);
	color: var(--cc-text-dim);
}

.cp-limit-confirm strong {
	color: var(--cc-text);
}

.cp-footer {
	padding: var(--cc-space-2) var(--cc-space-4);
	font-family: var(--cc-font-mono);
	font-size: var(--cc-fs-sm);
	color: var(--cc-text-faint);
	border-top: 1px solid var(--cc-line);
}
</style>
