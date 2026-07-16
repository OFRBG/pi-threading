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

`bin/thread-cli.mjs` lets a human act on the thread system without running pi. Anyone can interact with the message system.

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

## State machine

```
IDLE → THINKING → WORKING → OPEN ──→ DONE

OPEN ──(suspend)──→ ON HOLD ──(resume)──→ OPEN
any ──(unclean exit)──→ STOPPED
```

## Why (again)

Personal preferences.

pi already has an RPC mode, and there are multiple projects out there implemented teams already. Subagents are well handled by Claude Code, Codex, and any mejor coding agent now. What *I* want from pi-threading is async notifications from/to the world, for agents, while not being overly disruptive. 

pi-threading is my interpretation subagent communication and coordination, and how it should be implemented. It lies somewhere between plain markdown note sharing and ACP/A2A. It exposes the features that I care about.

Could it be email? Maybe. Email is surprisingly close to the concept, but sticking to the email standard would be limiting quickly, despite the existing infrastructure to leverage.

## License

MIT
