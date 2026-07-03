import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

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

export const DEFAULT_DELIVERY: Record<MessageType, "steer" | "follow-up"> = {
  Brief: "steer",
  Note: "steer",
  Question: "steer",
  Answer: "steer",
  Update: "follow-up",
  Result: "follow-up",
  Blocker: "steer",
  Sync: "steer",
};

export const OBLIGATION_TYPES: ReadonlySet<MessageType> = new Set([
  "Brief",
  "Question",
  "Sync",
  "Blocker",
]);

export const HEARTBEAT_MS = 20_000;
export const STALE_MS = 60_000;
export const PROCESSED_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export interface Obligation {
  requestId: string;
  type: "Brief" | "Question" | "Sync" | "Blocker";
  to: string;
  summary: string;
  sentAt: string;
  deadline?: string;
  nudged?: boolean;
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
  delivery: "steer" | "follow-up";
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
  barriers: Barrier[];
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
  delivery: "steer" | "follow-up";
  sentAt: string;
}

export interface ThreadSummary {
  id: string;
  state: ThreadState;
  status: "running" | "stopped";
  parent: string | null;
  role: string | null;
  lastSeen: string;
}

export interface ThreadStore extends ThreadData {
  transition: (next: ThreadState, ctx?: ExtensionContext) => void;
  writeFile: () => void;
  init: (cwd: string, ctx: ExtensionContext) => void;
  shutdown: (reason: string) => void;
  listThreads: () => ThreadSummary[];
  forkJournal: (sessionFile: string) => void;
  startHeartbeat: (onTick?: () => void) => void;
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
  barriers: Barrier[];
  /** In-memory only: set when this thread sends to its lock partner during the
   *  current turn; drives the "your text didn't reach your partner" nudge. */
  sentToPartnerThisTurn: boolean;
  nudgedSinceLastSend: boolean;
  /** In-memory only: fingerprint of (state, lock, obligations, barriers) as of
   *  the last journal write — lets turn_end skip forking a journal entry when
   *  a turn produced no tool call and nothing structural changed. */
  lastJournalSignature: string | null;
}
