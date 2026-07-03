#!/usr/bin/env bash
# Quick demo: starts pi in interactive mode with the thread extension loaded.
# Usage: ./live.sh -t <thread-id> [other pi flags...]
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WORK_DIR="$SCRIPT_DIR/live-workspace"
mkdir -p "$WORK_DIR"

# pi's bundled undici needs worker_threads.markAsUncloneable (Node >= 22.16).
# Volta redirects a bare `pi` to this project's local install and pairs it
# with whatever Node the project resolves to — an older one crashes with
# "webidl.util.markAsUncloneable is not a function" (package.json pins
# volta.node to prevent this; this check catches unpinned environments).
if ! node -e 'process.exit(typeof require("node:worker_threads").markAsUncloneable === "function" ? 0 : 1)' 2>/dev/null; then
  echo "error: node resolves to $(node --version 2>/dev/null || echo '(none)') here — pi needs Node >= 22.16." >&2
  echo "Fix: volta pin node@26 (or point PATH at a newer Node) and retry." >&2
  exit 1
fi

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
  --extension "$SCRIPT_DIR/src/index.ts" \
  "${args[@]}"