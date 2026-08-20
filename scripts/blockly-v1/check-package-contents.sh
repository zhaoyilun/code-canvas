#!/usr/bin/env bash
set -euo pipefail
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
TARGET="${1:-$ROOT_DIR/custom-nodes/n8n-nodes-blockly-code/dist}"
[[ -d "$TARGET" ]] || { echo "FAIL: package directory not found: $TARGET" >&2; exit 1; }
forbidden_name='(^|/)(\.env($|\.)|\.runtime|.*\.(sqlite|sqlite3|db|log|png|jpe?g|webp)$|credentials?($|/)|cookies?($|/))'
if find "$TARGET" -type f -print | grep -E "$forbidden_name" >/dev/null; then
  echo 'FAIL: package contains forbidden runtime, evidence, environment, or credential-like file:' >&2
  find "$TARGET" -type f -print | grep -E "$forbidden_name" >&2
  exit 1
fi
if grep -R -n -E '/(Users|Volumes)/|N8N_USER_FOLDER=|BEGIN( [A-Z]+)? PRIVATE KEY' "$TARGET" >/dev/null 2>&1; then
  echo 'FAIL: package contains a private machine path or private-key marker:' >&2
  grep -R -n -E '/(Users|Volumes)/|N8N_USER_FOLDER=|BEGIN( [A-Z]+)? PRIVATE KEY' "$TARGET" >&2
  exit 1
fi
echo "PASS: package content check: $TARGET"
echo 'PASS: no runtime DB, log, screenshot, .env, credential-like file, or private machine path found.'
