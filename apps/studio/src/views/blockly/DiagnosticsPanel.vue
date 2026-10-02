<script setup lang="ts">
/**
 * 诊断列表：编译诊断（积木侧）与声明诊断（store 侧）摆在一起。
 * 非法值被拒时，这里就是「为什么没写进去」的答案。
 *
 * 没有诊断时整块不画（连同它的上分隔线）：空列表的「诊断 0 / 没有诊断」只是噪音，
 * 而这块占了位置又什么都不说，还会把画布挤窄。
 */
import type { Diagnostic } from '@codecanvas/contracts';
import type { DiagnosticRow } from './blockly-canvas';

defineProps<{ rows: readonly DiagnosticRow[] }>();

const SOURCE_LABEL: Record<DiagnosticRow['source'], string> = {
	compile: '编译',
	declaration: '声明',
};

const location = (diagnostic: Diagnostic): string => {
	const path = diagnostic.path ?? '';
	const ref = diagnostic.ref ?? '';
	if (path !== '' && ref !== '') return `${path} · ${ref}`;
	return path !== '' ? path : ref;
};
</script>

<template>
	<section v-if="rows.length > 0" class="diagnostics" data-testid="blockly-diagnostics">
		<header class="diagnostics-head">
			<span class="diagnostics-title">诊断</span>
			<span class="diagnostics-count" data-testid="blockly-diagnostic-count">{{ rows.length }}</span>
		</header>
		<ul class="diagnostics-list">
			<li
				v-for="row in rows"
				:key="`${row.source}:${row.diagnostic.code}:${row.diagnostic.path ?? ''}:${row.diagnostic.message}`"
				class="diagnostic"
				:class="row.diagnostic.severity"
				data-testid="blockly-diagnostic"
			>
				<span class="diagnostic-meta">
					<span class="diagnostic-source">{{ SOURCE_LABEL[row.source] }}</span>
					<span class="diagnostic-code">{{ row.diagnostic.code }}</span>
				</span>
				<span class="diagnostic-message">{{ row.diagnostic.message }}</span>
				<span v-if="location(row.diagnostic) !== ''" class="diagnostic-where">{{ location(row.diagnostic) }}</span>
			</li>
		</ul>
	</section>
</template>

<style scoped>
.diagnostics {
	display: flex;
	flex-direction: column;
	gap: var(--cc-space-2);
	flex: 0 1 auto;
	min-height: 0;
	max-height: 34%;
	padding-top: var(--cc-space-2);
	border-top: 1px solid var(--cc-line);
}

.diagnostics-head {
	display: flex;
	align-items: baseline;
	gap: var(--cc-space-2);
}

.diagnostics-title {
	font-size: var(--cc-fs-sm);
	font-weight: 600;
	color: var(--cc-text-dim);
}

.diagnostics-count {
	font-family: var(--cc-font-mono);
	font-size: var(--cc-fs-xs);
	color: var(--cc-text-faint);
}

.diagnostics-list {
	display: flex;
	flex-direction: column;
	gap: var(--cc-space-1);
	margin: 0;
	padding: 0;
	overflow-y: auto;
	list-style: none;
}

.diagnostic {
	display: flex;
	flex-direction: column;
	gap: 2px;
	padding: var(--cc-space-2);
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

.diagnostic-meta {
	display: flex;
	align-items: baseline;
	gap: var(--cc-space-2);
}

.diagnostic-source {
	font-size: var(--cc-fs-xs);
	color: var(--cc-text-faint);
}

.diagnostic-code {
	font-family: var(--cc-font-mono);
	font-size: var(--cc-fs-xs);
	color: var(--cc-text-dim);
	overflow-wrap: anywhere;
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
	font-family: var(--cc-font-mono);
	font-size: var(--cc-fs-xs);
	color: var(--cc-text-faint);
	overflow-wrap: anywhere;
}
</style>
