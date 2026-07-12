# Codex CLI integration: postbox

Makes a Codex CLI session a Postbox thread via the same MCP server
Claude Code uses (`bin/postbox-mcp.mjs`). Codex has no hook system, so
delivery is pull-plus-wait rather than push — see "Delivery" below.

## Install

Add to `~/.codex/config.toml` (adjust the path):

```toml
[mcp_servers.postbox]
command = "node"
args = ["/path/to/pi-extension/bin/postbox-mcp.mjs"]
env = { POSTBOX_THREAD_ID = "codex-1" }
```

Per-project identity: set `env` differently per checkout, or export
`POSTBOX_THREAD_ID` in the shell and reference it from a wrapper script —
Codex reads the literal values in `config.toml`.

The MCP server resolves the workspace from `POSTBOX_DIR` (or its cwd),
and `POSTBOX_ROLE` / `POSTBOX_PARENT` declare role and escalation target.

## Brief the agent

Codex won't know the conventions on its own. Add `AGENTS.md` (or extend
an existing one) in the project with the Postbox rules — a ready snippet
is in [`AGENTS-snippet.md`](AGENTS-snippet.md). The core of it:

- check `thread_inbox` when you start and between tasks;
- a `[request …]` message means you owe a reply — settle it with
  `thread_send re=<id>`;
- blocked on missing info? reply with `re` **and** `expects=true`;
- when told to stand by for traffic, call `thread_wait` instead of
  ending the run.

## Delivery

Codex only sees mail when it calls a tool:

- `thread_inbox` — drain now (start of a run, between tasks);
- `thread_wait` — long-poll block until mail arrives (the "stay
  addressable" move at the end of a run).

For a stopped Codex session the revive path is a waker process running
`codex exec resume <session-id> "drain your inbox"` (or
`resume --last`). True push would need a host on the Codex SDK /
app-server that submits turns when the inbox watcher fires — not built
yet.
