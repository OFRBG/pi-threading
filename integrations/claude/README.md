# Claude Code plugin: postbox

Makes a Claude Code session a full Postbox thread in the workspace's
shared `.thread/` store — it can send, receive, and settle reply debts
with pi threads, other Claude/Codex sessions, and `thread-cli` humans.

Two pieces:

- **MCP server** (`bin/postbox-mcp.mjs`) — the six thread tools
  (`thread_send`, `thread_inbox`, `thread_wait`, `thread_status`,
  `thread_list`, `thread_journal`), presence heartbeat, and the
  obligation/owed ledger.
- **Hooks** (`bin/postbox-hook.mjs`, one script on four events) — push
  delivery, so the session doesn't have to poll:

  | Event              | Gate                                                                     |
  | ------------------ | ------------------------------------------------------------------------ |
  | `SessionStart`     | cold-start drain of all due mail                                         |
  | `UserPromptSubmit` | turn-start drain of all due mail                                         |
  | `PostToolUse`      | `urgency=high` mail injected at the next tool boundary — mid-turn        |
  | `Stop`             | pending mail blocks the stop; the turn continues with the mail delivered |

  The only blind window is a turn that streams prose without a single
  tool call — that mail lands at `Stop`. True mid-generation steer needs
  an Agent SDK host instead of hooks.

## Install

```bash
claude plugin marketplace add /path/to/pi-extension/integrations
claude plugin install postbox@pi-postbox
```

## Run

Identity is per-session, via environment:

```bash
cd ~/project                      # the workspace with the .thread/ store
POSTBOX_THREAD_ID=cc-1 claude
```

Optional: `POSTBOX_DIR` (workspace root override), `POSTBOX_ROLE`,
`POSTBOX_PARENT` (escalation target), `POSTBOX_STOP_WAIT_SECONDS`
(linger N seconds at Stop waiting for mail before the session is allowed
to end — a poor man's waker).

Without `POSTBOX_THREAD_ID` the hooks are silent no-ops and the MCP
server falls back to thread id `claude-1`.

## Notes

- Hooks and the MCP server claim from the same inbox by atomic rename,
  so a message is delivered exactly once no matter which gate wins.
- A stopped session receives nothing until something wakes it —
  `claude -p --resume <session-id> "drain your inbox"` from a waker
  process is the revive path.
