# Thread Communication Model — implementation notes

A communication model for independent threads that need to coordinate work, share state, and converse — without losing context or forking their history.

The **protocol itself is specified in [PROTOCOL-FORMALISM.md](PROTOCOL-FORMALISM.md)** (Postbox — the Thread Messaging Protocol, currently Rev 8): the envelope format, the three channels (mailbox/presence/journal), the debt ledger, conformance classes, and the local-fs binding. That document is the design-of-record; this one covers how the pi extension implements it — the parts that are client behavior, engineering tradeoffs, and history rather than protocol.

---

## Thread States

| State        | Meaning                                                                |
| ------------ | ---------------------------------------------------------------------- |
| **Idle**     | No active work                                                         |
| **Thinking** | Composing a response                                                   |
| **Working**  | Executing — a tool call, a write, a calculation                        |
| **Open**     | Yield point between turns — the only place messages land cooperatively |
| **On Hold**  | Suspended gracefully, resumable                                        |
| **Stopped**  | Terminated — not resumable without inspection                          |
| **Done**     | Work complete                                                          |

**Open** is the critical state. It is the only moment a thread can receive a message without interrupting mid-thought or mid-execution. All cooperative message delivery routes through Open.

There is **no waiting state**: a thread that needs a reply arms a barrier (a durable record, not a state) and ends its turn. Debts and barriers survive restarts unconditionally; states don't need to. The only boot repair is `done/stopped → idle`.

```
IDLE → THINKING → WORKING → OPEN ──→ DONE

OPEN ──(suspend)──→ ON HOLD ──(resume / user prompt)──→ OPEN
any ──(unclean exit)──→ STOPPED
```

---

## Message model (summary — normative version in the spec, §6–§10)

One envelope shape; `expects` and `re` presence derive the kind:

| Kind              | Fields    | Effect                                                                |
| ----------------- | --------- | --------------------------------------------------------------------- |
| **note**          | neither   | fire-and-forget                                                       |
| **request**       | `expects` | receiver records an owed reply; sender records an obligation          |
| **reply**         | `re`      | settles the debt keyed by `re`                                        |
| **reply+request** | both      | settles the old debt, opens a new one the other way ("pass the ball") |

`urgency: "high"` interrupts the receiver at its next opening; absent/low waits for idle. `deliverAfter` holds the envelope until due — a self-addressed one is a scheduled wake. Conventions on top: a **meeting** (request "meet?" → ok/busy → high-urgency notes → "closing", exclusivity advisory) and an **escalation** (request to `parent` at high urgency).

---

## Interrupt Model

Cooperative by default. The harness handles unconditional stops externally.

| Level       | Delivery                                               | Resumable |
| ----------- | ------------------------------------------------------ | --------- |
| **high**    | At next Open — thread finishes current tool call first | Yes       |
| **Suspend** | At next Open — thread finishes current turn cleanly    | Yes       |
| **Abort**   | Immediate (harness-level, not a message)               | No        |

No hard interrupt mid-Thinking or mid-Working. Messages queue for the next Open.

---

## Journal

The journal is the thread's own account of its state, written by a fork of the thread itself after each turn. It is one of the protocol's two observability channels (spec §8); everything below is how this client produces it.

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

1. **News gate** — a turn with no tool call that also left state, obligations, and barriers unchanged is a pure "still waiting" restatement, and is skipped.
2. **Rate limit** — tool-using turns on the same task journal at most once per 2 minutes (a long run of quick tool turns used to produce one near-duplicate entry, and one forked model call, per turn). Structural changes — a new obligation or barrier, the things teammates key off — bypass the limit and journal immediately. A rate-limited turn records a debt, and `agent_end` pays it with one wrap-up fork, so the final state of a run is always captured exactly once.
3. **Duplicate discard** — a freshly generated entry whose `Working on`/`Done` lines exactly match the previous entry's is discarded even after forking.

Journal generation throttling is client-private policy: the protocol only sees appends (spec §8.3 — writes are idempotent on id; the guards exist because each entry costs a forked model call, not because the channel needs protecting).

---

## Implementation Notes

Implemented as a pi coding-agent extension. pi's `ExtensionAPI` provides no native cross-process primitive (no session registry, no send-by-ID, no built-in watcher) — every delivery call (`pi.sendMessage`/`pi.sendUserMessage`) only injects into the _calling_ process's own conversation. The extension builds the harness itself, entirely natively, using primitives pi does expose: `registerFlag`/`getFlag` for thread identity, `session_start`/`session_shutdown` lifecycle hooks, and Node's own `fs.watch`/atomic rename.

**Storage backends**: all state/journal/mailbox I/O routes through a `StorageAdapter` plus an optional `JournalAdapter` extension (`src/adapter/types.ts`) — domain-shaped interfaces, not a generic fs shim, chosen deliberately so they also fit a backend whose durable state is RPC-addressed per-key rather than a file tree. There is no timer member: delayed delivery is the envelope's own `deliverAfter`, held by the store until due. `--thread-storage <local|restate>` (default `local`) selects the backend via a small registry (`src/adapter/registry.ts`); adding another backend means writing one factory and registering it.

**Storage (local backend)**: the Appendix B binding — `.thread/threads/<id>/{state.json, journal.md, inbox/, inbox.tmp/}`. Each thread only ever writes its own `state.json`; other threads only _create_ files in its `inbox/` — so no cross-process file locking is needed anywhere. Envelope filenames are the id's ULID tail, so a sorted directory listing IS FIFO order, and a retried send with the same id overwrites its own file (enqueue idempotence for free).

**Delivery (local backend)**: a sender writes the envelope into `inbox.tmp/` and renames it into `inbox/` (atomic on the same filesystem). The target drains its mailbox at `session_start` (durable — this is what makes delivery work even if the target wasn't running when the message arrived) and again on every `fs.watch` fire while running. Envelopes whose `deliverAfter` is still in the future stay queued. Claimed messages are renamed into `inbox/processed/` _before_ delivery is attempted, favoring "never deliver twice" over "never lose one" — and per the spec's §7.7 drain gate, a drain only happens at all when delivery can complete in the same tick, so the claim-to-delivery loss window is one tick wide by construction.

**Injection gate**: the last hop — from the drained mailbox into this session's own conversation via `pi.sendUserMessage` — is gated. While pi is mid-run, an injected message just joins pi's steering/follow-up queue (safe, consumed at turn boundaries and once more after `agent_end` handlers settle). While pi is _idle_, each injection starts a new agent run after an async preflight — two of those racing means the loser is dropped by pi with "Agent is already processing" — and during auto-compaction the agent _looks_ idle, so an unguarded injection starts a run that races the compaction's context rewrite (pi's own TUI holds user input during compaction for exactly this reason; extensions get no such guard for free). So: each drain coalesces every pending envelope into **one** `sendUserMessage` call (at the highest urgency present), an idle-time injection holds further drains until the run actually starts (`turn_start`, with a 3s expiry fallback), and `session_before_compact`/`session_compact` hold the drain shut across compactions with a 3-minute cap (compaction failures emit no end event). Gated messages stay durably on disk — the watcher, turn boundaries, and the 20s heartbeat all retry the drain, so a hold delays delivery, never loses it.

**Liveness**: each running thread heartbeats its own `state.json` every 20s; any reader treats a thread as effectively stopped once `lastSeen` is older than 60s, regardless of the stored `status` field — this is how a hard-killed process (`session_shutdown` never fires on `kill -9`) gets detected. This is the spec's one presence rule that binds every reader (§8.2), and it applies verbatim regardless of storage backend.

**Delayed delivery / wakes**: a send with `deliverAfterSeconds` (including to your own id — the scheduled-wake idiom) is just an envelope the store holds until due. The local backend picks it up from the same 20s heartbeat drain that already drives `checkDeadlines()`, which means it only fires while some process for that thread is running. The Restate backend arms a durable delayed `deliverDue` self-invocation at enqueue time and can wake a _stopped_ thread by spawning `pi` back up — the actual reason to choose that backend over the free one.

**Envelope rendering**: a delivered envelope renders as `[<kind> from <sender> #<id>]` followed by the body, plus an explicit reply hint when the message expects a reply. The id must travel with the message — the receiving model has no other way to learn the correlation id it must echo back as `re`. A revived thread that lost its session recovers pending ids from `thread_status`'s owed list instead of guessing.

**On Hold**: suspending queues the mailbox — nothing is delivered until `thread_resume` (or a direct user prompt, which is an implicit resume). The hold reason is persisted and visible to monitors. Suspend/resume are client-local controls, not protocol surface.

**Broadcast**: `thread_send` accepts `to` as a single id, a comma list, `*` (all known threads except self), or `role:<role>` (threads started with `--thread-role`). Fan-out sends mint a distinct envelope id per target, so replies stay individually correlatable.

**Barriers**: `thread_wait(ids, mode, deadlineSeconds?, message?)` arms a persistent barrier; each arriving reply removes its id, and the thread gets a single wake-up (envelope + any resolved-barrier note + the barrier's optional `message` payload, folded into one injection) when all (or any) have resolved. This is the "wait for several agents" primitive: fan out requests, wait on the set, end the turn. `thread_send(expects=true, wait=true)` arms the same kind of barrier inline. The `message` payload is what subsumed the old local pub/sub subscriptions.

**Deadlines**: every `expects` send carries a deadline — explicit `deadlineSeconds` or the 15-minute default (spec §9.2; a forgotten deadline used to mean zero automatic recovery). Barriers accept `deadlineSeconds` too. Both get a one-time overdue nudge from the heartbeat's `checkDeadlines()` — the accountability loop a human team runs by habit, covering "nobody answered" and "nobody I'm waiting on answered" alike.

**Silent-debtor nudge**: as a thread's context grows, it can drift into replying in plain text — which only reaches the human — instead of calling `thread_send`, even while holding an unresolved owed reply. A passive, once-per-silence reminder catches this at `turn_end`, never forcing a turn (a forced turn just goads the model into acting for its own sake). The reminder is built entirely from `store.owed`, so it can only ever name the real thread and envelope id actually owed, never a guess; it gates on a boolean so a long silent stretch queues exactly one reminder, and the gate re-arms once per run (at `agent_end`) so a persistently silent thread gets one fresh, escalating nudge per run rather than exactly one for its entire life. The reminder solicits the **"Standing by"** canary (spec §9.4): an acknowledged hold is conforming behavior, and it points at ball-passing (§9.5) when the block is on the requester's side. The send-side companion check soft-warns (never hard-fails) when a reply's `re`/target don't match a real owed record — the engine's discharge gate (owed to `from`, settled only toward `from`) is what actually protects the ledger.

**Human as peer**: `bin/thread-cli.mjs` writes the same envelope format into any thread's inbox (`send`, with `--expects`/`--re`/`--urgency`/`--deliver-after`, including `*` broadcast) and reads the same state files (`list`, `watch`, `tail`, `inbox`) — a human is a full C1 protocol citizen (spec §2.2) without running pi. It's a standalone, zero-dependency script that speaks the Appendix B file layout directly (it doesn't import `src/`), so it only sees threads running against the `local` storage backend.

---

## Known Limitations & Edge Cases

Verified by reading the implementation, not exhaustively tested. Listed so they're a documented tradeoff rather than a silent surprise.

- **Fork identity inheritance** (spec A.1): a user-made `pi --fork` of a participating session copies the session history including the thread-identity entry, so the fork wakes up believing it is the same thread as its parent (two processes, one id). The journal fork is immune (`--no-extensions`); the general case needs an init-time check (same id + fresh `lastSeen` + different pid → deactivate or re-mint). Open.
- **Meeting exclusivity is advisory.** There is no lock: a busy peer says "busy" and the requester retries later. Two threads that request a meeting with each other simultaneously will each see the other's request at their next opening and sort it out conversationally — nothing deadlocks, but nothing enforces a rendezvous either.
- **No automated test coverage yet for**: the CLI `delete` command and the CLI's live loops (`watch`/`tail`). The CLI's `status`/`list`/`send`/`inbox` are covered in `test/unit.test.ts`, including the full CLI↔extension interop loop.
- **`bin/thread-cli.mjs` only ever sees the `local` storage backend** — it speaks the file binding directly and doesn't go through `StorageAdapter`, so threads running with `--thread-storage restate` are invisible to it. Giving it Restate awareness would mean either duplicating `RestateAdapter`'s logic into a zero-dependency script or accepting a dependency it was deliberately designed without — not resolved, flagged as a real gap.
- **A Restate `deliverDue` self-check can't be un-armed** — the public client API has no "cancel a delayed send" call, so the invocation still fires at the original time; it no-ops if the envelope was already drained. Functionally correct (nothing visibly happens) but not a true cancellation at the infrastructure level.
- **`watchInbox` on the Restate backend polls every 2s** instead of getting an instant local `fs.watch` notification — live-delivery latency is worse, though cold-start durability (the guarantee that actually matters) is unaffected.
- **The §7.7 residual loss window**: an envelope claimed by a process that crashes inside the single drain-and-inject tick is moved to `processed/` but never seen by the model. This is the protocol's one declared loss window (spec §7.7, Erratum 5) — inspectable in `processed/`, upgradeable later via peek/ack in Layer 0.

**History**: this document used to carry the protocol definition (eight message types, reply/sync locks, subscriptions, scheduled wakes) plus a long fix log. The protocol moved to PROTOCOL-FORMALISM.md, went through a formal review across Revs 1–8 (five errata found and fixed along the way — misdirected-reply discharge, lock deadlock recovery, heartbeat coalescing, deadline generalization, the drain window), and the Rev-8 migration then deleted locks, types, subscriptions, and the wake machinery outright. The spec's Appendix A records what changed; git history holds the rest.
