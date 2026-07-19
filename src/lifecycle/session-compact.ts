import type { SessionCompactEvent } from "@earendil-works/pi-coding-agent";
import type { ThreadingHookHandler } from "./shared";

export const sessionCompact: ThreadingHookHandler<SessionCompactEvent> = async (
  { inbox },
  _,
  ctx,
) => {
  inbox.markCompactionEnd();
  await inbox.drain(ctx);
};
