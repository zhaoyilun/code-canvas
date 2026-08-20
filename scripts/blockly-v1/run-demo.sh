#!/usr/bin/env bash
set -euo pipefail
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SCRIPT_DIR="$ROOT_DIR/scripts/blockly-v1"
USER_FOLDER="${N8N_USER_FOLDER:-$SCRIPT_DIR/.runtime/n8n-user}"
EXTENSION_DIST="${N8N_BLOCKLY_EXTENSION_DIST:-$ROOT_DIR/custom-nodes/n8n-nodes-blockly-code/dist}"
N8N_BIN="${N8N_BIN:-$ROOT_DIR/packages/cli/bin/n8n}"
"$SCRIPT_DIR/setup-demo.sh" --check
mkdir -p "$USER_FOLDER" "$SCRIPT_DIR/.runtime/logs"
LOG_FILE="$SCRIPT_DIR/.runtime/logs/n8n-$(date +%Y%m%d-%H%M%S).log"
echo "N8N_USER_FOLDER=$USER_FOLDER"
echo "N8N_CUSTOM_EXTENSIONS=$EXTENSION_DIST"
echo "Writing n8n output to $LOG_FILE"
N8N_USER_FOLDER="$USER_FOLDER" N8N_CUSTOM_EXTENSIONS="$EXTENSION_DIST" "$N8N_BIN" start 2>&1 | tee "$LOG_FILE"
