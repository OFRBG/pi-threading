# Thread Communication Model — implementation notes

A communication model for independent threads that need to coordinate work, share state, and converse — without losing context or forking their history.

The **protocol itself is specified in [PROTOCOL-FORMALISM.md](PROTOCOL-FORMALISM.md)** (Postbox — the Thread Messaging Protocol, currently Rev 8): the envelope format, the three channels (mailbox/presence/journal), the debt ledger, conformance classes, and the local-fs binding. That document is the design-of-record; this one covers how the pi extension (and its companion standalone scripts) implement it — client behavior, engineering tradeoffs, and code structure — as of **v0.3.2**.

---

## Repo layout

```
src/
  index.ts            extension entry — flags, adapter/store/inbox wiring, attaches
                       lifecycle + tools + commands
  state.ts            ThreadStore: identity, heartbeat, watcher, persistence
  lifecycle.ts         opt-in gate + pi event hooks (session_start/turn_start/...)
  inbox.ts            the messaging engine: send/deliver/drain/barriers/injection gate
  journal.ts          journal fork prompt, cadence policy, spawn plumbing
  commands.ts         human-facing /thread-* slash commands
  core/
    types.ts          Envelope, Obligation, OwedReply, Barrier, StateFile, ThreadStore
    ids.ts             mintId (barriers), ulid, mintEnvelopeId
    format.ts          shared text rendering for thread_status/thread_list/commands
    thread-ops.ts       suspend/resume, shared by tools and slash commands
    system-prompt.ts    the injected "Thread Communication Model" system-prompt block
  tools/
    index.ts            registers all thread_* tools
    messaging.ts         thread_send, thread_wait
    introspection.ts     thread_status, thread_list, thread_journal
    control.ts            thread_suspend, thread_resume
    shared.ts             err() helper
  adapter/
    types.ts            StorageAdapter / JournalAdapter / ThreadAdapter interfaces
    local-fs.ts           the Appendix B binding (files under .thread/threads/)
    registry.ts            --thread-storage factory registry (local is the only built-in)
bin/
  thread-cli.mjs        zero-dependency CLI: human as a full protocol citizen
test/
  unit.test.ts           extension + local-fs adapter + CLI interop (no model calls)
  e2e.test.ts              real pi processes, real (cheap) model calls
.github/workflows/
  ci.yml                 typecheck + lint + unit, on push/PR (free)
  release.yml             on v* tags: same free checks, then publish (paid CI minutes only)
```

**Why `bin/thread-cli.mjs` duplicates ledger logic instead of importing `src/`:** it is a deliberately zero-dependency, single-file Node script — no `npm install`, no TypeScript build step, so it can be dropped onto any machine and just run. That means it cannot `import` from `src/` (which pulls in `@earendil-works/pi-coding-agent`, `typebox`, TS build tooling); it reimplements the pieces of the Appendix B binding and the §9 ledger discharge rule it needs, directly against `fs`, with comments pointing back at the `src/` files it mirrors. This is a conscious duplication tradeoff, not an oversight — see the Known Limitations entry on `thread-cli.mjs` for the corollary (it only ever sees the `local` backend).

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

There is **no waiting state**: a thread that needs a reply arms a barrier (a durable record, not a state) and ends its turn. Debts and barriers survive restarts unconditionally; states don't need to. The only boot repair is `done/stopped → idle` (`src/state.ts`'s `init()`; old/unknown state strings settle to `open`).

```
IDLE → THINKING → WORKING → OPEN ──→ DONE

OPEN ──(suspend)──→ ON HOLD ──(resume / user prompt)──→ OPEN
any ──(unclean exit)──→ STOPPED
```

`src/lifecycle.ts` drives every transition via pi's own event stream: `turn_start` → thinking (and an implicit resume if it was on-hold), `tool_execution_start` → working, `turn_end` → the resting state (`on-hold` if held, else `open`), `agent_end` → the resting state (`on-hold` if held, else `done`), `session_shutdown` (reason `"quit"`) → `stopped` unless the state was `done`/`on-hold` (those are deliberate resting states and survive a clean exit).

---

## Message model (summary — normative version in the spec, §6–§10)

One envelope shape (`src/core/types.ts` `Envelope`); `expects` and `re` presence derive the kind:

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

## The ThreadStore + StorageAdapter abstraction

`src/state.ts`'s `createThreadStore()` is the single mutable object every other module reads and writes (`ThreadStore extends ThreadData`, `src/core/types.ts`): identity (`threadId`, `parent`, `role`), the current `state`, the three durable ledgers (`obligations`, `owed`, `barriers`), plus in-memory-only bookkeeping for the nudge and journal-cadence gates (`owedNudgePending`, `owedSilentStreak`, `lastJournalSignature`, `lastJournalAt`, `journalDebt`). It owns the heartbeat (`setInterval`, `HEARTBEAT_MS = 20_000`) and the inbox watcher subscription, and every mutation goes through `persist()`, which serializes a `StateFile` through `store.adapter.saveState`.

All actual I/O is delegated to a `StorageAdapter` (`src/adapter/types.ts`) — a **domain-shaped** interface (`loadState`/`saveState`/`listThreads`/`threadExists`/`enqueueMessage`/`drainInbox`/`watchInbox`), not a generic filesystem shim. That's deliberate: it has to map cleanly onto both a local directory tree and any future remote backend whose durable state is addressed per-key, and there's no timer/wake member on the interface at all — a delayed delivery is just an envelope carrying `deliverAfter`, held by whichever backend stores it until due. An optional `JournalAdapter` extension (`appendJournal`/`readJournal`) is layered on top (`ThreadAdapter = StorageAdapter & Partial<JournalAdapter>`); backends that skip it simply have no journal channel and callers degrade gracefully (`readJournal` returns `undefined`, `forkJournalEntry` no-ops).

`--thread-storage` (default `local`, currently the only built-in) selects the backend via a factory registry (`src/adapter/registry.ts`); adding a backend means writing one factory function and adding one line there — nothing else in `src/` changes.

### The local-fs binding (`src/adapter/local-fs.ts`, Appendix B)

```
.thread/threads/<id>/
  state.json          presence + client state (write-temp+rename)
  journal.md            append-only journal stream
  inbox/                 one envelope per file, filename = id's ULID tail
  inbox/processed/         claimed envelopes, GC'd after PROCESSED_TTL_MS
  inbox.tmp/               enqueue staging (same filesystem as inbox/)
```

Each thread only ever writes its own `state.json`; other threads only ever *create* files in its `inbox/` — so no cross-process file locking is needed anywhere. Envelope filenames are the id's ULID tail (`mintEnvelopeId` → `<from>/<ulid>`, `src/core/ids.ts`), so a sorted `readdir` **is** FIFO order, and a retried send with the same id overwrites its own file — enqueue idempotence for free.

`enqueueMessage` writes into `inbox.tmp/`, then `fs.renameSync`s into `inbox/` — atomic on the same filesystem, so a reader never observes a partial envelope. `drainInbox` does a sorted `readdir`, skips anything whose `deliverAfter` is still in the future, and — **before** returning each envelope as claimed — renames it into `inbox/processed/`; if the caller throws after that, the message is already moved and won't be redelivered (favors "never deliver twice" over "never lose one", per the spec's §7.7 drain gate).

**processed/ GC (v0.3.2):** `pruneProcessed()` deletes files older than `PROCESSED_TTL_MS` (7 days, `src/core/types.ts`), but only runs **at most once per `PRUNE_INTERVAL_MS` (1 hour) per thread** — a `Map<threadId, lastPrunedAt>` inside the adapter closure gates it. This replaced an earlier once-per-process one-shot GC: a one-shot would let a long-lived process's `processed/` directory outgrow the 7-day retention window forever once the single GC pass had already happened.

`watchInbox` creates the thread's `inbox/` directory eagerly (an `fs.watch` on a not-yet-existing path throws `ENOENT`, which would otherwise leave a never-messaged thread with a silently no-op watch until its next restart), then wraps `fs.watch`.

---

## Message lifecycle, end to end

1. **Mint.** `inbox.ts`'s `sendEnvelope(to, body, opts)` mints an id via `mintEnvelopeId(store.threadId)` (`<from>/<ulid>`) and builds the `Envelope` — `re`/`expects`/`urgency`/`deliverAfter` included only when set (absence is meaningful on the wire: unset urgency reads as `"low"`).
2. **Enqueue.** `store.adapter.enqueueMessage(msg)` — on local-fs, write-to-staging (`inbox.tmp/`) then `renameSync` into the target's `inbox/` (atomic). `sendEnvelope` also checks `isTargetLive(to)` first (fresh `lastSeen` + `status: "running"`) purely to report `"live"` vs `"queued"` back to the caller — delivery itself doesn't depend on liveness; a queued message sits durably until drained.
3. **Bookkeeping at send time.** If `opts.re` is set, `sendEnvelope` looks for a matching entry in `store.owed` and only clears it **if `owedMatch.from === to`** (Errata 1 gate on this ledger — see "Dual ledgers" below). If `opts.expects` is set, a new `Obligation` is pushed with a deadline (explicit or the 15-minute default) and persisted.
4. **Drain claim.** The receiving process's `store.adapter.drainInbox(threadId)` runs — triggered by (a) `session_start`'s deferred initial drain, (b) the `fs.watch`/poll-driven live watcher, (c) `turn_end`, (d) the 20s heartbeat, (e) `session_compact`. On local-fs this is a sorted `readdir` → filter due → rename-to-`processed/` → return; the rename-before-delivery ordering is what makes "claimed but crashed before injection" the protocol's one declared loss window (spec §7.7, Erratum 5).
5. **Deliver.** `inbox.ts`'s `deliver(msg, ctx)` runs the receive-side ledger updates (below) and renders the envelope into an `Injection` (`renderEnvelope` → `[<kind> from <sender> #<id>]` + body + an explicit reply hint when `expects` is set).
6. **Injection.** `drainInbox` batches every delivered envelope's `Injection` parts and hands them to `inject()`, which is gated by `canInject()` (the §7.7 declare-and-shrink gate — see below) and, when clear, calls `pi.sendUserMessage` exactly once for the whole batch.

## Dual ledgers and both discharge gates (Erratum 6, v0.3.1/v0.3.2)

Two separate ledgers, both durable in `StateFile`:

- **`obligations`** (sender side): "I sent an `expects` envelope to X and am waiting on a reply." Recorded in `sendEnvelope` when `opts.expects` is set; cleared when a reply with matching `re` is *delivered* to this thread.
- **`owed`** (receiver side): "Someone sent me an `expects` envelope and I owe them a reply." Recorded in `deliver()` when an inbound envelope has `expects` set; cleared when this thread *sends* a reply whose `re` matches.

Both discharge paths are gated on sender identity — **only a reply from the thread the debt was actually recorded against may clear it.** A `re` that merely numerically collides with someone else's obligation/owed entry (typo, stale copy-paste, malicious neighbor) leaves the ledger untouched and renders as a plain, undischarging message instead (a v0.3.1/v0.3.2 fix — Erratum 6):

| Implementation | Ledger | Gate |
| --- | --- | --- |
| `src/inbox.ts` `deliver()` | `obligations` (sender side, on receiving a reply) | `!obMatch \|\| obMatch.to === msg.from` before filtering `obligations` and resolving barriers |
| `src/inbox.ts` `sendEnvelope()` | `owed` (receiver side, on sending a reply) | `owedMatch && owedMatch.from === to` before filtering `owed` |

`thread_send`'s own soft warning (`src/tools/messaging.ts`) — surfaced to the model when a `re` doesn't match any owed entry, or matches one owed to a different thread than the stated target — is a **UX nicety layered on top**, not the actual protection: it never blocks the send. The real invariant lives in the gates above.

## Barriers (§12.1)

`thread_wait(ids, mode, deadlineSeconds?, message?)` and `thread_send(expects=true, wait=true)` both call `armBarrier()` (`src/tools/messaging.ts`) to push a `Barrier` (`{ id, pending: string[], mode: "all"|"any", createdAt, deadline?, nudged?, message? }`) onto `store.barriers`. Each arriving reply (`inbox.ts`'s `resolveBarriers(re)`, called from `deliver()`) removes its id from every barrier's `pending` list; a barrier is "done" when `mode === "any"` (first reply) or `pending` is empty (`mode === "all"`). On resolution, a `[barrier "<id>" resolved]` note is generated, and if the barrier carries an optional `message` payload it's folded into the **same** injection batch as the resolving envelope and the resolved-note — one wake-up, not three separate ones. That `message` payload is what replaced the protocol's old local pub/sub subscriptions: a barrier armed with `message` is effectively "wake me and remind me what to do" in one call.

## Deadlines and one-shot nudges

Every `expects` send carries a deadline: explicit `deadlineSeconds`, or `DEFAULT_OBLIGATION_DEADLINE_MS` (15 minutes, `src/core/types.ts`) applied by `sendEnvelope` when the caller omits one — without a deadline, `checkDeadlines()` (`inbox.ts`, called from the heartbeat) has nothing to compare against and a silent counterparty means zero automatic recovery. Barriers accept `deadlineSeconds` too. Each overdue obligation/barrier gets exactly **one** high-urgency reminder (`ob.nudged`/`b.nudged` flip to `true` the first time the deadline check fires past due — never re-nudges).

## Silent-debtor nudge and the "Standing by" canary

`turn_end` (`src/lifecycle.ts`) checks: did this turn call a tool? If not, and `store.owed.length > 0`, the thread just ended a turn with unaddressed owed replies without touching `thread_send` — the classic channel-confusion failure where the model "answers" in plain text that only the human sees. The nudge is gated by `owedNudgePending` (queues at most one reminder per consecutive silent-and-owed stretch) and re-armed at `agent_end` (so a persistently silent thread across multiple runs still gets one fresh nudge per run, not exactly one for its entire life). The reminder text is built entirely from `store.owed` — it can only ever name a real thread/envelope id actually owed, never a guessed one — and escalates its wording once `owedSilentStreak >= 2`. It solicits the **"Standing by"** canary (spec §9.4): an acknowledged hold is conforming behavior, distinct from silence; and it points at ball-passing (§9.5, `re=<id>, expects=true`) when the block is on the requester's side, not the debtor's.

## The heartbeat and §7.7 declare-and-shrink injection gate

The last hop — from a drained mailbox into this session's own conversation via `pi.sendUserMessage` — is gated (`canInject()` in `src/inbox.ts`), because pi's extension API gives no native cross-process delivery primitive and the naive approach races two different pi behaviors:

- While pi is mid-run, an injected message just joins pi's own steering/follow-up queue (safe — consumed at turn boundaries and once more after `agent_end` handlers settle).
- While pi is *idle*, each injection starts a **new agent run** after an async preflight; two of those racing means the loser is dropped by pi with `"Agent is already processing"`.
- During auto-compaction the agent *looks* idle, so an unguarded injection starts a run that races the compaction's own context rewrite (pi's TUI holds user input during compaction for exactly this reason; extensions get no such guard for free).

So `canInject()` returns `false` (and every drain call is a no-op — envelopes stay durably claimed-but-undelivered on disk, or simply undrained) while: (a) `compactingSince` is set and less than `COMPACTION_HOLD_MAX_MS` (180s) old — set by `session_before_compact`, cleared by `session_compact` (compaction failures emit no end event, hence the timeout fallback rather than waiting forever); or (b) `inFlightSince` is set and less than `INJECTION_GRACE_MS` (3s) old — set the instant an idle-time injection fires, cleared by `turn_start` (or the 3s fallback if `turn_start` never lands). Each drain that *does* proceed coalesces every pending envelope's `Injection` into exactly **one** `pi.sendUserMessage` call (`inject()`), steering (`deliverAs: "steer"`) if any part is `urgency: "high"`, else `deliverAs: "followUp"`. Retries for gated messages come from the watcher, `turn_end`, and the heartbeat — a hold delays delivery, never loses it.

---

## Journal

The journal is the thread's own account of its state, written by a fork of the thread itself after each turn. It is one of the protocol's two observability channels (spec §8); everything below is how this client produces it.

**Self-written** — the fork has access to the thread's full reasoning, thinking blocks, and context. More accurate than external observation, which can only infer from tool calls.

**Non-interrupting** — the fork runs in the background after `turn_end` (`forkJournalEntry`, `src/journal.ts`). The main thread never pauses.

**Not a thread** — the fork runs with `--no-extensions`. Without that, an installed pi-threading would load inside the fork too, mint a ghost thread identity (it has no `--thread-id`), pollute `.thread/threads/` — and fork its own journal at its own turn's end, chaining forever. `piSelfCommand()` picks the right re-invocation for the running process (node-launched installs re-invoke `execPath entryScript`; standalone `pi` binaries re-invoke `execPath` directly) so the fork works the same across npm/volta/standalone installs, including Windows shims.

**Format:**

```
Working on: auth module
Done: read spec, created /lib/auth.ts with JWT + refresh tokens
Doing: writing tests — two edge cases failing, investigating token expiry
Next: once tests pass, move to middleware layer
Blockers: none
```

Checked once per turn — but most turns don't actually fork. Three gates, in order (`shouldJournal()`, `src/journal.ts`):

1. **News gate** — a turn with no tool call that also left state, obligations, and barriers unchanged is a pure "still waiting" restatement, and is skipped (`journalSignature()` fingerprints `state|obligation-ids|barrier-ids`).
2. **Rate limit** — tool-using turns on the same task journal at most once per `JOURNAL_MIN_INTERVAL_MS` (2 minutes) — a long run of quick tool turns used to produce one near-duplicate entry, and one forked model call, per turn. Structural changes — a new obligation or barrier, the things teammates key off — bypass the limit and journal immediately. A rate-limited turn sets `journalDebt = true`, and `agent_end` pays it with one wrap-up fork, so the final state of a run is always captured exactly once.
3. **Duplicate discard** — a freshly generated entry whose `Working on`/`Done` lines exactly match the previous entry's is discarded even after forking (`isDuplicateOfLastEntry`, compared against the adapter's `readJournal`).

`--thread-journal` (`turn` default / `done` / `off`) and `--thread-journal-model` (default: the thread's own model — a pinned model must resolve on the machine running the fork, or journaling silently fails) are the two knobs (`src/index.ts` flags, read via `journalMode()`/`store.forkJournal()`).

Journal generation throttling is client-private policy: the protocol only sees appends (spec §8.3 — writes are idempotent on id; the guards exist because each entry costs a forked model call, not because the channel needs protecting).

---

## The tool surface

Registered in three groups by `src/tools/index.ts` — five protocol tools (spec §14) plus two client-local on-hold controls:

| Tool | File | What it does |
| --- | --- | --- |
| `thread_send` | `messaging.ts` | Send to one id / comma list / `*` / `role:<role>`; `expects`, `re`, `urgency`, `deliverAfterSeconds`, `deadlineSeconds`, and an optional `wait` that arms a barrier inline |
| `thread_wait` | `messaging.ts` | Arm a standalone barrier over a set of envelope ids, with an optional `mode`, `deadlineSeconds`, and resolution `message` payload |
| `thread_status` | `introspection.ts` | This thread's own id/role/state/status/barriers/obligations/owed + latest journal — the recovery path after a compaction |
| `thread_list` | `introspection.ts` | Every known thread's summary (state/status/role/parent/load counts/lastSeen) |
| `thread_journal` | `introspection.ts` | Read any thread's journal (including your own), with optional `tail`/`lookbackMinutes` filtering |
| `thread_suspend` | `control.ts` | Enter On Hold (client-local, not protocol surface — §14/A.5); inbox queues until resume |
| `thread_resume` | `control.ts` | Leave On Hold back to Open, draining the queued inbox |

`before_agent_start` (`lifecycle.ts`) injects `threadModelPrompt(store)` (`core/system-prompt.ts`) — the "Thread Communication Model" block explaining these tools, the pattern→call map, and the "Standing by" canary — appended to pi's own system prompt, only while the opt-in gate is active.

---

## The three external actors

External actors speak the *same* `.thread/` local-fs store (Appendix B) and interoperate purely through it — atomic renames make claims mutually exclusive regardless of which actor wins the race.

- **`bin/thread-cli.mjs`** — zero-dependency CLI. `list`/`status`/`send`/`inbox`/`tail`/`watch`/`delete` read and write the same files the extension does. A human operator using it is a full **C1** protocol citizen (spec §2.2) without running pi at all. Operator sends default to `urgency: "high"` (a human steering a thread wants it seen at the next opening).

---

## Implementation Notes

Implemented as a pi coding-agent extension. pi's `ExtensionAPI` provides no native cross-process primitive (no session registry, no send-by-ID, no built-in watcher) — every delivery call (`pi.sendMessage`/`pi.sendUserMessage`) only injects into the _calling_ process's own conversation. The extension builds the harness itself, entirely natively, using primitives pi does expose: `registerFlag`/`getFlag` for thread identity, `session_start`/`session_shutdown` lifecycle hooks, and Node's own `fs.watch`/atomic rename.

**Opt-in gate**: `src/lifecycle.ts` keeps `active = false` for any session that neither passes `--thread-id` nor already has a `thread-identity` custom entry in its own session history. Every handler no-ops while inactive, and `session_start` explicitly strips `thread_*` from the active tool set — so an unrelated pi session (including forked children, which never inherit participation because journal forks run `--no-extensions`) never gets a `.thread/` dir, a random identity, the tools, or the system-prompt block.

**Liveness**: each running thread heartbeats its own `state.json` every 20s (`HEARTBEAT_MS`); any reader treats a thread as effectively stopped once `lastSeen` is older than 60s (`STALE_MS`), regardless of the stored `status` field — this is how a hard-killed process (`session_shutdown` never fires on `kill -9`) gets detected. This is the spec's one presence rule that binds every reader (§8.2), and it applies verbatim regardless of storage backend — `toSummary()` (`core/types.ts`) is the one shared implementation, reused by both adapters' `listThreads()`.

**Envelope rendering**: a delivered envelope renders as `[<kind> from <sender> #<id>]` followed by the body, plus an explicit reply hint when the message expects a reply. The id must travel with the message — the receiving model has no other way to learn the correlation id it must echo back as `re`. A revived thread that lost its session recovers pending ids from `thread_status`'s owed list instead of guessing.

**On Hold**: suspending queues the mailbox — nothing is delivered until `thread_resume` (or a direct user prompt, which is an implicit resume). The hold reason is persisted and visible to monitors. Suspend/resume are client-local controls, not protocol surface.

**Broadcast**: `thread_send` accepts `to` as a single id, a comma list, `*` (all known threads except self), or `role:<role>` (threads started with `--thread-role`). Fan-out sends mint a distinct envelope id per target, so replies stay individually correlatable.

**Human as peer**: `bin/thread-cli.mjs` writes the same envelope format into any thread's inbox (`send`, with `--expects`/`--re`/`--urgency`/`--deliver-after`, including `*` broadcast) and reads the same state files (`list`, `watch`, `tail`, `inbox`) — a human is a full C1 protocol citizen (spec §2.2) without running pi. It's a standalone, zero-dependency script that speaks the Appendix B file layout directly (it doesn't import `src/`), so it only sees threads running against the `local` storage backend.

---

## Testing and release

- **`test/unit.test.ts`** — extension logic + the local-fs adapter + the CLI, including the full CLI↔extension interop loop. No model calls, no network — fast and free.
- **`test/e2e.test.ts`** — spins up real `pi` processes and makes real (cheap) model calls, configurable via `PI_E2E_MODEL` (default `deepseek/deepseek-chat`) so the suite doesn't force a specific provider/cost on whoever runs it.

`npm test` runs `test:unit` then `test:e2e` (paid); both are also independently invokable scripts.

**CI** (`.github/workflows/ci.yml`) runs on every push to `main` and every PR: `tsc --noEmit`, lint, `test:unit` — all free, no model spend.

**Release** (`.github/workflows/release.yml`) triggers on `v*` tags (or manual dispatch): re-runs the same free checks, verifies the tag matches `package.json`'s `version`, then publishes twice — `pi-threading` (unscoped) to npmjs via OIDC trusted publishing (no stored token; requires npm ≥ 11.5.1 and one-time npmjs.com Trusted Publisher setup pointing at this workflow), and `@ofrbg/pi-threading` (scope patched in at publish time via `npm pkg set name=...`) to the GitHub npm registry using the built-in `GITHUB_TOKEN`. `package.json`'s checked-in `name` is the unscoped `pi-threading` — the `@ofrbg` scope only exists as the GitHub-registry mirror's name, applied in CI, never committed.

---

## Known Limitations & Edge Cases

Verified by reading the implementation, not exhaustively tested. Listed so they're a documented tradeoff rather than a silent surprise.

- **Fork identity inheritance** (spec A.1): a user-made `pi --fork` of a participating session copies the session history including the thread-identity entry, so the fork wakes up believing it is the same thread as its parent (two processes, one id). The journal fork is immune (`--no-extensions`); the general case needs an init-time check (same id + fresh `lastSeen` + different pid → deactivate or re-mint). Open.
- **Meeting exclusivity is advisory.** There is no lock: a busy peer says "busy" and the requester retries later. Two threads that request a meeting with each other simultaneously will each see the other's request at their next opening and sort it out conversationally — nothing deadlocks, but nothing enforces a rendezvous either.
- **No automated test coverage yet for**: the CLI `delete` command and the CLI's live loops (`watch`/`tail`). The CLI's `status`/`list`/`send`/`inbox` are covered in `test/unit.test.ts`, including the full CLI↔extension interop loop.
- **`bin/thread-cli.mjs` only ever sees the `local` storage backend** — it speaks the file binding directly and doesn't go through `StorageAdapter`, so threads on any future non-local backend would be invisible to it. A consequence of its zero-dependency design; flagged, not resolved.
- **The §7.7 residual loss window**: an envelope claimed by a process that crashes inside the single drain-and-inject tick is moved to `processed/` but never seen by the model. This is the protocol's one declared loss window (spec §7.7, Erratum 5) — inspectable in `processed/`, upgradeable later via peek/ack in Layer 0.

**History**: this document used to carry the protocol definition (eight message types, reply/sync locks, subscriptions, scheduled wakes) plus a long fix log. The protocol moved to PROTOCOL-FORMALISM.md, went through a formal review across Revs 1–8 (five errata found and fixed along the way — misdirected-reply discharge, lock deadlock recovery, heartbeat coalescing, deadline generalization, the drain window), and the Rev-8 migration then deleted locks, types, subscriptions, and the wake machinery outright. The spec's Appendix A records what changed; git history holds the rest. Erratum 6 (v0.3.1/v0.3.2) closed a follow-on gap in the same family: the misdirected-reply discharge fix (Erratum 1) had only ever been applied to the `owed` ledger's send-side check; the symmetric `obligations` ledger check in `deliver()`, and the two standalone `bin/` scripts' own copies of both checks, needed the same gate applied by hand.
