/**
 * 诊断：节点、转换器、校验器的统一出错形态（spec §2）。
 *
 * 不抛异常是纪律，所以这里给一个收集器：一次校验跑完，能带定位地把所有问题都报出来。
 */
import { z } from 'zod';
import { jsonObjectSchema, type JsonObject } from './json';

export const DIAGNOSTIC_SEVERITIES = ['error', 'warning', 'info'] as const;
export type DiagnosticSeverity = (typeof DIAGNOSTIC_SEVERITIES)[number];

export interface Diagnostic {
	/** 稳定引用词法：机器判断用这个字段，不要去匹配 message。 */
	readonly code: string;
	readonly severity: DiagnosticSeverity;
	readonly message: string;
	/** JSON 路径用点号 + 下标（`steps[0].linear`）；源码位置用 `source.<line>.<col>`。 */
	readonly path?: string;
	/** 谁出错了：节点 id / 块 id / 步骤 id。 */
	readonly ref?: string;
	readonly details?: JsonObject;
}

export const diagnosticSchema: z.ZodType<Diagnostic> = z.object({
	code: z.string().min(1),
	severity: z.enum(DIAGNOSTIC_SEVERITIES),
	message: z.string(),
	path: z.string().optional(),
	ref: z.string().optional(),
	details: jsonObjectSchema.optional(),
});

export interface DiagnosticInput {
	readonly code: string;
	readonly message: string;
	readonly path?: string;
	readonly ref?: string;
	readonly details?: JsonObject;
}

export class DiagnosticCollector {
	readonly #items: Diagnostic[] = [];
	#errorCount = 0;

	error(input: DiagnosticInput): void {
		this.#errorCount += 1;
		this.#items.push({ ...input, severity: 'error' });
	}

	warning(input: DiagnosticInput): void {
		this.#items.push({ ...input, severity: 'warning' });
	}

	info(input: DiagnosticInput): void {
		this.#items.push({ ...input, severity: 'info' });
	}

	get diagnostics(): readonly Diagnostic[] {
		return this.#items;
	}

	get errorCount(): number {
		return this.#errorCount;
	}

	get hasErrors(): boolean {
		return this.#errorCount > 0;
	}
}

/** 契约层的统一返回形状：要么给值，要么给诊断，绝不抛裸异常。 */
export type ContractResult<T> =
	| { readonly ok: true; readonly value: T; readonly diagnostics: readonly Diagnostic[] }
	| { readonly ok: false; readonly diagnostics: readonly Diagnostic[] };

export const formatDiagnostic = (diagnostic: Diagnostic): string => {
	const where = diagnostic.path === undefined ? '' : ` at ${diagnostic.path}`;
	const who = diagnostic.ref === undefined ? '' : ` [${diagnostic.ref}]`;
	return `${diagnostic.severity.toUpperCase()} ${diagnostic.code}${where}${who}: ${diagnostic.message}`;
};

export const formatDiagnostics = (diagnostics: readonly Diagnostic[]): string =>
	diagnostics.map(formatDiagnostic).join('\n');
