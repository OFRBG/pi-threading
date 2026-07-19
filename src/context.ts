import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { ThreadStore } from "./core/types";
import type { Inbox } from "./inbox";

export interface ThreadingState {
  active?: boolean;
  /** Reset false at turn_start, set true on tool_execution_start — drives
   *  journal cadence (journal.ts's shouldJournal) and the silent-debtor
   *  nudge gate in turn_end. */
  toolUsedThisTurn: boolean;

  inFlightSince: number | null;
  compactingSince: number | null;
}

export interface ThreadingContext {
  pi: ExtensionAPI;
  store: ThreadStore;
  inbox: Inbox;
  state: ThreadingState;
}
