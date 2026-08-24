# Unknown operation generation and registration

## Purpose

The generic dual-canvas importer keeps a deliberately small built-in grammar while allowing a
lesson to introduce a new pure helper without adding handwritten TypeScript or JavaScript code:

```text
static unknown call
  -> OPERATION_MODULE_MISSING
  -> ModuleScaffoldRequestV1 (AST evidence)
  -> OperationModuleTemplateV1 (fixed generation shell)
  -> AI or human completes strict OperationModuleDraftSpecV1 JSON (implementationRef: null)
  -> host finalizeOperationModuleSpecV1 derives immutable implementationRef
  -> expression and test-vector admission
  -> OperationModuleCatalogV1
  -> registered re-import
  -> operationCall IR
  -> dynamic Blockly value block
  -> canonical JavaScript compiled from workspace + catalog
```

The generator fills a bounded declarative JSON specification. It never supplies executable source,
a Blockly generator, or a frontend component. The host owns validation, block definition, toolbox
metadata, code generation, and execution.

## Example: `clampScore`

```ts
function transform(input) {
	const output = {};
	output.score = clampScore(input?.score ?? null, 0, 100);
	return output;
}
```

The first import emits one `OPERATION_MODULE_MISSING` diagnostic whose `details` value is a complete
`ModuleScaffoldRequestV1`. The call has a deterministic `callRef`, exact `callText`, source span, and
three independently spanned arguments. Request and call references are scoped by document,
revision, and source. Repeating the import produces byte-identical evidence.

`createOperationModuleTemplateV1(request)` then produces the fixed logical identity and parameter
slots, while leaving `implementationRef` as `null`. A completed draft declares names, JSON types,
null handling, output type, a bounded expression tree, and three to 32 test vectors. The host calls
`finalizeOperationModuleSpecV1(draft)` to derive the immutable implementation identity from the
canonical semantic fields. For this example the expression is equivalent to:

```text
value === null ? null : value < minimum ? minimum : value > maximum ? maximum : value
```

The admitted vectors cover below-range, in-range, above-range, and null input.

## Admission and registry boundary

The operation runtime is a domain-independent leaf package. It:

- parses strict expression, module, catalog, and block-descriptor schemas;
- caps expression depth at 16 and expression nodes at 128;
- checks parameter references, arity, JSON types, and null policies;
- evaluates every declared test vector before catalog admission;
- canonically sorts modules;
- derives and rechecks `implementationRef` from the complete execution and Blockly ABI semantics;
- rejects duplicate logical identity, implementation identity, signature/version, and generated block type;
- derives a stable Blockly type from `operationRef + implementationRef + version`;
- evaluates only the declarative expression tree.

`OperationModuleAdmissionV1` additionally binds a spec to its discovery request by `requestRef`,
`qualifiedName`, `arity`, deterministic logical identity, parameter slots, and the host-derived
implementation identity. Changing expression, parameter ABI, output contract, or execution
semantics creates a different `implementationRef` and Blockly type; changing request evidence,
behavior prose, or test vectors alone keeps the implementation identity stable. Side effects,
asynchronous work, network/device access, and other capabilities stay on the plugin route.

## Persistent visual model

After catalog registration, the same source imports as an `operationCall` expression. The Blockly
workspace stores one named dynamic value block per call, with `ARG0..ARGn` inputs and exact logical
operation, implementation, and version fields. It does not expand the function into anonymous
primitive blocks, so the lesson keeps module identity and each call keeps its own source mapping.

Blockly payload schema 3 carries the catalog beside the workspace. The editor derives JSON block
definitions and a **Function modules** toolbox category from that catalog. The production community
node ignores the saved JavaScript preview and recompiles the workspace against the same catalog,
so editing preview text does not change execution.

## Acceptance

```bash
node scripts/education/unknown-operation-runtime-acceptance.mjs --check
node --test scripts/education/unknown-operation-runtime-acceptance.test.mjs
node scripts/education/unknown-operation-runtime-acceptance.mjs
```

The quick gate checks discovery, template/spec admission, test vectors, registry, registered
re-import, call-level mapping, dynamic workspace, payload round-trip, and `node:vm` equivalence. The
full gate additionally installs the packed community node into an isolated real n8n runtime and
requires `{ score: 100, pairedItem: 0 }` for input `{ score: 125 }`.

RoboFrame remains an independent plugin. The operation runtime, SDK, importer, data-transform
compiler, and acceptance sample contain no robot, device, GPIO, or competition dependency.
