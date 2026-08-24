# `@n8n/dual-canvas-core`

This package defines the domain-independent boundary for visual programs that link a workflow
canvas with embedded Blockly canvases.

It provides:

- versioned capability, plan, trace, lifecycle, binding, and workflow-fragment contracts;
- a constrained semantic IR for data logic;
- deterministic Blockly workspace, JavaScript preview, and source-map generation;
- stable artifact identifiers;
- source import and editable dual-canvas document contracts;
- a declarative plugin manifest and generator SDK.

`LogicExpressionV1` can persist a pure registered function call as `operationCall`. The node keeps
the call, logical `operationRef`, immutable `implementationRef`, qualified-name, version, arguments,
and source-span identities instead of
expanding the function away. `generateLogicCanvas(draft, documentRef, operationCatalog)` requires
an explicit `OperationModuleCatalogV1`; use `{ apiVersion: 1, modules: [] }` when a generic lesson
has no generated operations. Registered calls become one deterministic dynamic Blockly value
block each, while the generated payload carries the same catalog needed for runtime recompilation.
Every call also receives its own source-to-block mapping in addition to the surrounding statement
mapping.

Installed node type names enter generation only through `NodeTypeBindingsV1`. A plugin owns its
capability vocabulary and workflow fragment while the core remains usable without that plugin.
`editorProfile` selects a built-in canvas adapter, while the optional `workbenchProfile` describes
domain presentation and teaching stages. Their identifiers are independent by design.
