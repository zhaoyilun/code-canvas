# Blockly Data Transform v1

## Entry card

| Field | Decision |
| --- | --- |
| Project root | Repository root |
| Base | n8n `2.35.4`, Blockly `12.3.1`, MVP commit `3d4bea91` |
| Branch | `main`（开发分支 `codex/blockly-data-transform-v1` 已并入） |
| Audience | Self-hosted n8n users who can model simple data rules but should not write JavaScript |
| Delivery | Deployable n8n fork: custom node runtime plus the smallest editor-ui integration |
| Product | `Blockly Data Transform`, technical node id remains `CUSTOM.blocklyCode` |
| Routing | Main session owns architecture, integration, acceptance, and release decision; workers own disjoint code slices |

## Acceptance card

Business PASS requires all of the following on a real local instance:

1. Node creator can search and add `Blockly Data Transform`.
2. Three real input items are transformed one-for-one using Blockly input-field blocks.
3. The UI covers field normalization, amount calculation, and conditional grading scenarios.
4. Workspace saves through the normal workflow PATCH path and survives reload plus export/import.
5. The generated JavaScript preview is read-only and matches the shared compiler output.
6. The backend ignores payload JavaScript, recompiles the workspace, and rejects unsupported or oversized workspaces.
7. Browser execution returns three valid n8n JSON items and the execution record is `success`.
8. Targeted unit/integration/E2E checks, production build, package artifact inspection, screenshots, export, and redacted runtime evidence are retained.

## Product boundary

### v1 does

```text
current input item
  → read a JSON field by dot path
  → apply text, math, comparison, boolean, and conditional expressions
  → set one or more output JSON fields
  → return one output item
```

### v1 does not

- No HTTP, credentials, database, filesystem, npm module, Python, or robot/IoT actions.
- No arbitrary JavaScript editor or escape hatch.
- No workflow routing, multi-input join, async operations, loops, or multiple output items per input.
- No binary-data editing.
- No generic Blockly plugin SDK.
- No compatibility layer or implicit migration for the MVP schema.

## Architecture decisions

1. Keep the custom node and n8n JavaScript task runner; do not add a task type.
2. Keep the minimal editor-ui fork because n8n has no NDV parameter-editor registry.
3. Add one shared pure TypeScript compiler package used by frontend and backend.
4. `workspace` is the only execution source of truth. `payload.javascript` is a read-only preview cache and is never trusted by the node runtime.
5. Bump payload schema directly from `1` to `2`; schema `1` is rejected without fallback or migration.
6. Execution mode is fixed to `runOnceForEachItem`; one input produces one output.
7. Output is JSON-only. Missing input paths evaluate to `null`.
8. Unknown, disconnected, duplicate-root, malformed, over-deep, or oversized blocks are compile errors.

## Shared package contract

Create `packages/@n8n/blockly-data-transform` with no browser or Blockly dependency.

```ts
export const BLOCKLY_DATA_SCHEMA_VERSION = 2;

export type BlocklyDataPayload = {
	schemaVersion: 2;
	workspace: Record<string, unknown>;
	javascript: string;
};

export type CompileResult =
	| { ok: true; javascript: string; blockCount: number }
	| { ok: false; error: string };

export function compileBlocklyWorkspace(workspace: unknown): CompileResult;
export function createDefaultWorkspace(): Record<string, unknown>;
export function parseBlocklyDataPayload(value: string):
	| { ok: true; payload: BlocklyDataPayload }
	| { ok: false; error: string };
export function serializeBlocklyDataPayload(workspace: Record<string, unknown>): string;
```

Limits:

| Limit | Value |
| --- | --- |
| Encoded payload | 256 KiB |
| Blocks | 200 |
| Block nesting / next-chain depth | 40 |
| Field path or output key | 128 characters |
| Text literal | 1,000 characters |
| Generated JavaScript | 64 KiB |

Reject `__proto__`, `prototype`, and `constructor` in field paths and output keys.

## Supported workspace grammar

Exactly one top-level `n8n_transform_item` root is allowed. Every serialized block must be reachable from it.

| Block | Role |
| --- | --- |
| `n8n_transform_item` | Root; output starts from a copy of `$json` or an empty object |
| `n8n_set_field` | Statement; set one output key to a value and chain to the next statement |
| `n8n_get_field` | Value; read current `$json` by dot path, returning `null` when missing |
| `math_number` | Numeric literal |
| `math_arithmetic` | Add, subtract, multiply, divide, power |
| `text` | Text literal |
| `text_join` | Join value expressions as text |
| `logic_boolean` | Boolean literal |
| `logic_compare` | Equality and ordered comparison |
| `logic_operation` | Boolean AND/OR |
| `logic_negate` | Boolean NOT |
| `logic_ternary` | Conditional value |

Generated code is a fixed template containing only field reads, expression evaluation, output assignments, and `return { json: output }`.

## Frontend behavior

- Toolbox contains only the supported grammar; remove variables and loops.
- Register the three n8n blocks with Blockly but generate code through the shared compiler.
- Default workspace copies input and sets `processed` to `true`.
- Show a read-only generated JavaScript preview.
- Show a localized compile error without discarding the workspace.
- Save intermediate invalid workspaces with an empty preview string so users can finish editing; execution remains blocked until compilation succeeds.
- Resize Blockly when its NDV container changes.
- Keep all text in `@n8n/i18n` and use design-system semantic tokens.

## Node runtime behavior

- Display name: `Blockly Data Transform`; technical name remains `blocklyCode`.
- Add `parameterPane: 'wide'` and `noDataExpression: true`.
- Parse schema `2`, compile `workspace` on the backend, and ignore supplied JavaScript.
- Execute with `runOnceForEachItem` in chunks of 1,000 input items.
- Return an empty output for empty input.
- Validate result count and every result's `json` object.
- Wrap compiler and runner failures in concise `NodeOperationError` messages without logging payload or generated code.
- Add a generic JSON output schema so the schema endpoint no longer returns 404.

## Test and release matrix

### Shared compiler

- [x] Default workspace compiles deterministically.
- [x] Every supported expression compiles.
- [x] Missing paths return `null`.
- [x] Unknown/disconnected/duplicate-root/malformed blocks fail.
- [x] Dangerous keys and all size/depth limits fail.
- [x] Payload schema `1` and stale JavaScript behavior are explicit.

### Frontend

- [x] Toolbox and custom blocks match the grammar.
- [x] Valid workspace shows canonical preview.
- [x] Invalid workspace remains saved and shows an error.
- [x] Reload, read-only, resize, and parameter integration pass.
- [x] Existing non-Blockly parameter editors are unchanged.

### Runtime

- [x] Three inputs produce three outputs in order.
- [x] Empty input returns empty output.
- [x] Payload JavaScript tampering has no effect.
- [x] Compiler, runner, result-count, and invalid-result errors are covered.
- [x] Secure runner is required for release evidence.

### End to end and packaging

- [x] Fixture covers normalization, amount calculation, and conditional grading.
- [x] UI add/edit/save/reload/execute passes in Playwright.
- [x] Official export/import preserves workspace and results.
- [x] `/schemas/CUSTOM.blocklyCode/1.0.0.json` returns 200.
- [x] Custom-node package and deployable fork artifact contain no runtime data, logs, screenshots, `.env`, secrets, or private paths.
- [x] Rollback rehearsal restores the MVP commit and removes isolated runtime data.

## Intended files

```text
.agents/specs/blockly-data-transform-v1.md
packages/@n8n/blockly-data-transform/**
packages/frontend/editor-ui/src/features/shared/editors/components/BlocklyEditor/**
packages/frontend/@n8n/i18n/src/locales/en.json
custom-nodes/n8n-nodes-blockly-code/**
scripts/blockly-v1/**
docs/blockly-v1/**
```

Do not add database migrations, REST endpoints, a new runner, or unrelated editor abstractions.

## Implementation TODO

- [x] Shared compiler and schema-2 payload package.
- [x] Blockly v1 toolbox, custom blocks, preview, errors, and resize behavior.
- [x] Backend recompilation, per-item execution, output schema, and tests.
- [x] Three-scenario fixture, verifier, runbook, and package/deploy checks.
- [x] Automated browser acceptance and final spec-alignment review.

## Final evidence — 2026-08-21

- Shared compiler: 16 tests passed; package typecheck, lint, and build passed.
- Custom node: 18 tests passed; package typecheck, official community-node lint, build, and bundled CJS load passed.
- Frontend: 3 targeted Blockly tests passed; editor-ui lint, stylelint, and production build passed (`built in 9.73s`); i18n typecheck, lint, and build passed.
- Full editor-ui typecheck has exactly two unrelated existing errors in `CanvasNodeDefault.test.ts` for `--canvas-node--height` and `--canvas-node--width`; it reports no Blockly path error.
- Real browser execution ID `7` succeeded in `57ms`; the final node returned three items with totals `150`, `80`, `120` and grades `gold`, `standard`, `gold`.
- Node creator search/add, a real Blockly drag, invalid intermediate save/reload, valid save/reload, read-only preview, and imported-node workspace were observed through the `blockly-mvp` Playwright session. Screenshots are retained under the ignored `output/playwright/` evidence directory.
- The official UI export passed `verify-v1.mjs`, was imported into a fresh isolated n8n user folder, and reproduced all three expected outputs through `verify-execution.mjs`.
- A schema-2 workflow with an unchanged workspace and tampered preview JavaScript reproduced the same three outputs; `verify-execution.mjs --expect-tampered-preview` passed.
- `/healthz` and `/schemas/CUSTOM.blocklyCode/1.0.0.json` both returned HTTP 200.
- The live JavaScript runner process used `--disallow-code-generation-from-strings --disable-proto=delete`; `N8N_RUNNERS_INSECURE_MODE=false` was explicit.
- Actual shared and custom-node tarballs passed full source-map/private-path and runtime-artifact scans. The packed custom node loaded in a temporary host that supplied `n8n-workflow` but did not supply `@n8n/blockly-data-transform`, proving the compiler was bundled.
- A detached temporary worktree reached MVP commit `3d4bea91` with all v1 files absent, and the isolated rollback rehearsal directory was removed without touching the live demo runtime.
