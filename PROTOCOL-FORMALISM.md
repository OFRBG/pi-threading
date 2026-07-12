# Postbox — Thread Messaging Protocol

**Status:** Living Specification &nbsp;·&nbsp; **Revision:** 8 &nbsp;·&nbsp; **Relation to code:** implemented — the A.6 migration landed 2026-07-12; Appendix A records what changed &nbsp;·&nbsp; **Errata:** 5 reported, 5 resolved (§16)

## 1. Status of this document

Rules are written at the generality their own justification actually has.
Where the spec is broader or cleaner than the current implementation, the
spec wins: the gap is either a migration item (Appendix A) or, when the
spec catches a real defect, an **erratum** (§16). Nothing this protocol
describes is in production, so the main body carries no compatibility
baggage — superseded designs are dropped from the spec and survive only in
Appendix A, as a coding reference for the migration.

## 2. Layering model

The protocol is three layers with strict downward-only dependencies:

```
+----------------------------------------------------------+
|  LAYER 2 — SEMANTICS (client-side, per-implementation)    |
|  vocabulary (request/reply/...), obligations & owed       |
|  replies, deadlines & nudges, barriers, state machine     |
+----------------------------------------------------------+
|  LAYER 1 — POSTBOX (the protocol proper, wire-level)      |
|  self-contained durable envelopes, per-thread mailboxes,  |
|  presence, journal, delivery windows & batching           |
+----------------------------------------------------------+
|  LAYER 0 — STORE (pluggable backend)                      |
|  StorageAdapter (state + mailbox) | JournalAdapter (ext.) |
|  bindings: local-fs (Appendix B), Restate                 |
+----------------------------------------------------------+
```

- **Layer 0** is a narrow storage contract. The postbox never touches a
  filesystem, a database, or an RPC client directly — only this interface.
  The protocol is **store-agnostic by construction**.
- **Layer 1** is the only part two independent implementations must agree
  on: what an envelope is, where it goes, when it may be delivered, and
  what a thread publishes about itself.
- **Layer 2** is meaning: which envelopes create debts, how a client
  waits, what states it displays. None of its _machinery_ crosses the
  wire (its published state does — §2.1); two peers can run different
  Layer-2 policies against the same Layer-1 traffic and interoperate.

**2.1 Three channels, one store.** Threads share three surfaces through
the store, and only one of them is the mailbox:

| Channel  | Access                              | Content                             | Spec  |
| -------- | ----------------------------------- | ----------------------------------- | ----- |
| Mailbox  | write-any, read-owner (destructive) | envelopes                           | §6–§7 |
| Presence | write-owner, read-any               | liveness + coarse state summary     | §8    |
| Journal  | write-owner, read-any               | history stream (optional extension) | §8    |

The mailbox is the communication channel; presence and journal are
observability channels. No thread's Layer-2 machinery (debts, barriers)
is ever interpreted by another thread's machinery — but some Layer-2
_state_ is published for others to read, and readers get normative rules
for it (§8). Those fields are Layer-1 surface, whatever layer computes
them.

**2.2 Conformance classes.** Not every actor runs every layer. Rules bind
by class: §5–§8 bind everyone who touches the store; §9 onward binds only
C2 and up.

| Class                     | Runs                                          | Examples                                                |
| ------------------------- | --------------------------------------------- | ------------------------------------------------------- |
| **C0 Observer**           | reads presence + journal                      | dashboards, `thread-cli list/status`                    |
| **C1 Postbox actor**      | C0 + mailbox enqueue/drain                    | a human on `thread-cli send/tail`, harnesses, cron jobs |
| **C2 Correlating client** | C1 + the debt ledger and deadlines (§9)       | a minimal agent client                                  |
| **C3 Full client**        | C2 + waits, state machine, vocabulary profile | the pi extension                                        |

Every protocol feature MUST be exercisable by a C1 actor. A feature that
needs both peers at C3 does not belong in the protocol.

**2.3 Participation is opt-in.** A process is a thread only if it
explicitly joins (loads a client with a thread id). In particular,
**forked children of a participating thread do not inherit participation**
— a fork is a plain process unless explicitly enrolled. Nothing in the
protocol assumes a process tree maps to a thread tree; `parent` (§8.1) is
declared topology, not inherited.

## 3. Requirements language

**MUST** / **MUST NOT**: enforced unconditionally; violations are bugs and
are tracked in §16. **SHOULD**: followed by default, knowingly
overridable. **MAY**: permitted, left to the acting thread's judgment.

## 4. Terminology

| Term       | Meaning                                                                                                        | Layer |
| ---------- | -------------------------------------------------------------------------------------------------------------- | ----- |
| Thread     | An addressable peer; identity is its thread id (§6.2). Need not be a pi process — anything that speaks Layer 1 | 1     |
| Envelope   | One message: `{id, from, to, body, sentAt, re?, expects?, urgency?, deliverAfter?}` (§6)                       | 1     |
| Mailbox    | A thread's durable inbox: envelopes enqueue when the peer is absent, drain when it returns                     | 1     |
| Presence   | A thread's published liveness/status record; write-owner, read-any (§8)                                        | 1     |
| Journal    | A thread's published history stream; write-owner, read-any (§8)                                                | 1     |
| Obligation | Sender-side record that an envelope it sent expects a reply                                                    | 2     |
| Owed reply | Receiver-side mirror of the same debt                                                                          | 2     |
| Barrier    | A client-side wait across outstanding envelope `id`s, resolved on `all`/`any`                                  | 2     |

---

# PART I — LAYER 0: THE STORE

## 5. Store contract

The persistence surface is one core interface plus one optional
extension:

```ts
interface StorageAdapter {
  configure(baseDir)                 // one-time setup
  loadState(id) / saveState(id, s)   // the thread's own state (presence source)
  listThreads() / threadExists(id)
  enqueueMessage(msg)                // place msg in the mailbox msg.to names
  drainInbox(id)                     // claim-and-remove, FIFO, atomic
  watchInbox(id, cb)                 // live trigger — NOT a durability mechanism
}

interface JournalAdapter {           // optional extension
  appendJournal(id, entry)
  readJournal(id)
}
```

A backend implements `StorageAdapter` and MAY implement `JournalAdapter`
(`StorageAdapter & Partial<JournalAdapter>`); the journal channel (§8.3)
simply doesn't exist on backends that omit it, and C0 readers degrade
gracefully. The journal is split out because it is not part of the
message world proper — it is a union _over_ it (§8.3), an extension.

There is no wake/timer member. A future self-wake is a self-addressed
envelope with `deliverAfter` (§6), so Layer 0 is pure storage and delayed
delivery is durable on every backend by the same mechanism as everything
else.

Requirements on any backend:

- `enqueueMessage` MUST be durable before it returns — Layer 1's
  "delayed, never lost" guarantee (§7.4) is only as strong as this. It
  MUST NOT make an envelope drainable before its `deliverAfter` (if
  present) has passed.
- `drainInbox` MUST be atomic claim-and-remove: two concurrent drains
  MUST NOT both return the same envelope.
- `watchInbox` MAY be best-effort. Durability comes from the cold-start
  drain, not the watcher.
- State readers MUST tolerate a stale record: a thread that died without
  cleanup is detected by `lastSeen` age (`STALE_MS`), never by trusting
  `status` (§8.2).

**5.1 The binding is the interop point.** `StorageAdapter` is a
TypeScript interface — a contract between one codebase's modules, not
something a Go harness or a human can link against. Independent
implementations interoperate by agreeing on a **binding**: the concrete
encoding of mailboxes, presence, and journals onto a shared store. The
local-fs binding is normative in Appendix B; the Restate binding (object
keys, handler names, payload shapes) remains an open gap (§17).

**5.2 Trust model.** Everything inside one store is one trust domain:
any actor that can reach the store can forge `from`, read any journal,
and write into any mailbox. Envelope fields are not authenticated and are
not meant to be — the security boundary is access to the store itself
(filesystem permissions, Restate auth), never the protocol. Federation
across trust domains is out of scope.

---

# PART II — LAYER 1: THE POSTBOX

This is the protocol proper — the only layer where independent
implementations must agree.

## 6. Envelope format

One self-contained record, five required fields, no type tag:

```
Envelope {
  id:           string               own identity — always minted, never echoed (§6.2)
  from:         ThreadId
  to:           ThreadId             consumed at enqueue: names the target mailbox
  body:         string
  sentAt:       ISO-8601
  re?:          EnvelopeId           reply correlation: discharges the debt on `re`
  expects?:     true                 sender tracks a debt; reply with re = this id
  urgency?:     "high" | "low"       delivery-priority level (default: low)
  deliverAfter?: ISO-8601            not drainable before this instant
}
```

The envelope is self-contained: `enqueueMessage(msg)` takes no target
parameter because `to` _is_ the addressing input — the store consumes it
to place the envelope. After placement, position is authoritative:
receivers MUST NOT branch on `to` (an envelope in your mailbox is yours,
wherever its `to` claims it was headed). Layer 1 treats `body` as opaque
payload. `id`/`re` are the sole join keys between a request and its
reply.

`urgency` is an ordered level, deliberately abstract: each client
translates it into its own delivery mechanics — the pi client maps
`high` to a steering injection and `low` to delivery at idle; another
implementation may map levels onto queue priorities or notification
tiers. It is a hint the receiving client SHOULD honor (§7.5) but no
sender can rely on. The enum is ordered and MAY grow levels; receivers
MUST treat unknown levels as `low`.

`deliverAfter` makes delayed delivery a wire feature: the store holds
the envelope invisible until the instant passes (§5). A self-addressed
`deliverAfter` envelope is the protocol's scheduled wake (§12.2).

**6.1 Derived kinds.** The envelope is a union of four message kinds,
discriminated **structurally by field presence** — never by a tag:

| Kind           | `expects` | `re` | Meaning                                                                |
| -------------- | --------- | ---- | ---------------------------------------------------------------------- |
| `Info`         | —         | —    | fire-and-forget                                                        |
| `Request`      | ✓         | —    | creates an obligation/owed pair (§9)                                   |
| `Reply`        | —         | ✓    | discharges the debt on `re`                                            |
| `ReplyRequest` | ✓         | ✓    | discharges `re` _and_ opens a new debt — a reply that asks a follow-up |

The two optionals are orthogonal, not exclusive: `ReplyRequest` is a
legal, useful kind. Implementations SHOULD expose this union as
refinement types over the record (e.g. TypeScript narrowing on field
presence) — derived, never serialized.

**6.2 Identifiers.** All identifiers are opaque strings to receivers;
structure inside them is for minting and debugging, never for mechanical
branching. Constraints and recommended forms:

- **Envelope ids** MUST be unique per sender (receivers MAY use `id` as
  a dedup key, §7.6). RECOMMENDED form: `<from>/<ulid>` — globally
  unique by construction (sender scope + monotonic ULID), time-sortable,
  and self-describing about origin. A bare UUID is conforming but loses
  sortability and self-description.
- **Thread ids** are bare names unique within a store (`--thread-id`,
  or generated and persisted). They MUST be safe as path segments in the
  binding (Appendix B). A namespaced form `<store>:<name>` is reserved
  for future federation and MUST NOT be minted today (§5.2: federation
  out of scope).

**6.3 Design rationale.** Precedent from protocols that faced the same
choices:

- **Structural union, no tag** — JSON-RPC 2.0 is the closest relative: a
  genuine Request/Notification/Response union discriminated purely by
  field presence, no `kind` field on the wire. Rule: when the
  discriminant is fully derivable from field presence, don't duplicate
  it as a tag — a tag can contradict the structure, and structural
  discrimination makes those states unrepresentable.
- **Reply-ness as an optional header** — email (RFC 5322) models replies
  with the optional `In-Reply-To` header on an otherwise uniform
  message. That is `re` exactly, and it is why replies to replies cost
  nothing: every envelope has its own `id`, so follow-ups about a reply,
  barriers over replies, and correlation chains need no new machinery.
- **Address on the envelope, position as truth** — like postal mail: the
  writer addresses the envelope, the carrier routes by it, and the
  recipient doesn't re-check the address to decide whether the letter in
  their box is theirs.

**6.4 Extensibility.** Receivers MUST ignore unknown envelope fields.
New capabilities are added as optional fields whose absence means "old
behavior." There is deliberately no version field: with must-ignore plus
presence discrimination, a version tag would be a second source of truth
that can contradict the fields it describes — §6.3's argument against
type tags, applied to versioning.

## 7. Delivery

**7.1 Enqueue.** Sending is one durable write into the mailbox `to`
names. The target need not exist yet or ever run — a mailbox is a
durable dead-drop.

**7.2 Drain.** A live pi thread drains its mailbox at session start, at
turn boundaries, on watcher triggers, and on a heartbeat. External
actors drain by reading their own mailbox whenever they choose —
polling is a conforming client.

**7.3 Delivery windows.** A pi client MUST NOT inject drained envelopes
into its live session at arbitrary moments:

```
available = ¬compacting ∧ ¬inFlight
```

`compacting` holds during context compaction (bounded by a timeout);
`inFlight` holds briefly after an idle-time injection, cleared by
`turn_start`. This is client behavior (Layer 2 strictly), specified here
because it bounds Layer 1's _observable latency_.

**7.4 Delayed, never lost.** While a client is unavailable, envelopes
stay in the durable mailbox. Every wait in this protocol degrades to
"retry later," never "drop."

**7.5 Batching.** A client draining multiple envelopes MUST coalesce
them into one session injection, at the highest `urgency` present; a
client running several drain sources in one tick MUST coalesce across
them too (Errata 3, §16).

**7.6 Ordering and duplication.** Drain preserves per-mailbox FIFO by
enqueue order (`deliverAfter` envelopes enter the order when they become
drainable). No ordering exists _across_ channels or mailboxes — a reply
and a presence update may be observed in either order. Enqueue is
at-least-once from the sender's perspective: a sender that cannot tell
whether its write landed MAY retry with the same `id`, so receivers
SHOULD treat `id` as a dedup key.

**7.7 The drain window (Erratum 5, resolved and implemented).** §5
requires drain to be destructive claim-and-remove, and §7.4 promises
"delayed, never lost." Read together, durability ends at the drain — so
the window between claiming and delivering is the protocol's one
declared loss window, and this section bounds it: a client MUST NOT
drain except when it can deliver in the same tick — for a pi client,
only while the delivery window (§7.3) is open — and MUST inject every
claimed envelope in that same tick. The residual exposure is a process
crash inside a single drain-and-inject tick, accepted and documented
here. Strengthening Layer 0 to peek/ack consumption (removal after
delivery) remains available as a future upgrade; it changes the adapter
contract and binding, not the wire.

## 8. Presence and journal

The two observability channels (§2.1). Both are write-owner, read-any.

**8.1 Presence record.** Each thread publishes a presence record. Only
the following fields are protocol surface; everything else in an
implementation's state file is private to it:

| Field                                      | Meaning                                                                                                                                                            |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `id`                                       | thread identity                                                                                                                                                    |
| `status`                                   | `running` \| `stopped` — advisory only (§8.2)                                                                                                                      |
| `lastSeen`                                 | heartbeat timestamp — the authoritative liveness signal                                                                                                            |
| `state`                                    | coarse activity label — informative; readers MUST NOT branch mechanically on specific values, since another implementation may run a different state machine (§11) |
| `parent`, `role`                           | declared topology and deployment metadata (§2.3)                                                                                                                   |
| `obligations`, `owed`, `barriers` (counts) | coordination-load observability                                                                                                                                    |

**8.2 Liveness rule.** Readers MUST derive liveness from `lastSeen` age
against `STALE_MS`, overriding the stored `status` — a hard-killed
process never writes its own obituary. This is the one presence rule
normative for every class from C0 up.

**8.3 Journal.** The journal is not a second message system — it is a
union over the same one: an **append-only, non-draining stream of
envelope-shaped notes** the owner writes to itself
(`{id, from, body, sentAt}` with `from = owner`), readable by anyone,
consumed by no one. Backends provide it through the optional
`JournalAdapter` (§5); on backends without it the channel simply doesn't
exist.

Because entries are envelope-shaped, appends are idempotent on `id` —
the write path needs no guarding, including for notes produced by forked
model calls. What the pi client's journal guards actually throttle is
_generation_ (each entry may cost a forked model call), and that is
private Layer-2 client economy, invisible to the protocol. Readers MUST
treat `body` as opaque text and MUST NOT parse it mechanically.

---

# PART III — LAYER 2: SEMANTICS

Nothing below is interpreted by another thread's machinery; what a
thread _publishes_ about itself is specified in §8. Each implementation
brings its own version of this layer (or none — a human on `thread-cli`
runs almost none of it and interoperates fine).

## 9. Correlation: obligations and owed replies

The kernel is the two envelope optionals, read directly:

- **`expects`** — the envelope creates a debt: the sender MUST record an
  obligation, the receiver MUST record an owed reply, both keyed by the
  envelope's `id`.
- **`re`** — the envelope discharges the debt keyed by `re`.

**9.1 Discharge.** A replying thread MUST clear its owed-reply record
for `re`, and MUST NOT clear it unless the reply's `to` matches the
thread the debt is owed to (Errata 1, §16). Send-side warnings for
unrecognized or misdirected `re` values SHOULD be produced.

**9.2 Default deadline.** Every `expects` send SHOULD carry a deadline;
when the caller omits one the client MUST apply a fallback
(`DEFAULT_OBLIGATION_DEADLINE_MS`, currently 15 minutes; Errata 2/4,
§16). An overdue obligation gets exactly one reminder (one-shot
`nudged`).

**9.3 Non-atomicity.** Discharge (at the replier) and obligation-clearing
(at the original sender, on receipt) are independent writes on two
processes. The guarantee is eventual; the deadline bounds the window.

**9.4 Silent-debtor nudge.** A pi client whose thread ends a no-tool
turn while holding owed replies receives an escalating passive reminder,
capped, re-armed once per run.

The reminder solicits a **canary acknowledgement**: a thread that is
intentionally holding the debt while it works answers with the phrase
**"Standing by"** in its turn output — a cheap, checkable signal that it
still speaks the protocol. The canary's absence is the drift signal this
nudge exists to catch: a thread that has slipped into answering in plain
text (which reaches only the human, never the creditor) produces neither
a discharging reply nor the canary. The client SHOULD therefore escalate
on _missing canary_, not on silence alone — an acknowledged hold is
conforming behavior and resets the escalation clock; an unacknowledged
silent turn with debts outstanding is presumed drift. (Requires the
client to observe its own turn text; whether the pi extension API exposes
this is an open implementation question — the rule stands regardless,
per §1.)

The canary is not an escape hatch: it resets only the _debtor's own_
escalation, never the counterparty's ledger — the exchange stays bounded
by the creditor's deadline nudge (§9.2), so a thread cannot stand by
forever unchallenged. And a thread standing by while holding
_obligations_ (waiting on others) needs no prompting at all: that is
conforming behavior, already bounded by the deadlines on each
obligation.

**9.5 Holds: pass the ball, don't pause the debt.** A debt has no hold
state. A debtor that cannot yet discharge has exactly two conforming
moves:

- **Keep working, acknowledge nudges** with the canary (§9.4) — right
  when the debtor has everything it needs and just needs time.
- **Pass the ball** when the block is on the requester's side (missing
  data, ambiguous ask): send a `ReplyRequest` (`re` + `expects`, §6.1)
  — "here is what I need to proceed." This discharges the original debt
  and opens a mirrored one owed by the requester. The ledger keeps
  exactly one side owing the next move: deadlines tick against whoever
  actually holds the ball, and neither side's nudge machinery fires at a
  thread that is legitimately waiting. The final answer arrives as an
  ordinary reply in the new exchange.

Consequence for barrier users: a barrier over the original `id` resolves
on the counter-request — the wait for _a response_ did end. A client
that still wants the eventual answer re-arms over the new `id`.

## 10. Vocabulary

Words are prompt-level names for kernel patterns — they never appear on
the wire, and any client may use different ones against the same
traffic:

| Word           | Kernel form                                                                                                                                                           |
| -------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **request**    | `expects` set — creates the debt pair (§9)                                                                                                                            |
| **reply**      | `re` set — discharges a debt (add `expects` for a follow-up)                                                                                                          |
| **note**       | neither — fire-and-forget; use `urgency` for attention level                                                                                                          |
| **meeting**    | a convention, not a kind: request "meet?" → reply "ok"/"busy" → an exchange of high-urgency notes → note "closing". Exclusivity is advisory — a busy peer says "busy" |
| **escalation** | a convention, not a kind: a request to your `parent` at high urgency                                                                                                  |

There is no lock anywhere in this protocol: a client that wants to block
on a request arms a barrier over it (§12) and stops taking other work by
its own policy. Mutual exclusion, where wanted, is the meeting
convention's advisory "busy."

## 11. Thread state machine (pi client)

```
                    turn_start
        +----------------------------------+
        |                                  |
        v                                  |
  +-----------+   tool_execution   +-------+----+
  |   OPEN    |------------------->|  THINKING  |
  +-----------+                    +------------+
     ^     ^                              |
     |     |                              v
     |     |                       +------------+
     |     +--- resumeThread ------|  WORKING   |
     |          (from ON-HOLD)     +------------+
     |                               |        |
     +--- turn_end / agent_end ------+        +--- suspend ---> ON-HOLD
          --> OPEN / DONE
```

**11.1 Resting-state rule.** `turn_end`/`agent_end` MUST NOT stomp a
waiting state: `rest(σ) = on-hold if held; open/done otherwise`.

**11.2 Restart rule.** On boot: `done`/`stopped` → `idle`. Barriers and
debts persist (§13.2); no state encodes a wait, so nothing else needs
repair.

**11.3 Back-edges.** Exactly one transition class moves backward
(`resumeThread`), meaning "an external event ended a hold," never "a
turn finished."

This state machine is Layer-2 client behavior. Another implementation
MAY run a different one (an external CLI actor effectively has two
states). What crosses to observers is the presence record (§8) — the
`state` label there is informative, and liveness is derived per §8.2.

## 12. Waiting: barriers and delayed self-sends

**12.1 Barriers.** A client MAY arm a wait across outstanding envelope
`id`s; resolution: `pending' = pending ∖ {re}; resolved ⟺ mode=any ∨
pending'=∅`. Same one-shot deadline nudge as obligations. Barriers
persist across restarts unconditionally. A barrier MAY carry a payload
to inject on resolution — this subsumes local pub/sub ("when X resolves,
tell me Y").

**12.2 Delayed self-sends.** A scheduled wake is an envelope to self
with `deliverAfter` (§6). It is durable, cancellable only by draining,
and needs no client machinery beyond ordinary receive.

External actors implement waiting however they like (poll, `thread-cli
tail`) — none of this crosses the wire.

## 13. Robustness considerations

**13.1 Misdirected replies** desync the two ledgers permanently; the
§9.1 gate prevents it going forward (Errata 1). **13.2 Restarts:**
obligations, owed replies, and barriers persist unconditionally; delayed
self-sends live in the store, not the process. **13.3 Stalled partners:**
the default deadline (§9.2) bounds every debt; there is no lock, so
there is no deadlock class — a thread that chooses to wait is bounded by
its barrier's deadline. **13.4 Nothing is dropped:** every unavailable
window degrades to durable queueing (§7.4), except the declared
single-tick drain window (§7.7).

## 14. Tool surface

The full Layer-2 client needs five tools; everything else in Appendix A
is machinery this spec has since absorbed into the envelope or deleted:

| Tool      | Does                                                                        |
| --------- | --------------------------------------------------------------------------- |
| `send`    | enqueue an envelope (all of §6: `re`, `expects`, `urgency`, `deliverAfter`) |
| `wait`    | arm a barrier (§12.1)                                                       |
| `status`  | read presence — own or another's (§8.1)                                     |
| `list`    | enumerate threads (presence summaries)                                      |
| `journal` | read a journal (§8.3), where the backend has one                            |

Acceptance test, restated from §2.2: each of these must be exercisable
end-to-end by a C1 actor via the binding alone — `thread-cli` and file
reads/writes, no extension on either side.

## 15. Design questions (all decided)

1. ~~**Should the reply deadline travel on the wire?**~~ Decided: **no**
   — `expects` stays `true`; deadlines remain sender-private Layer-2
   records (§9.2). Rationale for revisiting later if needed: §6.4's
   must-ignore rule makes `expects: { by? }` a compatible extension.
2. ~~**Erratum 5 resolution.**~~ Decided: **declare-and-shrink**, now
   normative in §7.7; peek/ack remains a possible future Layer-0
   upgrade.
3. ~~**Standard vocabulary mapping.**~~ Resolved: Appendix C maps the
   envelope onto ActivityStreams 2.0 via a JSON-LD aliasing context —
   no wire change. schema.org was considered and rejected there (no
   reply-correlation property; its `CommunicateAction` types would
   reintroduce the tag §6 deleted).

## 16. Errata

Numbering is historical; section references are to the current revision.

### Errata 1 — discharge not gated on destination (now §9.1)

**Status:** Verified, resolved. The pre-fix discharge cleared the owed
ledger on correlation-id match alone; a misdirected reply desynced the
ledgers permanently (absent a deadline). Fixed: discharge requires the
debt to be owed to the reply's target.

### Errata 2 — no deadlock recovery for reply locks

**Status:** Verified, resolved — then mooted. Question↔Question lock
cycles with no deadline had zero automatic recovery. Fixed by a default
deadline plus an acquire-time 2-cycle rejection; Rev 8 removes locks
from the protocol entirely (Appendix A), deleting the problem class. The
default deadline survives as §9.2.

### Errata 3 — heartbeat sources didn't coalesce (now §7.5)

**Status:** Verified, resolved. Drain/deadline/schedule checks each
injected independently; the first one's idle-time write gated the others
out for a full heartbeat interval. Fixed: one coalesced injection per
tick.

### Errata 4 — default deadline narrower than its own justification (now §9.2)

**Status:** Verified, resolved. The fallback covered two request types
only, though the justification (unbounded silent obligations) applies to
every `expects` send. Generalized. Found by reading the spec, not the
code.

### Erratum 5 — the drain window contradicts "never lost" (§7.7)

**Status:** Verified, resolved. Destructive drain (§5) plus "delayed,
never lost" (§7.4) were inconsistent — durability ended at the drain, and
the claim-to-delivery window was unbounded. Resolution:
declare-and-shrink (§7.7), implemented — `drainInbox` refuses to claim
unless the delivery window is open and injects in the same tick
(`inbox.ts`; test: "not even claimed while gated"). The residual
single-tick crash slice is the protocol's one declared loss window.
Peek/ack stays available as a future Layer-0 upgrade.

**Verification:** Errata 1–3: 123→134 tests, committed `28852f3`.
Errata 4: committed `8223cff`. Erratum 5: implemented with the Rev-8
migration; the post-migration suite is 120 tests, green.

## 17. Revision history

| Rev | Date       | Change                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| --- | ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | 2026-07-02 | Initial formalization: message/obligation algebra, injection-gate queueing model, barrier set algebra, escalation chain.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| 2   | 2026-07-11 | Added explicit state-machine section; Errata 1–3 implemented, verified, committed.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| 3   | 2026-07-11 | Reframed as a Petri net — conservation as place-invariant, deadlock as dead-marking vs. livelock.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| 4   | 2026-07-11 | Reframed as a protocol specification; method change (rules at their natural generality) surfaced Errata 4. Added the minimality analysis and the external-implementability criterion.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| 5   | 2026-07-11 | Restructured into three layers: Store (L0), Postbox (L1), Semantics (L2). The eight message types became a _profile_ over a two-boolean kernel; locking marked legacy.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| 6   | 2026-07-11 | Minimal structural-union envelope (`id`/`re`/`expects`, four presence-discriminated kinds, positional addressing) made normative.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| 7   | 2026-07-11 | Layer review on the protocol's own merit: three channels named (mailbox/presence/journal), presence specified normatively, conformance classes, binding-is-the-interop-point, trust model, extensibility rules; Erratum 5 reported at spec level.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| 8   | 2026-07-12 | The spec becomes the target outright — no compatibility framing in the main body; the current implementation moves to Appendix A as a coding reference. `delivery` → ordered `urgency` levels (client-translated); envelope self-contained (`to` required, consumed at enqueue; `enqueueMessage(msg)`); `deliverAfter` added, deleting wake/timer members from Layer 0; `JournalAdapter` split out as an optional extension and the journal modeled as an append-only stream of envelope-shaped notes (forked-note writes guard-free; generation throttling stays client-private); identifier scheme specified (`<from>/<ulid>` recommended, arn-lite); vocabulary v2 (request/reply/note + meeting/escalation conventions — brief→request, sync→meeting, blocker folded into escalation-to-parent, question/answer/result/update merged away); locks removed from the protocol (Errata 2 mooted); state machine loses `listening`/`in-sync`; subscriptions folded into barriers-with-payload; tool surface fixed at five; local-fs binding written (Appendix B); participation declared opt-in for forked children (§2.3). Amended same day: the silent-debtor nudge (§9.4) gains a "Standing by" canary acknowledgement — escalation keys on the canary's absence, not on silence alone — bounded by the creditor's deadline so standby cannot be indefinite; §9.5 added — debts have no hold state, blocked debtors pass the ball via `ReplyRequest`; Appendix C added — JSON-LD/AS2 aliasing context, resolving §15 question 3. Design questions closed: deadline stays off the wire (§15.1); Erratum 5 resolved by declare-and-shrink, normative in §7.7. Migration landed same day: all seven A.6 steps implemented in one pass, suite rewritten 135→120 green, Appendix A collapsed to a migration record. Renamed same day: the protocol is **Postbox**, after its own Layer 1 — the prior acronym (TMP) read as "temporary" in every filename and env var that carried it. |

**Open gaps:** the Restate binding as a written spec (§5.1 — the code
exists, the document doesn't); the canary turn-text capability spike
(§9.4); fork identity inheritance (A.1); the journal entry format
(§8.3).

---

# APPENDIX A — Migration record

The A.6 migration landed 2026-07-12 (steps 1–7 in one pass; suite
rewritten 135→120 tests, green; tsc/eslint/prettier clean). The
pre-migration implementation this appendix used to describe — the
`requestId`+`type` wire format, the eight-type vocabulary, reply/sync
locks with `listening`/`in-sync` states, subscriptions, `scheduleWake`,
and the 13-tool surface — is gone from the tree; git history is the
reference. What shipped:

- **Wire**: the §6 envelope verbatim (`Envelope` in `core/types.ts`);
  ids are `<from>/<ulid>` with a monotonic ULID (`core/ids.ts`); ledgers
  key on envelope `id`; kind derived from `expects`/`re` presence, no
  `type` anywhere.
- **No locks**: state machine is §11's; blocking = barrier + policy.
- **Waits**: barriers carry an optional `message` payload (§12.1);
  schedules are `deliverAfter` self-sends (§12.2); the store contract
  has no timer members.
- **Adapters**: `StorageAdapter` core + optional `JournalAdapter` (§5);
  local-fs follows Appendix B (inbox.tmp staging + rename, ULID
  filenames, deliverAfter filtered at drain); Restate holds future
  envelopes and revives stopped threads via a durable delayed
  `deliverDue` self-invocation.
- **Tools**: `thread_send`, `thread_wait`, `thread_status`,
  `thread_list`, `thread_journal` (the §14 five) + client-local
  `thread_suspend`/`thread_resume`; vocabulary moved to the system
  prompt, including the "Standing by" canary and ball-passing (§9.4/9.5).
- **§7.7 drain gate**: implemented — Erratum 5 closed.

**A.1 Remaining item — fork identity inheritance (§2.3).** The journal
fork opts out via `--no-extensions`, and sessions without a thread
identity never activate. But a user-made `pi --fork` of a participating
session _copies the session history_, including the thread-identity
entry — so the fork would wake up believing it is the same thread as its
parent (two processes, one id). §2.3 says forks must not inherit
participation; detecting "I am a fork of a live thread" at init (e.g.
same id + fresh `lastSeen` + different pid) and deactivating — or
re-minting — is the open implementation question.

# APPENDIX B — Local-fs binding (normative target)

The concrete encoding a C1 actor programs against. Root:
`.thread/threads/` under the workspace.

```
.thread/threads/<threadId>/
  state.json            presence + client state (owner-written)
  journal.md            journal stream (optional — JournalAdapter)
  inbox/
    <ulid>.json         one envelope per file, filename = sortable id
  inbox.tmp/            enqueue staging (same filesystem)
```

- **Enqueue:** write the envelope JSON to `inbox.tmp/<name>`, then
  `rename(2)` into `inbox/` — atomic on POSIX, so a reader never sees a
  partial envelope. The file name is the envelope's ULID (or its `id`
  made path-safe), giving FIFO by sorted `readdir`.
- **Drain:** sorted `readdir`, filter out envelopes whose `deliverAfter`
  is in the future, read, then unlink. One consumer per mailbox is
  assumed (the owner); the atomicity requirement in §5 is against
  _concurrent drains by the same owner_ (e.g. heartbeat vs. watcher),
  which the implementation MUST serialize.
- **Presence:** `state.json`, rewritten whole (write-temp + rename).
  Readers apply §8.2 to `lastSeen`.
- **Journal:** append-only `journal.md`; entries are envelope-shaped
  records serialized as fenced blocks or JSON lines (exact entry
  encoding: open, §17).
- **Watch:** filesystem watch on `inbox/` — best-effort per §5.

Considered and not chosen: **maildir** as the mailbox encoding (its
`tmp/`→`new/` rename discipline is exactly the enqueue rule above, and
RFC 5322 headers could carry the envelope). Rejected for now to keep
envelopes single-format JSON across bindings; the discipline is
borrowed, the format is not.

# APPENDIX C — JSON-LD mapping (interop annex)

Resolves §15 question 3. A Postbox envelope becomes valid JSON-LD **by
reference** — no wire change, no field renames — because JSON-LD
contexts support aliasing: Postbox's field names map onto
**ActivityStreams 2.0** terms, with the three Postbox-specific fields as
extension terms (the sanctioned AS2 extension mechanism):

```json
{
  "@context": [
    "https://www.w3.org/ns/activitystreams",
    {
      "postbox": "https://pi-threading.dev/ns#",
      "from": "attributedTo",
      "body": "content",
      "sentAt": "published",
      "re": "inReplyTo",
      "expects": "postbox:expects",
      "urgency": "postbox:urgency",
      "deliverAfter": { "@id": "postbox:deliverAfter", "@type": "xsd:dateTime" }
    }
  ]
}
```

A request envelope, unchanged from §6, interpreted through the context:

```json
{
  "@context": "https://pi-threading.dev/ns/context.jsonld",
  "id": "planner/01J1XYQ8Z3",
  "from": "planner",
  "to": "builder",
  "body": "ship the report by 17:00",
  "sentAt": "2026-07-12T10:00:00Z",
  "expects": true,
  "urgency": "high"
}
```

Rules:

- The mapping is an **export/interop view**, never a wire requirement:
  envelopes on the wire remain plain JSON per §6, and a binding MUST NOT
  require receivers to process JSON-LD.
- Exporters MAY add a node type (`"type": "Note"`), but it MUST be the
  same constant on every envelope — kind stays structurally
  discriminated (§6.1); a varying type would reintroduce the tag §6
  deleted.
- Thread ids are bare names within a store (§6.2); a full linked-data
  export SHOULD set `@base` to the store's IRI so `from`/`to` and
  envelope ids expand to absolute IRIs.

**Why AS2 and not an email ontology.** "Inherit from email" was the
right instinct with no maintained target: schema.org
`Message`/`EmailMessage` has `sender`/`toRecipient`/`dateSent`/`text`
but **no reply-correlation property** (its `CommunicateAction` types
would also reintroduce the kind tag); SIOC (`reply_of`/`has_reply`,
`addressed_to`) has genuine email lineage but is dormant; NEPOMUK NMO
is a true email ontology and is dead. AS2 is email's living JSON-LD
heir — `inReplyTo` is RFC 5322's `In-Reply-To`, actor-and-inbox is the
native model — and W3C **Linked Data Notifications** (per-resource
inboxes receiving JSON-LD payloads) is the standards precedent for
Postbox's whole shape.
