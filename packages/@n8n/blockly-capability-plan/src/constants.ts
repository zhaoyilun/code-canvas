export const CAPABILITY_PLAN_SCHEMA_VERSION = 1;
export const CAPABILITY_PLAN_MEDIA_TYPE = 'application/vnd.n8n.capability-plan+json';
export const CAPABILITY_PLAN_ADAPTER_REF = 'capability-plan';
export const CAPABILITY_PLAN_EDITOR_PROFILE = CAPABILITY_PLAN_ADAPTER_REF;

export const CAPABILITY_PLAN_ROOT_BLOCK_TYPE = 'n8n_capability_plan';
export const CAPABILITY_PLAN_STEP_BLOCK_TYPE = 'n8n_capability_step';

export const CAPABILITY_PLAN_MAX_STEPS = 127;

// A serialized Blockly statement chain adds one `next` wrapper and one `block`
// object per step. The fixed allowance covers the workspace/root/input/field
// containers around that chain. One extra sentinel step lets the workspace
// reader classify the first over-limit plan with WORKSPACE_LIMIT_EXCEEDED
// instead of a generic depth error. Every budget remains derived from the one
// public step limit.
const MAX_WORKSPACE_JSON_DEPTH = (CAPABILITY_PLAN_MAX_STEPS + 1) * 2 + 6;
const MAX_PAYLOAD_JSON_DEPTH = MAX_WORKSPACE_JSON_DEPTH + 1;

export const CAPABILITY_PLAN_LIMITS = {
	maxPayloadBytes: 512 * 1024,
	maxWorkspaceBytes: 256 * 1024,
	maxWorkspaceJsonDepth: MAX_WORKSPACE_JSON_DEPTH,
	maxPayloadJsonDepth: MAX_PAYLOAD_JSON_DEPTH,
	maxArgumentBytes: 16 * 1024,
	maxGuardBytes: 8 * 1024,
	maxJsonDepth: 24,
	maxJsonEntries: 4096,
} as const;
