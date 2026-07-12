# pi-threading

Cross-thread communication extension for [pi coding agent](https://github.com/earendil-works/pi-coding-agent). Independent threads that coordinate work, share state, and converse — without losing context or forking their history.

## How it works

Each `pi` process becomes a **thread** with a stable identity. Threads communicate through durable per-thread mailboxes — one thread writes an envelope, the target drains it on startup or via live updates. By default the mailbox is local files (no central broker, no external dependencies); a pluggable `StorageAdapter` means the same tools/commands also work against a durable backend (Restate) that can wake a stopped thread — see [Running with the Restate adapter](#running-with-the-restate-adapter).

The extension is opt-in: it only activates for a session launched with `--thread-id <id>` (or resuming one that was). Without that flag, loading this extension has no effect at all — no `.thread/` directory, no `thread_*` tools, no system-prompt changes.

The protocol is specified in [PROTOCOL-FORMALISM.md](PROTOCOL-FORMALISM.md) (Postbox — the Thread Messaging Protocol); implementation notes live in [THREAD-MODEL.md](THREAD-MODEL.md).

## Install

```bash
# From your private GitHub repo:
pi install git:github.com/OFRBG/pi-threading@main

# Or try it without installing:
pi -e git:github.com/OFRBG/pi-threading@main --thread-id my-thread
```

## Usage

Start any number of pi processes in the same working directory, each with a unique `--thread-id`:

```bash
# Terminal 1
cd ~/project
pi --thread-id coordinator

# Terminal 2
cd ~/project
pi --thread-id worker-a

# Terminal 3
pi --thread-id worker-b
```

Threads share state via `.thread/threads/<id>/` in the project directory. Each thread gets a journal, a state file, and an inbox for cross-thread envelopes.

## The message model

There is **one message shape** — the envelope — and two optional fields give it meaning:

```
Envelope {
  id            own identity — minted per send, form <from>/<ulid>
  from, to      sender / target thread id
  body          content
  sentAt        ISO-8601
  re?           reply correlation: settles the debt on that envelope id
  expects?      true — sender needs a reply; tracked until one arrives
  urgency?      "high" (interrupt at next opening) | "low" (default: when idle)
  deliverAfter? not deliverable before this instant
}
```

- `expects: true` → a **request**. The receiver records an owed reply (durable, survives restarts); the sender records an obligation with a deadline (default 15 min) and gets a one-time overdue reminder.
- `re: <id>` → a **reply**. Settles the debt.
- Both together → a reply that asks a follow-up — "pass the ball" when you can't answer without more information.
- Neither → a plain **note**.

There are no message types on the wire and no locks anywhere: a thread that wants to block on a reply arms a **barrier** (`wait=true` or `thread_wait`) and ends its turn — the reply wakes it. A live back-and-forth (a "meeting") is a convention: request "meet?" → reply ok/busy → exchange of high-urgency notes → note "closing". A scheduled self-wake is just an envelope to your own id with `deliverAfter`.

Messages arrive as `[<kind> from <sender> #<id>]` — kind (request/reply/reply+request/note) is derived from the fields, and requests carry an explicit reply hint so receivers always know the id to echo back as `re`.

### Tools available to the LLM

| Tool             | Purpose                                                                                                                                           |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `thread_send`    | Send an envelope — to one id, `a,b`, `*`, or `role:<role>`; `expects`, `re`, `urgency`, `deliverAfterSeconds`, `wait=true` (arm a barrier inline) |
| `thread_wait`    | Wait for all/any of several outstanding replies (barrier) — accepts `deadlineSeconds` and an optional `message` payload injected on resolution    |
| `thread_status`  | Read this thread's state, obligations, owed replies, barriers, and journal                                                                        |
| `thread_list`    | List all known threads in the workspace                                                                                                           |
| `thread_journal` | Read another thread's journal — filter by `tail`/`lookbackMinutes`                                                                                |
| `thread_suspend` | Mark thread On Hold — inbox queues until resume (client-local, not protocol)                                                                      |
| `thread_resume`  | Resume from On Hold and drain queued messages (client-local, not protocol)                                                                        |

### Slash commands

| Command                    | Purpose                                    |
| -------------------------- | ------------------------------------------ |
| `/thread-status`           | Show state and latest journal entry        |
| `/thread-list`             | List all known threads                     |
| `/thread-send <to> <body>` | Send a high-urgency note to another thread |
| `/thread-suspend`          | Mark On Hold                               |
| `/thread-resume`           | Resume from On Hold                        |

## Flags

- `--thread-id <id>` — stable identity for this thread (e.g., `coordinator`, `worker-a`); also the opt-in trigger — omit it and the extension does nothing
- `--thread-parent <id>` — parent thread id, the escalation target ("I'm stuck" → request to parent at high urgency)
- `--thread-role <role>` — role label, targetable via `thread_send to="role:<role>"`
- `--thread-journal <turn|done|off>` — journal cadence (default `turn`; each entry is one forked model call, rate-limited to one entry per ~2 minutes of same-task tool turns, plus a wrap-up entry when a run ends with unjournaled work; structural changes — new obligations, barriers — always journal immediately)
- `--thread-journal-model <model>` — model for the journal fork (e.g. `deepseek/deepseek-chat` to keep entries cheap). Default: the thread's own model. A pinned model must resolve on the machine the thread runs on, or journaling fails (loudly, on stderr)
- `--thread-storage <local|restate>` — storage backend (default `local`, the filesystem; see [Running with the Restate adapter](#running-with-the-restate-adapter))
- `--thread-storage-url <url>` — backend connection URL (e.g. a Restate ingress URL); ignored by the local backend

## Human monitoring & steering

`bin/thread-cli.mjs` lets a human act on the thread system without running pi — a full protocol citizen over plain files:

```bash
node bin/thread-cli.mjs list                      # table of all threads incl. coordination counts
node bin/thread-cli.mjs status link               # one thread's full coordination state:
                                                  #   obligations, owed replies, barriers,
                                                  #   pending inbox, last journal entry
node bin/thread-cli.mjs status link --json        # same, as machine-readable JSON
node bin/thread-cli.mjs watch                     # live coordination board
node bin/thread-cli.mjs tail link                 # follow one thread's state/journal/messages
                                                  #   (incl. +/- diffs of obligations/barriers)
node bin/thread-cli.mjs inbox link                # pending + recent messages
node bin/thread-cli.mjs send link "status?" --expects       # ask, tracked — thread owes you a reply
node bin/thread-cli.mjs send link "looks good" --re link/01ABC…  # reply, settles the debt
node bin/thread-cli.mjs send '*' "standup in 5"             # broadcast note
node bin/thread-cli.mjs delete link                         # remove a thread (refuses if it looks live)
node bin/thread-cli.mjs delete --stale --yes                # prune every stopped/stale thread
```

## Interop: MCP server for other coding agents

`bin/postbox-mcp.mjs` is a zero-dependency MCP (Model Context Protocol) stdio server: point any MCP-capable coding agent at it and that agent becomes a full Postbox thread over plain files — the same `.thread/threads/<id>/` binding pi and `thread-cli` speak, so a Claude Code or Codex session sends, receives, and settles reply debts with pi threads and each other, no pi process required on its side. It exposes the six protocol tools (`thread_send`, `thread_inbox`, `thread_wait`, `thread_status`, `thread_list`, `thread_journal`) and maintains the sending thread's presence and obligation/owed ledger in `state.json`. Identity comes from environment variables: `POSTBOX_THREAD_ID` (required), `POSTBOX_DIR` (workspace root, default cwd), and optional `POSTBOX_ROLE` / `POSTBOX_PARENT`.

Register it with Claude Code:

```bash
claude mcp add postbox -e POSTBOX_THREAD_ID=cc-1 -- node /path/to/pi-extension/bin/postbox-mcp.mjs
```

Or with Codex, in `~/.codex/config.toml`:

```toml
[mcp_servers.postbox]
command = "node"
args = ["/path/to/pi-extension/bin/postbox-mcp.mjs"]
env = { POSTBOX_THREAD_ID = "codex-1" }
```

Caveat — foreign agents are pull-delivery only: they see incoming messages when they call `thread_inbox` (drain now) or `thread_wait` (block until one arrives), and don't get pi's push injection into a live turn.

## State machine

```
IDLE → THINKING → WORKING → OPEN ──→ DONE

OPEN ──(suspend)──→ ON HOLD ──(resume)──→ OPEN
any ──(unclean exit)──→ STOPPED
```

There is no waiting state: debts and barriers are durable records, not states, so nothing needs repair on restart beyond `done/stopped → idle`. Full detail in [PROTOCOL-FORMALISM.md](PROTOCOL-FORMALISM.md) §11–§13.

## Running with the Restate adapter

The default `local` backend is the filesystem — durable enough for a crash, but a stopped `pi` process obviously can't watch its own inbox or fire its own heartbeat while it isn't running. The `restate` backend trades "no dependencies" for one real capability the local backend structurally cannot offer: **waking a stopped thread**. A `deliverAfter` envelope coming due for a stopped thread causes the companion service to spawn `pi` back up, because the mailbox and its timer live in Restate, not in the process that armed it.

This backend has a real operational footprint — three things need to be running:

1. **A self-hosted `restate-server`** (single binary or Docker), e.g. `docker run --rm -p 8080:8080 -p 9070:9070 docker.io/restatedev/restate:latest`.
2. **The companion service**, which hosts the `Thread`/`ThreadRegistry` virtual objects: `npm run restate:serve` (listens on port 9080 by default). Three environment variables shape how it revives a stopped thread: `RESTATE_INGRESS_URL` — the ingress URL the spawned `pi` connects back to (default `http://localhost:8080`); `PI_THREAD_EXTENSION` — the path to this extension's entry point, passed to the spawned `pi` as `--extension` (omit if your `pi` config already loads it); and `PI_BIN` — the pi executable to spawn (default `pi` from PATH; required on Windows, where the npm-installed `pi` is a `.cmd` shim `spawn()` can't execute). The revived `pi` runs in the thread's original working directory, recorded in its state.
3. **Register the deployment** with the server's admin API (one-time, or after changing `src/restate/service.ts`):
   ```bash
   curl -X POST http://localhost:9070/deployments -d '{"uri":"http://localhost:9080"}'
   ```

Then start `pi` pointed at it:

```bash
pi --thread-id coordinator --thread-storage restate --thread-storage-url http://localhost:8080
```

Known limitations versus the local backend: `watchInbox` polls (every 2s) instead of getting an instant `fs.watch` notification — cold-start delivery at session_start is unaffected either way. A future-dated envelope's delayed self-check (`deliverDue`) can't be un-armed once scheduled (Restate has no public "cancel a delayed send" API) — it no-ops if the envelope was already drained by the time it fires. `bin/thread-cli.mjs` (the human monitoring CLI above) is a standalone, zero-dependency script that only ever reads the local filesystem layout — it won't see threads running against the Restate backend.

## Tests

```bash
npm run test:unit         # ~120 cases, milliseconds, no API cost — deterministic logic
npm run test:e2e          # ~10 cases, minutes, real model calls — tool discovery & process boundaries
npm run test:e2e:restate  # ~6 cases, needs Docker, no API cost — RestateAdapter against a real restate-server
npm test                  # test:unit + test:e2e
```

Three tiers, deliberately: `test:unit` drives the extension's own tool/command/inbox/adapter logic directly against a stubbed `pi` (no subprocess), covering targeting, correlation, dedup, error handling, and — via a small fake in-memory `StorageAdapter` — that the core logic doesn't secretly depend on the filesystem. `test:e2e` spawns a real `pi` process per case and is kept small — each test there earns its place by proving something only a live model or a real subprocess boundary can (ambiguity resolution, envelope comprehension, cross-process durability, journal forking). `test:e2e:restate` is separate because it needs Docker rather than API credits — it proves `RestateAdapter` and the `Thread`/`ThreadRegistry` service actually work against a real `restate-server`, not just against the type checker. See [TESTING.md](TESTING.md) before adding a new test.

## License

MIT
