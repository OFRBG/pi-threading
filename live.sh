#!/usr/bin/env bash
# Quick demo: starts pi in interactive mode with the thread extension loaded.
# Usage: ./live.sh -t <thread-id> [other pi flags...]
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WORK_DIR="$SCRIPT_DIR/live-workspace"
mkdir -p "$WORK_DIR"

echo "Workspace:    $WORK_DIR"
echo ""

# Translate -t <id> → --thread-id <id>
args=()
while [[ $# -gt 0 ]]; do
  case "$1" in
    -t) args+=("--thread-id" "$2"); shift 2 ;;
    *)  args+=("$1"); shift ;;
  esac
done

cd "$WORK_DIR" && exec pi \
  --extension "$SCRIPT_DIR/index.ts" \
  "${args[@]}"