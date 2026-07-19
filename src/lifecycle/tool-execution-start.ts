import type { ThreadingHookHandler } from "./shared";

export const toolExecutionStart: ThreadingHookHandler<unknown> = async (
  { state, store },
  _,
  ctx,
) => {
  state.toolUsedThisTurn = true;
  await store.transition("working", ctx);
};
