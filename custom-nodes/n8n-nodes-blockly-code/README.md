# Blockly Data Transform

`Blockly Data Transform` transforms every incoming n8n item with a Blockly workspace. Its technical node type remains `CUSTOM.blocklyCode` for existing node-file compatibility.

## v1 behavior

- The node always runs once per input item and returns exactly one JSON item per input item.
- The workspace is the execution source of truth. The saved `javascript` preview is ignored at runtime and the node recompiles the workspace before execution.
- Execution uses n8n's JavaScript task runner in chunks of 1,000 items.
- The output is JSON only. Binary data, routing, loops, async operations, external I/O, credentials, and arbitrary JavaScript are unsupported.
- Payload schema version 1 is rejected. Use schema version 2 workspaces created by the Blockly editor.

## Development

Build the shared compiler first from the repository root, then run the node checks:

```bash
pnpm --filter @n8n/blockly-data-transform build
cd custom-nodes/n8n-nodes-blockly-code
pnpm test
pnpm typecheck
pnpm lint
pnpm build
pnpm pack --dry-run
```

`@n8n/blockly-data-transform` provides the payload parser and compiler used by both the editor and runtime. It is a build-time dependency of this package and is bundled into the compiled node with esbuild. The published custom-node artifact has no runtime dependency other than the host-provided `n8n-workflow` peer.
