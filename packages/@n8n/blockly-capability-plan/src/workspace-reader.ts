import {
	executionPlanGuardV1Schema,
	jsonObjectSchema,
	stableReferenceSchema,
	type CapabilityCatalogV1,
	type ExecutionPlanGuardV1,
	type ExecutionPlanV1,
	type JsonObject,
} from '@n8n/dual-canvas-core';

import {
	CAPABILITY_PLAN_LIMITS,
	CAPABILITY_PLAN_MAX_STEPS,
	CAPABILITY_PLAN_ROOT_BLOCK_TYPE,
	CAPABILITY_PLAN_STEP_BLOCK_TYPE,
} from './constants';
import {
	firstUnknownKey,
	inspectJsonValue,
	isRecord,
	jsonByteLength,
	utf8ByteLength,
} from './json';
import type { CapabilityPlanError } from './types';

const workspaceKeys = new Set(['blocks']);
const blocksStateKeys = new Set(['languageVersion', 'blocks']);
const rootBlockKeys = new Set(['type', 'id', 'x', 'y', 'inputs']);
const rootInputKeys = new Set(['STEPS']);
const childWrapperKeys = new Set(['block']);
const stepBlockKeys = new Set(['type', 'id', 'fields', 'next']);
const stepFieldKeys = new Set([
	'STEP_REF',
	'CAPABILITY_REF',
	'ARGUMENTS_JSON',
	'LABEL',
	'TIMEOUT_MS',
	'GUARD_JSON',
]);

type ParsedStep = {
	blockId: string;
	step: ExecutionPlanV1['steps'][number];
};

export type WorkspaceReadResult =
	| { ok: true; steps: ParsedStep[]; blockCount: number }
	| { ok: false; error: CapabilityPlanError };

export function readCapabilityPlanWorkspace(
	workspaceInput: unknown,
	catalog: CapabilityCatalogV1,
): WorkspaceReadResult {
	const workspaceBytes = jsonByteLength(workspaceInput);
	if (workspaceBytes === undefined) {
		return failure('WORKSPACE_INVALID', 'Workspace must be a finite JSON value', 'workspace');
	}
	if (workspaceBytes > CAPABILITY_PLAN_LIMITS.maxWorkspaceBytes) {
		return failure(
			'WORKSPACE_LIMIT_EXCEEDED',
			`Workspace exceeds ${CAPABILITY_PLAN_LIMITS.maxWorkspaceBytes} UTF-8 bytes`,
			'workspace',
		);
	}
	const workspaceInspection = inspectJsonValue(
		workspaceInput,
		CAPABILITY_PLAN_LIMITS.maxWorkspaceJsonDepth,
		CAPABILITY_PLAN_LIMITS.maxJsonEntries * 4,
	);
	if (!workspaceInspection.ok) {
		return failure(
			'WORKSPACE_INVALID',
			workspaceInspection.message,
			`workspace${workspaceInspection.path.slice(1)}`,
		);
	}
	if (!isRecord(workspaceInput)) {
		return failure('WORKSPACE_INVALID', 'Workspace must be an object', 'workspace');
	}
	const workspaceUnknownKey = firstUnknownKey(workspaceInput, workspaceKeys);
	if (workspaceUnknownKey !== undefined) {
		return failure(
			'WORKSPACE_INVALID',
			`Workspace contains unknown field "${workspaceUnknownKey}"`,
			`workspace.${workspaceUnknownKey}`,
		);
	}

	const blocksState = workspaceInput.blocks;
	if (!isRecord(blocksState)) {
		return failure('WORKSPACE_INVALID', 'Workspace blocks must be an object', 'workspace.blocks');
	}
	const blocksStateUnknownKey = firstUnknownKey(blocksState, blocksStateKeys);
	if (blocksStateUnknownKey !== undefined) {
		return failure(
			'WORKSPACE_INVALID',
			`Workspace blocks contain unknown field "${blocksStateUnknownKey}"`,
			`workspace.blocks.${blocksStateUnknownKey}`,
		);
	}
	if (blocksState.languageVersion !== 0) {
		return failure(
			'WORKSPACE_INVALID',
			'Workspace languageVersion must be 0',
			'workspace.blocks.languageVersion',
		);
	}
	if (!Array.isArray(blocksState.blocks) || blocksState.blocks.length !== 1) {
		return failure(
			'WORKSPACE_INVALID',
			'Workspace must contain exactly one root block',
			'workspace.blocks.blocks',
		);
	}

	const root: unknown = blocksState.blocks[0];
	if (!isRecord(root)) {
		return failure('WORKSPACE_INVALID', 'Root block must be an object', 'workspace.root');
	}
	const rootUnknownKey = firstUnknownKey(root, rootBlockKeys);
	if (rootUnknownKey !== undefined) {
		return failure(
			'WORKSPACE_INVALID',
			`Root block contains unknown field "${rootUnknownKey}"`,
			`workspace.root.${rootUnknownKey}`,
		);
	}
	if (root.type !== CAPABILITY_PLAN_ROOT_BLOCK_TYPE) {
		return failure(
			'WORKSPACE_INVALID',
			`Root block must be ${CAPABILITY_PLAN_ROOT_BLOCK_TYPE}`,
			'workspace.root.type',
		);
	}
	const rootId = parseBlockId(root.id);
	if (rootId === undefined) {
		return failure('WORKSPACE_INVALID', 'Root block id is invalid', 'workspace.root.id');
	}
	if (!isOptionalCoordinate(root.x) || !isOptionalCoordinate(root.y)) {
		return failure(
			'WORKSPACE_INVALID',
			'Root coordinates must be finite numbers',
			'workspace.root',
		);
	}

	const visitedBlocks = new WeakSet<object>();
	visitedBlocks.add(root);
	const blockIds = new Set([rootId]);
	let blockCount = 1;
	const inputs = root.inputs;
	if (inputs === undefined) return { ok: true, steps: [], blockCount };
	if (!isRecord(inputs)) {
		return failure('WORKSPACE_INVALID', 'Root inputs must be an object', 'workspace.root.inputs');
	}
	const inputUnknownKey = firstUnknownKey(inputs, rootInputKeys);
	if (inputUnknownKey !== undefined) {
		return failure(
			'WORKSPACE_INVALID',
			`Root inputs contain unknown field "${inputUnknownKey}"`,
			`workspace.root.inputs.${inputUnknownKey}`,
		);
	}
	if (!('STEPS' in inputs)) return { ok: true, steps: [], blockCount };

	const firstStep = readChildWrapper(inputs.STEPS, 'workspace.root.inputs.STEPS');
	if (!firstStep.ok) return firstStep;
	const steps: ParsedStep[] = [];
	let current: unknown = firstStep.block;
	let chainDepth = 0;
	let previousStepRef: string | undefined;

	while (current !== undefined) {
		chainDepth += 1;
		if (chainDepth > CAPABILITY_PLAN_MAX_STEPS) {
			return failure(
				'WORKSPACE_LIMIT_EXCEEDED',
				`Step chain exceeds ${CAPABILITY_PLAN_MAX_STEPS} steps`,
				'workspace.root.inputs.STEPS',
			);
		}
		if (!isRecord(current)) {
			return failure('WORKSPACE_INVALID', 'Step block must be an object', `steps.${steps.length}`);
		}
		if (visitedBlocks.has(current)) {
			return failure(
				'WORKSPACE_INVALID',
				'Step chain contains a cycle or shared block reference',
				`steps.${steps.length}`,
			);
		}
		visitedBlocks.add(current);
		blockCount += 1;
		if (blockCount > CAPABILITY_PLAN_MAX_STEPS + 1) {
			return failure(
				'WORKSPACE_LIMIT_EXCEEDED',
				`Workspace exceeds ${CAPABILITY_PLAN_MAX_STEPS} steps`,
				`steps.${steps.length}`,
			);
		}

		const parsedStep = parseStepBlock(current, catalog, steps.length, previousStepRef, blockIds);
		if (!parsedStep.ok) return parsedStep;
		steps.push(parsedStep.value);
		previousStepRef = parsedStep.value.step.stepRef;

		if (!('next' in current)) break;
		const nextStep = readChildWrapper(current.next, `steps.${steps.length - 1}.next`);
		if (!nextStep.ok) return nextStep;
		current = nextStep.block;
	}

	return { ok: true, steps, blockCount };
}

function parseStepBlock(
	block: Record<string, unknown>,
	catalog: CapabilityCatalogV1,
	stepIndex: number,
	previousStepRef: string | undefined,
	blockIds: Set<string>,
): { ok: true; value: ParsedStep } | { ok: false; error: CapabilityPlanError } {
	const path = `steps.${stepIndex}`;
	const unknownKey = firstUnknownKey(block, stepBlockKeys);
	if (unknownKey !== undefined) {
		return failure(
			'WORKSPACE_INVALID',
			`Step block contains unknown field "${unknownKey}"`,
			`${path}.${unknownKey}`,
		);
	}
	if (block.type !== CAPABILITY_PLAN_STEP_BLOCK_TYPE) {
		return failure(
			'WORKSPACE_INVALID',
			`Step block must be ${CAPABILITY_PLAN_STEP_BLOCK_TYPE}`,
			`${path}.type`,
		);
	}
	const blockId = parseBlockId(block.id);
	if (blockId === undefined) {
		return failure('WORKSPACE_INVALID', 'Step block id is invalid', `${path}.id`);
	}
	if (blockIds.has(blockId)) {
		return failure('WORKSPACE_INVALID', `Duplicate block id "${blockId}"`, `${path}.id`, blockId);
	}
	blockIds.add(blockId);
	if (!isRecord(block.fields)) {
		return failure('WORKSPACE_INVALID', 'Step fields must be an object', `${path}.fields`, blockId);
	}
	const fields = block.fields;
	const unknownField = firstUnknownKey(fields, stepFieldKeys);
	if (unknownField !== undefined) {
		return failure(
			'WORKSPACE_INVALID',
			`Step contains unknown field "${unknownField}"`,
			`${path}.fields.${unknownField}`,
			blockId,
		);
	}

	const stepRef = parseStableReference(fields.STEP_REF);
	if (stepRef === undefined) {
		return failure(
			'STEP_REF_INVALID',
			'STEP_REF must be a stable reference',
			`${path}.fields.STEP_REF`,
			blockId,
		);
	}
	const capabilityRef = parseStableReference(fields.CAPABILITY_REF);
	if (capabilityRef === undefined) {
		return failure(
			'CAPABILITY_REF_INVALID',
			'CAPABILITY_REF must be a stable reference',
			`${path}.fields.CAPABILITY_REF`,
			blockId,
			stepRef,
		);
	}
	const capability = catalog.capabilities.find((entry) => entry.capabilityRef === capabilityRef);
	if (capability === undefined) {
		return failure(
			'PLAN_CAPABILITY_MISSING',
			`Capability "${capabilityRef}" is absent from the supplied catalog`,
			`${path}.fields.CAPABILITY_REF`,
			blockId,
			stepRef,
		);
	}

	const argumentsResult = parseArguments(
		fields.ARGUMENTS_JSON,
		capability.inputs,
		path,
		blockId,
		stepRef,
	);
	if (!argumentsResult.ok) return argumentsResult;
	const labelResult = parseOptionalLabel(fields.LABEL, path, blockId, stepRef);
	if (!labelResult.ok) return labelResult;
	const timeoutResult = parseOptionalTimeout(fields.TIMEOUT_MS, path, blockId, stepRef);
	if (!timeoutResult.ok) return timeoutResult;
	const guardResult = parseOptionalGuard(fields.GUARD_JSON, path, blockId, stepRef);
	if (!guardResult.ok) return guardResult;

	const step: ExecutionPlanV1['steps'][number] = {
		stepRef,
		capabilityRef,
		arguments: argumentsResult.value,
		dependsOn: previousStepRef === undefined ? [] : [previousStepRef],
	};
	if (labelResult.value !== undefined) step.label = labelResult.value;
	if (timeoutResult.value !== undefined) step.timeoutMs = timeoutResult.value;
	if (guardResult.value !== undefined) step.guard = guardResult.value;

	return { ok: true, value: { blockId, step } };
}

function parseArguments(
	value: unknown,
	inputs: CapabilityCatalogV1['capabilities'][number]['inputs'],
	path: string,
	blockId: string,
	stepRef: string,
): { ok: true; value: JsonObject } | { ok: false; error: CapabilityPlanError } {
	if (typeof value !== 'string') {
		return failure(
			'ARGUMENTS_INVALID',
			'ARGUMENTS_JSON must be a JSON object string',
			`${path}.fields.ARGUMENTS_JSON`,
			blockId,
			stepRef,
		);
	}
	if (utf8ByteLength(value) > CAPABILITY_PLAN_LIMITS.maxArgumentBytes) {
		return failure(
			'ARGUMENTS_LIMIT_EXCEEDED',
			`Arguments exceed ${CAPABILITY_PLAN_LIMITS.maxArgumentBytes} UTF-8 bytes`,
			`${path}.fields.ARGUMENTS_JSON`,
			blockId,
			stepRef,
		);
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(value);
	} catch {
		return failure(
			'ARGUMENTS_INVALID',
			'ARGUMENTS_JSON is not valid JSON',
			`${path}.fields.ARGUMENTS_JSON`,
			blockId,
			stepRef,
		);
	}
	if (!isRecord(parsed)) {
		return failure(
			'ARGUMENTS_INVALID',
			'ARGUMENTS_JSON must contain an object',
			`${path}.fields.ARGUMENTS_JSON`,
			blockId,
			stepRef,
		);
	}
	const inspection = inspectJsonValue(
		parsed,
		CAPABILITY_PLAN_LIMITS.maxJsonDepth,
		CAPABILITY_PLAN_LIMITS.maxJsonEntries,
	);
	if (!inspection.ok) {
		return failure(
			'ARGUMENTS_INVALID',
			inspection.message,
			`${path}.fields.ARGUMENTS_JSON${inspection.path.slice(1)}`,
			blockId,
			stepRef,
		);
	}
	const normalized = jsonObjectSchema.safeParse(parsed);
	if (!normalized.success) {
		const issue = normalized.error.issues[0];
		return failure(
			'ARGUMENTS_INVALID',
			issue?.message ?? 'Arguments are invalid',
			`${path}.fields.ARGUMENTS_JSON${issue?.path.length ? `.${issue.path.join('.')}` : ''}`,
			blockId,
			stepRef,
		);
	}
	const declaredInputs = new Set(inputs.map((input) => input.parameterRef));
	const unknownArgument = Object.keys(normalized.data).find((key) => !declaredInputs.has(key));
	if (unknownArgument !== undefined) {
		return failure(
			'PLAN_ARGUMENT_UNKNOWN',
			`Argument "${unknownArgument}" is not declared by the capability`,
			`${path}.fields.ARGUMENTS_JSON.${unknownArgument}`,
			blockId,
			stepRef,
		);
	}
	return { ok: true, value: normalized.data };
}

function parseOptionalLabel(
	value: unknown,
	path: string,
	blockId: string,
	stepRef: string,
): { ok: true; value: string | undefined } | { ok: false; error: CapabilityPlanError } {
	if (value === undefined) return { ok: true, value: undefined };
	if (
		typeof value !== 'string' ||
		value.trim() === '' ||
		value.trim() !== value ||
		value.length > 128
	) {
		return failure(
			'LABEL_INVALID',
			'LABEL must be trimmed text of 1 to 128 characters',
			`${path}.fields.LABEL`,
			blockId,
			stepRef,
		);
	}
	return { ok: true, value };
}

function parseOptionalTimeout(
	value: unknown,
	path: string,
	blockId: string,
	stepRef: string,
): { ok: true; value: number | undefined } | { ok: false; error: CapabilityPlanError } {
	if (value === undefined) return { ok: true, value: undefined };
	if (!Number.isInteger(value) || typeof value !== 'number' || value <= 0 || value > 86_400_000) {
		return failure(
			'TIMEOUT_INVALID',
			'TIMEOUT_MS must be a positive integer at most 86400000',
			`${path}.fields.TIMEOUT_MS`,
			blockId,
			stepRef,
		);
	}
	return { ok: true, value };
}

function parseOptionalGuard(
	value: unknown,
	path: string,
	blockId: string,
	stepRef: string,
):
	| { ok: true; value: ExecutionPlanGuardV1 | undefined }
	| { ok: false; error: CapabilityPlanError } {
	if (value === undefined) return { ok: true, value: undefined };
	if (typeof value !== 'string') {
		return failure(
			'GUARD_INVALID',
			'GUARD_JSON must be a JSON object string',
			`${path}.fields.GUARD_JSON`,
			blockId,
			stepRef,
		);
	}
	if (utf8ByteLength(value) > CAPABILITY_PLAN_LIMITS.maxGuardBytes) {
		return failure(
			'GUARD_LIMIT_EXCEEDED',
			`Guard exceeds ${CAPABILITY_PLAN_LIMITS.maxGuardBytes} UTF-8 bytes`,
			`${path}.fields.GUARD_JSON`,
			blockId,
			stepRef,
		);
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(value);
	} catch {
		return failure(
			'GUARD_INVALID',
			'GUARD_JSON is not valid JSON',
			`${path}.fields.GUARD_JSON`,
			blockId,
			stepRef,
		);
	}
	const inspection = inspectJsonValue(
		parsed,
		CAPABILITY_PLAN_LIMITS.maxJsonDepth,
		CAPABILITY_PLAN_LIMITS.maxJsonEntries,
	);
	if (!inspection.ok) {
		return failure(
			'GUARD_INVALID',
			inspection.message,
			`${path}.fields.GUARD_JSON${inspection.path.slice(1)}`,
			blockId,
			stepRef,
		);
	}
	const normalized = executionPlanGuardV1Schema.safeParse(parsed);
	if (!normalized.success) {
		const issue = normalized.error.issues[0];
		return failure(
			'GUARD_INVALID',
			issue?.message ?? 'Guard is invalid',
			`${path}.fields.GUARD_JSON${issue?.path.length ? `.${issue.path.join('.')}` : ''}`,
			blockId,
			stepRef,
		);
	}
	return { ok: true, value: normalized.data };
}

function readChildWrapper(
	value: unknown,
	path: string,
): { ok: true; block: unknown } | { ok: false; error: CapabilityPlanError } {
	if (!isRecord(value)) {
		return failure('WORKSPACE_INVALID', 'Block connection must be an object', path);
	}
	const unknownKey = firstUnknownKey(value, childWrapperKeys);
	if (unknownKey !== undefined || !('block' in value)) {
		return failure('WORKSPACE_INVALID', 'Block connection must contain only block', path);
	}
	return { ok: true, block: value.block };
}

function parseBlockId(value: unknown): string | undefined {
	if (
		typeof value !== 'string' ||
		value.length === 0 ||
		value.length > 256 ||
		value.trim() !== value ||
		containsControlCharacter(value)
	) {
		return undefined;
	}
	return value;
}

function containsControlCharacter(value: string): boolean {
	for (const character of value) {
		const codePoint = character.codePointAt(0);
		if (codePoint !== undefined && (codePoint < 32 || codePoint === 127)) return true;
	}
	return false;
}

function parseStableReference(value: unknown): string | undefined {
	const parsed = stableReferenceSchema.safeParse(value);
	return parsed.success ? parsed.data : undefined;
}

function isOptionalCoordinate(value: unknown): boolean {
	return value === undefined || (typeof value === 'number' && Number.isFinite(value));
}

export function failure(
	code: string,
	message: string,
	path?: string,
	blockId?: string,
	stepRef?: string,
): { ok: false; error: CapabilityPlanError } {
	const error: CapabilityPlanError = { code, message };
	if (path !== undefined) error.path = path;
	if (blockId !== undefined) error.blockId = blockId;
	if (stepRef !== undefined) error.stepRef = stepRef;
	return { ok: false, error };
}
