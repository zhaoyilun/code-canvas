import { describe, expect, it } from 'vitest';
import {
	canonicalWorkflowBytes,
	computeWorkflowDigest,
	validateWorkflowDeclaration,
	verifyWorkflowDigest,
	WORKFLOW_FORMAT_VERSION,
	type WorkflowDeclarationDraft,
	type WorkflowNode,
} from '../src/workflow';

// `overrides` stays loosely typed on purpose: some cases feed deliberately invalid
// values (e.g. `typeVersion: 1.5`) to exercise the validator's negative paths.
const node = (id: string, name: string, overrides: Record<string, unknown> = {}): WorkflowNode =>
	({
		id,
		name,
		type: 'task.action',
		typeVersion: 1,
		parameters: { action: 'stop' },
		position: { x: 0, y: 0 },
		disabled: false,
		...overrides,
	}) as WorkflowNode;

const draft = (overrides: Record<string, unknown> = {}): WorkflowDeclarationDraft => ({
	formatVersion: WORKFLOW_FORMAT_VERSION,
	id: 'wf_demo',
	name: '避障前进',
	nodes: [node('nd_a', '1. stop'), node('nd_b', '2. get_status')],
	connections: { nd_a: { main: [[{ node: 'nd_b', input: 0 }]] } },
	meta: { task_id: 'task-1' },
	...overrides,
});

const declaration = (overrides: Record<string, unknown> = {}): Record<string, unknown> => {
	const value = draft(overrides);
	return { ...value, digest: computeWorkflowDigest(value) };
};

const codesOf = (result: ReturnType<typeof validateWorkflowDeclaration>): string[] =>
	result.diagnostics.map((diagnostic) => diagnostic.code);

describe('声明 schema', () => {
	it('接受合法声明并回传解析结果', () => {
		const result = validateWorkflowDeclaration(declaration());
		expect(result.ok, JSON.stringify(result.diagnostics)).toBe(true);
		if (!result.ok) return;
		expect(result.declaration.nodes).toHaveLength(2);
		expect(verifyWorkflowDigest(result.declaration)).toBe(true);
	});

	it('node id 必须匹配稳定引用词法（且 1–128 字符）', () => {
		for (const badId of ['1 bad id', '_leading', 'x'.repeat(129), '']) {
			const result = validateWorkflowDeclaration(declaration({ nodes: [node(badId, 'x')] }), { checkDigest: false });
			expect(result.ok, badId).toBe(false);
			expect(codesOf(result)).toContain('workflow.schema');
		}
	});

	it('typeVersion 必须是整数', () => {
		const result = validateWorkflowDeclaration(declaration({ nodes: [node('nd_a', 'a', { typeVersion: 1.5 })] }), {
			checkDigest: false,
		});
		expect(result.ok).toBe(false);
	});

	it('connections 的键也必须是稳定引用', () => {
		const result = validateWorkflowDeclaration(declaration({ connections: { 'bad key': { main: [] } } }), {
			checkDigest: false,
		});
		expect(result.ok).toBe(false);
	});

	it('格式版本被钉死', () => {
		const result = validateWorkflowDeclaration(declaration({ formatVersion: 2 }), { checkDigest: false });
		expect(result.ok).toBe(false);
	});
});

describe('声明完整性', () => {
	it('node id 与 name 工作流内唯一', () => {
		const duplicated = declaration({
			nodes: [node('nd_a', 'same'), node('nd_a', 'same')],
		});
		const result = validateWorkflowDeclaration(duplicated, { checkDigest: false });
		expect(codesOf(result)).toEqual(expect.arrayContaining(['workflow.node.id.duplicate', 'workflow.node.name.duplicate']));
	});

	it('连线只能指向存在的节点', () => {
		const result = validateWorkflowDeclaration(
			declaration({ connections: { nd_a: { main: [[{ node: 'nd_ghost', input: 0 }]] } } }),
			{ checkDigest: false },
		);
		expect(codesOf(result)).toContain('workflow.connections.target.unknown');
		expect(result.diagnostics[0]?.path).toBe('connections.nd_a.main[0][0].node');
	});

	it('连线不能以不存在的节点为源', () => {
		const result = validateWorkflowDeclaration(
			declaration({ connections: { nd_ghost: { main: [[{ node: 'nd_a', input: 0 }]] } } }),
			{ checkDigest: false },
		);
		expect(codesOf(result)).toContain('workflow.connections.source.unknown');
	});

	it('digest 与内容不符即拒', () => {
		const tampered = { ...declaration(), name: '偷偷改个名字' };
		const result = validateWorkflowDeclaration(tampered);
		expect(result.ok).toBe(false);
		expect(codesOf(result)).toContain('workflow.digest.mismatch');
	});
});

describe('内容摘要', () => {
	it('规范化文本与书写顺序无关，逐字节相同', () => {
		const first = declaration();
		const second = declaration({ meta: { task_id: 'task-1' } });
		expect(canonicalWorkflowBytes(first as WorkflowDeclarationDraft)).toBe(
			canonicalWorkflowBytes(second as WorkflowDeclarationDraft),
		);
	});

	it('digest 不参与自身计算（可重复校验）', () => {
		const once = declaration();
		expect(computeWorkflowDigest(once as WorkflowDeclarationDraft)).toBe(once['digest']);
		expect(computeWorkflowDigest({ ...once, digest: 'sha256-' + 'f'.repeat(64) } as WorkflowDeclarationDraft)).toBe(once['digest']);
	});

	it('内容变则摘要变', () => {
		expect(computeWorkflowDigest(draft())).not.toBe(computeWorkflowDigest(draft({ name: '别的名字' })));
	});
});
