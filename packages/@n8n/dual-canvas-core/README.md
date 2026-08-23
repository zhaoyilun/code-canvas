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

Installed node type names enter generation only through `NodeTypeBindingsV1`. A plugin owns its
capability vocabulary and workflow fragment while the core remains usable without that plugin.
`editorProfile` selects a built-in canvas adapter, while the optional `workbenchProfile` describes
domain presentation and teaching stages. Their identifiers are independent by design.
