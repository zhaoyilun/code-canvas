#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SCRIPT_DIR="$ROOT_DIR/scripts/blockly-mvp"
FIXTURE="$SCRIPT_DIR/fixtures/blockly-code-demo.workflow.json"
USER_FOLDER="${N8N_USER_FOLDER:-$SCRIPT_DIR/.runtime/n8n-user}"
EXTENSION_ROOT="${N8N_BLOCKLY_EXTENSION_ROOT:-$ROOT_DIR/custom-nodes/n8n-nodes-blockly-code}"
EXTENSION_DIST="${N8N_BLOCKLY_EXTENSION_DIST:-$EXTENSION_ROOT/dist}"
N8N_BIN="${N8N_BIN:-$ROOT_DIR/packages/cli/bin/n8n}"
IMPORT=false

usage() {
	cat <<'EOF'
Usage: scripts/blockly-mvp/setup-demo.sh [--check|--import]

--check   Validate the fixture and required built artifacts without writing data.
--import  Import the fixture into the isolated N8N_USER_FOLDER.

The default only prepares the isolated folder and prints the environment. It never
deletes existing data. Import uses the isolated instance's database owner shell and
does not require browser setup.
EOF
}

case "${1:-}" in
	'') ;;
	--check) CHECK_ONLY=true ;;
	--import) IMPORT=true ;;
	-h|--help) usage; exit 0 ;;
	*) echo "FAIL: unknown argument: $1" >&2; usage >&2; exit 2 ;;
esac

node "$SCRIPT_DIR/verify-payload.mjs" "$FIXTURE"

MISSING_ARTIFACT=false

if [[ ! -x "$N8N_BIN" ]]; then
	echo "FAIL: n8n CLI is not executable: $N8N_BIN" >&2
	MISSING_ARTIFACT=true
fi

if [[ ! -f "$ROOT_DIR/packages/cli/dist/command-registry.js" ]]; then
	echo "FAIL: n8n CLI build is missing packages/cli/dist/command-registry.js; build the CLI before starting or importing." >&2
	MISSING_ARTIFACT=true
fi

if [[ ! -f "$EXTENSION_ROOT/package.json" ]]; then
	echo "FAIL: Blockly extension package is missing: $EXTENSION_ROOT/package.json" >&2
	MISSING_ARTIFACT=true
fi

if [[ ! -f "$EXTENSION_DIST/nodes/BlocklyCode/BlocklyCode.node.js" ]]; then
	echo "FAIL: Blockly extension build is missing: $EXTENSION_DIST/nodes/BlocklyCode/BlocklyCode.node.js" >&2
	echo "Build the extension with its documented package command, then rerun this script." >&2
	MISSING_ARTIFACT=true
fi

if [[ "$MISSING_ARTIFACT" == true ]]; then
	exit 1
fi

if [[ "${CHECK_ONLY:-false}" == true ]]; then
	echo 'PASS: CLI and compiled Blockly extension are available; no user data was written.'
	exit 0
fi

mkdir -p "$USER_FOLDER"
echo "N8N_USER_FOLDER=$USER_FOLDER"
echo "N8N_CUSTOM_EXTENSIONS=$EXTENSION_DIST"
echo 'Task runner mode: internal (n8n 2.35.4 default; no insecure-mode flag is set).'

if [[ "$IMPORT" == true ]]; then
	N8N_USER_FOLDER="$USER_FOLDER" N8N_CUSTOM_EXTENSIONS="$EXTENSION_DIST" "$N8N_BIN" import:workflow --input="$FIXTURE"
fi
