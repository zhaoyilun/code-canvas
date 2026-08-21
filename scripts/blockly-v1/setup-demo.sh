#!/usr/bin/env bash
set -euo pipefail
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SCRIPT_DIR="$ROOT_DIR/scripts/blockly-v1"
FIXTURE="$SCRIPT_DIR/fixtures/blockly-data-transform-v1.workflow.json"
USER_FOLDER="${N8N_USER_FOLDER:-$SCRIPT_DIR/.runtime/n8n-user}"
EXTENSION_DIST="${N8N_BLOCKLY_EXTENSION_DIST:-$ROOT_DIR/custom-nodes/n8n-nodes-blockly-code/dist}"
N8N_BIN="${N8N_BIN:-$ROOT_DIR/packages/cli/bin/n8n}"
case "${1:-}" in
  --check) check_only=true ;;
  --import) check_only=false ;;
  *) echo 'Usage: scripts/blockly-v1/setup-demo.sh --check|--import' >&2; exit 2 ;;
esac
node "$SCRIPT_DIR/verify-v1.mjs" "$FIXTURE" --require-compiler
[[ -x "$N8N_BIN" ]] || { echo "FAIL: missing n8n CLI: $N8N_BIN" >&2; exit 1; }
[[ -f "$ROOT_DIR/packages/cli/dist/command-registry.js" ]] || { echo 'FAIL: build packages/cli before import.' >&2; exit 1; }
[[ -f "$EXTENSION_DIST/nodes/BlocklyCode/BlocklyCode.node.js" ]] || { echo "FAIL: build custom node extension: $EXTENSION_DIST" >&2; exit 1; }
[[ "$check_only" == true ]] && { echo 'PASS: fixture and current build prerequisites checked; no runtime data written.'; exit 0; }
mkdir -p "$USER_FOLDER"
echo "N8N_USER_FOLDER=$USER_FOLDER"
echo "N8N_CUSTOM_EXTENSIONS=$EXTENSION_DIST"
N8N_USER_FOLDER="$USER_FOLDER" N8N_CUSTOM_EXTENSIONS="$EXTENSION_DIST" "$N8N_BIN" import:workflow --input="$FIXTURE"
