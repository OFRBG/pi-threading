#!/usr/bin/env bash
# two-teams.sh — launch a two-team org of pi threads in one tmux session.
#
#   Team A: a-lead + a-dev-1..3     Team B: b-lead + b-dev-1..2
#   Leads escalate to "hq" — a pseudo-thread whose mailbox you drain with
#   thread-cli (window 0 runs the live board).
#
# Usage: examples/two-teams.sh [project-dir]
#   project-dir  where the teams work (shared .thread/ store); default: cwd
set -euo pipefail

PROJECT_DIR="$(cd "${1:-$PWD}" && pwd)"
REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
EXT="$REPO_DIR/src/index.ts"
CLI="$REPO_DIR/bin/thread-cli.mjs"
BRIEFS="$REPO_DIR/examples/briefs"
SESSION="teams"

LEAD_MODEL="minimax/minimax-m3"
A_DEV_MODEL="deepseek/deepseek-v4-pro"
B_DEV_MODEL="moonshotai/kimi-k2.6"
JOURNAL_MODEL="google/gemini-2.5-flash-lite"

if tmux has-session -t "$SESSION" 2>/dev/null; then
  echo "tmux session '$SESSION' already exists — attach with: tmux attach -t $SESSION" >&2
  exit 1
fi

# launch <window> <thread-id> <role> <parent> <model> <brief-file> <roster-line>
launch() {
  local window="$1" id="$2" role="$3" parent="$4" model="$5" brief="$6" roster="$7"
  tmux new-window -t "$SESSION" -n "$window" -c "$PROJECT_DIR" -- \
    pi --provider openrouter --model "$model" \
    --extension "$EXT" \
    --thread-id "$id" --thread-role "$role" --thread-parent "$parent" \
    --thread-journal-model "$JOURNAL_MODEL" \
    --append-system-prompt "$brief" \
    --append-system-prompt "$roster"
}

tmux new-session -d -s "$SESSION" -n hq -c "$PROJECT_DIR" -- \
  node "$CLI" watch

launch a-lead a-lead lead hq "$LEAD_MODEL" "$BRIEFS/lead.md" \
  "Roster: you are a-lead, lead of Team A. Your team: a-dev-1, a-dev-2, a-dev-3 (fan out via role:a-support). Peer lead: b-lead. Parent: hq (the human)."
launch b-lead b-lead lead hq "$LEAD_MODEL" "$BRIEFS/lead.md" \
  "Roster: you are b-lead, lead of Team B. Your team: b-dev-1, b-dev-2 (fan out via role:b-support). Peer lead: a-lead. Parent: hq (the human)."

A_TEAM="a-dev-1 a-dev-2 a-dev-3"
for n in 1 2 3; do
  mates="$(echo ${A_TEAM/a-dev-$n/} | xargs)"
  launch "a-dev-$n" "a-dev-$n" a-support a-lead "$A_DEV_MODEL" "$BRIEFS/dev.md" \
    "Roster: you are a-dev-$n on Team A. Your lead (and parent): a-lead. Teammates: $mates."
done
B_TEAM="b-dev-1 b-dev-2"
for n in 1 2; do
  mates="$(echo ${B_TEAM/b-dev-$n/} | xargs)"
  launch "b-dev-$n" "b-dev-$n" b-support b-lead "$B_DEV_MODEL" "$BRIEFS/dev.md" \
    "Roster: you are b-dev-$n on Team B. Your lead (and parent): b-lead. Teammates: $mates."
done

tmux select-window -t "$SESSION:hq"
echo "Launched 7 threads in tmux session '$SESSION' (working dir: $PROJECT_DIR)."
echo "  attach:   tmux attach -t $SESSION"
echo "  steer:    node $CLI send a-lead \"<directive>\" --expects"
echo "  inbox:    node $CLI inbox hq"
echo "  teardown: tmux kill-session -t $SESSION"
