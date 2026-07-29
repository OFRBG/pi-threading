// Types for pi-top — mirrors the relevant shapes from pi-threading's StateFile
// so pi-top can read .thread/threads/<id>/state.json without a dependency on
// the pi-threading extension package.

export type ThreadState =
  | "idle"
  | "thinking"
  | "working"
  | "open"
  | "on-hold"
  | "stopped"
  | "done";

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

export interface ThreadDetail {
  summary: ThreadSummary;
  raw: StateFile;
  journal?: string;
}

// State display helpers
export const STATE_COLORS: Record<ThreadState, string> = {
  idle: "gray",
  thinking: "cyan",
  working: "yellow",
  open: "green",
  "on-hold": "red",
  stopped: "bright-black",
  done: "gray",
};

export const STATE_LABELS: Record<ThreadState, string> = {
  idle: "idle    ",
  thinking: "think   ",
  working: "working ",
  open: "open    ",
  "on-hold": "on hold ",
  stopped: "stopped ",
  done: "done    ",
};

export const STATE_DOTS: Record<ThreadState, string> = {
  idle: "○",
  thinking: "◐",
  working: "◐",
  open: "●",
  "on-hold": "◌",
  stopped: "○",
  done: "○",
};

export const STALE_MS = 60_000;