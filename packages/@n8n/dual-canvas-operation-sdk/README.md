# `@n8n/dual-canvas-operation-sdk`

This package defines the admission boundary for source calls that do not yet have a visual operation.

- `ModuleScaffoldRequestV1` records only AST evidence: document/revision/source scope, static
  qualified name, arity, exact call and argument spans, literal values, and conservative type hints.
  Unknown behavior is left as a required decision.
- `createOperationModuleTemplateV1` turns a request into a deterministic JSON shell for an AI or a
  human author. Its constraints describe the target module; they are not a claim about the source call.
- `OperationModuleSpecV1` admits only synchronous, deterministic, side-effect-free JSON-to-JSON
  expressions. It requires three or more test vectors and validates parameter references plus
  expression depth and node-count limits.
- `OperationModuleAdmissionV1` binds a final spec back to its scaffold request by `requestRef`,
  qualified name, and arity; the spec also requires its parameter count to equal that arity.

The public argument, request, expression, spec, and admission schemas run iterative depth, node, and
cycle preflights before recursive Zod parsing. Extreme or cyclic untrusted AI JSON therefore returns
a schema failure through `safeParse` rather than entering an unbounded recursive parser.

Calls that need asynchronous work, network access, device access, or any other side effect belong in
a capability/plugin package. The operation contract contains no executable source, `eval`, dynamic
function construction, registry, Blockly block definition, or runtime dispatch.
