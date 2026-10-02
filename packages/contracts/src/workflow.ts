/**
 * Workflow 声明（spec §1.2）。
 *
 * 一份声明是三个视图的唯一真相：流程画布、积木画布、代码面板都从它派生。
 * `digest` 只回答「这份产物是不是从那份声明来的」；引用 ID 与内容无关（生成即固定）。
 */
import { z } from 'zod';
import { DiagnosticCollector, type Diagnostic } from './diagnostic';
import { canonicalJsonString, jsonValueSchema } from './json';
import { sha256Hex } from './sha256';
import { stableReferenceSchema } from './stable-ids';

export const WORKFLOW_FORMAT_VERSION = 1;
export const DIGEST_PATTERN = /^sha256-[0-9a-f]{64}$/;

export const digestSchema = z.string().regex(DIGEST_PATTERN, 'digest must look like sha256-<64 hex chars>');

export const nodePositionSchema = z.object({ x: z.number(), y: z.number() });
export type NodePosition = z.infer<typeof nodePositionSchema>;

export const workflowNodeSchema = z.object({
	id: stableReferenceSchema,
	name: z.string().min(1),
	type: z.string().min(1),
	typeVersion: z.number().int(),
	parameters: z.record(z.string(), jsonValueSchema),
	position: nodePositionSchema,
	disabled: z.boolean(),
});
export type WorkflowNode = z.infer<typeof workflowNodeSchema>;

export const connectionTargetSchema = z.object({
	node: stableReferenceSchema,
	input: z.number().int().min(0),
});
export type ConnectionTarget = z.infer<typeof connectionTargetSchema>;

/** 按源节点 id 索引（不是按名字）：`{ [nodeId]: { main: [[目标, ...], ...] } }`。 */
export const workflowConnectionsSchema = z.record(
	stableReferenceSchema,
	z.record(z.string().min(1), z.array(z.array(connectionTargetSchema))),
);
export type WorkflowConnections = z.infer<typeof workflowConnectionsSchema>;

export const workflowDeclarationSchema = z.object({
	formatVersion: z.literal(WORKFLOW_FORMAT_VERSION),
	id: stableReferenceSchema,
	name: z.string().min(1),
	nodes: z.array(workflowNodeSchema),
	connections: workflowConnectionsSchema,
	digest: digestSchema,
	/** 画布外观、教学 profile 等；引擎不解释。 */
	meta: z.record(z.string(), jsonValueSchema),
});
export type WorkflowDeclaration = z.infer<typeof workflowDeclarationSchema>;

/** 还没算 digest 的声明（含 digest 也接受，算的时候忽略它）。 */
export type WorkflowDeclarationDraft = Omit<WorkflowDeclaration, 'digest'> & { readonly digest?: string };

/**
 * 内容摘要：稳定键序序列化后的 SHA-256。
 * `digest` 自身不参与计算——自引用会让摘要永远算不出来。
 */
export const computeWorkflowDigest = (declaration: WorkflowDeclarationDraft): string => {
	const { digest: _omitDigest, ...rest } = declaration;
	return `sha256-${sha256Hex(canonicalJsonString(rest))}`;
};

export const verifyWorkflowDigest = (declaration: WorkflowDeclaration): boolean =>
	declaration.digest === computeWorkflowDigest(declaration);

/** 规范化（键排序）产物文本：字节级比较与落盘都用它。 */
export const canonicalWorkflowBytes = (declaration: WorkflowDeclarationDraft): string =>
	canonicalJsonString(declaration);

export type WorkflowValidationResult =
	| { readonly ok: true; readonly declaration: WorkflowDeclaration; readonly diagnostics: readonly Diagnostic[] }
	| { readonly ok: false; readonly diagnostics: readonly Diagnostic[] };

export interface ValidateWorkflowOptions {
	/** 默认核对 digest；关掉用于「刚改完还没重算摘要」的中间态。 */
	readonly checkDigest?: boolean;
}

export const validateWorkflowDeclaration = (
	input: unknown,
	options: ValidateWorkflowOptions = {},
): WorkflowValidationResult => {
	const collector = new DiagnosticCollector();

	const parsed = workflowDeclarationSchema.safeParse(input);
	if (!parsed.success) {
		for (const issue of parsed.error.issues) {
			collector.error({
				code: 'workflow.schema',
				message: issue.message,
				path: issue.path.join('.'),
			});
		}
		return { ok: false, diagnostics: collector.diagnostics };
	}

	const declaration = parsed.data;
	const nodeIds = new Set<string>();
	const nodeNames = new Set<string>();
	declaration.nodes.forEach((node, index) => {
		if (nodeIds.has(node.id)) {
			collector.error({
				code: 'workflow.node.id.duplicate',
				message: `duplicate node id: ${node.id}`,
				path: `nodes[${index}].id`,
				ref: node.id,
			});
		}
		nodeIds.add(node.id);
		if (nodeNames.has(node.name)) {
			collector.error({
				code: 'workflow.node.name.duplicate',
				message: `duplicate node name: ${node.name}`,
				path: `nodes[${index}].name`,
				ref: node.id,
			});
		}
		nodeNames.add(node.name);
	});

	for (const [sourceId, ports] of Object.entries(declaration.connections)) {
		if (!nodeIds.has(sourceId)) {
			collector.error({
				code: 'workflow.connections.source.unknown',
				message: `connections keyed by unknown node id: ${sourceId}`,
				path: `connections.${sourceId}`,
				ref: sourceId,
			});
		}
		for (const [port, branches] of Object.entries(ports)) {
			branches.forEach((branch, branchIndex) => {
				branch.forEach((target, targetIndex) => {
					if (!nodeIds.has(target.node)) {
						collector.error({
							code: 'workflow.connections.target.unknown',
							message: `connection targets unknown node id: ${target.node}`,
							path: `connections.${sourceId}.${port}[${branchIndex}][${targetIndex}].node`,
							ref: sourceId,
						});
					}
				});
			});
		}
	}

	if (options.checkDigest !== false) {
		const expected = computeWorkflowDigest(declaration);
		if (declaration.digest !== expected) {
			collector.error({
				code: 'workflow.digest.mismatch',
				message: 'digest does not match declaration content',
				path: 'digest',
				details: { expected, actual: declaration.digest },
			});
		}
	}

	if (collector.hasErrors) return { ok: false, diagnostics: collector.diagnostics };
	return { ok: true, declaration, diagnostics: collector.diagnostics };
};
