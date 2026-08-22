# @n8n/competition-designer

Deterministic design-time support for the competition workflow. One constrained semantic draft
produces both the Blockly robot plan and the review-gated n8n workflow. The package keeps n8n as
the macro workflow source of truth and embeds the serialized Blockly plan in a Robot Skill Plan
node.

The first software slice generates this reviewed execution chain:

```text
Manual Trigger
  → Robot Status
  → IF robot ready
    ├→ Robot Skill Plan (compile)
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

It deliberately reuses `@n8n/workflow-sdk` for node IDs, connections, layout and workflow JSON.
`validateCompetitionWorkflow()` adds the project-specific rules that the generic SDK does not know:

- a robot task has status, plan validation, a decision form and an explicit rejected branch;
- approved form data is merged back with the digest-pinned validated plan;
- robot execution results branch into completed versus inspection paths;
- Robot Skill Plan stays a pure compiler node;
- a serialized Blockly payload is present;
- a generic HTTP Request node does not call robot action endpoints.

`generateCompetitionDesign()` also emits a stable
`intentStepId → blockId → planStepId → n8n node` trace map, so the teaching UI can highlight the
same decision across natural-language intent, Blockly, the compiled plan and runtime execution.
The normalized semantic draft remains beside the runtime artifacts, preserving each step's
`what`, `why`, editable fields and expected effect for the teaching explanation panel.

The generated workflow is a draft with `meta.competitionDesign.reviewState` set to
`review_required`. Publishing and device execution remain explicit n8n operations.
