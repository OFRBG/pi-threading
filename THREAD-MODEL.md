# Thread Communication Model

A communication model for independent threads that need to coordinate work, share state, and converse — without losing context or forking their history.

---

## Thread States

| State | Meaning |
|---|---|
| **Idle** | No active work |
| **Thinking** | Composing a response |
| **Working** | Executing — a tool call, a write, a calculation |
| **Open** | Yield point between turns — the only place messages land cooperatively |
| **Listening** | Blocked — waiting on a reply or an event |
| **In Sync** | Rendezvous — both threads present, exchanging turns, mutually blocked |
| **On Hold** | Suspended gracefully, resumable |
| **Stopped** | Terminated — not resumable without inspection |
| **Done** | Work complete, result sent |

**Open** is the critical state. It is the only moment a thread can receive a message without interrupting mid-thought or mid-execution. All cooperative message delivery routes through Open.

---

## State Machine

```
IDLE
 └──(Brief)──→ THINKING ──→ WORKING ──→ OPEN
                                          │
               ┌──────────────────────────┤
               │                          │
          (Note/Brief               (Question sent
           delivered)                or subscribe)
               │                          │
            THINKING                  LISTENING
                                          │
                                  (Answer received
                                   or event fires)
                                          │
                                         OPEN

OPEN ──(Sync requested, unlocked)──→ IN SYNC [LOCKED]
                                          │
                                    (close signal)
                                          │
                                         OPEN [UNLOCKED] → fires lock eventId

OPEN ──(Sync requested, locked)──→ returns eventId to caller

OPEN ──(Result sent)──→ DONE
OPEN ──(Blocker)──────→ LISTENING (waiting on parent thread)

── harness operations ──────────────────────────────
Any state ──(Suspend)──→ ON HOLD ──(resume)──→ OPEN
Any state ──(Abort)───→ STOPPED
```

---

## Channel

```
IN  → follow-up | steer | stop | subscribe(eventId, message, delivery)
OUT → event stream   (live, real-time)
      journal         (self-written, one turn behind)
      lock events     (eventId fires when thread returns to Open)
```

### IN operations

| Operation | Delivery | Meaning |
|---|---|---|
| **follow-up** | When thread reaches Done or Idle | Deferred — "when you're free" |
| **steer** | At next Open | Urgent — "at your next pause" |
| **stop** | Immediate | Unconditional abort — harness operation, not a message |
| **subscribe** | — | Register a message to be delivered when an eventId fires |

`subscribe(eventId, message, delivery)` — when the named event fires, harness injects `message` into this thread's queue at the specified delivery priority (`steer` or `follow-up`).

### OUT operations

| Output | Nature |
|---|---|
| **Event stream** | Live JSONL from pi RPC — `turn_start`, `turn_end`, `tool_execution_*`, `message_update`, `agent_end` |
| **Journal** | Self-written, updated via fork after each `turn_end` |
| **Lock events** | eventId fires when thread exits In Sync and returns to Open |

---

## Message Types

Two axes: **what obligation the message creates**, and **which delivery mechanic applies**.

| Message | Obligation | Default delivery |
|---|---|---|
| **Brief** | Receiver owns the work, must close with a Result | steer |
| **Note** | None — guidance on current work, no reply expected | steer |
| **Question** | Receiver must answer, sender enters Listening | steer |
| **Answer** | None — closes a Question | steer |
| **Update** | None — informational broadcast | follow-up |
| **Result** | None — closes a Brief, may re-trigger sender | follow-up |
| **Blocker** | Parent thread must decide | steer |
| **Sync** | Both threads enter rendezvous — both enter Listening until close | steer |

Delivery is a hint, not a constraint. A sender can override — "when you're free, here's an update" or "urgent: answer this before your next tool call."

---

## Interrupt Model

Cooperative by default. The harness handles unconditional stops externally.

| Level | Delivery | Resumable |
|---|---|---|
| **steer** | At next Open — thread finishes current tool call first | Yes |
| **Suspend** | At next Open — thread finishes current turn cleanly | Yes |
| **Abort** | Immediate | No |

**Cost of interruption:**

| Interrupted at | Cost |
|---|---|
| Open | None |
| Working | Low — tool completes, then message lands |
| Thinking | Medium — in-progress response discarded |
| Stopped | High — requires inspection before resumption |

No hard interrupt mid-Thinking or mid-Working. The model is cooperative: messages queue for the next Open, stops are harness-level operations.

---

## Lock Model

**In Sync** is mutually exclusive. A thread can be in rendezvous with at most one other thread at a time.

**Acquiring:**
- Sync request arrives, thread is unlocked → `{ ok: true }`, both threads enter In Sync [LOCKED]
- Sync request arrives, thread is locked → `{ locked: true, eventId: "evt-abc123" }`

**Releasing:**
- Thread exits In Sync → lock released, `evt-abc123` fires to all subscribers

The locked thread does not decide what the caller does next. It returns an eventId and the caller chooses — subscribe and wait, subscribe and do other work, or ignore and continue without the sync.

---

## Event Subscription

Threads can register to receive a message when any named event fires.

```
subscribe(eventId, message, delivery)
```

- `delivery: "steer"` — urgent, delivered at caller's next Open
- `delivery: "follow-up"` — deferred, delivered when caller finishes current work

Multiple threads can subscribe to the same event. All receive their message when it fires.

**Sync wait:** thread subscribes then enters Listening — nothing else to do until event fires.  
**Async wait:** thread subscribes then continues working — event message arrives at next Open.

---

## Journal

The journal is the thread's own account of its state, written by a fork of the thread itself after each turn.

**Self-written** — the fork has access to the thread's full reasoning, thinking blocks, and context. More accurate than external observation, which can only infer from tool calls.

**Non-interrupting** — the fork runs in the background after `turn_end`. The main thread never pauses.

**Format:**

```
Working on: auth module
Done: read spec, created /lib/auth.ts with JWT + refresh tokens
Doing: writing tests — two edge cases failing, investigating token expiry
Next: once tests pass, move to middleware layer
Blockers: none
```

Updated once per turn. On `agent_end`, a final fork writes a closing summary.

The journal is the thread's interface to the outside world. Humans, supervisor threads, and the war room all read this rather than parsing raw session files or subscribing to the full event stream.

---

## Interaction Patterns

Patterns are composed from the primitives above.

| Pattern | Mechanics |
|---|---|
| **Delegation** | Sender sends Brief (follow-up). Receiver works, sends Result when done. Result re-triggers sender. |
| **Supervision** | Supervisor sends Note (steer). No reply expected. Receiver adjusts at next Open. |
| **Query** | Sender sends Question (steer), enters Listening. Receiver sends Answer (steer). Sender resumes. |
| **Conversation** | Sender sends Sync (steer). Both enter In Sync [LOCKED]. Alternating turns until close signal. Both resume with conversation in linear history. |
| **Broadcast** | Sender sends Update (follow-up) to multiple receivers. No reply, no obligation. |
| **Escalation** | Thread sends Blocker (steer) to parent. Parent enters Listening (or deprioritises other work). Parent sends Answer when decided. |

---

## Linear History

Each thread maintains a single linear history — no forking, no parallel branches.

- Conversation (In Sync) appears as a named segment: `[SYNC with thread-B: 4 exchanges, outcome: agreed on JWT]`
- Compaction summarises but preserves segment boundaries
- Journal maintains the full record externally, unaffected by compaction
- A thread resuming from On Hold or re-triggered after Done forks its last session — context is preserved linearly

The combination of JSONL session (full fidelity), event stream (live), and journal (self-written condensed record) means three different observers get what they need without the thread itself being fragmented.

---

## Implementation Notes

Implemented as a pi coding-agent extension. pi's `ExtensionAPI` provides no native cross-process primitive (no session registry, no send-by-ID, no built-in watcher) — every delivery call (`pi.sendMessage`/`pi.sendUserMessage`) only injects into the *calling* process's own conversation. The extension builds the harness itself, entirely natively, using primitives pi does expose: `registerFlag`/`getFlag` for thread identity, `session_start`/`session_shutdown` lifecycle hooks, and Node's own `fs.watch`/atomic rename — the same idiom as pi's bundled `examples/extensions/file-trigger.ts` (`fs.watch` → read → `sendMessage(..., {triggerTurn: true})`), extended from one global trigger file to a per-thread inbox.

**Storage**: `.thread/threads/<thread-id>/{state.json, journal.md, inbox/}`. Each thread only ever writes its own `state.json`; other threads only *create* files in its `inbox/` — so no cross-process file locking is needed anywhere.

**Delivery**: a sender writes a message into the target's `inbox/` via write-temp-then-rename (atomic on the same filesystem). The target drains its inbox synchronously at `session_start` (durable — this is what makes delivery work even if the target wasn't running when the message arrived) and again on every `fs.watch` fire while running. Messages are renamed into `inbox/processed/` *before* delivery is attempted, favoring "never deliver twice" over "never lose one" — a duplicate Brief/Question appearing twice in a conversation is worse than one that's dropped but still inspectable in `processed/`.

**Liveness**: each running thread heartbeats its own `state.json` every 20s; any reader treats a thread as effectively stopped once `lastSeen` is older than 60s, regardless of the stored `status` field — this is how a hard-killed process (`session_shutdown` never fires on `kill -9`) gets detected.

**Scope boundary**: this only works because every thread shares one filesystem (one `.thread` directory) — true for multiple `pi` processes on the same machine, which is the only scenario built. Cross-machine threads without a shared filesystem would need a thin external relay (a socket, HTTP endpoint, or object store) sitting between machines, each side still feeding its local `.thread` inbox via the same drain logic.
