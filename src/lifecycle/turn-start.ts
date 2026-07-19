import type { TurnStartEvent } from "@earendil-works/pi-coding-agent";
import type { ThreadingHookHandler } from "./shared";

export const turnStart: ThreadingHookHandler<TurnStartEvent> = async (
  { state, store, inbox },
  _,
  ctx,
) => {
  inbox.markRunStarted();
  const wasOnHold = store.state === "on-hold";
  state.toolUsedThisTurn = false;
  await store.transition("thinking", ctx);
  if (wasOnHold) {
    // A prompt landing on a suspended thread is an implicit resume.
    store.holdReason = null;
    await store.persist();
    await inbox.drain(ctx);
  }
};
