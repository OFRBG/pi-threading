import type { SessionBeforeCompactEvent } from "@earendil-works/pi-coding-agent";
import type { ThreadingHookHandler } from "./shared";

// The TUI holds user input while a compaction runs; extension-initiated
// prompts get no such guard, and one injected mid-compaction starts an
// agent run that races the context rewrite. Mirror the TUI: hold the
// inbox during compaction, flush as soon as it ends (see session_compact).
export const sessionBeforeCompact: ThreadingHookHandler<SessionBeforeCompactEvent> = async ({
  inbox,
}) => {
  inbox.markCompactionStart();
};
