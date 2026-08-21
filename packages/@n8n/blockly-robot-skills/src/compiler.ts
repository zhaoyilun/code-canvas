/** Grammar + compiler: Blockly robot workspace → structured RobotTaskPlan.
 *
 * Same safety model as blockly-data-transform v1: whitelist grammar, single
 * root, full reachability, size/depth limits, dangerous-key rejection, and
 * "the workspace is the only source of truth" (the payload plan field is a
 * read-only preview the runtime never trusts).
 */

import type { CatalogSkillEntry, JsonRecord, RobotCatalog } from './catalog';
import {
	DEFAULT_SKILL_TIMEOUT_SEC,
	MOTION_DIRECTIONS,
	TASK_BUDGET_SEC,
	containsDangerousKey,
	isDangerousSegment,
	isJsonRecord,
	validateParamsAgainstSchema,
} from './catalog';

export type SkipIfGuard = {
	field: 'last.success' | 'last.state';
	op: '==' | '!=';
	value: string | boolean | number;
};

export type SkillStep = {
	step: 'skill';
	skill: string;
	params?: JsonRecord;
	timeoutSec?: number;
	skipIf?: SkipIfGuard;
};

export type PrimitiveStep = {
	step: 'primitive';
	primitive: string;
	params?: JsonRecord;
	timeoutSec?: number;
	skipIf?: SkipIfGuard;
};

export type WaitStep = { step: 'wait'; seconds: number };

export type PlanStep = SkillStep | PrimitiveStep | WaitStep;

export type RobotTaskPlan = {
	schemaVersion: 1;
	robot: string;
	configDigest: string;
	plan: PlanStep[];
};

export type RobotCompileResult =
	| { ok: true; plan: RobotTaskPlan; blockCount: number }
	| { ok: false; error: string };

export const MAX_BLOCKS = 200;
export const MAX_PLAN_STEPS = 100;
export const MAX_DEPTH = 40;
export const MAX_TEXT_LENGTH = 1000;
export const MAX_WAIT_SECONDS = 60;
export const MAX_TIMEOUT_SEC = 600;
export const MAX_PARAM_JSON_BYTES = 16 * 1024;

const STATEMENT_TYPES = new Set([
	'robot_execute_skill',
	'robot_execute_primitive',
	'robot_wait',
	'robot_gripper',
	'robot_condition',
]);

const GRIPPER_SKILLS: Record<string, string | undefined> = {
	open: 'open_gripper_skill',
	close: 'close_gripper_skill',
};

const GRIPPER_PRIMITIVES: Record<string, string | undefined> = {
	rotate_cw: 'rotate_gripper_cw',
	rotate_ccw: 'rotate_gripper_ccw',
};

const GUARD_FIELDS = ['last.success', 'last.state'] as const;
const GUARD_OPS = ['==', '!='] as const;

type Block = JsonRecord & { type: string };

function isBlock(value: unknown): value is Block {
	return isJsonRecord(value) && typeof value.type === 'string';
}

export function compileRobotWorkspace(
	workspace: unknown,
	catalog: RobotCatalog,
): RobotCompileResult {
	const fail = (error: string): RobotCompileResult => ({ ok: false, error });

	if (!isJsonRecord(workspace) || !isJsonRecord(workspace.blocks))
		return fail('workspace is malformed');
	const rawRoots: unknown[] = Array.isArray(workspace.blocks.blocks) ? workspace.blocks.blocks : [];
	if (rawRoots.length === 0) return fail('workspace has no root block');
	if (rawRoots.length > 1) return fail('workspace must contain exactly one root block');
	const root = rawRoots[0];
	if (!isBlock(root)) return fail('root block is malformed');
	if (root.type !== 'robot_task_plan') return fail(`unexpected root block "${root.type}"`);

	const plan: PlanStep[] = [];
	let blockCount = 0;

	const statementRoot = inputBlock(root, 'DO');
	if (statementRoot !== null) {
		const walkError = walkChain(statementRoot, 0, undefined);
		if (walkError !== null) return fail(walkError);
	}

	const budgetError = planBudgetError(plan);
	if (budgetError !== null) return fail(budgetError);

	return {
		ok: true,
		plan: {
			schemaVersion: 1,
			robot: catalog.robotName,
			configDigest: catalog.configDigest,
			plan,
		},
		blockCount,
	};

	function walkChain(block: Block, depth: number, guard: SkipIfGuard | undefined): string | null {
		if (depth > MAX_DEPTH) return `block chain exceeds depth ${MAX_DEPTH}`;
		if (++blockCount > MAX_BLOCKS) return `workspace exceeds ${MAX_BLOCKS} blocks`;
		if (!STATEMENT_TYPES.has(block.type)) return `unsupported block "${block.type}"`;

		if (block.type === 'robot_condition') {
			if (guard !== undefined) return 'consecutive robot_condition blocks are not supported';
			const parsed = parseGuard(block);
			if (typeof parsed === 'string') return parsed;
			const next = nextBlock(block);
			if (!next || next.type === 'robot_condition') {
				return 'robot_condition must guard a following action block';
			}
			return walkChain(next, depth + 1, parsed);
		}

		const compiled = compileAction(block, catalog);
		if (typeof compiled === 'string') return compiled;
		if (guard !== undefined) {
			if (compiled.step.step === 'wait') return 'robot_condition cannot guard a wait step';
			compiled.step.skipIf = guard;
		}
		plan.push(compiled.step);

		const next = nextBlock(block);
		return next === null ? null : walkChain(next, depth + 1, undefined);
	}
}

function parseGuard(block: Block): SkipIfGuard | string {
	const field = fieldValue(block, 'FIELD');
	if (typeof field !== 'string' || !(GUARD_FIELDS as readonly string[]).includes(field)) {
		return 'robot_condition has an invalid field';
	}
	const op = fieldValue(block, 'OP');
	if (typeof op !== 'string' || !(GUARD_OPS as readonly string[]).includes(op)) {
		return 'robot_condition has an invalid operator';
	}
	const raw = inputValue(block, 'VALUE');
	if (raw === null) return 'robot_condition is missing a value';
	let value: string | boolean | number;
	if (field === 'last.success') {
		if (raw === 'true') value = true;
		else if (raw === 'false') value = false;
		else if (typeof raw === 'boolean') value = raw;
		else return 'last.success must compare against true or false';
	} else {
		value = raw;
	}
	return { field: field as SkipIfGuard['field'], op: op as SkipIfGuard['op'], value };
}

function compileAction(
	block: Block,
	catalog: RobotCatalog,
): { step: SkillStep | PrimitiveStep | WaitStep } | string {
	switch (block.type) {
		case 'robot_execute_skill':
			return compileSkillOrPrimitive(block, catalog, 'skill');
		case 'robot_execute_primitive':
			return compileSkillOrPrimitive(block, catalog, 'primitive');
		case 'robot_wait':
			return compileWait(block);
		case 'robot_gripper':
			return compileGripper(block, catalog);
		default:
			return `unsupported block "${block.type}"`;
	}
}

function compileSkillOrPrimitive(
	block: Block,
	catalog: RobotCatalog,
	kind: 'skill' | 'primitive',
): { step: SkillStep | PrimitiveStep } | string {
	const name = fieldValue(block, kind === 'skill' ? 'SKILL' : 'PRIMITIVE');
	if (typeof name !== 'string' || name === '') return `${block.type} is missing its ${kind} field`;
	if (isDangerousSegment(name)) return `${kind} name "${name}" is not allowed`;

	if (kind === 'skill' && !findSkill(catalog, name)) return `unknown skill "${name}"`;
	if (kind === 'primitive' && !catalog.primitives.includes(name)) {
		return `unknown primitive "${name}"`;
	}

	const params = collectParams(block);
	if (typeof params === 'string') return params;

	const timeout = collectTimeout(block);
	if (typeof timeout === 'string') return timeout;

	if (kind === 'skill') {
		const skill = findSkill(catalog, name);
		const schemaError = validateParamsAgainstSchema(skill?.parameters, params.value);
		if (schemaError !== null) return schemaError;
	}

	const timeoutSec =
		timeout.value ?? (kind === 'skill' ? findSkill(catalog, name)?.timeoutSec : undefined);
	const step: SkillStep | PrimitiveStep =
		kind === 'skill' ? { step: 'skill', skill: name } : { step: 'primitive', primitive: name };
	if (Object.keys(params.value).length > 0) step.params = params.value;
	if (timeoutSec !== undefined) step.timeoutSec = timeoutSec;
	return { step };
}

function collectParams(block: Block): { value: JsonRecord } | string {
	const params: JsonRecord = {};
	const target = inputValue(block, 'TARGET');
	if (target !== null) params.target_name = target;
	const place = inputValue(block, 'PLACE');
	if (place !== null) params.place_name = place;
	const direction = fieldValue(block, 'DIRECTION');
	if (typeof direction === 'string' && direction !== '') {
		if (!(MOTION_DIRECTIONS as readonly string[]).includes(direction)) {
			return `invalid motion direction "${direction}"`;
		}
		params.motion_direction = direction;
	}
	const distance = inputValue(block, 'DISTANCE');
	if (distance !== null) params.motion_distance = distance;

	const extraJson = fieldValue(block, 'PARAMS_JSON');
	if (typeof extraJson === 'string' && extraJson.trim() !== '') {
		if (extraJson.length > MAX_PARAM_JSON_BYTES) return 'PARAMS_JSON is too large';
		let parsed: unknown;
		try {
			parsed = JSON.parse(extraJson);
		} catch {
			return 'PARAMS_JSON is not valid JSON';
		}
		if (!isJsonRecord(parsed)) return 'PARAMS_JSON must be a JSON object';
		for (const [key, value] of Object.entries(parsed)) {
			if (isDangerousSegment(key)) return `parameter key "${key}" is not allowed`;
			params[key] = value;
		}
	}

	if (Object.keys(params).length > 0 && containsDangerousKey(params)) {
		return 'parameter values contain a forbidden key';
	}
	return { value: params };
}

function collectTimeout(block: Block): { value: number | undefined } | string {
	const raw = inputValue(block, 'TIMEOUT');
	if (raw === null) return { value: undefined };
	if (typeof raw !== 'number' || !Number.isFinite(raw) || raw <= 0) {
		return 'timeout must be a positive number';
	}
	if (raw > MAX_TIMEOUT_SEC) return `timeout exceeds ${MAX_TIMEOUT_SEC}s`;
	return { value: raw };
}

function compileWait(block: Block): { step: WaitStep } | string {
	const raw = inputValue(block, 'SECONDS');
	if (typeof raw !== 'number' || !Number.isFinite(raw) || raw <= 0) {
		return 'robot_wait needs a positive number of seconds';
	}
	if (raw > MAX_WAIT_SECONDS) return `robot_wait exceeds ${MAX_WAIT_SECONDS}s`;
	return { step: { step: 'wait', seconds: raw } };
}

function compileGripper(
	block: Block,
	catalog: RobotCatalog,
): { step: SkillStep | PrimitiveStep } | string {
	const action = fieldValue(block, 'ACTION');
	if (typeof action !== 'string' || action === '')
		return 'robot_gripper is missing its ACTION field';
	const skillName = GRIPPER_SKILLS[action];
	if (skillName !== undefined) {
		if (findSkill(catalog, skillName) !== undefined)
			return { step: { step: 'skill', skill: skillName } };
		return {
			step: { step: 'primitive', primitive: action === 'open' ? 'open_gripper' : 'close_gripper' },
		};
	}
	const primitiveName = GRIPPER_PRIMITIVES[action];
	if (primitiveName === undefined) return `invalid gripper action "${action}"`;
	return { step: { step: 'primitive', primitive: primitiveName } };
}

function findSkill(catalog: RobotCatalog, name: string): CatalogSkillEntry | undefined {
	return catalog.skills.find((skill) => skill.name === name);
}

/** Blockly serializes fields either as plain values or `{ id, name, value }`. */
function fieldValue(block: Block, name: string): unknown {
	const fields = block.fields;
	if (!isJsonRecord(fields)) return undefined;
	const entry = fields[name];
	if (isJsonRecord(entry) && typeof entry.value === 'string') return entry.value;
	return entry;
}

function inputBlock(block: Block, name: string): Block | null {
	const inputs = block.inputs;
	if (!isJsonRecord(inputs)) return null;
	const input = inputs[name];
	if (!isJsonRecord(input)) return null;
	const child = input.block;
	if (!isJsonRecord(child) || typeof child.type !== 'string') return null;
	return child as Block;
}

function inputValue(block: Block, name: string): string | number | null {
	const child = inputBlock(block, name);
	if (child === null) return null;
	if (child.type === 'text') {
		const value = fieldValue(child, 'TEXT');
		if (typeof value !== 'string' || value.length > MAX_TEXT_LENGTH) return null;
		return value;
	}
	if (child.type === 'math_number') {
		const value = fieldValue(child, 'NUM');
		if (typeof value === 'number' && Number.isFinite(value)) return value;
		return null;
	}
	return null;
}

function nextBlock(block: Block): Block | null {
	const next = block.next;
	if (!isJsonRecord(next)) return null;
	const child = next.block;
	if (!isJsonRecord(child) || typeof child.type !== 'string') return null;
	return child as Block;
}

/** Total plan budget must stay within task_budget_sec (design §7.4). */
export function planBudgetError(plan: PlanStep[]): string | null {
	if (plan.length > MAX_PLAN_STEPS) return `plan exceeds ${MAX_PLAN_STEPS} steps`;
	let budget = 0;
	for (const step of plan) {
		if (step.step === 'wait') budget += step.seconds;
		else budget += step.timeoutSec ?? DEFAULT_SKILL_TIMEOUT_SEC;
	}
	if (budget > TASK_BUDGET_SEC) {
		return `plan total budget ${budget}s exceeds task_budget_sec ${TASK_BUDGET_SEC}s`;
	}
	return null;
}
