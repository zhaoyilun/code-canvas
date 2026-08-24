# `@n8n/dual-canvas-operation-runtime`

This leaf package is the single runtime contract for generated pure operations used by the generic
dual-canvas editor. It provides a strict declarative expression schema, deterministic evaluation,
test-vector verification, an immutable canonical catalog, exact module resolution, and plain-data
Blockly block descriptors.

`operationRef` names the logical operation. `implementationRef` is the immutable UUIDv5 identity of
its canonical semantic projection. `finalizeOperationModuleSpecV1(draft)` replaces the draft's
required `implementationRef: null` with that host-derived identity. The projection includes the
ordered parameter contract and expression, while request evidence, explanatory text, and test
vectors remain outside implementation identity. Final specs and catalogs rederive the reference and
reject any mismatch; Blockly block types include both identities.

The catalog contains data only. Operation expressions are interpreted by a bounded evaluator; they
never contain JavaScript source or dynamically constructed functions. Catalog creation revalidates
every module and executes every declared test vector before the module becomes available to import,
render, or compile.
