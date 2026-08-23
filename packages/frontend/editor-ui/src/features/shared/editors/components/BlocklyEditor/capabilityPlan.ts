import {
	CAPABILITY_PLAN_ROOT_BLOCK_TYPE,
	CAPABILITY_PLAN_STEP_BLOCK_TYPE,
	compileCapabilityPlanWorkspace as compileSharedCapabilityPlanWorkspace,
	createDefaultCapabilityPlanPayload,
	createEmptyCapabilityPlanWorkspace,
	generateCapabilityPlanWorkspace,
	parseCapabilityPlanPayload,
	serializeCapabilityPlanPayload as serializeSharedCapabilityPlanPayload,
} from '@n8n/blockly-capability-plan';
import type { CapabilityPlanError, CapabilityPlanPayloadV1 } from '@n8n/blockly-capability-plan';
import type * as Blockly from 'blockly';

export {
	CAPABILITY_PLAN_ROOT_BLOCK_TYPE,
	CAPABILITY_PLAN_STEP_BLOCK_TYPE,
	createDefaultCapabilityPlanPayload,
	createEmptyCapabilityPlanWorkspace,
	generateCapabilityPlanWorkspace,
	parseCapabilityPlanPayload,
};
export type { CapabilityPlanPayloadV1 };

export type CapabilityCatalogV1 = CapabilityPlanPayloadV1['catalog'];

type BlocklyRuntime = Pick<typeof Blockly, 'Blocks' | 'FieldDropdown' | 'FieldTextInput'>;

export type CapabilityPlanToolboxLabels = {
	plan: string;
};

export type CapabilityPlanBlockLabels = {
	plan: string;
	step: string;
	stepRef: string;
	capability: string;
	argumentsJson: string;
	label: string;
	timeoutMs: string;
	guardJson: string;
};

const CAPABILITY_STEP_CONNECTION = 'N8nCapabilityPlanStep';

/**
 * Blockly keeps keys whose custom field state is `undefined` in its in-memory
 * snapshot. Strip only those keys before crossing the JSON payload boundary;
 * every semantic value is still validated and compiled by the shared package.
 */
export function compileCapabilityPlanWorkspace(
	workspace: unknown,
	catalog: unknown,
	planRef: unknown,
	metadata?: unknown,
) {
	return compileSharedCapabilityPlanWorkspace(
		omitUndefinedProperties(workspace),
		catalog,
		planRef,
		metadata,
	);
}

export function serializeCapabilityPlanPayload(payload: unknown): string {
	return serializeSharedCapabilityPlanPayload(omitUndefinedProperties(payload));
}

export function createCapabilityPlanToolbox(
	labels: CapabilityPlanToolboxLabels,
): Blockly.utils.toolbox.ToolboxInfo {
	return {
		kind: 'categoryToolbox',
		contents: [
			{
				kind: 'category',
				name: labels.plan,
				colour: '160',
				contents: [
					{ kind: 'block', type: CAPABILITY_PLAN_ROOT_BLOCK_TYPE },
					{ kind: 'block', type: CAPABILITY_PLAN_STEP_BLOCK_TYPE },
				],
			},
		],
	};
}

export function registerCapabilityPlanBlocks(
	blockly: BlocklyRuntime,
	labels: CapabilityPlanBlockLabels,
	catalog?: CapabilityCatalogV1,
) {
	const capabilityOptions = createCapabilityOptions(catalog);
	const OptionalTextInput = class extends blockly.FieldTextInput {
		override saveState(doFullSerialization?: boolean): unknown {
			const state: unknown = super.saveState(doFullSerialization);
			return state === '' ? undefined : state;
		}
	};
	const OptionalIntegerInput = class extends OptionalTextInput {
		override saveState(doFullSerialization?: boolean): unknown {
			const state = super.saveState(doFullSerialization);
			if (state === undefined || typeof state !== 'string') return state;
			const numericValue = Number(state);
			return Number.isFinite(numericValue) ? numericValue : state;
		}
	};

	blockly.Blocks[CAPABILITY_PLAN_ROOT_BLOCK_TYPE] = {
		init(this: Blockly.Block) {
			this.appendDummyInput().appendField(labels.plan);
			this.appendStatementInput('STEPS').setCheck(CAPABILITY_STEP_CONNECTION);
			this.setColour(210);
		},
	};

	blockly.Blocks[CAPABILITY_PLAN_STEP_BLOCK_TYPE] = {
		init(this: Blockly.Block) {
			this.appendDummyInput()
				.appendField(labels.step)
				.appendField(labels.stepRef)
				.appendField(new blockly.FieldTextInput('step.new'), 'STEP_REF');
			this.appendDummyInput()
				.appendField(labels.capability)
				.appendField(new blockly.FieldDropdown(capabilityOptions), 'CAPABILITY_REF');
			this.appendDummyInput()
				.appendField(labels.argumentsJson)
				.appendField(new blockly.FieldTextInput('{}'), 'ARGUMENTS_JSON');
			this.appendDummyInput()
				.appendField(labels.label)
				.appendField(new OptionalTextInput(''), 'LABEL');
			this.appendDummyInput()
				.appendField(labels.timeoutMs)
				.appendField(new OptionalIntegerInput(''), 'TIMEOUT_MS');
			this.appendDummyInput()
				.appendField(labels.guardJson)
				.appendField(new OptionalTextInput(''), 'GUARD_JSON');
			this.setPreviousStatement(true, CAPABILITY_STEP_CONNECTION);
			this.setNextStatement(true, CAPABILITY_STEP_CONNECTION);
			this.setColour(160);
		},
	};
}

export function formatCapabilityPlanError(error: CapabilityPlanError): string {
	const location = [error.path, error.blockId, error.stepRef].filter(
		(value): value is string => value !== undefined,
	);
	return `${error.code}: ${error.message}${location.length > 0 ? ` (${location.join(' · ')})` : ''}`;
}

function createCapabilityOptions(catalog?: CapabilityCatalogV1): Array<[string, string]> {
	if (!catalog) return [['-', '']];
	return catalog.capabilities.map(({ displayName, capabilityRef }) => [displayName, capabilityRef]);
}

function omitUndefinedProperties(value: unknown, seen = new WeakMap<object, unknown>()): unknown {
	if (Array.isArray(value)) {
		if (seen.has(value)) return seen.get(value);
		const copy: unknown[] = [];
		seen.set(value, copy);
		for (const item of value) copy.push(omitUndefinedProperties(item, seen));
		return copy;
	}
	if (typeof value !== 'object' || value === null) return value;
	const prototype: unknown = Object.getPrototypeOf(value);
	if (prototype !== Object.prototype && prototype !== null) return value;
	if (seen.has(value)) return seen.get(value);

	const copy: Record<string, unknown> = {};
	seen.set(value, copy);
	for (const [key, item] of Object.entries(value)) {
		if (item !== undefined) copy[key] = omitUndefinedProperties(item, seen);
	}
	return copy;
}
