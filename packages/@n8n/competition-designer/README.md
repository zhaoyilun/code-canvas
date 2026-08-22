# @n8n/competition-designer

Deterministic design-time compiler for the competition workflow. n8n remains the macro workflow
and execution source of truth. Blockly appears inside the n8n nodes that need visual local logic:

- `CUSTOM.blocklyCode` holds data calculation, normalization and bounded local decisions;
- `CUSTOM.robotSkillPlan` holds physical robot skills, primitives, poses and short waits;
- standard n8n nodes keep orchestration, readiness branching, approval, merge and result routing;
- RoboFrame nodes keep robot validation and execution.

## Strict design draft v2

The AI submits semantic intent rather than workflow JSON, Blockly JSON or source code. Version 1
drafts are rejected directly. `logicNodes` is required and may be an empty array.

```ts
{
  schemaVersion: '2.0',
  designId: 'lesson.pick-and-place',
  revisionId: 'revision-2',
  name: 'Explainable robot lesson',
  logicNodes: [{
    nodeRef: 'normalize-input',
    label: 'Normalize Input',
    outputMode: 'copyInput',
    statements: [{
	  kind: 'set',
      intentStepId: 'calculate-total',
      targetField: 'total',
      value: {
        kind: 'arithmetic',
        op: 'multiply',
        left: { kind: 'input', path: 'price' },
        right: { kind: 'number', value: 1.2 },
      },
    }],
  }],
  robotPlan: { /* constrained RobotPlanDraft */ },
}
```

The Blockly Logic statement union maps only to set field, delete field, bounded IF/ELSE and
assertion blocks. Its value union covers input/path reads, conversion, lists, list length/index,
list path map/filter, object construction, finite numbers, text, booleans, arithmetic, comparison,
AND/OR, NOT, conditional values and text join. `lists_create_with` receives an exact
`extraState.itemCount` plus continuous `ADD0..ADDn` inputs, so its visual slots and execution value
stay aligned. There is no arbitrary code field. Each generated workspace is recompiled by
`@n8n/blockly-data-transform` before its schema-2 payload is accepted.

## Generated macro workflow

Each Blockly Logic node is placed linearly between the trigger and robot readiness check:

```text
Manual Trigger
  → Blockly Logic 0..n (CUSTOM.blocklyCode)
  → Robot Status
  → IF robot ready
    ├→ Robot Plan (Blockly robot detail)
    │  → Robot Validate (plan)
    │  ├→ Wait (approval form) → IF approved ─┐
    │  └──────────────────────────────────────→ Merge validated plan + decision
    │                                           → Robot Task
    │                                           → IF completed
    │                                             ├→ Completed
    │                                             └→ Needs Inspection
    └→ Robot Not Ready

Approval IF false → Rejected
```

`validateCompetitionWorkflow()` adds project rules beyond the generic workflow SDK:

- every Blockly Logic node carries a parseable schema-2 data payload;
- an arbitrary n8n Code node is rejected from the generated competition graph;
- a robot task has status, plan validation, a decision form and an explicit rejected branch;
- approved form data is merged back with the digest-pinned validated plan;
- robot execution results branch into completed versus inspection paths;
- generic HTTP Request nodes do not call robot action endpoints.

## Teaching trace

Every semantic statement has a stable trace:

```text
intentStepId → n8nNodeId → blockId
```

Logic entries additionally retain `logicNodeRef`, statement kind and `targetField` when relevant.
Robot entries retain the
compiled `planStepId` and execution-node ID. The teaching UI can therefore open the correct n8n
node, highlight the exact Blockly block and relate it to generated JavaScript preview or RoboFrame
runtime execution without treating preview code as an execution source.

The generated workflow remains a review draft with
`meta.competitionDesign.reviewState = 'review_required'`. Publishing and device execution stay as
explicit n8n operations.
