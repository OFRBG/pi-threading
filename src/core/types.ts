import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { ThreadAdapter } from "../adapter/types";

/** The domain model per PROTOCOL-FORMALISM.md Rev 8: the wire envelope
 *  (Layer 1), the durable Layer-2 records (obligations, owed replies,
 *  barriers) and the two shared views of a thread — its own StateFile
 *  (presence source) and the ThreadSummary others see. */

export type ThreadState = "idle" | "thinking" | "working" | "open" | "on-hold" | "stopped" | "done";

/** Wire urgency level (§6). Deliberately abstract: this client maps `high`
 *  to a steering injection and `low` (the default when absent) to delivery
 *  at idle; other implementations may map levels differently. Receivers
 *  treat unknown levels as `low` (§6, must-ignore discipline). */
export type Urgency = "high" | "low";

/** The one wire record (PROTOCOL-FORMALISM.md §6). Self-contained: `to` is
 *  consumed at enqueue to place the envelope; receivers never branch on it
 *  (position is authoritative). Kind is structural — `expects` and `re`
 *  presence — never a tag. */
export interface Envelope {
  /** Own identity — always minted, never echoed. Form: `<from>/<ulid>`. */
  id: string;
  from: string;
  to: string;
  body: string;
  sentAt: string;
  /** Reply correlation: discharges the debt keyed by this envelope id. */
  re?: string;
  /** The sender tracks a debt; reply with re = this envelope's id. */
  expects?: true;
  /** Delivery-priority hint. Absent = "low". */
  urgency?: Urgency;
  /** Not drainable before this instant — delayed delivery / self-wakes. */
  deliverAfter?: string;
  /** Not deliverable after this instant — stale mail self-discards at
   *  drain (retained as processed audit, never injected). Rev 10 §6. */
  expiresAt?: string;
  /** Reserved experiment namespace (Rev 10 §6.4): bindings and clients may
   *  attach data here without colliding with future protocol fields. */
  ext?: Record<string, unknown>;
}

export const HEARTBEAT_MS = 20_000;
export const STALE_MS = 60_000;
export const PROCESSED_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** Fallback obligation deadline for any `expects` send when the caller
 *  passes no explicit deadlineSeconds (PROTOCOL-FORMALISM.md §9.2). Without
 *  it, checkDeadlines skips the obligation forever (it only fires on
 *  obligations with a set deadline), so a forgotten deadline leaves the
 *  sender with zero automatic recovery. 15 minutes is a deliberately
 *  generous agent-to-agent reply SLA — long enough not to nag a partner
 *  doing real work, short enough that a stuck obligation gets one nudge
 *  before a human has to notice it. */
export const DEFAULT_OBLIGATION_DEADLINE_MS = 15 * 60_000;

/** Sender-side debt record: an `expects` envelope this thread sent, keyed
 *  by that envelope's id (§9). Cleared when a reply with re = id arrives. */
export interface Obligation {
  id: string;
  to: string;
  summary: string;
  sentAt: string;
  deadline?: string;
  nudged?: boolean;
}

/** The receiving side of an Obligation: recorded when an `expects` envelope
 *  is delivered, cleared when the matching reply is sent. Durable — the
 *  envelope id the reply must echo otherwise lives only in the session that
 *  received it, so a revived thread would have no way to reply. */
export interface OwedReply {
  id: string;
  from: string;
  summary: string;
  receivedAt: string;
}

/** Waiting on multiple envelope ids: resolves when all (or any) get a reply.
 *  An optional `message` payload is injected on resolution — this is what
 *  subsumed the old local pub/sub subscriptions (§12.1). */
export interface Barrier {
  id: string;
  pending: string[];
  mode: "all" | "any";
  createdAt: string;
  deadline?: string;
  nudged?: boolean;
  message?: string;
}

/** Advisory capability tokens this client publishes in presence (Rev 10
 *  §8.1). Each names an optional behavior a counterparty can adapt to;
 *  readers ignore unknown tokens. The pi client honors all of these. */
export const CLIENT_CAPABILITIES = [
  "urgency", // urgency=high steers mid-turn, not just at idle
  "barriers", // durable reply barriers (§12.1)
  "deliverAfter", // scheduled self-wakes honored
  "expiresAt", // stale mail discarded at drain (Rev 10)
  "journal", // writes an observable journal stream (§8.3)
  "canary", // speaks the "Standing by" protocol (§9.4)
] as const;

export interface StateFile {
  id: string;
  pid: number;
  cwd: string;
  parent: string | null;
  role: string | null;
  sessionFile: string | null;
  state: ThreadState;
  status: "running" | "stopped";
  holdReason: string | null;
  obligations: Obligation[];
  owed: OwedReply[];
  barriers: Barrier[];
  startedAt: string;
  lastSeen: string;
  updatedAt: string;
  /** Advisory capability tokens (Rev 10 §8.1); absent = claim nothing. */
  capabilities?: string[];
  /** Advisory revive recipe (Rev 10 §8.1): a shell command any actor MAY
   *  run to wake this thread. Trust caveat: only act on it in stores where
   *  every writer is already trusted (running it is code execution). */
  wake?: string;
}

export interface ThreadSummary {
  id: string;
  state: ThreadState;
  status: "running" | "stopped";
  parent: string | null;
  role: string | null;
  lastSeen: string;
  /** Coordination load, so observers can see who is waiting on what without
   *  reading each thread's full state: sent-side debts... */
  obligations: number;
  /** ...received-side debts... */
  owed: number;
  /** ...and armed reply barriers. */
  barriers: number;
}

/** How every reader classifies another thread: a stale lastSeen overrides the
 *  stored status, so hard-killed processes (no session_shutdown) read as
 *  stopped (§8.2 — the one presence rule normative for every reader). */
export function toSummary(s: StateFile): ThreadSummary {
  const stale = Date.now() - new Date(s.lastSeen).getTime() > STALE_MS;
  return {
    id: s.id,
    state: s.state,
    status: stale ? "stopped" : s.status,
    parent: s.parent,
    role: s.role ?? null,
    lastSeen: s.lastSeen,
    obligations: s.obligations?.length ?? 0,
    owed: s.owed?.length ?? 0,
    barriers: s.barriers?.length ?? 0,
  };
}

export interface ThreadStore extends ThreadData {
  adapter: ThreadAdapter;
  transition: (next: ThreadState, ctx?: ExtensionContext) => Promise<void>;
  /** Persist the current in-memory state through the storage adapter. */
  persist: () => Promise<void>;
  init: (ctx: ExtensionContext) => Promise<void>;
  shutdown: (reason: string) => Promise<void>;
  listThreads: () => Promise<ThreadSummary[]>;
  /** Undefined on backends without the JournalAdapter extension. */
  readJournal: (threadId: string) => Promise<string | undefined>;
  threadExists: (threadId: string) => Promise<boolean>;
  forkJournal: (sessionFile: string) => void;
  startHeartbeat: (onTick?: () => void | Promise<void>) => void;
  stopHeartbeat: () => void;
  startWatcher: (drainInbox: (ctx: ExtensionContext) => void, ctx: ExtensionContext) => void;
  stopWatcher: () => void;
}

/** Mutable data that multiple modules read and write. */
export interface ThreadData {
  threadId: string;
  threadDir: string;
  threadsRootDir: string;
  parent: string | null;
  role: string | null;
  sessionFile: string | null;
  startedAt: string;
  state: ThreadState;
  status: "running" | "stopped";
  holdReason: string | null;
  obligations: Obligation[];
  owed: OwedReply[];
  barriers: Barrier[];
  /** In-memory only: true once a reminder about the current unaddressed owed
   *  replies has been queued, so consecutive silent+owed turns within one run
   *  don't each queue another stale copy. Re-armed at agent_end so a
   *  persistently silent thread gets one fresh nudge per run instead of
   *  exactly one for its entire life. */
  owedNudgePending: boolean;
  /** In-memory only: consecutive silent turns with owed replies outstanding,
   *  capped — used only to pick reminder severity, not to gate whether one
   *  fires. Reset by any tool use, including the send that clears the debt. */
  owedSilentStreak: number;
  /** In-memory only: fingerprint of (state, obligations, barriers) as of
   *  the last journal write — lets turn_end skip forking a journal entry when
   *  a turn produced no tool call and nothing structural changed. */
  lastJournalSignature: string | null;
  /** In-memory only: epoch ms of the last journal fork — rate-limits per-turn
   *  journaling so a long run of quick tool turns doesn't produce one
   *  near-duplicate entry (and one forked model call) per turn. */
  lastJournalAt: number;
  /** In-memory only: set when a turn's journal entry was rate-limited away —
   *  the run owes one wrap-up entry at agent_end so the final state of the
   *  work is never lost to the rate limit. */
  journalDebt: boolean;
}
