import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { ThreadStore } from "./core/types";
import type { Inbox } from "./inbox";

/** Bundled dependencies + per-turn state: built once in the extension
 *  factory (index.ts) and threaded through registerLifecycle/registerTools/
 *  registerCommands as one object instead of separate positional args. */
export interface ThreadingContext {
  pi: ExtensionAPI;
  store: ThreadStore;
  inbox: Inbox;
  state: {
    /** Opt-in gate (§2.3 — participation is opt-in): true once session_start
     *  has confirmed --thread-id was passed on this launch. Every handler
     *  no-ops while this is false. */
    active: boolean;
    /** Reset false at turn_start, set true on tool_execution_start — drives
     *  journal cadence (journal.ts's shouldJournal) and the silent-debtor
     *  nudge gate in turn_end. */
    toolUsedThisTurn: boolean;
  }
}
