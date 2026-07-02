#!/usr/bin/env bash
# Quick demo: starts pi in interactive mode with the thread extension loaded.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WORK_DIR="$SCRIPT_DIR/live-workspace"
mkdir -p "$WORK_DIR"

echo "Workspace:    $WORK_DIR"
echo ""

cd "$WORK_DIR" && exec pi \
  --extension "$SCRIPT_DIR/index.ts" \
  "$@"
