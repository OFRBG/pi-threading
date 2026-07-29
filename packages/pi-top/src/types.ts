/**
 * pi-top types — mirrors pi-threading's StateFile/ThreadSummary shapes
 * without a hard dependency, so pi-top can be a standalone package that
 * reads the same JSON files on disk.
 */

export type ThreadState = "idle" | "thinking" | "working" | "open" | "on-hold" | "stopped" | "done";

export interface Obligation {
  id: string;
  to: string;
  summary: string;
  sentAt: string;
  deadline?: string;
  nudged?: boolean;
}

export interface OwedReply {
  id: string;
  from: string;
  summary: string;
  receivedAt: string;
}

export interface Barrier {
  id: string;
  pending: string[];
  mode: "all" | "any";
  createdAt: string;
  deadline?: string;
  nudged?: boolean;
  message?: string;
}

/** On-disk representation — mirrors pi-threading's StateFile. */
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
  capabilities?: string[];
  wake?: string;
}

/** Derived summary for the thread list view. */
export interface ThreadSummary {
  id: string;
  state: ThreadState;
  status: "running" | "stopped";
  parent: string | null;
  role: string | null;
  lastSeen: string;
  obligations: number;
  owed: number;
  barriers: number;
}

/** Full detail for the detail panel. */
export interface ThreadDetail {
  summary: ThreadSummary;
  pid: number;
  cwd: string;
  holdReason: string | null;
  obligations: Obligation[];
  owed: OwedReply[];
  barriers: Barrier[];
  startedAt: string;
  journal?: string;
}

// --- pi-threading compat (no import) ---

export const STALE_MS = 60_000;

/** Display color for each thread state. */
export const STATE_COLORS: Record<ThreadState, string> = {
  idle: "bright-black",
  thinking: "cyan",
  working: "yellow",
  open: "green",
  "on-hold": "red",
  stopped: "bright-black",
  done: "bright-black",
};

/** Display label for each thread state (padded). */
export const STATE_LABELS: Record<ThreadState, string> = {
  idle: "idle    ",
  thinking: "think   ",
  working: "working ",
  open: "open    ",
  "on-hold": "on hold ",
  stopped: "stopped ",
  done: "done    ",
};

/** Unicode dot symbol for each thread state. */
export const STATE_DOTS: Record<ThreadState, string> = {
  idle: "○",
  thinking: "◐",
  working: "◐",
  open: "●",
  "on-hold": "◌",
  stopped: "○",
  done: "○",
};

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

/** Human-readable relative time string. */
export function relTime(iso: string | null): string {
  if (!iso) {
    return "-";
  }
  const ms = Date.now() - Date.parse(iso);
  if (Number.isNaN(ms)) {
    return "-";
  }
  if (ms < 0) {
    return "0s ago";
  }
  const s = Math.floor(ms / 1000);
  if (s < 60) {
    return `${s}s ago`;
  }
  const m = Math.floor(s / 60);
  if (m < 60) {
    return `${m}m ago`;
  }
  const h = Math.floor(m / 60);
  if (h < 24) {
    return `${h}h ago`;
  }
  const d = Math.floor(h / 24);
  return `${d}d ago`;
}
