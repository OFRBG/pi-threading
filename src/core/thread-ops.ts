import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { ThreadStore } from "./types";

/** State transitions that always travel as a group — shared by the tools,
 *  the slash commands, and lifecycle so no call site can leave a hold
 *  reason behind. (There is no lock in this protocol — blocking on a reply
 *  is a barrier plus client policy, PROTOCOL-FORMALISM.md §10/§12.) */

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
  if (store.state !== "on-hold") {
    return false;
  }

  store.holdReason = null;
  await store.transition("open", ctx);
  await drain();
  return true;
}
