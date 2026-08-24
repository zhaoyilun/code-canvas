# `@n8n/dual-canvas-typescript-importer`

This package turns a deliberately small JavaScript, TypeScript, or TypeScript-compatible ArkTS
data-transformation function into dual-canvas artifacts. Version one accepts only source forms whose
runtime result is equivalent to the generated `@n8n/blockly-data-transform` program:

- `VisualProgramIRV1`;
- a generic Blockly Logic workspace and canonical payload;
- source-span mappings for the outer workflow node, every statement block, and every registered call;
- a minimal n8n workflow fragment containing a manual trigger followed by a Blockly Code node;
- a linked `DualCanvasDocumentV1`.

Installed n8n node type names are supplied by `NodeTypeBindingsV1`. The importer does not embed
environment-specific node type names.

## Frozen source subset

The selected entry function has one plain input parameter. Its first statement initializes
`output`, and its final statement returns it:

```ts
export function transform(input: Input) {
	const output = { ...input }; // `const output = {};` is also supported
	output.total = Number(input.amount) * 1.2;
	return output;
}
```

Input reads use an explicit null-normalized optional path because Blockly data-transform reads map
missing or null values to `null`:

```ts
output.score = input?.score ?? null;
output.firstTag = input?.profile?.tags?.[0] ?? null;
```

Direct reads such as `input.score` and partially optional paths are diagnosed before artifact
generation. This makes a missing field produce the same result on both sides instead of JavaScript's
`undefined` on one side and Blockly's `null` on the other.

The statements between the frozen boundaries may contain:

- assignments to and deletion of top-level static `output` fields;
- numeric, text, boolean, array, and explicit object literals;
- null-normalized fully optional static input paths;
- `Boolean` conversions, plus `Number` and `String` conversions of supported primitive literals;
- arithmetic, strict comparisons, boolean operations, negation, and conditional expressions;
- `if`/`else`, including nested branches;
- throwing validation guards in the exact form `if (!condition) { throw new Error(message); }`.

In this source subset, both assertion spellings become a throwing validation block. Nested output
assignment or deletion, arbitrary property/index reads, negative bracket indexes, nullable
`Number`/`String` conversions, `assert(...)`/`console.assert(...)` calls, and other result-changing forms produce
`SOURCE_SEMANTICS_MISMATCH`. For example, `Number(null)` is `0` in JavaScript while the Blockly
number conversion preserves it as `null`; `String(null)` is similarly different. Nested writes after
`const output = { ...input }` are also excluded because JavaScript mutates the shared nested object
while Blockly clones that parent path. Assertion calls are excluded because `console.assert` only logs
in JavaScript, whereas a Blockly validation block throws; the accepted explicit throwing guard has the
same terminal behavior on both sides.

Other syntax outside the subset produces versioned diagnostics with a 1-based line, 0-based column,
and UTF-16 source offset. ArkTS support covers its TypeScript-compatible data-transformation syntax;
UI component DSL syntax is reported at its source location. Source import parses syntax and does not
execute the submitted program. Accepted artifacts record
`source-semantics.blockly-data-transform-equivalent.v1` in metadata.

## Registered and missing operations

Every import request carries an explicit `OperationModuleCatalogV1`. A static identifier or
property call is resolved by exact qualified name and arity. A match becomes a persistent
`operationCall` expression and one dynamic Blockly value block; the block and payload retain the
logical operation reference, immutable implementation reference, and exact version for deterministic
recompilation. Nested registered calls remain
nested operation blocks.

A call with no exact match (including a known name with the wrong arity) produces
`OPERATION_MODULE_MISSING`. Calls with the same qualified name and arity are aggregated into one
`ModuleScaffoldRequestV1` in `diagnostic.details`:

```ts
output.low = clamp(-2, 0, 10);
output.high = clamp(12, 0, 10);
output.other = tools.math.clamp(input?.value ?? null, 0, 10);
```

The request contains document/revision/source scope, exact AST-derived call text, call and argument
source spans, JSON-safe literal values, and conservative type hints. Static calls nested in another
unknown call's arguments are recursively discovered and independently aggregated. The request
deliberately lists behavior, effect, parameter names, input types, null handling, output type, and
test vectors as decisions instead of inferring them from a function name. Dynamic, computed,
optional, spread-argument, and call-result invocations stay on the located syntax-diagnostic route.

`createOperationModuleTemplateV1(request)` from `@n8n/dual-canvas-operation-sdk` supplies a stable
JSON shell for AI or human generation. That shell is only generation input. Admission requires a
strict `OperationModuleAdmissionV1` envelope pairing the request with an `OperationModuleSpecV1`,
including a bounded declarative expression and at least three test vectors. Async work,
network/device access, and other effects route to a capability/plugin package. Operation
registration uses `createOperationModuleCatalogV1({ apiVersion: 1, modules: [spec] })`; it validates
the strict specs, executes every test vector, rejects identity conflicts, and returns the canonical
catalog supplied to the next import.

See [`examples/score-normalizer.ts`](examples/score-normalizer.ts) for a domain-independent input.

## API

```ts
import { importTypeScriptSource } from '@n8n/dual-canvas-typescript-importer';

const result = importTypeScriptSource({
	apiVersion: 1,
	documentRef: 'lesson.score-normalizer',
	revisionRef: 'revision.1',
	title: 'Score normalizer',
	profileRef: 'teaching.data-transform',
	entryFunction: 'transform',
	operationCatalog: { apiVersion: 1, modules: [] },
	source: {
		apiVersion: 1,
		sourceRef: 'source.main',
		language: 'typescript',
		content: SOURCE,
	},
	bindings: {
		apiVersion: 1,
		packageName: 'n8n-nodes-teaching',
		nodeTypes: {
			manual: 'n8n-nodes-base.manualTrigger',
			logic: 'n8n-nodes-teaching.blocklyCode',
		},
	},
	workflow: {
		manualTrigger: { bindingRef: 'manual', typeVersion: 1, label: 'Start' },
		blocklyCode: { bindingRef: 'logic', typeVersion: 1, label: 'Transform data' },
	},
	canvasAdapterRef: 'blockly.data-transform.v1',
});
```

`importTypeScriptSource` returns the complete document, workflow, canvas, and IR artifact. The
package also exports a core-compatible `SourceImporterV1` implementation; its `importSource` method
returns only `VisualProgramIRV1` as required by the generic contract. Core import options contain
the source entry name, display title, and pure-operation catalog; installed node bindings, workflow
layout, and canvas adapter selection belong to the later assembly API:

```ts
import { typescriptSourceImporterV1 } from '@n8n/dual-canvas-typescript-importer';

const programResult = typescriptSourceImporterV1.importSource({
	apiVersion: 1,
	documentRef: 'lesson.score-normalizer',
	revisionRef: 'revision.1',
	profileRef: 'teaching.data-transform',
	source: {
		apiVersion: 1,
		sourceRef: 'source.main',
		language: 'typescript',
		content: SOURCE,
	},
	options: {
		apiVersion: 1,
		title: 'Score normalizer',
		entryFunction: 'transform',
		operationCatalog: { apiVersion: 1, modules: [] },
	},
});
```
