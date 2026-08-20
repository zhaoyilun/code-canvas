# Blockly Code MVP acceptance helper

This directory contains a repeatable local acceptance path for n8n `2.35.4` and
`custom-nodes/n8n-nodes-blockly-code`. It uses an isolated user folder at
`scripts/blockly-mvp/.runtime/n8n-user` unless `N8N_USER_FOLDER` is already set.
No script deletes that folder, changes system configuration, supplies credentials,
or enables insecure task-runner mode.

The custom-node package root and load directory are separate. By default the
package root is `custom-nodes/n8n-nodes-blockly-code`, while
`N8N_CUSTOM_EXTENSIONS` points to its compiled `dist` directory. Override them
with `N8N_BLOCKLY_EXTENSION_ROOT` and `N8N_BLOCKLY_EXTENSION_DIST` if needed.

## Prerequisites

Build the n8n CLI and the custom extension by their existing package commands.
The helper deliberately does not build either artifact, so it cannot write outside
`scripts/blockly-mvp/` as part of its normal operation. It requires:

- `packages/cli/dist/command-registry.js`
- `custom-nodes/n8n-nodes-blockly-code/dist/nodes/BlocklyCode/BlocklyCode.node.js`

`n8n start` initializes the task runner. In n8n `2.35.4` the default is internal
mode; these scripts do not set `N8N_RUNNERS_INSECURE_MODE` or any runner token.

## Commands

```bash
# No writes: validates the workflow payload and reports missing build artifacts.
scripts/blockly-mvp/setup-demo.sh --check

# Starts n8n with the isolated user folder, custom extension, and a timestamped log.
scripts/blockly-mvp/run-demo.sh
```

The CLI import can initialize the isolated database and import the fixture before
browser setup. Start the server after the import:

```bash
scripts/blockly-mvp/setup-demo.sh --import
scripts/blockly-mvp/run-demo.sh
```

To enter the authenticated editor, complete n8n's owner setup in the browser.
Then select **Blockly Code MVP Demo** and use **Execute workflow**. The fixture has
a Manual Trigger followed by the custom
`CUSTOM.blocklyCode` node. Its `blocklyPayload` contains schema
version `1`, an `n8n_return_output.VALUE` input connected to `math_number=42`, and
the generated JavaScript `return [{ json: { result: 42 } }];`.

After importing, collect command-execution evidence from the repository root:

```bash
N8N_USER_FOLDER=scripts/blockly-mvp/.runtime/n8n-user \
N8N_CUSTOM_EXTENSIONS=custom-nodes/n8n-nodes-blockly-code/dist \
packages/cli/bin/n8n execute --id=blockly-code-mvp-demo --rawOutput
```

This command requires the workflow to be imported first. If import assigns a
different workflow ID, replace `blockly-code-mvp-demo` with the actual ID. A
successful command result containing `result: 42` is execution evidence for the
custom node and task runner. It is not UI business PASS: UI acceptance separately
requires opening the visible workflow, executing it from the editor, and retaining
a screenshot plus the corresponding runtime log.

To validate a modified fixture without starting n8n:

```bash
node scripts/blockly-mvp/verify-payload.mjs path/to/workflow.json
```

## Runtime data and rollback

Runtime data and logs stay below `scripts/blockly-mvp/.runtime/`. They are kept
by default so imports and timestamped evidence logs remain inspectable. The
directory is gitignored to prevent local database and log evidence from entering
commits. To discard this isolated demo, delete that directory manually after
stopping n8n; no system configuration or non-demo n8n user data is affected.
