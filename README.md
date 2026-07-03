# pi-threading

Cross-thread communication extension for [pi coding agent](https://github.com/earendil-works/pi-coding-agent). Independent threads that coordinate work, share state, and converse — without losing context or forking their history.

## How it works

Each `pi` process becomes a **thread** with a stable identity. Threads communicate through a shared filesystem inbox — one thread writes a message, the target drains it on startup or via live `fs.watch`. No central broker, no external dependencies.

Read the full design in [THREAD-MODEL.md](THREAD-MODEL.md).

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

Threads share state via `.thread/threads/<id>/` in the project directory. Each thread gets a journal, a state file, and an inbox for cross-thread messages.

### Tools available to the LLM

| Tool                  | Purpose                                                                                                                             |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `thread_status`       | Read this thread's state, obligations, and journal                                                                                  |
| `thread_list`         | List all known threads in the workspace                                                                                             |
| `thread_journal`      | Read another thread's journal — filter by `tail`/`lookbackMinutes`                                                                  |
| `thread_send`         | Send a typed message — to one id, `a,b`, `*`, or `role:<role>`; `wait=true` (Brief only) arms a barrier for the reply automatically |
| `thread_await`        | Wait for all/any of several outstanding replies (barrier) — accepts `deadlineSeconds`                                               |
| `thread_subscribe`    | Subscribe a message to a named event                                                                                                |
| `thread_emit`         | Fire a named event, notifying subscribers                                                                                           |
| `thread_sync_request` | Enter rendezvous (In Sync) with another thread                                                                                      |
| `thread_sync_close`   | End the current sync session                                                                                                        |
| `thread_suspend`      | Mark thread On Hold — inbox queues until resume                                                                                     |
| `thread_resume`       | Resume from On Hold and drain queued messages                                                                                       |

### Slash commands

| Command                           | Purpose                             |
| --------------------------------- | ----------------------------------- |
| `/thread-status`                  | Show state and latest journal entry |
| `/thread-list`                    | List all known threads              |
| `/thread-send <to> <type> <body>` | Send a message to another thread    |
| `/thread-emit <eventId>`          | Fire a named event                  |
| `/thread-suspend`                 | Mark On Hold                        |
| `/thread-resume`                  | Resume from On Hold                 |

### Message types

| Type         | Obligation             | Reply                         |
| ------------ | ---------------------- | ----------------------------- |
| **Brief**    | Receiver owns the work | Must close with Result        |
| **Note**     | None — guidance        | No reply expected             |
| **Question** | Receiver must answer   | Sender enters Listening       |
| **Answer**   | None                   | Closes a Question or Blocker  |
| **Update**   | None — broadcast       | None                          |
| **Result**   | None                   | Closes a Brief                |
| **Blocker**  | Parent must answer     | Sender enters Listening       |
| **Sync**     | Both enter rendezvous  | Alternating turns until close |

Messages arrive as `[<Type> from <sender> #<requestId>]` with an explicit reply hint when a reply is owed, so receivers always know the correlation id to echo back. Brief/Question/Sync/Blocker (the obligation-creating types) accept `deadlineSeconds` — if no reply lands in time, the sender gets a one-time overdue reminder to follow up or escalate.

`wait=true` only arms a barrier for **Brief** — Question/Blocker/Sync already wait via the lock, and Note/Update have no reply protocol (no requestId hint in the envelope), so `wait=true` is a documented no-op for all of them.

## Flags

- `--thread-id <id>` — stable identity for this thread (e.g., `coordinator`, `worker-a`)
- `--thread-parent <id>` — parent thread for Blocker escalation
- `--thread-role <role>` — role label, targetable via `thread_send to="role:<role>"`
- `--thread-journal <turn|done|off>` — journal cadence (default `turn`; each entry is one cheap model call)

## Human monitoring & steering

`bin/thread-cli.mjs` lets a human act on the thread system without running pi:

```bash
node bin/thread-cli.mjs list                      # table of all threads
node bin/thread-cli.mjs watch                     # live-updating view + open obligations
node bin/thread-cli.mjs tail link                 # follow one thread's state/journal/messages
node bin/thread-cli.mjs inbox link                # pending + recent messages
node bin/thread-cli.mjs send link Question "status?"   # steer: message a thread as "user"
node bin/thread-cli.mjs send '*' Update "standup in 5" # broadcast
node bin/thread-cli.mjs delete link                    # remove a thread (refuses if it looks live)
node bin/thread-cli.mjs delete --stale --yes           # prune every stopped/stale thread
```

## State machine

```
IDLE → THINKING → WORKING → OPEN ──→ DONE
                               ↕
                           LISTENING
                               ↕
                           IN SYNC [LOCKED]

OPEN ──(suspend)──→ ON HOLD ──(resume)──→ OPEN
any ──(unclean exit)──→ STOPPED
```

Full detail (including how Stopped/Listening/On Hold survive or don't survive a restart) is in [THREAD-MODEL.md](THREAD-MODEL.md#lock-durability).

## Tests

```bash
npm run test:unit   # ~60 cases, milliseconds, no API cost — deterministic logic
npm run test:e2e    # ~12 cases, minutes, real model calls — tool discovery & process boundaries
npm test            # both
```

Two tiers, deliberately: `test:unit` drives the extension's own tool/command/inbox logic directly against a stubbed `pi` (no subprocess), covering targeting, locking, correlation, dedup, and error handling. `test:e2e` spawns a real `pi` process per case and is kept small — each test there earns its place by proving something only a live model or a real subprocess boundary can (ambiguity resolution, envelope comprehension, cross-process durability, journal forking). See [TESTING.md](TESTING.md) before adding a new test, and [THREAD-MODEL.md](THREAD-MODEL.md#known-limitations--edge-cases) for gaps not yet covered.

## License

MIT
