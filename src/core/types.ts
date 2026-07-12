import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { StorageAdapter } from "../adapter/types";

/** The domain model: thread states, message types, the durable records
 *  (obligations, owed replies, barriers, wakes) and the two shared views of
 *  a thread — its own StateFile and the ThreadSummary others see. */

export type ThreadState =
  | "idle"
  | "thinking"
  | "working"
  | "open"
  | "in-sync"
  | "listening"
  | "on-hold"
  | "stopped"
  | "done";

export type MessageType =
  "Brief" | "Note" | "Question" | "Answer" | "Update" | "Result" | "Blocker" | "Sync";

/** When a message lands: at the target's next Open (steer) or once it's
 *  Done/Idle (follow-up). */
export type Delivery = "steer" | "follow-up";

/** The types whose send leaves a durable obligation until Answer/Result. */
export type ObligationType = "Brief" | "Question" | "Sync" | "Blocker";

/** The received counterparts that leave a durable owed reply (Sync excluded —
 *  its reply is produced by thread_sync_close via the lock). */
export type OwedType = Exclude<ObligationType, "Sync">;

export const DEFAULT_DELIVERY: Record<MessageType, Delivery> = {
  Brief: "steer",
  Note: "steer",
  Question: "steer",
  Answer: "steer",
  Update: "follow-up",
  Result: "follow-up",
  Blocker: "steer",
  Sync: "steer",
};

export const OBLIGATION_TYPES: ReadonlySet<ObligationType> = new Set([
  "Brief",
  "Question",
  "Sync",
  "Blocker",
]);

export function isObligationType(type: MessageType): type is ObligationType {
  return (OBLIGATION_TYPES as ReadonlySet<MessageType>).has(type);
}

export const HEARTBEAT_MS = 20_000;
export const STALE_MS = 60_000;
export const PROCESSED_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** Fallback obligation deadline for any obligation-creating send
 *  (Brief/Question/Blocker — everything in OwedType) when the caller passes
 *  no explicit deadlineSeconds. Without it, checkDeadlines skips the
 *  obligation forever (it only fires on obligations with a set deadline),
 *  so a forgotten deadline leaves the sender with zero automatic recovery —
 *  originally fixed for Question/Blocker only (PROTOCOL-FORMALISM.md
 *  Errata 2), then generalized here once the same reasoning was checked
 *  against Brief and found to apply identically: a Brief to a thread that
 *  crashes before replying is just as permanently silent, it just doesn't
 *  also deadlock anyone. 15 minutes is a deliberately generous
 *  agent-to-agent reply SLA — long enough not to nag a partner doing real
 *  work, short enough that a stuck obligation gets one nudge before a human
 *  has to notice it. Callers who need longer still pass an explicit
 *  deadlineSeconds; this only flips the default from opt-in to opt-out.
 *  Sync is excluded — it isn't in OwedType (§8.4) and already self-heals via
 *  its receiver-side rejection path. */
export const DEFAULT_OBLIGATION_DEADLINE_MS = 15 * 60_000;

export interface Obligation {
  requestId: string;
  type: ObligationType;
  to: string;
  summary: string;
  sentAt: string;
  deadline?: string;
  nudged?: boolean;
}

/** The receiving side of an Obligation: recorded when a Brief/Question/Blocker
 *  is delivered, cleared when the matching Result/Answer is sent. Durable —
 *  the envelope's requestId otherwise lives only in the session that received
 *  it, so a revived thread would have no way to echo the right id back. */
export interface OwedReply {
  requestId: string;
  type: OwedType;
  from: string;
  summary: string;
  receivedAt: string;
}

/** Waiting on multiple obligations: resolves when all (or any) requestIds get a reply. */
export interface Barrier {
  id: string;
  pending: string[];
  mode: "all" | "any";
  createdAt: string;
  deadline?: string;
  nudged?: boolean;
}

export interface Subscription {
  eventId: string;
  message: string;
  delivery: Delivery;
}

/** A future wake-up this thread armed for itself. Fires exactly once, same
 *  `nudged` guard pattern as Obligation/Barrier deadlines. */
export interface ScheduledWake {
  id: string;
  fireAt: string;
  reason: string;
  nudged?: boolean;
}

export interface StateFile {
  id: string;
  pid: number;
  cwd: string;
  parent: string | null;
  role: string | null;
  sessionFile: string | null;
  state: ThreadState;
  status: "running" | "stopped";
  lockEventId: string | null;
  lockPartner: string | null;
  lockType: "sync" | "reply" | null;
  holdReason: string | null;
  subscriptions: Subscription[];
  obligations: Obligation[];
  owed: OwedReply[];
  barriers: Barrier[];
  schedules: ScheduledWake[];
  startedAt: string;
  lastSeen: string;
  updatedAt: string;
}

export interface InboxMessage {
  from: string;
  to: string;
  type: MessageType;
  body: string;
  requestId: string;
  delivery: Delivery;
  sentAt: string;
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
  /** ...armed reply barriers... */
  barriers: number;
  /** ...and pending scheduled wakes. */
  schedules: number;
}

/** How every reader classifies another thread: a stale lastSeen overrides the
 *  stored status, so hard-killed processes (no session_shutdown) read as
 *  stopped. Shared by all storage backends' listThreads. */
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
    schedules: s.schedules?.length ?? 0,
  };
}

export interface ThreadStore extends ThreadData {
  adapter: StorageAdapter;
  transition: (next: ThreadState, ctx?: ExtensionContext) => Promise<void>;
  /** Persist the current in-memory state through the storage adapter. */
  persist: () => Promise<void>;
  init: (cwd: string, ctx: ExtensionContext) => Promise<void>;
  shutdown: (reason: string) => Promise<void>;
  listThreads: () => Promise<ThreadSummary[]>;
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
  lockEventId: string | null;
  lockPartner: string | null;
  lockType: "sync" | "reply" | null;
  holdReason: string | null;
  subscriptions: Subscription[];
  obligations: Obligation[];
  owed: OwedReply[];
  barriers: Barrier[];
  schedules: ScheduledWake[];
  /** In-memory only: set when this thread sends to its lock partner during the
   *  current turn; drives the "your text didn't reach your partner" nudge. */
  sentToPartnerThisTurn: boolean;
  nudgedSinceLastSend: boolean;
  /** In-memory only: true once a reminder about the current unaddressed owed
   *  replies has been queued, so consecutive silent+owed turns within one run
   *  don't each queue another stale copy — same shape as nudgedSinceLastSend
   *  but keyed to owed replies rather than a sync lock. Re-armed at agent_end
   *  so a persistently silent thread gets one fresh nudge per run instead of
   *  exactly one for its entire life. */
  owedNudgePending: boolean;
  /** In-memory only: consecutive silent turns with owed replies outstanding,
   *  capped — used only to pick reminder severity, not to gate whether one
   *  fires. Reset by any tool use, including the send that clears the debt. */
  owedSilentStreak: number;
  /** In-memory only: fingerprint of (state, lock, obligations, barriers) as of
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
