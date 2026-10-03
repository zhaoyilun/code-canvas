/**
 * 我们编出来的请求 vs **bridge 自己的 pydantic 模型**：同一批载荷，两边结论必须相同。
 *
 * 三层核对：
 * ① 编译产出的每一条 execute 请求，交给 `docs/reference/bridge_models.py`（那份文件是从上游原样抄来的）
 *    用 pydantic 逐个 validate ——**全过**；同时我们的 zod 镜像也过，且逐字段值相同；
 * ② 响应侧的十一个类各来一份样例（只给必填栏，缺省值由两边各自填）：pydantic 的 `model_dump()`
 *    必须与 zod parse 的结果**逐字相同**——字段名写错、缺省值漏一个，都在这里露出来；
 * ③ 约束对账：`task_id` 1..128、`timeout_sec > 0` 这几条，两边**同接受同拒绝**（含「多给的键不报错」
 *    这一条：pydantic 缺省是 `extra='ignore'`，所以我们的镜像也不许 `.strict()`）。
 *
 * 骨架照 `packages/contracts/test/parity.test.ts`（那条既有做法）：探测解释器 → 不可用就可见地跳过
 * → 可用就把语料写进临时文件、起子进程、读 JSON 结论。
 *
 * **pydantic 不是每台机器都有**（本机系统 `python3` 没有；桥的 venv 里有）。所以解释器可指定：
 * 环境变量 `BRIDGE_PYTHON`，不给就用 `python3`。跳过会打印为什么——跳过不算过。
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import type { ZodType } from 'zod';
import {
	SKILL_PLAN_SCHEMA_VERSION,
	type SkillPlan,
	type SkillPlanStep,
} from '@codecanvas/contracts';
import { ROBOFRAME_SO101_CATALOG } from '@codecanvas/capabilities';
import {
	BRIDGE_PLAN_DIAGNOSTIC_CODES,
	cancelResultSchema,
	catalogSchema,
	catalogSkillSchema,
	compilePlanToCalls,
	executeAcceptedSchema,
	executeRequestSchema,
	gatewayStatusSchema,
	healthSchema,
	poseCatalogSchema,
	taskResultSchema,
	validateRequestSchema,
	validateResultSchema,
	type CompiledPlan,
} from '../src/index';

// ---------------------------------------------------------------------------
// 解释器与脚本位置
// ---------------------------------------------------------------------------

const TEST_DIR = fileURLToPath(new URL('.', import.meta.url));
const REPO_ROOT = join(TEST_DIR, '..', '..', '..');
const MODELS_PATH = join(REPO_ROOT, 'docs', 'reference', 'bridge_models.py');
const CHECKER_PATH = join(TEST_DIR, 'helpers', 'bridge-model-check.py');

const INTERPRETER = (process.env['BRIDGE_PYTHON'] ?? '').trim() || 'python3';

const probe = spawnSync(INTERPRETER, ['-c', 'import pydantic; print(pydantic.VERSION)'], { encoding: 'utf8' });
const pydanticVersion = (probe.stdout ?? '').trim();
const pydanticAvailable = probe.status === 0 && pydanticVersion !== '';
const probeNote =
	(probe.stderr ?? '').trim() || `exit ${String(probe.status)}`;

if (!pydanticAvailable) {
	console.warn(
		`[model-parity] 跳过与 pydantic 的对账：解释器「${INTERPRETER}」import 不到 pydantic（${probeNote}）。` +
			'要真跑这一层，用桥那个 venv：BRIDGE_PYTHON=/Volumes/MySSD/zhaoyilun/dev/n8n-blockly/services/roboframe-bridge/.venv/bin/python pnpm --filter @codecanvas/robot-bridge test',
	);
}

// ---------------------------------------------------------------------------
// 语料：一份真目录上的计划（含分支 / 等待 / 原语 / 不存在的技能）
// ---------------------------------------------------------------------------

const DEVICE = 'so101_single_arm';

const PLAN_WITH_GAPS: SkillPlan = {
	schemaVersion: SKILL_PLAN_SCHEMA_VERSION,
	robot: DEVICE,
	plan: [
		{ step: 'skill', skill: 'inspect_scene' },
		{
			step: 'skill',
			skill: 'move_relative_ee',
			params: { motion_direction: 'forward', motion_distance: 0.03 },
			timeoutSec: 10,
		},
		{
			step: 'if',
			condition: { field: 'last.success', op: '==', value: false },
			then: [{ step: 'skill', skill: 'wave_hello' }],
			else: [
				{ step: 'wait', seconds: 2 },
				// 目录里**有**这个原语（`catalog.primitives` 里），但 bridge 接不了它——这正是要报出来的缺口
				{ step: 'primitive', primitive: 'open_gripper' },
			],
		},
		{ step: 'primitive', primitive: 'close_gripper' },
		{ step: 'skill', skill: 'not_a_skill' },
		{ step: 'wait', seconds: 0.5 },
	] satisfies readonly SkillPlanStep[],
};

const COMPILED: CompiledPlan = compilePlanToCalls(PLAN_WITH_GAPS, {
	catalog: ROBOFRAME_SO101_CATALOG,
	deviceRef: DEVICE,
});

/** 编译出来的每一条 execute：**这些才是要送去 bridge 的东西**。 */
const REQUESTS = COMPILED.calls.flatMap((call) =>
	call.kind === 'execute' ? [{ stepPath: call.stepPath, request: call.request }] : [],
);

// ---------------------------------------------------------------------------
// 语料：响应侧十一个类各一份（只给必填栏，缺省值交给两边各自填）
// ---------------------------------------------------------------------------

interface ModelCase {
	readonly model: string;
	readonly payload: Record<string, unknown>;
}

const ZOD_OF: Readonly<Record<string, ZodType>> = {
	CatalogSkill: catalogSkillSchema,
	Catalog: catalogSchema,
	PoseCatalog: poseCatalogSchema,
	GatewayStatus: gatewayStatusSchema,
	ValidateRequest: validateRequestSchema,
	ValidateResult: validateResultSchema,
	ExecuteRequest: executeRequestSchema,
	ExecuteAccepted: executeAcceptedSchema,
	TaskResult: taskResultSchema,
	CancelResult: cancelResultSchema,
	Health: healthSchema,
};

const SHAPE_CASES: readonly ModelCase[] = [
	{ model: 'CatalogSkill', payload: { name: 'wave_hello' } },
	{ model: 'Catalog', payload: { robot_name: DEVICE, config_digest: 'sha256:abc', skills: [{ name: 'wave_hello' }] } },
	{ model: 'PoseCatalog', payload: { robot_name: DEVICE, config_digest: 'sha256:abc', poses: ['home'] } },
	{ model: 'GatewayStatus', payload: { motion_authorized: true, busy: false } },
	{ model: 'ValidateRequest', payload: { skill: 'wave_hello' } },
	{ model: 'ValidateResult', payload: { valid: true, error_code: '', message: '' } },
	// 显式给 `timeout_sec`：不给的话 pydantic 落成 `None`、我们的 zod 落成「没有这个键」，
	// 那是同一件事的两种写法（JSON 里都不出现），但逐字比较会显出差别——这一条在下面单独钉。
	{ model: 'ExecuteRequest', payload: { task_id: 'task-1', skill: 'wave_hello', timeout_sec: 5 } },
	{ model: 'ExecuteAccepted', payload: { task_id: 'task-1', skill: 'wave_hello' } },
	{ model: 'TaskResult', payload: { task_id: 'task-1', skill: 'wave_hello', state: 'completed', success: true } },
	{ model: 'CancelResult', payload: { task_id: 'task-1', requested: true, state: 'canceled' } },
	{ model: 'Health', payload: { version: '0.1.0' } },
];

/** 约束对账：这些必须**两边都拒**（`expected: false`），最后一条是「两边都收」。 */
const CONSTRAINT_CASES: readonly (ModelCase & { readonly expected: boolean; readonly why: string })[] = [
	{ model: 'ExecuteRequest', payload: { task_id: '', skill: 'x' }, expected: false, why: 'task_id 空' },
	{ model: 'ExecuteRequest', payload: { task_id: 'a'.repeat(129), skill: 'x' }, expected: false, why: 'task_id 129 字符' },
	{ model: 'ExecuteRequest', payload: { task_id: 'a'.repeat(128), skill: 'x' }, expected: true, why: 'task_id 128 字符（正好到上限）' },
	{ model: 'ExecuteRequest', payload: { task_id: 'ok', skill: 'x', timeout_sec: 0 }, expected: false, why: 'timeout_sec = 0' },
	{ model: 'ExecuteRequest', payload: { task_id: 'ok', skill: 'x', timeout_sec: -1 }, expected: false, why: 'timeout_sec < 0' },
	{ model: 'ExecuteRequest', payload: { task_id: 'ok', skill: 'x', timeout_sec: 1 }, expected: true, why: 'timeout_sec > 0' },
	{
		model: 'ExecuteRequest',
		payload: { task_id: 'ok', skill: 'x', unexpected_field: 1 },
		expected: true,
		why: '多给的键不报错（pydantic 缺省 extra=ignore，所以镜像也不许 strict）',
	},
];

// ---------------------------------------------------------------------------
// 跑子进程
// ---------------------------------------------------------------------------

interface CheckResult {
	readonly model: string;
	readonly ok: boolean;
	readonly error_type: string | null;
	readonly error: string | null;
	readonly dump: Record<string, unknown> | null;
}

const runChecker = (cases: readonly ModelCase[]): CheckResult[] => {
	const directory = mkdtempSync(join(tmpdir(), 'codecanvas-bridge-parity-'));
	const casesPath = join(directory, 'cases.json');
	writeFileSync(casesPath, JSON.stringify(cases), 'utf8');

	const run = spawnSync(INTERPRETER, [CHECKER_PATH, casesPath, MODELS_PATH], { encoding: 'utf8' });
	if (run.status !== 0) {
		throw new Error(`bridge-model-check.py failed (status ${String(run.status)}): ${run.stderr ?? ''}`);
	}
	return JSON.parse(run.stdout) as CheckResult[];
};

/** 逐字比较用：`undefined` 的键在 JSON 里本来就不出现，两边先过一遍同一道归一化。 */
const normalize = (value: unknown): unknown => JSON.parse(JSON.stringify(value)) as unknown;

// ---------------------------------------------------------------------------
// 退化路径：pydantic 不在也成立的那些（编译本身就该对，与解释器无关）
// ---------------------------------------------------------------------------

describe('退化路径（pydantic 不可用时也成立）', () => {
	it('能送的三条技能步编出三条请求，其余三种步一条都不多', () => {
		expect(REQUESTS.map((item) => item.stepPath)).toEqual(['0', '1', '2.then.0']);
		expect(REQUESTS.map((item) => item.request.skill)).toEqual(['inspect_scene', 'move_relative_ee', 'wave_hello']);
	});

	it('原语步一条请求都没有（两条原语步都没有），诊断说到那一格上', () => {
		const primitivePaths = COMPILED.diagnostics
			.filter((item) => item.code === BRIDGE_PLAN_DIAGNOSTIC_CODES.primitiveUnsupported)
			.map((item) => item.details?.['stepPath']);
		expect(primitivePaths).toEqual(['2.else.1', '3']);
		for (const stepPath of primitivePaths) {
			expect(COMPILED.calls.filter((call) => call.stepPath === stepPath)).toEqual([]);
		}
	});

	it('目录里没有的技能也不发（第 4 步），诊断说到那一格上', () => {
		const unknown = COMPILED.diagnostics.find((item) => item.code === BRIDGE_PLAN_DIAGNOSTIC_CODES.skillUnknown);
		expect(unknown?.details?.['stepPath']).toBe('4');
		expect(COMPILED.calls.filter((call) => call.stepPath === '4')).toEqual([]);
	});
});

// ---------------------------------------------------------------------------
// 与 pydantic 逐条对照
// ---------------------------------------------------------------------------

describe.skipIf(!pydanticAvailable)(`与 bridge 的 pydantic 模型逐条对照（${INTERPRETER} / pydantic ${pydanticVersion}）`, () => {
	let requestResults: CheckResult[] = [];
	let shapeResults: CheckResult[] = [];
	let constraintResults: CheckResult[] = [];

	beforeAll(() => {
		requestResults = runChecker(REQUESTS.map((item) => ({ model: 'ExecuteRequest', payload: item.request })));
		shapeResults = runChecker(SHAPE_CASES);
		constraintResults = runChecker(CONSTRAINT_CASES);
	});

	it('判据来自上游：那份 models.py 真的在、真能 import', () => {
		expect(existsSync(MODELS_PATH), MODELS_PATH).toBe(true);
		expect(existsSync(CHECKER_PATH), CHECKER_PATH).toBe(true);
		expect(pydanticVersion).toMatch(/^2\./);
	});

	it('编出来的每一条 execute 请求，pydantic 全过', () => {
		expect(requestResults).toHaveLength(REQUESTS.length);
		for (const [index, result] of requestResults.entries()) {
			const item = REQUESTS[index];
			expect(result.ok, `${item?.stepPath ?? '?'} 被 bridge 的 ExecuteRequest 拒了：${result.error ?? ''}`).toBe(true);
		}
	});

	it('同一条请求，我们这边（zod 镜像）也过，且逐字段值相同', () => {
		for (const [index, item] of REQUESTS.entries()) {
			const parsed = executeRequestSchema.safeParse(item.request);
			expect(parsed.success, item.stepPath).toBe(true);
			const dump = requestResults[index]?.dump;
			expect(dump, item.stepPath).not.toBeNull();
			// 我们给的每一栏，bridge 那边读到的必须是同一个值（改名/改型都会在这儿露出来）
			for (const [key, value] of Object.entries(item.request)) {
				expect(dump?.[key], `${item.stepPath}.${key}`).toEqual(value);
			}
			// 反方向：bridge 认的字段就是这四栏，没有我们没写到的
			expect(Object.keys(dump ?? {}).sort()).toEqual(['params', 'skill', 'task_id', 'timeout_sec']);
		}
	});

	it('十一个类各有一份样例（一个都不漏）', () => {
		expect(SHAPE_CASES.map((item) => item.model).sort()).toEqual(Object.keys(ZOD_OF).sort());
	});

	it('响应侧的类：两边同接受，且缺省值逐字相同', () => {
		for (const [index, testCase] of SHAPE_CASES.entries()) {
			const result = shapeResults[index];
			expect(result?.ok, `${testCase.model} 被 pydantic 拒了：${result?.error ?? ''}`).toBe(true);
			const parsed = ZOD_OF[testCase.model]?.safeParse(testCase.payload);
			expect(parsed?.success, testCase.model).toBe(true);
			// pydantic 填好的缺省值 vs zod 填好的缺省值：字段名、缺省值、嵌套形状必须一模一样
			expect(normalize(parsed?.data), testCase.model).toEqual(result?.dump);
		}
	});

	it('约束两边同接受同拒绝（task_id 1..128 / timeout_sec > 0 / 多给的键不报错）', () => {
		for (const [index, testCase] of CONSTRAINT_CASES.entries()) {
			const result = constraintResults[index];
			expect(result?.ok, `pydantic 的结论与预期不符（${testCase.why}）：${result?.error ?? ''}`).toBe(
				testCase.expected,
			);
			const parsed = ZOD_OF[testCase.model]?.safeParse(testCase.payload);
			expect(parsed?.success, `zod 的结论与预期不符（${testCase.why}）`).toBe(testCase.expected);
		}
	});

	it('`timeout_sec` 不给时两边都是「没有这一栏」（pydantic None / zod undefined），不是两种形状', () => {
		const [result] = runChecker([{ model: 'ExecuteRequest', payload: { task_id: 'ok', skill: 'x' } }]);
		expect(result?.ok).toBe(true);
		expect(result?.dump?.['timeout_sec']).toBeNull();
		const parsed = executeRequestSchema.parse({ task_id: 'ok', skill: 'x' });
		expect(parsed.timeout_sec ?? null).toBeNull();
	});
});

// 不可用时这一条**看得见地跑**：把「为什么跳过」摆在报告里（跳过不算过）
it.skipIf(pydanticAvailable)('pydantic 不可用——与 bridge 模型的对账跳过了（原因见上面的告警）', () => {
	expect(pydanticAvailable).toBe(false);
	expect(INTERPRETER.length).toBeGreaterThan(0);
});
