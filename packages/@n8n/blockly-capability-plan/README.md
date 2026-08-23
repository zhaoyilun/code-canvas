# `@n8n/blockly-capability-plan`

This package is the domain-independent Blockly layer for ordered capability plans. A catalog
describes the available operations, while a two-block grammar keeps the editable workspace as the
step source of truth:

- `n8n_capability_plan` is the single root block.
- `n8n_capability_step` invokes one catalog capability with a strict JSON object.

Compilation produces `ExecutionPlanV1` plus stable block-to-step mappings. Generation performs the
inverse operation deterministically. The persisted payload contains the catalog snapshot, plan
reference, workspace, and optional plan metadata; it does not store a derived execution plan.
Payload parsing and serialization preserve structurally valid intermediate Blockly states, including
steps that are temporarily incomplete while a learner edits them. Call
`compileCapabilityPlanWorkspace()` separately to obtain semantic diagnostics and the derived plan.
Plugins select the built-in adapter with `CAPABILITY_PLAN_EDITOR_PROFILE` and declare payloads with
`CAPABILITY_PLAN_MEDIA_TYPE`.

`CAPABILITY_PLAN_MAX_STEPS` is the shared public plan limit. Generator, payload validation, and
workspace compilation derive their structural budgets from this value, so a plan at the limit can
round-trip through every layer.

```ts
import {
	compileCapabilityPlanWorkspace,
	createDefaultCapabilityPlanPayload,
} from '@n8n/blockly-capability-plan';

const payload = createDefaultCapabilityPlanPayload(catalog, 'lesson.publish');
const compiled = compileCapabilityPlanWorkspace(
	payload.workspace,
	payload.catalog,
	payload.planRef,
	payload.metadata,
);
```
