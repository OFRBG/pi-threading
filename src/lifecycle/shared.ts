import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { ThreadStore, ThreadState } from "../core/types";
import type { ThreadingContext } from "../context";

/** Where a thread settles between turns: On Hold must survive the turn
 *  boundary instead of being stomped to open/done (§11.1). */
export function restingState(store: ThreadStore, whenFree: ThreadState): ThreadState {
  if (store.state === "on-hold") return "on-hold";
  return whenFree;
}

/** Each lifecycle module exports one of these as a plain value — `threading`
 *  is passed in rather than closed over. `lifecycle.ts` registers each one
 *  with its own literal `pi.on("...", ...)` call, so the event name and E/R
 *  here are checked against the real overload at the call site, not against
 *  a same-file field that could silently drift from them. */
export type ThreadingHookHandler<E, R = void> = (
  threading: ThreadingContext,
  event: E,
  ctx: ExtensionContext,
) => Promise<R | void> | R | void;
