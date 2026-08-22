# @n8n/blockly-robot-skills

Shared, browser-compatible robot plan contracts for n8n:

- compile a constrained Blockly workspace into `RobotTaskPlan`;
- generate a Blockly workspace from a catalog-bound `RobotPlanDraft`;
- recompile every generated workspace and compare normalized semantics;
- preserve stable `blockId` / `planStepId` identities for review and runtime tracing.

## Deterministic draft generation

```ts
import {
  generateRobotPlanWorkspace,
  type RobotPlanDraft,
  type RobotPlanGenerationResult,
  type RobotPlanSourceMapEntry,
} from '@n8n/blockly-robot-skills';

const draft: RobotPlanDraft = {
  schemaVersion: 1,
  planRef: 'plan.inspect-table',
  label: 'Inspect the teaching table',
  robotProfileRef: catalog.robotName,
  catalogDigest: catalog.configDigest,
  budgetSec: 90,
  steps: [
    { stepRef: 'observe', kind: 'skill', name: 'inspect_scene' },
    { stepRef: 'pause', kind: 'wait', durationMs: 1000 },
    { stepRef: 'home', kind: 'namedPose', pose: 'home' },
  ],
};

const result = generateRobotPlanWorkspace(draft, catalog, {
  designId: 'lesson.demo-1',
});
```

The function accepts `unknown` at runtime so an AI structured-output payload can
be passed directly. A successful result contains:

- `workspace`: official Blockly JSON ready for the robot editor;
- `plan`: the result of recompiling that workspace with the supplied catalog;
- `normalizedDraft`: the validated, key-normalized draft;
- `sourceMap`: one ordered mapping per executable step.

Errors use `{ code, path, message }`, for example
`PARAMS_INVALID` at `steps[1].params.distance`. Callers should display all three
fields and send a corrected draft rather than editing Blockly JSON.

## Draft boundary

`RobotPlanDraft` supports only:

- catalog skills;
- catalog primitives (scalar params require `primitiveDetails[].parameters`);
- catalog named poses through `move_to_named_pose`;
- local waits up to 60 seconds;
- a `when` condition over `last.success` or `last.state` for an action step.

`when` means “execute this action when the comparison holds.” The linear runtime
uses `skipIf`, so generation deterministically stores the inverse comparison in
the compiled plan. Branches, loops, triggers, approvals, and long waits belong
on the n8n canvas.

Every parameter name must appear in the selected catalog schema and every value
is limited to a finite string, number, or boolean. The generator constructs
Blockly JSON itself; model-produced workspace JSON is outside this API.

## Catalog-bound payload

The editor and runtime exchange one schema only. Payload v2 stores the Blockly
workspace together with the exact catalog that defined its skills, primitives,
named poses, parameter schemas, and `configDigest`:

```ts
const stored = serializeRobotPlanPayload({
  catalog: liveCatalog,
  workspace: generated.workspace,
});

const parsed = parseRobotPlanPayload(stored);
if (parsed.ok) {
  const preview = compileRobotWorkspace(
    parsed.payload.workspace,
    parsed.payload.catalog,
  );
}
```

`serializeRobotPlanPayload` rejects malformed catalogs and workspaces before
storage. `parseRobotPlanPayload` accepts only the three top-level fields
`schemaVersion`, `catalog`, and `workspace`; runtime recompilation must use
`parsed.payload.catalog`, not a process-local catalog snapshot. Use
`createDefaultRobotPlanPayload()` when a new editor value is required.

## Stable identities

An action block ID is derived from:

```text
designId + planRef + stepRef
```

Changing parameters or reordering steps retains the action ID. `planStepId` is
always `step:${blockId}`. The compiler preserves both values on the derived plan
step whenever the workspace block carries an ID. `sourceMap` is the package-level
mapping; the orchestration layer adds `workflowNodeId`, explanation references,
and revision metadata.

## Frontend integration

The robot Blockly editor should:

1. parse the catalog-bound payload and register blocks from its catalog before
   loading `workspace`;
2. build skill, primitive, pose, and parameter controls from that catalog;
3. preserve generated block IDs during edits and saves;
4. retain the canonical `PARAMS_JSON` field used for catalog-declared scalar
   params outside the current `TARGET`, `PLACE`, `DIRECTION`, and `DISTANCE`
   controls, or expose an equivalent schema-driven field that serializes back to
   the same key;
5. re-run `compileRobotWorkspace` after edits and rebuild the source map from
   compiled `blockId` / `planStepId` values;
6. treat the returned plan as a preview; execution recompiles the saved
   workspace again.

The current offline SO-101 catalog remains a fixture. Production generation
should pass the live, digest-pinned RoboFrame catalog into both generation and
recompilation.
