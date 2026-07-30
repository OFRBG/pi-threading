# pi-threading

Cross-thread communication extension for [pi coding agent](https://github.com/earendil-works/pi-coding-agent).

## Why

Working with subagents, I often found myself debugging why specific tools and actions were made by the LLM, and their ephemeral nature made it very hard to capture and recreate. While agents can be evaluated in a Petri dish with tests and fixtures, I found it more interesting to insert myself into a live agent flow, forking the session, and interrogating it.

pi-threading allows me to spin up any amount of agents in a soft-hierarchy where I can interact with any of them, and observe their reasoning through "journaling". Journaling also provides a sort of built-in on-going high-fidelity compaction mechanism.

Threading is lightweight enough to be molded into a framework, while providing the basis of the communication model I want to use.

## How it works

Each `pi` process becomes a **thread** with a stable identity. Threads communicate through mailboxes. The extension runs a watcher that will inject messages with steer or queue, depending on message urgency.

All messages get dropped into `.thread`, where state and message history is recorded.

The model implementation notes live in [THREAD-MODEL.md](THREAD-MODEL.md).

## Install

```bash
# install it
pi install npm:pi-threading

# load on start
pi -e npm:pi-threading --thread-id my-thread
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

I recommend using tmux to manage teams.

### Slash commands

| Command                          | Purpose                                                          |
| -------------------------------- | ---------------------------------------------------------------- |
| `thread-status`                  | Show state and latest journal entry                              |
| `thread-list`                    | List all known threads                                           |
| `thread-send <to> <body>`        | Send a high-urgency note to another thread                       |
| `thread-suspend`                 | Mark On Hold                                                     |
| `thread-resume`                  | Resume from On Hold                                              |
| `thread-launch [config]`         | Spin up a team of threads from a JSON config                     |
| `thread-shutdown <to> [--force]` | Signal thread(s) to stop (SIGTERM, or SIGKILL with `--force`)    |
| `thread-spawn <id> [prompt...]`  | Spin up a single thread ad hoc, no config file — like a subagent |

### Launching a team from a config

`/thread-launch` reads a JSON file (default `.thread/team.json`) listing the
threads to spin up — id, role, parent, model, and system-prompt pieces — and
launches each one as its own `pi` process, reusing this thread's own launch
flags (extension, storage backend, etc.) so the config only needs to specify
what differs per thread.

```json
{
  "mode": "tmux",
  "session": "teams",
  "defaults": {
    "provider": "openrouter",
    "model": "minimax/minimax-m3",
    "journalModel": "google/gemini-2.5-flash-lite"
  },
  "threads": [
    {
      "id": "a-lead",
      "role": "lead",
      "parent": "hq",
      "systemPrompt": ["briefs/lead.md", "Roster: you lead ${teammates}."]
    },
    {
      "id": "a-dev-1",
      "role": "a-support",
      "parent": "a-lead",
      "model": "deepseek/deepseek-v4-pro",
      "systemPrompt": ["briefs/dev.md", "Teammates: ${teammates}."]
    }
  ]
}
```

- `mode`: `"tmux"` (default; falls back to `"background"` automatically if
  `tmux` isn't installed) or `"background"` (plain detached processes,
  logged to `.thread/threads/<id>/launch.log`).
- `defaults` are merged under each thread's own fields.
- `systemPrompt` entries are file paths (resolved relative to the config
  file) when they exist on disk, otherwise literal strings — either way
  they're rendered through `${id}`, `${role}`, `${parent}`, and `${teammates}`
  (auto-derived from sibling threads sharing the same `parent`, or an
  explicit `"teammates": [...]` override) before becoming
  `--append-system-prompt` flags.

### Spawning a single thread ad hoc

`/thread-spawn <id> [--role r] [--model m] [--parent p] [--mode tmux|background] [prompt...]`
spins up one thread without a config file — the trailing words become its
system prompt (the task brief). `--parent` defaults to you, so the new
thread escalates back to you when it's stuck, same as a subagent. Skips if
`id` already exists. The agent itself can do the same via the `thread_spawn`
tool.

```bash
/thread-spawn researcher Look into why the login flow times out on mobile.
```

## Flags

- `--thread-id <id>` — stable identity for this thread (e.g., `coordinator`, `worker-a`); also the opt-in trigger — omit it and the extension does nothing
- `--thread-parent <id>` — parent thread id, the escalation target ("I'm stuck" → request to parent at high urgency)
- `--thread-role <role>` — role label, targetable via `thread_send to="role:<role>"`
- `--thread-journal <turn|done|off>` — journal cadence (default `turn`; each entry is one forked model call, rate-limited to one entry per ~2 minutes of same-task tool turns, plus a wrap-up entry when a run ends with unjournaled work; structural changes — new obligations, barriers — always journal immediately)
- `--thread-journal-model <model>` — model for the journal fork (e.g. `deepseek/deepseek-chat` to keep entries cheap). Default: the thread's own model. A pinned model must resolve on the machine the thread runs on, or journaling fails (loudly, on stderr)
- `--thread-storage <local|redis|mongo|http>` — storage backend (default `local`, the filesystem; see [Storage backends](#storage-backends))

## Storage backends

By default, threads coordinate through `.thread/` on the local filesystem — fine
for one machine. To coordinate across hosts, point every thread at the same
Redis or MongoDB instance instead; every thread must use the same
`--thread-storage-*` values to see each other.

### Redis

```bash
# each terminal, same connection string
pi --thread-id coordinator \
   --thread-storage redis \
   --thread-storage-connection-string redis://localhost:6379

pi --thread-id worker-a \
   --thread-storage redis \
   --thread-storage-connection-string redis://localhost:6379
```

- `--thread-storage-connection-string <url>` — default `redis://localhost:6379`

### MongoDB

```bash
pi --thread-id coordinator \
   --thread-storage mongo \
   --thread-storage-connection-string mongodb://localhost:27017 \
   --thread-storage-database pi-threading

pi --thread-id worker-a \
   --thread-storage mongo \
   --thread-storage-connection-string mongodb://localhost:27017 \
   --thread-storage-database pi-threading
```

- `--thread-storage-connection-string <url>` — default `mongodb://localhost:27017`
- `--thread-storage-database <name>` — default `pi-threading`

> Running under Bun: the `mongo` backend currently fails to load due to an
> upstream Bun/`bson` incompatibility ([oven-sh/bun#32501](https://github.com/oven-sh/bun/issues/32501),
> fixed but not yet in a stable Bun release as of this writing). `redis` and
> `local` are unaffected.
>
> Separately, under `pi`'s compiled-Bun-binary distribution specifically
> (not plain Bun), the extension loader can fail to resolve npm
> dependencies _by name_ even when correctly installed
> ([earendil-works/pi#6455](https://github.com/earendil-works/pi/issues/6455),
> [#5949](https://github.com/earendil-works/pi/issues/5949) — upstream Bun
> limitations `pi`'s maintainers don't plan to fix). Both `ioredis` and
> `mongodb` are pre-bundled into `vendor/*.cjs` at publish time
> (`scripts/bundle-vendor.mjs`) specifically to sidestep this: the redis/
> mongo adapters load them via a relative path, never by resolving a
> package name, which works under the same broken loader.

See [docs/testing-adapters.md](docs/testing-adapters.md) for running each
backend against a real server (including Docker one-liners) and the offline
test suite.

## Human monitoring & steering

[`pi-threading-cli`](https://github.com/OFRBG/pi-threading/tree/main/packages/pi-threading-cli) — a separate, zero-dependency npm package published from this repo — lets a human act on the thread system without running pi. Anyone can interact with the message system — via `npx @pi-threading/cli` (no install needed) or `node packages/pi-threading-cli/bin/thread-cli.mjs` from inside this repo.

```bash
npx @pi-threading/cli list                      # table of all threads incl. coordination counts
npx @pi-threading/cli status link               # one thread's full coordination state:
                                           #   obligations, owed replies, barriers,
                                           #   pending inbox, last journal entry
npx @pi-threading/cli status link --json        # same, as machine-readable JSON
npx @pi-threading/cli watch                     # live coordination board
npx @pi-threading/cli tail link                 # follow one thread's state/journal/messages
                                           #   (incl. +/- diffs of obligations/barriers)
npx @pi-threading/cli inbox link                # pending + recent messages
npx @pi-threading/cli send link "status?" --expects       # ask, tracked — thread owes you a reply
npx @pi-threading/cli send link "looks good" --re link/01ABC…  # reply, settles the debt
npx @pi-threading/cli send '*' "standup in 5"             # broadcast note
npx @pi-threading/cli delete link                         # remove a thread (refuses if it looks live)
npx @pi-threading/cli delete --stale --yes                # prune every stopped/stale thread
```

## State machine

```
IDLE → THINKING → WORKING → OPEN ──→ DONE

OPEN ──(suspend)──→ ON HOLD ──(resume)──→ OPEN
any ──(unclean exit)──→ STOPPED
```

## Why (again)

Personal preferences.

pi already has an RPC mode, and there are multiple projects out there implemented teams already. Subagents are well handled by Claude Code, Codex, and any major coding agent now. What _I_ want from pi-threading is async notifications from/to the world, for agents, while not being overly disruptive.

pi-threading is my interpretation subagent communication and coordination, and how it should be implemented. It lies somewhere between plain markdown note sharing and ACP/A2A. It exposes the features that I care about.

Could it be email? Maybe. Email is surprisingly close to the concept, but sticking to the email standard would be limiting quickly, despite the existing infrastructure to leverage.

## License

MIT
