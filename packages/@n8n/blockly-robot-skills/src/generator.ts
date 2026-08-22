/** Deterministic RobotPlanDraft → Blockly workspace generation.
 *
 * The draft is a constrained semantic input. This module alone constructs the
 * Blockly JSON, then recompiles it with the runtime compiler and verifies the
 * normalized plan before returning a result.
 */

import type {
	CatalogPrimitiveEntry,
	CatalogSkillEntry,
	JsonRecord,
	RobotCatalog,
	SkillParamSchema,
} from './catalog';
import {
	DEFAULT_SKILL_TIMEOUT_SEC,
	MOTION_DIRECTIONS,
	TASK_BUDGET_SEC,
	containsDangerousKey,
	isDangerousSegment,
	isJsonRecord,
	parseRobotCatalog,
	validateParamsAgainstSchema,
} from './catalog';
import type { PlanStep, PrimitiveStep, RobotTaskPlan, SkillStep, SkipIfGuard } from './compiler';
import {
	MAX_PARAM_JSON_BYTES,
	MAX_DEPTH,
	MAX_PLAN_STEPS,
	MAX_TEXT_LENGTH,
	MAX_TIMEOUT_SEC,
	MAX_WAIT_SECONDS,
	compileRobotWorkspace,
	planBudgetError,
} from './compiler';

export const ROBOT_PLAN_DRAFT_SCHEMA_VERSION = 1;

export type RobotPlanDraftScalar = string | number | boolean;

export type RobotPlanDraftGuard = {
	field: 'last.success' | 'last.state';
	op: 'eq' | 'neq';
	value: string | boolean;
};

export type RobotPlanTeachingAnnotation = {
	what: string;
	why: string;
	editable: string[];
	expectedEffect: string;
};

export type RobotSkillStepDraft = {
	stepRef: string;
	kind: 'skill';
	name: string;
	params?: Record<string, RobotPlanDraftScalar>;
	timeoutSec?: number;
	when?: RobotPlanDraftGuard;
	teaching?: RobotPlanTeachingAnnotation;
};

export type RobotPrimitiveStepDraft = {
	stepRef: string;
	kind: 'primitive';
	name: string;
	params?: Record<string, RobotPlanDraftScalar>;
	timeoutSec?: number;
	when?: RobotPlanDraftGuard;
	teaching?: RobotPlanTeachingAnnotation;
};

export type RobotNamedPoseStepDraft = {
	stepRef: string;
	kind: 'namedPose';
	pose: string;
	timeoutSec?: number;
	when?: RobotPlanDraftGuard;
	teaching?: RobotPlanTeachingAnnotation;
};

export type RobotWaitStepDraft = {
	stepRef: string;
	kind: 'wait';
	durationMs: number;
	teaching?: RobotPlanTeachingAnnotation;
};

export type RobotStepDraft =
	| RobotSkillStepDraft
	| RobotPrimitiveStepDraft
	| RobotNamedPoseStepDraft
	| RobotWaitStepDraft;

export type RobotPlanDraft = {
	schemaVersion: typeof ROBOT_PLAN_DRAFT_SCHEMA_VERSION;
	planRef: string;
	label: string;
	robotProfileRef: string;
	catalogDigest: string;
	budgetSec: number;
	steps: RobotStepDraft[];
};

export type RobotPlanGenerationContext = {
	designId: string;
};

export type RobotPlanSourceMapEntry = {
	planRef: string;
	stepRef: string;
	blockId: string;
	planStepId: string;
	guardBlockId?: string;
	kind: 'skill' | 'primitive' | 'wait';
	capabilityName?: string;
};

export type RobotPlanGenerationErrorCode =
	| 'DRAFT_MALFORMED'
	| 'DRAFT_SCHEMA_VERSION_UNSUPPORTED'
	| 'DESIGN_ID_INVALID'
	| 'PLAN_REF_INVALID'
	| 'ROBOT_PROFILE_MISMATCH'
	| 'CATALOG_DIGEST_MISMATCH'
	| 'CATALOG_INVALID'
	| 'EMPTY_PLAN'
	| 'TOO_MANY_STEPS'
	| 'STEP_MALFORMED'
	| 'STEP_REF_INVALID'
	| 'DUPLICATE_STEP_REF'
	| 'STEP_KIND_UNSUPPORTED'
	| 'SKILL_UNKNOWN'
	| 'PRIMITIVE_UNKNOWN'
	| 'NAMED_POSE_UNKNOWN'
	| 'PARAMS_INVALID'
	| 'TIMEOUT_INVALID'
	| 'WAIT_INVALID'
	| 'GUARD_INVALID'
	| 'TEACHING_INVALID'
	| 'PLAN_BUDGET_EXCEEDED'
	| 'ID_COLLISION'
	| 'WORKSPACE_COMPILE_FAILED'
	| 'SEMANTIC_MISMATCH';

export type RobotPlanGenerationError = {
	code: RobotPlanGenerationErrorCode;
	path: string;
	message: string;
};

export type RobotPlanGenerationResult =
	| {
			ok: true;
			workspace: Record<string, unknown>;
			plan: RobotTaskPlan;
			normalizedDraft: RobotPlanDraft;
			sourceMap: RobotPlanSourceMapEntry[];
	  }
	| { ok: false; error: RobotPlanGenerationError };

type GenerationFailure = { ok: false; error: RobotPlanGenerationError };

type NormalizedStep = {
	draft: RobotStepDraft;
	planStep: PlanStep;
	blockId: string;
	guardBlockId?: string;
};

type BlocklyBlock = JsonRecord & { type: string; id: string };

const REFERENCE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

const DRAFT_KEYS = new Set([
	'schemaVersion',
	'planRef',
	'label',
	'robotProfileRef',
	'catalogDigest',
	'budgetSec',
	'steps',
]);
const ACTION_STEP_KEYS = new Set([
	'stepRef',
	'kind',
	'name',
	'params',
	'timeoutSec',
	'when',
	'teaching',
]);
const NAMED_POSE_STEP_KEYS = new Set(['stepRef', 'kind', 'pose', 'timeoutSec', 'when', 'teaching']);
const WAIT_STEP_KEYS = new Set(['stepRef', 'kind', 'durationMs', 'teaching']);
const GUARD_KEYS = new Set(['field', 'op', 'value']);
const TEACHING_KEYS = new Set(['what', 'why', 'editable', 'expectedEffect']);

/** Generate a loadable Blockly workspace from an AI-produced constrained draft. */
export function generateRobotPlanWorkspace(
	draftInput: unknown,
	catalog: RobotCatalog,
	context: RobotPlanGenerationContext,
): RobotPlanGenerationResult {
	const catalogResult = parseRobotCatalog(catalog);
	if (!catalogResult.ok) return failure('CATALOG_INVALID', 'catalog', catalogResult.error);
	const validatedCatalog = catalogResult.catalog;
	if (!isValidReference(context.designId)) {
		return failure(
			'DESIGN_ID_INVALID',
			'context.designId',
			'designId must be a stable 1-128 character reference',
		);
	}

	const draftResult = normalizeDraft(draftInput, validatedCatalog, context.designId);
	if (!draftResult.ok) return draftResult;
	const { draft, steps } = draftResult;
	const statementDepth = steps.reduce(
		(depth, step) => depth + 1 + (step.guardBlockId === undefined ? 0 : 1),
		0,
	);
	if (statementDepth > MAX_DEPTH) {
		return failure(
			'TOO_MANY_STEPS',
			'steps',
			`generated statement chain depth ${statementDepth} exceeds ${MAX_DEPTH}`,
		);
	}

	const budgetError = planBudgetError(steps.map((step) => step.planStep));
	if (budgetError !== null) return failure('PLAN_BUDGET_EXCEEDED', 'steps', budgetError);
	const budget = planBudgetSeconds(steps.map((step) => step.planStep));
	if (budget > draft.budgetSec) {
		return failure(
			'PLAN_BUDGET_EXCEEDED',
			'budgetSec',
			`plan total budget ${budget}s exceeds declared budgetSec ${draft.budgetSec}s`,
		);
	}

	const sourceMap = createSourceMap(draft.planRef, steps);
	const workspace = createWorkspace(context.designId, draft.planRef, steps);
	const compiled = compileRobotWorkspace(workspace, validatedCatalog);
	if (!compiled.ok) {
		return failure(
			'WORKSPACE_COMPILE_FAILED',
			'workspace',
			`generated workspace failed recompilation: ${compiled.error}`,
		);
	}

	const expectedPlan: RobotTaskPlan = {
		schemaVersion: 1,
		robot: validatedCatalog.robotName,
		configDigest: validatedCatalog.configDigest,
		plan: steps.map((step) => step.planStep),
	};
	if (canonicalJson(compiled.plan) !== canonicalJson(expectedPlan)) {
		return failure(
			'SEMANTIC_MISMATCH',
			'workspace',
			'generated workspace does not recompile to the normalized draft semantics',
		);
	}

	return {
		ok: true,
		workspace,
		plan: compiled.plan,
		normalizedDraft: draft,
		sourceMap,
	};
}

function normalizeDraft(
	value: unknown,
	catalog: RobotCatalog,
	designId: string,
): { ok: true; draft: RobotPlanDraft; steps: NormalizedStep[] } | GenerationFailure {
	if (!isJsonRecord(value)) return failure('DRAFT_MALFORMED', 'draft', 'draft must be an object');
	const unknownKey = firstUnknownKey(value, DRAFT_KEYS);
	if (unknownKey !== null) {
		return failure('DRAFT_MALFORMED', `draft.${unknownKey}`, `unknown draft field "${unknownKey}"`);
	}
	if (value.schemaVersion !== ROBOT_PLAN_DRAFT_SCHEMA_VERSION) {
		return failure(
			'DRAFT_SCHEMA_VERSION_UNSUPPORTED',
			'schemaVersion',
			`unsupported draft schemaVersion ${String(value.schemaVersion)}`,
		);
	}
	if (!isValidReference(value.planRef)) {
		return failure(
			'PLAN_REF_INVALID',
			'planRef',
			'planRef must be a stable 1-128 character reference',
		);
	}
	if (!isNonEmptyText(value.label)) {
		return failure('DRAFT_MALFORMED', 'label', 'label must be a non-empty string');
	}
	if (value.robotProfileRef !== catalog.robotName) {
		return failure(
			'ROBOT_PROFILE_MISMATCH',
			'robotProfileRef',
			`robotProfileRef must equal catalog robotName "${catalog.robotName}"`,
		);
	}
	if (value.catalogDigest !== catalog.configDigest) {
		return failure(
			'CATALOG_DIGEST_MISMATCH',
			'catalogDigest',
			`catalogDigest must equal "${catalog.configDigest}"`,
		);
	}
	if (!isPositiveFinite(value.budgetSec) || value.budgetSec > TASK_BUDGET_SEC) {
		return failure(
			'PLAN_BUDGET_EXCEEDED',
			'budgetSec',
			`budgetSec must be a positive number at most ${TASK_BUDGET_SEC}`,
		);
	}
	if (!Array.isArray(value.steps)) {
		return failure('DRAFT_MALFORMED', 'steps', 'steps must be an array');
	}
	if (value.steps.length === 0) {
		return failure('EMPTY_PLAN', 'steps', 'robot plan must contain at least one step');
	}
	if (value.steps.length > MAX_PLAN_STEPS) {
		return failure('TOO_MANY_STEPS', 'steps', `robot plan exceeds ${MAX_PLAN_STEPS} steps`);
	}

	const normalizedSteps: NormalizedStep[] = [];
	const stepRefs = new Set<string>();
	const blockIds = new Set<string>();
	for (const [index, stepInput] of value.steps.entries()) {
		const normalized = normalizeStep(
			stepInput,
			catalog,
			designId,
			value.planRef,
			index,
			stepRefs,
			blockIds,
		);
		if (!normalized.ok) return normalized;
		normalizedSteps.push(normalized.step);
	}

	const draft: RobotPlanDraft = {
		schemaVersion: ROBOT_PLAN_DRAFT_SCHEMA_VERSION,
		planRef: value.planRef,
		label: value.label,
		robotProfileRef: catalog.robotName,
		catalogDigest: catalog.configDigest,
		budgetSec: value.budgetSec,
		steps: normalizedSteps.map((step) => step.draft),
	};
	return { ok: true, draft, steps: normalizedSteps };
}

function normalizeStep(
	value: unknown,
	catalog: RobotCatalog,
	designId: string,
	planRef: string,
	index: number,
	stepRefs: Set<string>,
	blockIds: Set<string>,
): { ok: true; step: NormalizedStep } | GenerationFailure {
	const path = `steps[${index}]`;
	if (!isJsonRecord(value)) return failure('STEP_MALFORMED', path, 'step must be an object');
	if (!isValidReference(value.stepRef)) {
		return failure(
			'STEP_REF_INVALID',
			`${path}.stepRef`,
			'stepRef must be a stable 1-128 character reference',
		);
	}
	if (stepRefs.has(value.stepRef)) {
		return failure('DUPLICATE_STEP_REF', `${path}.stepRef`, `duplicate stepRef "${value.stepRef}"`);
	}
	stepRefs.add(value.stepRef);

	const blockId = stableBlockId(designId, planRef, value.stepRef);
	if (blockIds.has(blockId)) {
		return failure('ID_COLLISION', `${path}.stepRef`, `generated duplicate blockId "${blockId}"`);
	}
	blockIds.add(blockId);

	if (value.kind === 'skill') {
		return normalizeCapabilityStep(
			value,
			catalog,
			path,
			blockId,
			findSkill(catalog, value.name),
			'skill',
		);
	}
	if (value.kind === 'primitive') {
		return normalizeCapabilityStep(
			value,
			catalog,
			path,
			blockId,
			findPrimitive(catalog, value.name),
			'primitive',
		);
	}
	if (value.kind === 'namedPose') {
		return normalizeNamedPoseStep(value, catalog, path, blockId);
	}
	if (value.kind === 'wait') return normalizeWaitStep(value, path, blockId);
	return failure(
		'STEP_KIND_UNSUPPORTED',
		`${path}.kind`,
		`unsupported robot step kind "${String(value.kind)}"`,
	);
}

function normalizeCapabilityStep(
	value: JsonRecord,
	catalog: RobotCatalog,
	path: string,
	blockId: string,
	capability: CatalogSkillEntry | CatalogPrimitiveEntry | undefined,
	kind: 'skill' | 'primitive',
): { ok: true; step: NormalizedStep } | GenerationFailure {
	const unknownKey = firstUnknownKey(value, ACTION_STEP_KEYS);
	if (unknownKey !== null) {
		return failure('STEP_MALFORMED', `${path}.${unknownKey}`, `unknown step field "${unknownKey}"`);
	}
	if (!isNonEmptyText(value.name)) {
		return failure('STEP_MALFORMED', `${path}.name`, 'capability name must be a non-empty string');
	}
	if (!isValidReference(value.stepRef)) {
		return failure('STEP_REF_INVALID', `${path}.stepRef`, 'stepRef is invalid');
	}
	if (capability === undefined) {
		return failure(
			kind === 'skill' ? 'SKILL_UNKNOWN' : 'PRIMITIVE_UNKNOWN',
			`${path}.name`,
			`${kind} "${value.name}" is absent from the supplied catalog`,
		);
	}
	if (kind === 'primitive' && !catalog.primitives.includes(value.name)) {
		return failure(
			'PRIMITIVE_UNKNOWN',
			`${path}.name`,
			`primitive "${value.name}" is absent from the supplied catalog`,
		);
	}

	const paramsResult = normalizeParams(value.params, capability.parameters, `${path}.params`);
	if (!paramsResult.ok) return paramsResult;
	const timeoutResult = normalizeTimeout(value.timeoutSec, `${path}.timeoutSec`);
	if (!timeoutResult.ok) return timeoutResult;
	const guardResult = normalizeGuard(value.when, `${path}.when`, blockId);
	if (!guardResult.ok) return guardResult;
	const teachingResult = normalizeTeaching(value.teaching, `${path}.teaching`);
	if (!teachingResult.ok) return teachingResult;

	const timeoutSec = timeoutResult.value ?? capability.timeoutSec;
	const identity = { blockId, planStepId: `step:${blockId}` };
	const planStep: SkillStep | PrimitiveStep =
		kind === 'skill'
			? { step: 'skill', skill: value.name, ...identity }
			: { step: 'primitive', primitive: value.name, ...identity };
	if (Object.keys(paramsResult.params).length > 0) planStep.params = paramsResult.params;
	if (timeoutSec !== undefined) planStep.timeoutSec = timeoutSec;
	if (guardResult.skipIf !== undefined) planStep.skipIf = guardResult.skipIf;

	const draftBase = {
		stepRef: value.stepRef,
		params: paramsResult.params,
	};
	const draft: RobotSkillStepDraft | RobotPrimitiveStepDraft =
		kind === 'skill'
			? { ...draftBase, kind: 'skill', name: value.name }
			: { ...draftBase, kind: 'primitive', name: value.name };
	if (timeoutResult.value !== undefined) draft.timeoutSec = timeoutResult.value;
	if (guardResult.when !== undefined) draft.when = guardResult.when;
	if (teachingResult.teaching !== undefined) draft.teaching = teachingResult.teaching;

	const step: NormalizedStep = { draft, planStep, blockId };
	if (guardResult.guardBlockId !== undefined) step.guardBlockId = guardResult.guardBlockId;
	return { ok: true, step };
}

function normalizeNamedPoseStep(
	value: JsonRecord,
	catalog: RobotCatalog,
	path: string,
	blockId: string,
): { ok: true; step: NormalizedStep } | GenerationFailure {
	const unknownKey = firstUnknownKey(value, NAMED_POSE_STEP_KEYS);
	if (unknownKey !== null) {
		return failure('STEP_MALFORMED', `${path}.${unknownKey}`, `unknown step field "${unknownKey}"`);
	}
	if (!catalog.primitives.includes('move_to_named_pose')) {
		return failure(
			'PRIMITIVE_UNKNOWN',
			`${path}.kind`,
			'catalog does not expose the move_to_named_pose primitive',
		);
	}
	if (!isNonEmptyText(value.pose) || !catalog.namedPoses.includes(value.pose)) {
		return failure(
			'NAMED_POSE_UNKNOWN',
			`${path}.pose`,
			`named pose "${String(value.pose)}" is absent from the supplied catalog`,
		);
	}
	if (!isValidReference(value.stepRef)) {
		return failure('STEP_REF_INVALID', `${path}.stepRef`, 'stepRef is invalid');
	}
	const timeoutResult = normalizeTimeout(value.timeoutSec, `${path}.timeoutSec`);
	if (!timeoutResult.ok) return timeoutResult;
	const guardResult = normalizeGuard(value.when, `${path}.when`, blockId);
	if (!guardResult.ok) return guardResult;
	const teachingResult = normalizeTeaching(value.teaching, `${path}.teaching`);
	if (!teachingResult.ok) return teachingResult;

	const primitive = findPrimitive(catalog, 'move_to_named_pose');
	const timeoutSec = timeoutResult.value ?? primitive?.timeoutSec;
	const params: JsonRecord = { target_name: value.pose };
	const planStep: PrimitiveStep = {
		step: 'primitive',
		primitive: 'move_to_named_pose',
		params,
		blockId,
		planStepId: `step:${blockId}`,
	};
	if (timeoutSec !== undefined) planStep.timeoutSec = timeoutSec;
	if (guardResult.skipIf !== undefined) planStep.skipIf = guardResult.skipIf;

	const draft: RobotNamedPoseStepDraft = {
		stepRef: value.stepRef,
		kind: 'namedPose',
		pose: value.pose,
	};
	if (timeoutResult.value !== undefined) draft.timeoutSec = timeoutResult.value;
	if (guardResult.when !== undefined) draft.when = guardResult.when;
	if (teachingResult.teaching !== undefined) draft.teaching = teachingResult.teaching;
	const step: NormalizedStep = { draft, planStep, blockId };
	if (guardResult.guardBlockId !== undefined) step.guardBlockId = guardResult.guardBlockId;
	return { ok: true, step };
}

function normalizeWaitStep(
	value: JsonRecord,
	path: string,
	blockId: string,
): { ok: true; step: NormalizedStep } | GenerationFailure {
	const unknownKey = firstUnknownKey(value, WAIT_STEP_KEYS);
	if (unknownKey !== null) {
		return failure('STEP_MALFORMED', `${path}.${unknownKey}`, `unknown step field "${unknownKey}"`);
	}
	if (
		typeof value.durationMs !== 'number' ||
		!Number.isInteger(value.durationMs) ||
		value.durationMs <= 0 ||
		value.durationMs > MAX_WAIT_SECONDS * 1000
	) {
		return failure(
			'WAIT_INVALID',
			`${path}.durationMs`,
			`durationMs must be a positive integer at most ${MAX_WAIT_SECONDS * 1000}`,
		);
	}
	if (!isValidReference(value.stepRef)) {
		return failure('STEP_REF_INVALID', `${path}.stepRef`, 'stepRef is invalid');
	}
	const teachingResult = normalizeTeaching(value.teaching, `${path}.teaching`);
	if (!teachingResult.ok) return teachingResult;
	const draft: RobotWaitStepDraft = {
		stepRef: value.stepRef,
		kind: 'wait',
		durationMs: value.durationMs,
	};
	if (teachingResult.teaching !== undefined) draft.teaching = teachingResult.teaching;
	return {
		ok: true,
		step: {
			draft,
			planStep: {
				step: 'wait',
				seconds: value.durationMs / 1000,
				blockId,
				planStepId: `step:${blockId}`,
			},
			blockId,
		},
	};
}

function normalizeParams(
	value: unknown,
	schema: SkillParamSchema | undefined,
	path: string,
): { ok: true; params: Record<string, RobotPlanDraftScalar> } | GenerationFailure {
	if (value === undefined) {
		const schemaError = validateParamsAgainstSchema(schema, {});
		return schemaError === null
			? { ok: true, params: {} }
			: failure('PARAMS_INVALID', path, schemaError);
	}
	if (!isJsonRecord(value)) return failure('PARAMS_INVALID', path, 'params must be an object');
	if (containsDangerousKey(value)) {
		return failure('PARAMS_INVALID', path, 'params contain a forbidden key');
	}
	const declaredProperties = schema?.type === 'object' ? (schema.properties ?? {}) : null;
	const entries: Array<[string, RobotPlanDraftScalar]> = [];
	for (const [key, entry] of Object.entries(value)) {
		if (isDangerousSegment(key)) {
			return failure('PARAMS_INVALID', `${path}.${key}`, `parameter key "${key}" is not allowed`);
		}
		if (declaredProperties === null || !(key in declaredProperties)) {
			return failure(
				'PARAMS_INVALID',
				`${path}.${key}`,
				`parameter "${key}" is absent from the supplied catalog schema`,
			);
		}
		if (!isDraftScalar(entry)) {
			return failure(
				'PARAMS_INVALID',
				`${path}.${key}`,
				`parameter "${key}" must be a finite string, number, or boolean`,
			);
		}
		if (typeof entry === 'string' && entry.length > MAX_TEXT_LENGTH) {
			return failure(
				'PARAMS_INVALID',
				`${path}.${key}`,
				`parameter "${key}" exceeds ${MAX_TEXT_LENGTH} characters`,
			);
		}
		entries.push([key, entry]);
	}
	entries.sort(([left], [right]) => left.localeCompare(right));
	const params = Object.fromEntries(entries);
	const schemaError = validateParamsAgainstSchema(schema, params);
	if (schemaError !== null) return failure('PARAMS_INVALID', path, schemaError);
	if (utf8ByteLength(canonicalJson(params)) > MAX_PARAM_JSON_BYTES) {
		return failure('PARAMS_INVALID', path, `params exceed ${MAX_PARAM_JSON_BYTES} UTF-8 bytes`);
	}
	return { ok: true, params };
}

function normalizeTimeout(
	value: unknown,
	path: string,
): { ok: true; value: number | undefined } | GenerationFailure {
	if (value === undefined) return { ok: true, value: undefined };
	if (!isPositiveFinite(value) || value > MAX_TIMEOUT_SEC) {
		return failure(
			'TIMEOUT_INVALID',
			path,
			`timeoutSec must be a positive number at most ${MAX_TIMEOUT_SEC}`,
		);
	}
	return { ok: true, value };
}

function normalizeGuard(
	value: unknown,
	path: string,
	blockId: string,
):
	| {
			ok: true;
			when: RobotPlanDraftGuard | undefined;
			skipIf: SkipIfGuard | undefined;
			guardBlockId: string | undefined;
	  }
	| GenerationFailure {
	if (value === undefined) {
		return { ok: true, when: undefined, skipIf: undefined, guardBlockId: undefined };
	}
	if (!isJsonRecord(value)) return failure('GUARD_INVALID', path, 'when must be an object');
	const unknownKey = firstUnknownKey(value, GUARD_KEYS);
	if (unknownKey !== null) {
		return failure('GUARD_INVALID', `${path}.${unknownKey}`, `unknown when field "${unknownKey}"`);
	}
	if (value.field !== 'last.success' && value.field !== 'last.state') {
		return failure(
			'GUARD_INVALID',
			`${path}.field`,
			'when field must be last.success or last.state',
		);
	}
	if (value.op !== 'eq' && value.op !== 'neq') {
		return failure('GUARD_INVALID', `${path}.op`, 'when op must be eq or neq');
	}
	if (value.field === 'last.success' && typeof value.value !== 'boolean') {
		return failure('GUARD_INVALID', `${path}.value`, 'last.success must compare with a boolean');
	}
	if (value.field === 'last.state' && !isNonEmptyText(value.value)) {
		return failure(
			'GUARD_INVALID',
			`${path}.value`,
			'last.state must compare with a non-empty string',
		);
	}
	if (typeof value.value !== 'string' && typeof value.value !== 'boolean') {
		return failure('GUARD_INVALID', `${path}.value`, 'when value must be text or boolean');
	}
	const when: RobotPlanDraftGuard = {
		field: value.field,
		op: value.op,
		value: value.value,
	};
	const skipIf: SkipIfGuard = {
		field: value.field,
		op: value.op === 'eq' ? '!=' : '==',
		value: value.value,
	};
	return { ok: true, when, skipIf, guardBlockId: `${blockId}-guard` };
}

function normalizeTeaching(
	value: unknown,
	path: string,
): { ok: true; teaching: RobotPlanTeachingAnnotation | undefined } | GenerationFailure {
	if (value === undefined) return { ok: true, teaching: undefined };
	if (!isJsonRecord(value)) {
		return failure('TEACHING_INVALID', path, 'teaching must be an object');
	}
	const unknownKey = firstUnknownKey(value, TEACHING_KEYS);
	if (unknownKey !== null) {
		return failure(
			'TEACHING_INVALID',
			`${path}.${unknownKey}`,
			`unknown teaching field "${unknownKey}"`,
		);
	}
	if (
		!isNonEmptyText(value.what) ||
		!isNonEmptyText(value.why) ||
		!isNonEmptyText(value.expectedEffect) ||
		!isNonEmptyTextArray(value.editable)
	) {
		return failure(
			'TEACHING_INVALID',
			path,
			'teaching requires what, why, editable[], and expectedEffect text',
		);
	}
	return {
		ok: true,
		teaching: {
			what: value.what,
			why: value.why,
			editable: [...value.editable],
			expectedEffect: value.expectedEffect,
		},
	};
}

function createWorkspace(
	designId: string,
	planRef: string,
	steps: NormalizedStep[],
): Record<string, unknown> {
	let head: BlocklyBlock | undefined;
	for (const step of [...steps].reverse()) {
		const action = createActionBlock(step);
		if (head !== undefined) action.next = { block: head };
		if (step.draft.kind !== 'wait' && step.draft.when !== undefined) {
			const guard = createGuardBlock(step.draft.when, step.guardBlockId ?? `${step.blockId}-guard`);
			guard.next = { block: action };
			head = guard;
		} else {
			head = action;
		}
	}

	const root: BlocklyBlock = {
		type: 'robot_task_plan',
		id: stableAuxiliaryBlockId(designId, planRef, 'root'),
		x: 40,
		y: 40,
		inputs: { DO: { block: head } },
	};
	return { blocks: { languageVersion: 0, blocks: [root] } };
}

function createActionBlock(step: NormalizedStep): BlocklyBlock {
	if (step.draft.kind === 'wait') {
		return {
			type: 'robot_wait',
			id: step.blockId,
			inputs: {
				SECONDS: {
					block: numberBlock(
						step.draft.durationMs / 1000,
						stableAuxiliaryBlockId(step.blockId, 'input', 'seconds'),
					),
				},
			},
		};
	}

	if (step.draft.kind === 'namedPose') {
		return {
			type: 'robot_execute_primitive',
			id: step.blockId,
			fields: { PRIMITIVE: 'move_to_named_pose' },
			inputs: {
				TARGET: {
					block: textBlock(
						step.draft.pose,
						stableAuxiliaryBlockId(step.blockId, 'input', 'target_name'),
					),
				},
				...timeoutInput(step.draft.timeoutSec, step.blockId),
			},
		};
	}

	const fields: JsonRecord =
		step.draft.kind === 'skill' ? { SKILL: step.draft.name } : { PRIMITIVE: step.draft.name };
	const block: BlocklyBlock = {
		type: step.draft.kind === 'skill' ? 'robot_execute_skill' : 'robot_execute_primitive',
		id: step.blockId,
		fields,
	};
	const params = step.draft.params ?? {};
	const inputResult = paramsToBlockly(params, step.blockId);
	block.fields = { ...fields, ...inputResult.fields };
	block.inputs = { ...inputResult.inputs, ...timeoutInput(step.draft.timeoutSec, step.blockId) };
	return block;
}

function paramsToBlockly(
	params: Record<string, RobotPlanDraftScalar>,
	blockId: string,
): { fields: JsonRecord; inputs: JsonRecord } {
	const fields: JsonRecord = {};
	const inputs: JsonRecord = {};
	const extra: Record<string, RobotPlanDraftScalar> = {};
	for (const [name, value] of Object.entries(params)) {
		if (name === 'target_name' && typeof value === 'string') {
			inputs.TARGET = {
				block: textBlock(value, stableAuxiliaryBlockId(blockId, 'input', 'target_name')),
			};
		} else if (name === 'place_name' && typeof value === 'string') {
			inputs.PLACE = {
				block: textBlock(value, stableAuxiliaryBlockId(blockId, 'input', 'place_name')),
			};
		} else if (
			name === 'motion_direction' &&
			typeof value === 'string' &&
			MOTION_DIRECTIONS.some((direction) => direction === value)
		) {
			fields.DIRECTION = value;
		} else if (name === 'motion_distance' && typeof value === 'number') {
			inputs.DISTANCE = {
				block: numberBlock(value, stableAuxiliaryBlockId(blockId, 'input', 'motion_distance')),
			};
		} else {
			extra[name] = value;
		}
	}
	if (Object.keys(extra).length > 0) fields.PARAMS_JSON = canonicalJson(extra);
	return { fields, inputs };
}

function timeoutInput(timeoutSec: number | undefined, blockId: string): JsonRecord {
	if (timeoutSec === undefined) return {};
	return {
		TIMEOUT: {
			block: numberBlock(timeoutSec, stableAuxiliaryBlockId(blockId, 'input', 'timeout')),
		},
	};
}

function createGuardBlock(when: RobotPlanDraftGuard, id: string): BlocklyBlock {
	const op = when.op === 'eq' ? '!=' : '==';
	const value = typeof when.value === 'boolean' ? String(when.value) : when.value;
	return {
		type: 'robot_condition',
		id,
		fields: { FIELD: when.field, OP: op },
		inputs: {
			VALUE: { block: textBlock(value, stableAuxiliaryBlockId(id, 'input', 'value')) },
		},
	};
}

function textBlock(value: string, id: string): BlocklyBlock {
	return { type: 'text', id, fields: { TEXT: value } };
}

function numberBlock(value: number, id: string): BlocklyBlock {
	return { type: 'math_number', id, fields: { NUM: value } };
}

function createSourceMap(planRef: string, steps: NormalizedStep[]): RobotPlanSourceMapEntry[] {
	return steps.map((step) => {
		const base: RobotPlanSourceMapEntry = {
			planRef,
			stepRef: step.draft.stepRef,
			blockId: step.blockId,
			planStepId: `step:${step.blockId}`,
			kind:
				step.planStep.step === 'skill'
					? 'skill'
					: step.planStep.step === 'primitive'
						? 'primitive'
						: 'wait',
		};
		if (step.guardBlockId !== undefined) base.guardBlockId = step.guardBlockId;
		if (step.planStep.step === 'skill') base.capabilityName = step.planStep.skill;
		if (step.planStep.step === 'primitive') base.capabilityName = step.planStep.primitive;
		return base;
	});
}

function stableBlockId(designId: string, planRef: string, stepRef: string): string {
	return `robot-${stableHash(['block', designId, planRef, stepRef])}`;
}

function stableAuxiliaryBlockId(...parts: string[]): string {
	return `robot-${stableHash(['aux', ...parts])}`;
}

function stableHash(parts: string[]): string {
	const input = parts.map((part) => `${part.length}:${part}`).join('|');
	let first = 0x811c9dc5;
	let second = 0x9e3779b9;
	for (let index = 0; index < input.length; index++) {
		const code = input.charCodeAt(index);
		first = Math.imul(first ^ code, 0x01000193);
		second = Math.imul(second ^ code, 0x85ebca6b);
		second ^= second >>> 13;
	}
	return `${(first >>> 0).toString(16).padStart(8, '0')}${(second >>> 0)
		.toString(16)
		.padStart(8, '0')}`;
}

function findSkill(catalog: RobotCatalog, value: unknown): CatalogSkillEntry | undefined {
	if (typeof value !== 'string') return undefined;
	return catalog.skills.find((skill) => skill.name === value);
}

function findPrimitive(catalog: RobotCatalog, value: unknown): CatalogPrimitiveEntry | undefined {
	if (typeof value !== 'string' || !catalog.primitives.includes(value)) return undefined;
	const detail = catalog.primitiveDetails?.find((primitive) => primitive.name === value);
	return detail ?? { name: value };
}

function planBudgetSeconds(plan: PlanStep[]): number {
	let budget = 0;
	for (const step of plan) {
		if (step.step === 'wait') budget += step.seconds;
		else budget += step.timeoutSec ?? DEFAULT_SKILL_TIMEOUT_SEC;
	}
	return budget;
}

function canonicalJson(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map((entry) => canonicalJson(entry)).join(',')}]`;
	if (isJsonRecord(value)) {
		return `{${Object.keys(value)
			.sort()
			.map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
			.join(',')}}`;
	}
	return JSON.stringify(value) ?? 'null';
}

function utf8ByteLength(value: string): number {
	let bytes = 0;
	for (const character of value) {
		const codePoint = character.codePointAt(0);
		if (codePoint === undefined) continue;
		if (codePoint <= 0x7f) bytes += 1;
		else if (codePoint <= 0x7ff) bytes += 2;
		else if (codePoint <= 0xffff) bytes += 3;
		else bytes += 4;
	}
	return bytes;
}

function firstUnknownKey(value: JsonRecord, allowed: ReadonlySet<string>): string | null {
	return Object.keys(value).find((key) => !allowed.has(key)) ?? null;
}

function isDraftScalar(value: unknown): value is RobotPlanDraftScalar {
	return (
		typeof value === 'string' ||
		typeof value === 'boolean' ||
		(typeof value === 'number' && Number.isFinite(value))
	);
}

function isPositiveFinite(value: unknown): value is number {
	return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

function isNonEmptyText(value: unknown): value is string {
	return typeof value === 'string' && value.trim() !== '' && value.length <= MAX_TEXT_LENGTH;
}

function isNonEmptyTextArray(value: unknown): value is string[] {
	return Array.isArray(value) && value.every(isNonEmptyText);
}

function isValidReference(value: unknown): value is string {
	return typeof value === 'string' && REFERENCE_PATTERN.test(value);
}

function failure(
	code: RobotPlanGenerationErrorCode,
	path: string,
	message: string,
): GenerationFailure {
	return { ok: false, error: { code, path, message } };
}
