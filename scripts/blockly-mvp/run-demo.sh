#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SCRIPT_DIR="$ROOT_DIR/scripts/blockly-mvp"
USER_FOLDER="${N8N_USER_FOLDER:-$SCRIPT_DIR/.runtime/n8n-user}"
EXTENSION_ROOT="${N8N_BLOCKLY_EXTENSION_ROOT:-$ROOT_DIR/custom-nodes/n8n-nodes-blockly-code}"
EXTENSION_DIST="${N8N_BLOCKLY_EXTENSION_DIST:-$EXTENSION_ROOT/dist}"
N8N_BIN="${N8N_BIN:-$ROOT_DIR/packages/cli/bin/n8n}"
LOG_DIR="$SCRIPT_DIR/.runtime/logs"

"$SCRIPT_DIR/setup-demo.sh" --check
mkdir -p "$USER_FOLDER" "$LOG_DIR"

LOG_FILE="$LOG_DIR/n8n-$(date +%Y%m%d-%H%M%S).log"
echo "Writing n8n output to $LOG_FILE"
echo "N8N_USER_FOLDER=$USER_FOLDER"
echo "N8N_CUSTOM_EXTENSIONS=$EXTENSION_DIST"
echo 'Task runner mode: internal (default).'

N8N_USER_FOLDER="$USER_FOLDER" N8N_CUSTOM_EXTENSIONS="$EXTENSION_DIST" "$N8N_BIN" start 2>&1 | tee "$LOG_FILE"
