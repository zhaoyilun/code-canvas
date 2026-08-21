# `@n8n/blockly-data-transform`

Shared schema-2 payload parser and deterministic workspace compiler for the
`Blockly Data Transform` editor and custom node runtime.

The package has no Blockly or browser dependency. A saved workspace is the
execution source of truth; generated JavaScript is only a preview cache. The
runtime must compile the workspace again and must never execute the cached
preview.

Supported blocks, limits, and release checks are defined in
`../../../.agents/specs/blockly-data-transform-v1.md`.
