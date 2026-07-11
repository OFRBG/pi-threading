# A formal model of the messaging protocol

**Status: living document.** This is a mathematical restatement of what
`src/inbox.ts`, `src/core/types.ts`, `src/core/thread-ops.ts`, `src/state.ts`,
and `src/tools/{messaging,sync}.ts` implement, written to make the protocol's
invariants explicit and check them for violations. Every claim cites the code
it's derived from; when the code changes, this doc should change with it —
don't let it drift into aspirational documentation. Three real defects have
surfaced so far while building/extending the model — flagged inline as
**Finding 1**, **Finding 2**, **Finding 3**, tracked to resolution in the
changelog at the bottom.

## 1. Objects

**Threads.** `T` is the finite set of thread ids live in a workspace at a given
time. Each `t ∈ T` owns a mutable record

```
t = ⟨σ, L, O, W, B, S, Z⟩
```

- `σ ∈ Σ = {open, thinking, working, listening, in-sync, on-hold, done, …}` — state (`core/types.ts:8-17`)
- `L ∈ (RequestId × T × {sync, reply}) ∪ {⊥}` — the mutex lock, at most one at a time (`core/thread-ops.ts:10-21`)
- `O ⊆ RequestId × T × ObligationType` — sent-side debts (`core/types.ts:59-67`)
- `W ⊆ RequestId × T × OwedType` — received-side debts (`core/types.ts:73-79`)
- `B` — armed barriers, each `⟨pending ⊆ RequestId, mode ∈ {all, any}⟩` (`core/types.ts:82-89`)
- `S, Z` — local subscriptions and scheduled wakes (not central to this analysis)

**Messages.** `m = ⟨from, to, τ, body, rid, δ, t⟩ ∈ M`, where
`τ ∈ Types = {Brief, Note, Question, Answer, Update, Result, Blocker, Sync}` and
`δ ∈ {steer, follow-up}` (`core/types.ts:19-24, 129-137`).

**Type partition.** Two subsets of `Types` matter:

```
ObligationType = {Brief, Question, Blocker, Sync}
OwedType       = ObligationType \ {Sync}   (core/types.ts:27-31)
Locking        = {Question, Blocker, Sync} (messaging.ts:128)
```

`OwedType ⊊ ObligationType`: a `Sync`'s reply is produced by the lock
machinery (`thread_sync_close`), not tracked as a durable owed record. This
asymmetry is deliberate but, as shown below, it's also where an untracked
edge case lives (§3).

## 2. The state machine

`σ_t` moves through `Σ` under a fixed set of triggers, all wired in
`src/lifecycle.ts`'s `pi.on(...)` handlers plus the two lock primitives in
`core/thread-ops.ts`. It's easiest read as one function per trigger rather
than a single transition table, because several triggers close over more
state than just `σ` (the lock, `holdReason`, `toolUsedThisTurn`).

```
turn_start(t):        σ ← "thinking"                              (lifecycle.ts:93)
                       wasOnHold ⟹ holdReason ← null, drain()      (lifecycle.ts:94-99)

tool_execution_start(t): σ ← "working"                             (lifecycle.ts:105)

turn_end(t):           σ ← rest(t, "open")                         (lifecycle.ts:110)

agent_end(t):           σ ← rest(t, "done")                        (lifecycle.ts:181)

acquireLock(t, r, p, k): σ ← (k = sync ? "in-sync" : "listening")   (thread-ops.ts:10-21)
                          L ← ⟨r, p, k⟩

releaseLock(t):          σ ← "open", L ← ⊥                         (thread-ops.ts:24-29)

suspendThread(t, reason): σ ← "on-hold", holdReason ← reason        (thread-ops.ts:31-38)

resumeThread(t):          σ ← "open", holdReason ← null, drain()    (thread-ops.ts:41-51)
                           [no-op if σ ≠ "on-hold"]

init(t) [process boot]:   σ ← f_restore(σ_persisted)                (state.ts:140-145)
```

where the **resting-state function** `rest` is the piece of logic that keeps
a waiting thread waiting across a turn boundary instead of being stomped back
to `open`/`done` just because a turn finished:

```
rest(t, whenUnlocked) =
  "on-hold"                        if σ_t = "on-hold"
  ("in-sync" if L.kind = sync
             else "listening")     if L ≠ ⊥
  whenUnlocked                     otherwise                       (lifecycle.ts:13-17)
```

and the **restore function**, applied once at process boot from the last
persisted `StateFile`, canonicalizes states that only made sense mid-process
into states that make sense for a freshly-started one:

```
f_restore(s) =
  "idle"   if s ∈ {"done", "stopped"}
  "open"   if s = "in-sync"  ∨  (s = "listening" ∧ ¬keepLock)
  s        otherwise                                               (state.ts:140-145)
```

`keepLock` is itself a small predicate worth stating explicitly, because it's
the asymmetry between the two lock kinds made concrete: `keepLock = (L ≠ ⊥) ∧
(L.kind = reply)` (`state.ts:124`) — a reply lock (`Question`/`Blocker`)
survives a restart because the eventual `Answer` is a durable, addressable
message that can still arrive at a revived process; a sync lock does not
survive, because `in-sync` is a live rendezvous between two running
processes and there is no message that "resumes" it — the partner's process
identity for that conversation is gone the moment either side restarts. This
is the same live-vs-durable distinction that makes `Sync ∉ OwedType` in §1 —
one design decision, two independent places it has to be honored correctly.

**Reachability note.** Every trigger above is monotonically forward except
`resumeThread`/the `wasOnHold` branch of `turn_start` (both re-enter `open`
from `on-hold`) and `releaseLock` (re-enters `open` from `listening`/
`in-sync`). So the live subgraph of `Σ` under normal operation is a DAG with
exactly two back-edges, both of which model "an external event ended a wait,"
never "a turn just happened to finish." That's a useful sanity check on any
future state: if you're about to add a new trigger that moves `σ` backward
for a reason *other* than "a wait ended," it's very likely fighting the
existing model rather than extending it.

## 3. The conservation law

Sending an obligation-type message and later closing it is meant to satisfy a
simple invariant: **every open debt has exactly one owner-side record, on
exactly one side, until discharged.** Formally, define two indicator predicates
over time:

```
owes(a, r)  ⟺  ∃ entry in O_a with requestId = r      (a sent it, unanswered)
owed(b, r)  ⟺  ∃ entry in W_b with requestId = r      (b received it, unreplied)
```

The intended lifecycle for `r`, sent `a → b` with `τ ∈ OwedType`:

```
t0: send(a, b, τ, r)         owes(a,r) := true                      (messaging.ts:153-192)
t1: deliver at b             owed(b,r) := true                      (inbox.ts:293-301)
t2: send(b, a', τ', r)       owed(b,r) := false   [τ' ∈ {Answer,Result}]  (inbox.ts:174-180)
t3: deliver at a             owes(a,r) := false                     (inbox.ts:274-281)
```

The two clears (`t2`, `t3`) are **independent, asynchronous writes on
different machines**, not one atomic transaction. `owed(b,r)` is cleared the
instant `b` *sends*, regardless of whether the reply ever reaches `a`.
`owes(a,r)` is cleared only when `a` actually *receives* it. This gap is
structural — a durable multi-process system can't do better without a
two-phase commit nobody wants here — but it means the invariant

```
∀r: owes(a,r) ⟹ owed(b,r) ∨ (r was answered and the answer is in flight)
```

is only *eventually* true, and the code's job is to bound how long the
exception window can last and who gets told about it.

### Finding 1 — the discharge guard is unconditional on destination

Look again at `t2`. The clear in `sendCrossThread` is:

```ts
if (type === "Answer" || type === "Result") {
  const before = store.owed.length;
  store.owed = store.owed.filter(o => o.requestId !== requestId);   // inbox.ts:178
  ...
}
```

This fires for *any* `to`, as long as `requestId` matches something in `b`'s
own `store.owed`. Formally, discharge is keyed only on `rid ∈ W_b`, not on
`(rid, to) ∈ W_b × {correct target}`. `thread_send` layers a soft warning on
top (`messaging.ts:119-127`, added in Phase 1 of the prior plan) when
`to ∉ {owedMatch.from}` — but a warning is advisory text in the tool result,
not a gate. The send still executes, `owed(b,r)` still flips false.

Consequence: if `b` sends the Answer to the wrong thread (or `a` never
receives it because the target string was stale/typo'd but happened to
collide with a real thread id), `owed(b,r)` clears while `owes(a,r)` never
does. The conservation law is now permanently violated for that `r` — `a`
has a debt nobody is tracking as owed, `b`'s ledger says the debt is gone.
The *only* recovery path is `a`'s own deadline nudge (`checkDeadlines`,
`inbox.ts:338-361`), and that only fires **if `a` set a `deadlineSeconds`**
on the original send — otherwise `ob.deadline` is `undefined`, the loop's
guard (`if (!ob.deadline || ...) continue`) skips it forever, and the
obligation sits in `O_a` with no automatic recovery at all.

This isn't hypothetical scope-creep — it's the exact failure class the owed-
reply nudge (Phase 1 of the prior plan) was built to catch on the *receiving*
side, but the *sending* side's discharge is still a soft warning rather than
a hard gate. Tightening it doesn't touch `Sync` (excluded from `OwedType`
already, so unaffected) and is a small, local change:

```ts
if (type === "Answer" || type === "Result") {
  const owedMatch = store.owed.find(o => o.requestId === requestId);
  if (owedMatch && owedMatch.from === to) {
    store.owed = store.owed.filter(o => o.requestId !== requestId);
    await store.persist();
  }
  // else: leave W_b alone — a misdirected/stale reply must not discharge
  // a debt it didn't actually settle. The warning text stays as-is.
}
```

This changes the observable behavior on the *misdirected* path only: today a
misdirected Answer silently succeeds and desyncs the two ledgers; with the
guard, `owed(b,r)` stays true, `thread_status` keeps showing it, and the
existing owed-reply nudge in `lifecycle.ts` keeps reminding `b` — which is
the correct outcome, since `b` in fact still owes `a` a reply.

## 4. The lock automaton and deadlock

`L` is a single mutable slot per thread — mutual exclusion, not a queue. Two
of the three `Locking` types acquire it on the *sender's* side at send time
(`Question`/`Blocker`, via `acquireLock` in `messaging.ts:162-164`); `Sync`
acquires it on the sender's side too, but through a different tool
(`thread_sync_request`, `sync.ts:46`) and unconditionally before the message
even leaves (`acquireLock` then `sendCrossThread`, rolled back on send
failure). All three acquire it on the *receiver's* side on delivery
(`Sync` in `inbox.ts:304-318`; `Question`/`Blocker` don't lock the receiver —
only the sender waits).

Define the **wait-for graph** `G = (T, →)` at an instant: `a → b` iff
`L_a = ⟨r, b, _⟩` (a is locked, waiting on a reply keyed to `r`, from `b`).
A cycle `a → b → a` is a live deadlock candidate: both sides are locked
waiting on each other. `resolveTargets`/existence checks (`messaging.ts:140-
145`, `sync.ts:39-45`) rule out locking onto a thread that has *never
existed*, but they do nothing about a thread that exists and is itself
locked waiting on you.

### Finding 2 — deadlock is bounded by nudges, not prevented, and only when a deadline was set

The protocol doesn't do lock-ordering or cycle detection at acquire time —
it can't, cheaply, across independent OS processes with only a shared
filesystem. Instead it relies on two separate mitigations, and it's worth
being precise about what each one actually covers:

1. **Symmetric-`Sync`-race self-healing.** If `a` and `b` call
   `thread_sync_request` on each other concurrently, both self-lock with
   *different* `rid`s (`mintId("sync." + partner)` — asymmetric per
   direction) before either message lands. Whichever `Sync` arrives second
   finds the receiver already locked and rejects it with an `Answer` keyed to
   the *original* `rid`, which unwinds the sender's lock on delivery
   (`inbox.ts:304-316`, the `store.lockEventId === msg.requestId` check in
   `deliver()`). This resolves the 2-cycle **only if that rejection Answer is
   itself delivered** — which routes through the exact same injection-gate
   and discharge path as everything else. If it's dropped, both sides end up
   permanently locked with no message left to unstick either one.

2. **Deadline nudge for `Question`/`Blocker` cycles.** These don't self-heal
   like `Sync` does — there's no receiver-side lock or rejection path at all,
   just two independent sender-side locks. A cycle here is inert: nothing in
   the system observes it as a cycle. The only way either side gets nudged
   is `checkDeadlines` firing on an *individual* obligation's own
   `deadlineSeconds` timer (`inbox.ts:338-361`) — a per-obligation timeout,
   not cycle detection. **`wait`/`deadlineSeconds` are both optional
   parameters on `thread_send`** (`messaging.ts:72-89`). A `Question`↔
   `Question` cycle formed by two calls that both omit `deadlineSeconds` has
   zero automatic recovery: `ob.deadline` is `undefined` for both sides,
   `checkDeadlines`' guard skips them forever, and the only way out is a
   human or a third thread noticing via `thread_list`/`thread_status` and
   intervening manually.

So: liveness under contention is a **detect-and-recover-via-timeout**
strategy, and today it's opt-in per call rather than a system default. The
formal gap is narrow but real: nothing currently distinguishes "I chose not
to set a deadline because I don't need one" from "I forgot," and the second
case is exactly the one that leaves a true 2-cycle unrecoverable.

Two independent, low-cost hardenings fall out of this, not mutually
exclusive:

- **Default deadline for locking sends.** Give `Question`/`Blocker`/`Sync`
  a fallback `deadlineSeconds` (e.g. via a workspace-level constant) when the
  caller omits one, rather than leaving `ob.deadline` unset. This converts
  "no automatic recovery" into "bounded automatic recovery" for the whole
  `Locking` type-class, at the cost of an eventual nudge firing on
  legitimately long-lived waits — which is exactly the tradeoff `deadlineSeconds` already exists to let a caller tune, just flipped to opt-out instead of opt-in.
- **Cheap cycle check at acquire time.** Before `acquireLock` commits a
  `Question`/`Blocker` lock onto partner `b`, a single `store.adapter.loadState(b)`
  (already the primitive `isTargetLive` uses, `inbox.ts:123-127`) can check
  whether `b`'s own `lockEventId`/`lockPartner` already points back at `a`.
  This doesn't catch cycles that form in the race window between two
  concurrent sends (TOCTOU — same class of gap as the `Sync` case above,
  fundamentally unfixable without a real distributed lock), but it does
  catch the far more common straight-line case: `a` deliberately sends a
  `Question` to `b` while `b` is *already* sitting there waiting on `a`.
  That's a strict, symmetric, cheap-to-check precondition failure, not a
  probabilistic one — worth rejecting synchronously rather than deferring
  to a timer.

## 5. The injection gate as a queueing system

Model each thread's own pi session as a single server with two down-states:

```
available(t) = ¬compacting(t) ∧ ¬inFlight(t)     (canInject(), inbox.ts:91-96)
compacting(t): true for ≤ COMPACTION_HOLD_MAX_MS (180_000ms) after session_before_compact,
               cleared early by session_compact
inFlight(t):   true for ≤ INJECTION_GRACE_MS (3_000ms) after an idle-time inject(),
               cleared early by turn_start (noteRunStarted)
```

Injections (`Injection = ⟨text, delivery⟩`) are produced by four independent
sources — `drainInbox`, `checkDeadlines`, `checkSchedules`, `fireSubscribers`
— and queue durably on disk (the inbox file, the obligation/barrier/schedule
records themselves) whenever `¬available(t)`. `inject()` is the sole point
where `Injection[]` becomes a real `pi.sendUserMessage` call, and it already
does the right thing *within* one call site: it coalesces a whole `parts`
array into **one** message, `steer` if any part demands it
(`inbox.ts:98-108`). That's a genuine amortization — collapsing what could be
`|parts|` separate server-availability windows into 1.

### Finding 3 (optimization, not correctness) — coalescing stops at the function boundary, not the heartbeat tick

`store.startHeartbeat` (wired in `lifecycle.ts:62-66`) runs all three
heartbeat-driven checks in sequence:

```ts
await inbox.drainInbox(ctx);
await inbox.checkDeadlines(ctx);
await inbox.checkSchedules(ctx);
```

Each function independently: checks `canInject()`, builds its own `parts`,
and calls `inject(parts, ctx)` on its own. If `drainInbox` finds a message to
deliver *and* `checkDeadlines` finds an overdue obligation in the same tick,
that's two separate `inject()` calls, and the first one — if the thread was
idle — sets `inFlightSince = Date.now()` (`inbox.ts:104`). The second call's
own `canInject()` check, running microseconds later, now sees
`inFlightSince` inside the 3-second grace window and returns `false`. Not a
lost message (deadlines/schedules leave their durable record untouched and
retry next tick), but a **self-inflicted latency tax**: an overdue-obligation
nudge that could have shipped in the same batch as the inbox drain instead
waits a full `HEARTBEAT_MS` (20s) longer than necessary, purely because the
three checks don't share one `parts` array.

The fix is mechanical — thread one `parts: Injection[]` through all three
calls (or have the heartbeat callback collect their return values) and call
`inject()` exactly once per tick:

```ts
store.startHeartbeat(async () => {
  const parts: Injection[] = [
    ...(await inbox.drainInboxParts(ctx)),   // same bodies, minus the trailing inject() call
    ...(await inbox.checkDeadlineParts(ctx)),
    ...(await inbox.checkScheduleParts(ctx)),
  ];
  inbox.inject(parts, ctx);
});
```

This is the same reasoning that motivated coalescing *within* `drainInbox`
in the first place (documented in `inbox.ts:78-87`'s block comment) — it
just wasn't carried one level up to the caller that already had three
sibling sources of `Injection[]` in hand.

## 6. Barrier resolution as set algebra

A barrier `b = ⟨pending, mode⟩` resolves against an incoming `rid` by

```
pending' = pending \ {rid}
done ⟺ (mode = any) ∨ (pending' = ∅)          (inbox.ts:241-243)
```

i.e. `any` is existential (`∃ rid ∈ pending` — trivially satisfied the
instant *any* member arrives, since `resolveBarriers` only runs for a `rid`
already confirmed `∈ pending` via the `includes` filter one line above), and
`all` is the standard set-difference-to-empty. `resolveBarriers` scans every
barrier in `store.barriers` per delivered `Answer`/`Result`
(`inbox.ts:233-253`) — `O(|B_t| · |pending|)` worst case per message. Given
`|B_t|` is bounded by how many outstanding fan-out waits one thread can
plausibly hold open at once (a handful, in practice — each one requires an
explicit `thread_send(wait=true)` or `thread_await` call), this is not a
scaling concern worth optimizing; noted here only because the set-algebra
framing makes the `any`/`all` semantics and the deadline-nudge interaction
(`inbox.ts:350-357`, same per-barrier `nudged` one-shot guard as obligations)
fully precise rather than read off the code by inspection each time.

## 7. Escalation as a bounded Markov chain

`owedSilentStreak ∈ {0,1,2,3}` (capped, `lifecycle.ts:148`) with transitions

```
toolUsedThisTurn        ⟹ streak → 0, owedNudgePending → false     (lifecycle.ts:144-146)
¬toolUsedThisTurn ∧
  ¬lockEventId ∧ owed≠∅ ⟹ streak → min(streak+1, 3)                (lifecycle.ts:147-148)
agent_end                                                          
  (every run)            ⟹ owedNudgePending → false                (lifecycle.ts:186)
```

`owedNudgePending` is the *emission* gate (fires at most once per run);
`owedSilentStreak` only selects wording severity once a nudge does fire
(`escalation` string, `lifecycle.ts:154-157`). This is a fairly deliberate
design already (documented at length in the plan that shipped it, with a
specific bug — unreachable escalation — caught and fixed by a second review
pass before merge), so there's no defect to report here. One formal
observation worth carrying forward if this is revisited: the streak counts
*turns*, not wall-clock time. A thread that takes one very long turn to
think and a thread that takes three quick silent turns register identically
different severities that don't track actual elapsed debt age. If escalation
wording is ever meant to reflect urgency rather than call-count, `receivedAt`
on the `OwedReply` record itself (already durable, `core/types.ts:78`) is the
more faithful signal — `now − min(o.receivedAt for o in store.owed)` instead
of `owedSilentStreak`.

## Summary of actionable findings

| # | Where | Class | Status |
|---|-------|-------|--------|
| 1 | `inbox.ts` (`sendCrossThread` discharge) | Correctness — conservation law violated by misdirected Answer/Result | **Fixed** — discharge now gated on `owedMatch.from === to` |
| 2 | `tools/messaging.ts` / `core/types.ts` (lock acquisition) | Liveness — `Question`/`Blocker` cycles have zero automatic recovery when no `deadlineSeconds` is passed | **Fixed** — `DEFAULT_LOCK_DEADLINE_MS` (15min) fallback + synchronous 2-cycle rejection at acquire time; `Sync` deliberately excluded (see changelog) |
| 3 | `lifecycle.ts` heartbeat wiring / `inbox.ts` | Latency — heartbeat's three injection sources self-serialize instead of coalescing | **Fixed** — `drainInbox`/`checkDeadlines`/`checkSchedules` take an optional `collect?: Injection[]`; heartbeat shares one array, one terminal `inject()` |

None of these are urgent — the system already degrades gracefully in each
case (dangling obligation surfaces via `thread_status` and, if a deadline was
set, a nudge; a locked cycle is visible to any thread that runs
`thread_list`; the latency tax is bounded by one heartbeat interval). They're
the kind of thing worth fixing opportunistically rather than as their own
project.

## Changelog

Findings are tracked here rather than left implicit in prose above, so the
doc's "current truth" is always visible without re-reading every section.

| Date | Change |
|------|--------|
| 2026-07-02 | Initial model: §1 Objects, §3 Conservation law (Finding 1), §4 Lock automaton (Finding 2), §5 Injection gate (Finding 3), §6 Barrier algebra, §7 Escalation chain. |
| 2026-07-11 | Added §2 State machine (turn-cycle triggers, `rest`/`f_restore`/`keepLock`) — the model was previously silent on `σ` transitions outside locks. Findings 1–3 implemented and verified (tsc/eslint/prettier clean, unit suite 123→134 tests, all passing); table above updated to reflect the fixed code, not just a plan. `Sync` was deliberately excluded from Finding 2's default-deadline and cycle-check hardening — it goes through a different tool (`thread_sync_request`) and already self-heals a concurrent-race 2-cycle via `deliver()`'s receiver-side rejection path (§4), so a timeout-based fallback would be redundant rather than protective. Changes are implemented but **not yet committed** — working tree has 5 modified files pending review. |

**Open model gaps** (known incomplete, not yet formalized):
- The subscription mechanism (`Subscription`, `fireSubscribers`) is used in
  the message-flow sections but never given its own algebraic treatment —
  it's structurally a lightweight pub/sub keyed on `eventId`, worth a short
  section if it grows more call sites.
- `ScheduledWake`/`checkSchedules` likewise — currently just referenced from
  the queueing section (§5), not modeled as its own timer algebra.
- No treatment yet of the `Restate` storage-adapter backend mentioned in
  `inbox.ts:63-65`'s comment (`checkSchedules` behaves differently there) —
  everything above is implicitly about the local-fs adapter's semantics.
- Journal forking (`shouldJournal`/`forkJournal`) is a parallel bookkeeping
  system this doc doesn't touch at all.
