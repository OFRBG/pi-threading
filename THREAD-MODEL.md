# Thread Communication Model

A communication model for independent threads that need to coordinate work, share state, and converse — without losing context or forking their history.

---

## Thread States

| State         | Meaning                                                                |
| ------------- | ---------------------------------------------------------------------- |
| **Idle**      | No active work                                                         |
| **Thinking**  | Composing a response                                                   |
| **Working**   | Executing — a tool call, a write, a calculation                        |
| **Open**      | Yield point between turns — the only place messages land cooperatively |
| **Listening** | Blocked — waiting on a reply or an event                               |
| **In Sync**   | Rendezvous — both threads present, exchanging turns, mutually blocked  |
| **On Hold**   | Suspended gracefully, resumable                                        |
| **Stopped**   | Terminated — not resumable without inspection                          |
| **Done**      | Work complete, result sent                                             |

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

| Operation     | Delivery                         | Meaning                                                  |
| ------------- | -------------------------------- | -------------------------------------------------------- |
| **follow-up** | When thread reaches Done or Idle | Deferred — "when you're free"                            |
| **steer**     | At next Open                     | Urgent — "at your next pause"                            |
| **stop**      | Immediate                        | Unconditional abort — harness operation, not a message   |
| **subscribe** | —                                | Register a message to be delivered when an eventId fires |

`subscribe(eventId, message, delivery)` — when the named event fires, harness injects `message` into this thread's queue at the specified delivery priority (`steer` or `follow-up`).

### OUT operations

| Output           | Nature                                                                                               |
| ---------------- | ---------------------------------------------------------------------------------------------------- |
| **Event stream** | Live JSONL from pi RPC — `turn_start`, `turn_end`, `tool_execution_*`, `message_update`, `agent_end` |
| **Journal**      | Self-written, updated via fork after each `turn_end`                                                 |
| **Lock events**  | eventId fires when thread exits In Sync and returns to Open                                          |

---

## Message Types

Two axes: **what obligation the message creates**, and **which delivery mechanic applies**.

| Message      | Obligation                                                       | Default delivery |
| ------------ | ---------------------------------------------------------------- | ---------------- |
| **Brief**    | Receiver owns the work, must close with a Result                 | steer            |
| **Note**     | None — guidance on current work, no reply expected               | steer            |
| **Question** | Receiver must answer, sender enters Listening                    | steer            |
| **Answer**   | None — closes a Question                                         | steer            |
| **Update**   | None — informational broadcast                                   | follow-up        |
| **Result**   | None — closes a Brief, may re-trigger sender                     | follow-up        |
| **Blocker**  | Parent thread must decide                                        | steer            |
| **Sync**     | Both threads enter rendezvous — both enter Listening until close | steer            |

Delivery is a hint, not a constraint. A sender can override — "when you're free, here's an update" or "urgent: answer this before your next tool call."

---

## Interrupt Model

Cooperative by default. The harness handles unconditional stops externally.

| Level       | Delivery                                               | Resumable |
| ----------- | ------------------------------------------------------ | --------- |
| **steer**   | At next Open — thread finishes current tool call first | Yes       |
| **Suspend** | At next Open — thread finishes current turn cleanly    | Yes       |
| **Abort**   | Immediate                                              | No        |

**Cost of interruption:**

| Interrupted at | Cost                                         |
| -------------- | -------------------------------------------- |
| Open           | None                                         |
| Working        | Low — tool completes, then message lands     |
| Thinking       | Medium — in-progress response discarded      |
| Stopped        | High — requires inspection before resumption |

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

**Not a thread** — the fork runs with `--no-extensions`. Without that, an installed pi-threading would load inside the fork too, mint a ghost thread identity (it has no `--thread-id`), pollute `.thread/threads/` — and fork its own journal at its own turn's end, chaining forever.

**Format:**

```
Working on: auth module
Done: read spec, created /lib/auth.ts with JWT + refresh tokens
Doing: writing tests — two edge cases failing, investigating token expiry
Next: once tests pass, move to middleware layer
Blockers: none
```

Checked once per turn — but most turns don't actually fork. Three gates, in order:

1. **News gate** — a turn with no tool call that also left state, lock, obligations, and barriers unchanged is a pure "still waiting" restatement, and is skipped.
2. **Rate limit** — tool-using turns on the same task journal at most once per 2 minutes (a long run of quick tool turns used to produce one near-duplicate entry, and one forked model call, per turn). Structural changes — a new obligation, lock, or barrier, the things teammates key off — bypass the limit and journal immediately. A rate-limited turn records a debt, and `agent_end` pays it with one wrap-up fork, so the final state of a run is always captured exactly once.
3. **Duplicate discard** — a freshly generated entry whose `Working on`/`Done` lines exactly match the previous entry's is discarded even after forking.

The journal is the thread's interface to the outside world. Humans, supervisor threads, and the war room all read this rather than parsing raw session files or subscribing to the full event stream.

---

## Interaction Patterns

Patterns are composed from the primitives above.

| Pattern          | Mechanics                                                                                                                                      |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| **Delegation**   | Sender sends Brief (follow-up). Receiver works, sends Result when done. Result re-triggers sender.                                             |
| **Supervision**  | Supervisor sends Note (steer). No reply expected. Receiver adjusts at next Open.                                                               |
| **Query**        | Sender sends Question (steer), enters Listening. Receiver sends Answer (steer). Sender resumes.                                                |
| **Conversation** | Sender sends Sync (steer). Both enter In Sync [LOCKED]. Alternating turns until close signal. Both resume with conversation in linear history. |
| **Broadcast**    | Sender sends Update (follow-up) to multiple receivers. No reply, no obligation.                                                                |
| **Escalation**   | Thread sends Blocker (steer) to parent. Parent enters Listening (or deprioritises other work). Parent sends Answer when decided.               |

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

Implemented as a pi coding-agent extension. pi's `ExtensionAPI` provides no native cross-process primitive (no session registry, no send-by-ID, no built-in watcher) — every delivery call (`pi.sendMessage`/`pi.sendUserMessage`) only injects into the _calling_ process's own conversation. The extension builds the harness itself, entirely natively, using primitives pi does expose: `registerFlag`/`getFlag` for thread identity, `session_start`/`session_shutdown` lifecycle hooks, and Node's own `fs.watch`/atomic rename — the same idiom as pi's bundled `examples/extensions/file-trigger.ts` (`fs.watch` → read → `sendMessage(..., {triggerTurn: true})`), extended from one global trigger file to a per-thread inbox.

**Storage backends**: all state/journal/inbox/schedule I/O routes through a `StorageAdapter` (`src/adapter/types.ts`) — a domain-shaped interface (`loadState`/`saveState`/`enqueueMessage`/`drainInbox`/`scheduleWake`/... keyed by thread id), not a generic fs shim, chosen deliberately so it also fits a backend whose durable state is RPC-addressed per-key rather than a file tree. `--thread-storage <local|restate>` (default `local`) selects the backend via a small registry (`src/adapter/registry.ts`); adding another backend later means writing one factory and registering it, no other call site changes. The two paragraphs below describe the default `local` backend specifically; see README.md's [Running with the Restate adapter](README.md#running-with-the-restate-adapter) for the other one.

**Storage (local backend)**: `.thread/threads/<thread-id>/{state.json, journal.md, inbox/}`. Each thread only ever writes its own `state.json`; other threads only _create_ files in its `inbox/` — so no cross-process file locking is needed anywhere.

**Delivery (local backend)**: a sender writes a message into the target's `inbox/` via write-temp-then-rename (atomic on the same filesystem). The target drains its inbox synchronously at `session_start` (durable — this is what makes delivery work even if the target wasn't running when the message arrived) and again on every `fs.watch` fire while running. Messages are renamed into `inbox/processed/` _before_ delivery is attempted, favoring "never deliver twice" over "never lose one" — a duplicate Brief/Question appearing twice in a conversation is worse than one that's dropped but still inspectable in `processed/`. The Restate backend gets the same cold-start-durability guarantee from a different mechanism (the message lives in the target's virtual-object state whether or not the target is running) but trades the instant `fs.watch` live-nudge for polling (see README).

**Liveness**: each running thread heartbeats its own `state.json` every 20s; any reader treats a thread as effectively stopped once `lastSeen` is older than 60s, regardless of the stored `status` field — this is how a hard-killed process (`session_shutdown` never fires on `kill -9`) gets detected. Same rule applies verbatim regardless of storage backend, since it only reads `lastSeen`/`status` off whatever `loadState` returns.

**Scope boundary**: the local backend only works because every thread shares one filesystem (one `.thread` directory) — true for multiple `pi` processes on the same machine. The Restate backend is exactly the "thin external relay" this used to describe as a hypothetical follow-up: threads address each other through a Restate ingress URL instead of a shared directory, so they no longer need to be on the same machine — the tradeoff is the new operational footprint (a `restate-server` plus the companion service both need to be running; see README).

**Scheduled wakes**: `thread_schedule(fireInSeconds, reason)` arms a `ScheduledWake`, itemized via `thread_status` like an obligation. How it actually fires is entirely the backend's call — the tool handler only validates params and calls `store.adapter.scheduleWake(...)`, nothing else. The local backend fires it from the same 20s heartbeat that already drives `checkDeadlines()`, which means it only fires while this exact process is still running. The Restate backend arms a real durable delayed invocation and can wake a _stopped_ thread by spawning `pi` back up — the actual reason to choose that backend over the free one.

**Envelope**: a delivered message renders as `[<Type> from <sender> #<requestId>]` followed by the body, plus an explicit reply hint when a reply is owed (Question/Blocker → Answer, Brief → Result, Sync → Note/close). The requestId must travel with the message — the receiving model has no other way to learn the correlation id it must echo back.

**Lock durability**: reply locks (Question/Blocker, `lockType: "reply"`) survive restarts — the Answer may arrive in the durable inbox while the thread is down, so the thread restores to Listening with its obligations intact. Sync locks (`lockType: "sync"`) are live conversations and are cleared on restart. A clean quit preserves the deliberate waiting states (Done, Listening, On Hold) in `state.json`; interrupted work (Thinking/Working/Open/Idle) is marked Stopped.

**Sync rejection**: a thread that receives a Sync while already locked auto-replies with an **Answer** keyed to the sync's requestId — which releases the requester's lock through the normal Answer path instead of leaving it locked forever (this also unwinds the mutual-sync race, where two threads request each other simultaneously).

**On Hold**: suspending queues the inbox — nothing is delivered until `thread_resume` (or a direct user prompt, which is an implicit resume). The hold reason is persisted and visible to monitors.

**Broadcast**: `thread_send` accepts `to` as a single id, a comma list, `*` (all known threads except self), or `role:<role>` (threads started with `--thread-role`). Locking types (Question/Blocker/Sync) require exactly one target; fan-out work uses per-target requestIds.

**Barriers**: `thread_await(requestIds, mode, deadlineSeconds?)` arms a persistent barrier; each arriving Answer/Result removes its id, and the thread gets a single steer wake-up (envelope + any resolved-barrier note folded into one message) when all (or any) have resolved. This is the "wait for several agents" primitive: fan out Briefs, await the set, end the turn. `thread_send(type="Brief", wait=true)` arms the same kind of barrier inline — the only message type it works for, since Question/Blocker/Sync already wait via the lock and Note/Update have no reply protocol for the receiver to correlate a reply against.

**Deadlines**: Brief/Question/Sync/Blocker (via `deadlineSeconds` on `thread_send`) and barriers (via `deadlineSeconds` on `thread_await`, or inherited from the same call on `thread_send(wait=true)`) both get a one-time overdue nudge from the heartbeat's `checkDeadlines()` — the accountability loop a human team runs by habit, now covering "nobody answered" and "nobody I'm waiting on answered" alike.

**Human as peer**: `bin/thread-cli.mjs` writes the same message format into any thread's inbox (`send`, including `*` broadcast) and reads the same state files (`list`, `watch`, `tail`, `inbox`) — a human can monitor and steer the team without running pi. It's a standalone, zero-dependency script that only ever reads the local filesystem layout directly (it doesn't import `src/`), so it only sees threads running against the `local` storage backend — a known, deliberate limitation, flagged again in the Known Limitations section below.

---

## Known Limitations & Edge Cases

Verified by reading the implementation, not exhaustively tested. Listed so they're a documented tradeoff rather than a silent surprise.

- **`deadlineSeconds` applies to any obligation-creating type** (Brief/Question/Sync/Blocker), not just the three the tool description and README call out — Sync obligations can carry a deadline too, which is correct behavior but under-documented.
- **Simultaneous mutual sync can cancel out instead of connecting.** If A and B both call `thread_sync_request` targeting each other in the same narrow window, and each is still locked with its own pending request when the other's `Sync` arrives, both sides auto-reject each other — both end up back at Open, unsynced, rather than deadlocked or connected. Fails safe, but a caller expecting a rendezvous needs to notice it didn't happen and retry.
- **No automated test coverage yet for**: the CLI `delete` command and the CLI's live loops (`watch`/`tail`). The CLI's `status`/`list` and everything else mentioned here are covered in `test/unit.test.ts`.
- **`bin/thread-cli.mjs` only ever sees the `local` storage backend** — it reads/writes the filesystem layout directly and doesn't go through `StorageAdapter`, so threads running with `--thread-storage restate` are invisible to it. Giving it Restate awareness would mean either duplicating `RestateAdapter`'s logic into a zero-dependency script or accepting a dependency it was deliberately designed without — not resolved, flagged as a real gap.
- **`thread_schedule_cancel` can't truly un-arm a Restate delayed send** — the public client API has no cancel call, so the underlying invocation still fires at the original time; `fireWake` re-checks the persisted schedules list and no-ops if the wake was removed. Functionally correct (nothing visibly happens) but not a true cancellation at the infrastructure level.
- **`watchInbox` on the Restate backend polls every 2s** instead of getting an instant local `fs.watch` notification — live-delivery latency is worse, though cold-start durability (the guarantee that actually matters) is unaffected.

**Fixed since the above was first written**: barrier resolution now folds into the single envelope message instead of double-injecting (`resolveBarriers()` returns notice text, `deliver()` sends one message); `wait=true` is now an explicit, documented no-op for Note/Update instead of silently arming an unresolvable barrier; barriers now support `deadlineSeconds` (on `thread_await` or inherited from `thread_send(wait=true)`) with the same one-time overdue nudge obligations get, and `thread_status` itemizes pending barriers (id/mode/pending ids/deadline) instead of showing a bare count. Covered by `test/unit.test.ts`'s `inbox: deliver` block (stubs `pi`/`ctx` directly against `createThreadStore`/`createInbox`, no subprocess) plus one E2E case for the Note no-op. All storage/inbox/journal I/O was later extracted behind a `StorageAdapter` (see Implementation Notes above) with zero behavior change to the `local` backend, and a `thread_schedule`/`thread_schedule_cancel` primitive was added on top, delegated entirely to whichever backend is active.

Also fixed later: received Brief/Question/Blocker are now durable **owed replies** (surfaced in `thread_status` with the exact requestId to echo, cleared when the matching Result/Answer is sent) — a revived thread no longer has to guess correlation ids. Sends of locking types (Question/Blocker/Sync) to a thread id that has never run are refused instead of locking the sender forever on a typo; queueing types still dead-drop to future thread ids, with a warning in the tool result. Fired scheduled wakes are pruned from state instead of accumulating as `(fired)` entries. Correlation/barrier/wake ids carry a per-process counter so two mints in the same millisecond can't collide. The Restate service's `fireWake` spawns the revived `pi` with `--thread-storage restate`/`--thread-storage-url` and the thread's original cwd (see README for the `RESTATE_INGRESS_URL`/`PI_THREAD_EXTENSION` service env vars) — previously it spawned a `pi` that booted against the wrong (local) backend in the wrong directory. Per-turn journaling is rate-limited (see Journal above). The journal fork now runs `--no-extensions`: with pi-threading installed via extension discovery, each fork used to load the extension, create a ghost `thread-<uuid>` in the workspace, and spawn a further journal fork of its own — an unbounded chain (reproduced live before the fix; explicit `--extension` launches were immune because forks don't inherit that flag).
