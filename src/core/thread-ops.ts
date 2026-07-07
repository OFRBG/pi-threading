import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { ThreadStore } from "./types";

/** State transitions that always travel as a group — shared by the tools,
 *  the slash commands, and inbox delivery so no call site can set half a
 *  lock or leave a hold reason behind. */

/** Take the mutually-exclusive conversation lock and enter its wait state:
 *  In Sync for a sync lock, Listening for a reply (Question/Blocker) lock. */
export async function acquireLock(
  store: ThreadStore,
  eventId: string,
  partner: string,
  type: "sync" | "reply",
  ctx?: ExtensionContext,
): Promise<void> {
  store.lockEventId = eventId;
  store.lockPartner = partner;
  store.lockType = type;
  await store.transition(type === "sync" ? "in-sync" : "listening", ctx);
}

/** Release whatever lock is held and settle back to Open. */
export async function releaseLock(store: ThreadStore, ctx?: ExtensionContext): Promise<void> {
  store.lockEventId = null;
  store.lockPartner = null;
  store.lockType = null;
  await store.transition("open", ctx);
}

export async function suspendThread(
  store: ThreadStore,
  reason: string | null,
  ctx?: ExtensionContext,
): Promise<void> {
  store.holdReason = reason;
  await store.transition("on-hold", ctx);
}

/** Returns false when the thread wasn't on hold (nothing to resume). */
export async function resumeThread(
  store: ThreadStore,
  drain: () => Promise<void>,
  ctx?: ExtensionContext,
): Promise<boolean> {
  if (store.state !== "on-hold") return false;
  store.holdReason = null;
  await store.transition("open", ctx);
  await drain();
  return true;
}
