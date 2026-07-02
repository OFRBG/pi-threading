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

| Tool                  | Purpose                                        |
| --------------------- | ---------------------------------------------- |
| `thread_status`       | Read this thread's state and journal           |
| `thread_list`         | List all known threads in the workspace        |
| `thread_send`         | Send a typed message to another thread         |
| `thread_subscribe`    | Subscribe a message to a named event           |
| `thread_emit`         | Fire a named event, notifying subscribers      |
| `thread_sync_request` | Enter rendezvous (In Sync) with another thread |
| `thread_sync_close`   | End the current sync session                   |
| `thread_suspend`      | Mark thread On Hold                            |
| `thread_resume`       | Resume from On Hold                            |

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
| **Answer**   | None                   | Closes a Question             |
| **Update**   | None — broadcast       | None                          |
| **Result**   | None                   | Closes a Brief                |
| **Blocker**  | Parent must decide     | Parent sends Answer           |
| **Sync**     | Both enter rendezvous  | Alternating turns until close |

## Flags

- `--thread-id <id>` — stable identity for this thread (e.g., `coordinator`, `worker-a`)
- `--thread-parent <id>` — parent thread for Blocker escalation

## State machine

```
IDLE → THINKING → WORKING → OPEN
                               ↕
                           LISTENING
                               ↕
                           IN SYNC [LOCKED]
```

## Tests

```bash
bun test
```

End-to-end functional tests that verify state tracking, journaling, event subscription, lock acquisition/release, and cross-thread message delivery.

## License

MIT
