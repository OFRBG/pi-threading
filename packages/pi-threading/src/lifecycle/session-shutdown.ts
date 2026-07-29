import type { SessionShutdownEvent } from "@earendil-works/pi-coding-agent";
import type { ThreadingHookHandler } from "./shared";

export const sessionShutdown: ThreadingHookHandler<SessionShutdownEvent> = async (
  { store },
  event,
) => {
  await store.shutdown(event.reason);
};
