# `@n8n/blockly-data-transform`

Pure TypeScript compiler for **Blockly Logic**, the visual logic editor embedded
inside the n8n `n8n-nodes-blockly-code.blocklyCode` community node. It covers
deterministic, per-item work that would otherwise require a small JavaScript Code
node.

The package has no Blockly, browser, network, filesystem, credential, or dynamic
code-execution dependency. A saved `workspace` is the only execution source of
truth. `payload.javascript` is a read-only preview cache; the node always
recompiles the workspace before execution.

## Payload API

```ts
type BlocklyDataPayload = {
	schemaVersion: 2;
	workspace: Record<string, unknown>;
	javascript: string;
};
```

Use `serializeBlocklyDataPayload(workspace)` to produce a canonical payload and
`parseBlocklyDataPayload(value)` to parse and canonicalize one. Schema version 2
is strict; other versions are rejected.

## Workspace grammar

Exactly one `n8n_transform_item` root is allowed. Its `MODE` field is `COPY` or
`EMPTY`, and its optional `STATEMENTS` input contains a statement chain.

### Statements

| Block | Fields | Inputs | Chain |
| --- | --- | --- | --- |
| `n8n_set_field` | `KEY` | `VALUE` | optional `next` |
| `n8n_delete_field` | `KEY` | — | optional `next` |
| `n8n_if` | — | `CONDITION`, optional `THEN`, optional `ELSE` | optional `next`; branch inputs contain statement chains |
| `n8n_assert` | — | `CONDITION`, `MESSAGE` | optional `next` |

### Input, collection, and conversion values

| Block | Fields | Inputs |
| --- | --- | --- |
| `n8n_get_field` | `PATH` | — |
| `n8n_get_path` | `PATH` | `VALUE` |
| `n8n_convert` | `TYPE`: `TEXT`, `NUMBER`, `BOOLEAN` | `VALUE` |
| `lists_create_with` | — | official Blockly list mutator; `extraState.itemCount` preserves visible slots, and empty slots compile to `null` |
| `lists_length` | — | official Blockly `VALUE` input; arrays and text return their length |
| `n8n_array_at` | — | `ARRAY`, `INDEX` |
| `n8n_array_map_path` | `PATH` | `ARRAY` |
| `n8n_array_filter_path` | `PATH`, `OP`: `EQ`, `NEQ`, `LT`, `LTE`, `GT`, `GTE` | `ARRAY`, `VALUE` |
| `n8n_object_create` | — | optional `PROPERTIES` property chain |
| `n8n_object_property` | `KEY` | `VALUE`; optional `next` property |

The existing Blockly literal, text, math, comparison, boolean, and ternary
blocks remain valid value expressions. Array mapping and filtering are bounded
operations over one existing JSON array; the grammar has no general-purpose
loop or variable block.

Input and output paths are 1–128 characters and use dot-separated object
segments. Set and delete follow the same nested-path semantics as reads, using
copy-on-write so the input item is not mutated. `n8n_object_property` uses one
literal key segment rather than a dotted path. All variants reject `__proto__`,
`prototype`, and `constructor`. Missing paths and invalid numeric conversions
produce `null`; non-array collection operations produce a neutral result (`[]`,
`0`, or `null`).

Limits and release checks are retained in
`../../../.agents/specs/blockly-data-transform-v1.md`.
