#!/usr/bin/env bash
# Quick demo: starts pi in interactive mode with the thread extension loaded.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
THREAD_ID="${1:-demo}"
WORK_DIR="$SCRIPT_DIR/live-workspace"
mkdir -p "$WORK_DIR"

echo "Thread:      $THREAD_ID"
echo "Workspace:    $WORK_DIR"
echo "State file:   $WORK_DIR/.thread/threads/$THREAD_ID/state.json"
echo "Journal:      $WORK_DIR/.thread/threads/$THREAD_ID/journal.md"
echo ""

cd "$WORK_DIR" && exec pi \
  --extension "$SCRIPT_DIR/index.ts" \
  --thread-id "$THREAD_ID" \
  "$@"
