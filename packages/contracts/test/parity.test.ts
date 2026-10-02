/**
 * TypeScript 校验器 vs `docs/reference/task_protocol.py`：同一批输入，两边结论必须相同。
 *
 * 参考实现是 fail-fast 的（只回第一处错的原文），TS 侧是收集式的，所以核对方式是：
 * ① 合法/非法结论逐一相同；② 参考实现报的那句话，必须逐字出现在 TS 的诊断集合里；
 * ③ 合法样例上，合并后的 limits 也要相同。
 * python3 不在时退化：同一批语料按内建期望值核对（见 task-protocol.test.ts 的同名断言）。
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import { validateTask, type TaskValidationResult } from '../src/task-protocol';
import { TASK_CASES } from './fixtures/task-cases';

interface ReferenceResult {
	readonly ok: boolean;
	readonly message: string | null;
	readonly error_type: string | null;
	readonly limits: Record<string, unknown> | null;
}

const TEST_DIR = fileURLToPath(new URL('.', import.meta.url));
const REPO_ROOT = join(TEST_DIR, '..', '..', '..');
const PROTOCOL_PATH = join(REPO_ROOT, 'docs', 'reference', 'task_protocol.py');
const RUNNER_PATH = join(TEST_DIR, 'helpers', 'reference-runner.py');

const pythonProbe = spawnSync('python3', ['--version'], { encoding: 'utf8' });
const pythonAvailable = pythonProbe.status === 0;
const pythonVersion = `${pythonProbe.stdout ?? ''}${pythonProbe.stderr ?? ''}`.trim() || 'unknown';

const runReference = (): ReferenceResult[] => {
	const directory = mkdtempSync(join(tmpdir(), 'codecanvas-parity-'));
	const corpusPath = join(directory, 'task-cases.json');
	const corpus = TASK_CASES.map((testCase) => ({
		name: testCase.name,
		task: testCase.task,
		seen_task_ids: testCase.seenTaskIds ?? [],
	}));
	writeFileSync(corpusPath, JSON.stringify(corpus), 'utf8');

	const run = spawnSync('python3', [RUNNER_PATH, corpusPath, PROTOCOL_PATH], { encoding: 'utf8' });
	if (run.status !== 0) {
		throw new Error(`reference runner failed (status ${run.status}): ${run.stderr}`);
	}
	return JSON.parse(run.stdout) as ReferenceResult[];
};

const runCase = (index: number): TaskValidationResult => {
	const testCase = TASK_CASES[index];
	if (testCase === undefined) throw new Error(`no case at ${index}`);
	return validateTask(testCase.task, testCase.seenTaskIds === undefined ? {} : { seenTaskIds: testCase.seenTaskIds });
};

describe('退化路径（python3 不可用时也成立）', () => {
	it('语料自带的期望值全部满足', () => {
		for (const testCase of TASK_CASES) {
			const result = validateTask(
				testCase.task,
				testCase.seenTaskIds === undefined ? {} : { seenTaskIds: testCase.seenTaskIds },
			);
			expect(result.ok, `${testCase.name}: ${result.diagnostics.map((d) => d.code).join(',')}`).toBe(
				testCase.expectation === 'valid',
			);
		}
	});
});

if (!pythonAvailable) {
	it('python3 不可用——对照测试跳过', () => {
		expect(pythonAvailable).toBe(false);
	});
} else {
	describe(`与 task_protocol.py 逐条对照（${pythonVersion}）`, () => {
		let reference: ReferenceResult[] = [];

		beforeAll(() => {
			reference = runReference();
		});

		it('语料条数与参考结果条数一致', () => {
			expect(reference).toHaveLength(TASK_CASES.length);
		});

		for (const [index, testCase] of TASK_CASES.entries()) {
			it(`${testCase.expectation === 'valid' ? '接受' : '拒绝'}一致：${testCase.name}`, () => {
				const expected = reference[index];
				expect(expected, `缺第 ${index} 条参考结论`).toBeDefined();
				if (expected === undefined) return;

				const result = runCase(index);
				const crashed = expected.error_type !== null && expected.error_type !== 'TaskValidationError';

				// 结论必须相同（参考实现崩溃时，两边都拒即可）。
				expect(result.ok, `TS=${result.ok} python=${expected.ok} / python 报：${expected.message}`).toBe(expected.ok);

				if (!expected.ok && !crashed && expected.message !== null) {
					expect(result.diagnostics.map((diagnostic) => diagnostic.message)).toContain(expected.message);
				}
				if (expected.ok && result.ok && expected.limits !== null) {
					expect(result.task.limits).toEqual(expected.limits);
				}
			});
		}
	});
}
