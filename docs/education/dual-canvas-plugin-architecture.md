# Generic Dual-Canvas Teaching Architecture

## Decision

The education product is split into three independently owned layers:

```text
Generic dual-canvas core
        ^
        | DualCanvasPluginV1
Domain plugin, such as RoboFrame
        ^
        | Catalog / Plan / Lifecycle / Trace
Device-side bridge and runtime
```

The dependency direction is always `domain plugin -> dual-canvas core`. Production code in the
core does not import a domain plugin.

This architecture is based on branch `codex/education-generic-dual-canvas`, created from
`5ea2842c925ac1c9bf3c70803e9c1184fba99fad`.

## Product model

Multiple importers converge on one constrained intermediate representation:

```text
Natural language -> structured AI importer --+
JS/TS/ArkTS     -> syntax-tree importer ------+-> VisualProgramIR
Course template -> template importer ---------+
                                                   |
                               +-------------------+-------------------+
                               |                                       |
                               v                                       v
                        n8n WorkflowJSON                      Blockly workspaces
                        macro orchestration                   local teaching logic
```

The imported source is retained as a revision snapshot. After a proposal is reviewed and applied,
the n8n workflow and its linked Blockly workspaces are the editable truth. Code previews and
execution plans are derived artifacts.

## Generic core ownership

The generic core owns:

- `VisualProgramIR` schemas and diagnostics;
- source import contracts;
- stable node, block, step, and source-span mappings;
- deterministic n8n workflow and Blockly generation;
- generic data-transform Blockly semantics;
- generic capability-plan semantics;
- validation, revision, and source/artifact mapping metadata;
- a declarative Blockly editor host;
- a profile-driven teaching workbench;
- the public plugin SDK.

The initial permanent language adapter covers the source-equivalent JS/TS/ArkTS teaching subset
using the TypeScript Compiler API. It parses source into semantic logic IR and then uses the same
deterministic Blockly generator as hand-authored logic. It exports a concrete `SourceImporterV1`
whose core-contract method returns `VisualProgramIRV1`; its higher-level API additionally assembles
the linked workflow, canvas, and document. The core import request needs only source identity,
`title`, and `entryFunction`; installed node bindings, workflow layout, and the canvas adapter enter
only during that later assembly stage. Additional languages implement the same importer contract.

### JS/TS/ArkTS source boundary

The language adapter accepts one named transformation function with one plain input parameter. The
first statement is either `const output = { ...input };` or `const output = {};`, and the final
statement is `return output;`. Between those boundaries the version-one subset supports:

- fully optional static input paths normalized with `?? null` and top-level output-field assignment
  or deletion;
- number, text, boolean, array, and explicit object literals;
- `Boolean` conversions, plus `Number` and `String` conversions of supported primitive literals;
- arithmetic, strict comparison, boolean, negation, and conditional expressions;
- `if`/`else`, nested branches, and explicit throwing validation guards of the form
  `if (!condition) { throw new Error(message); }`.

This boundary is semantic rather than merely syntactic. Blockly data-transform intentionally maps a
missing read to `null`, uses relative array indexing, normalizes nullable number/text conversions,
and clones parent objects during nested writes. Plain JavaScript differs at each of those points.
Version one therefore rejects direct or partially optional input reads, negative or arbitrary bracket
indexes, nullable `Number`/`String` conversions, and nested output assignment/deletion. In particular,
nested writes after `{ ...input }` would mutate a shared reference in JavaScript but not in the
generated Blockly program. `assert(...)` and `console.assert(...)` calls are also rejected because
their JavaScript behavior does not match a throwing Blockly validation block. Accepted imports carry
`source-semantics.blockly-data-transform-equivalent.v1`; rejected result-changing forms carry a
located `SOURCE_SEMANTICS_MISMATCH` diagnostic.

ArkTS means the TypeScript-compatible data-transformation subset. ArkUI decorators, `struct`
components, builder DSL, imports, loops, asynchronous functions, arbitrary calls, and other syntax
outside this subset produce structured diagnostics with 1-based lines, 0-based columns, and UTF-16
offsets. Source import does not evaluate the submitted program.

## Domain plugin ownership

A domain plugin owns:

- capability catalog normalization;
- domain-specific validation;
- plan conversion;
- workflow fragments and node-type bindings;
- credentials and protocol clients;
- domain copy, icons, examples, and fixtures;
- execution-trace normalization.

RoboFrame-specific concepts such as robot identity, skills, primitives, named poses, motion
authorization, SO-101 fixtures, and bridge routes live in the RoboFrame plugin or device runtime.

## Stable plugin data plane

The public version-one data plane contains six versioned contracts:

1. `CapabilityCatalogV1`
2. `ExecutionPlanV1`
3. `TraceEntryV1`
4. `ExecutionEventV1`
5. `NodeTypeBindingsV1`
6. `WorkflowFragmentV1`

For a capability-plan domain plugin, the minimum plugin surface is:

```ts
export interface DualCanvasPluginV1 {
	manifest: {
		apiVersion: 1;
		id: string;
		n8nPackage: string;
		editorProfile: 'capability-plan';
	};

	normalizeCatalog(raw: unknown): Result<CapabilityCatalogV1>;
	generatePlan(draft: unknown, context: PluginGenerationContextV1): Result<PlanArtifactV1>;
	buildWorkflowFragment(
		artifact: PlanArtifactV1,
		bindings: NodeTypeBindingsV1,
	): Result<WorkflowFragmentV1>;
	validateWorkflow(fragment: WorkflowFragmentV1): DiagnosticV1[];
}
```

Installed node types are supplied through `NodeTypeBindingsV1`; generators do not hard-code a
development-only `CUSTOM.*` prefix.

## Editor extension rule

The core frontend provides one declarative Blockly editor host with two independent profile axes:

1. **`editorProfile` selects Blockly grammar and payload adapter for one node parameter.** It is
   carried by `typeOptions.editorProfile`. Generic capability-plan nodes use
   `editorProfile = 'capability-plan'`; generic data transformations use
   `editorProfile = 'data-transform'`. A domain plugin using capability-plan semantics therefore
   declares `manifest.editorProfile = 'capability-plan'` and emits the same value in its node
   parameter metadata.
2. **`workbenchProfile` selects workflow-level teaching presentation.** Its serialized form is
   `workflow.meta.visualProgramming`, whose `profileId`, display name, brand, stages, node-type
   membership, and capability summaries drive the header and workflow canvas. This is separate
   from the Blockly adapter ID. `workflowVisualProgrammingProfileV1Schema` is the one serialized
   schema for this field. A plugin manifest keeps the portable `workbenchProfileDescriptorV1Schema`
   form with node roles; the shared `resolveWorkflowVisualProgrammingProfileV1` resolver projects
   that descriptor through `NodeTypeBindingsV1` into installed node-type names before serialization.

Changing a workbench profile does not change the Blockly grammar. Selecting `capability-plan` does
not select domain branding or workflow stages. Domain packages supply capability catalogs and
serialized workbench-profile data; they do not add a new editor adapter by patching Vue components.

## RoboFrame distribution boundary

The RoboFrame integration is distributed as an independent n8n community package plus versioned
contracts and fixtures. The hardware group owns the bridge implementation and device deployment.
The plugin owns the bridge client and validates the six shared data-plane contracts.

## Acceptance gates

### Generic core gate

- The core builds and runs with the RoboFrame plugin absent.
- A generic teaching example imports source, generates both canvases, exports and reloads JSON, and
  compiles the Blockly payload.
- Supported source input has complete source-span, workflow-node, canvas, and block mappings;
  runtime adapters attach trace mappings when execution begins.
- Identical normalized input produces identical normalized artifacts.
- Production imports from core packages to RoboFrame packages equal zero.

The checked-in generic acceptance example is generated by
`node scripts/education/generic-dual-canvas-example.mjs` and verified by
`node --test scripts/education/generic-dual-canvas-example.test.mjs`. Its auditable export is
`docs/education/examples/generic-score-normalizer.dual-canvas.json`. The acceptance run uses the
installed node types `n8n-nodes-base.manualTrigger` and
`n8n-nodes-blockly-code.blocklyCode`, compiles the Blockly payload, checks every source mapping,
round-trips JSON, and proves repeated generation is byte-identical with only the generic runtime
dependency closure.

### Plugin gate

- The RoboFrame package builds with versioned dependencies outside the n8n monorepo.
- Installation through an npm tarball registers nodes and credentials with their installed names.
- Installing the plugin adds its serialized workbench-profile data without adding a new Blockly
  editor adapter or editing core source.
- The existing Chinese RoboFrame classroom workflow remains semantically equivalent.
- Catalog revision, validation, execution state, cancellation, terminal state, and trace fixtures
  pass contract tests.

### Integration gate

- The generic example passes with the plugin absent.
- The RoboFrame example passes after plugin installation.
- Mock and device evidence remain separately labeled.
- Export and import preserve both canvases, stable IDs, profile metadata, and mappings.
