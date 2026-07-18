import type { ExtensionAPI, SessionStartEvent } from "@earendil-works/pi-coding-agent";
import type { Injection } from "../inbox";
import { ThreadingTool } from "../tools/index";
import type { ThreadingHookHandler as Handler } from "./shared";

function hasThreadId(pi: ExtensionAPI): boolean {
  const id = pi.getFlag("thread-id");
  return typeof id === "string" && id.length > 0;
}

export const sessionStart: Handler<SessionStartEvent> = async (
  { pi, store, inbox, state },
  _,
  ctx,
) => {
  state.active = hasThreadId(pi);

  if (!state.active) {
    const threadTools: string[] = Object.values(ThreadingTool);
    pi.setActiveTools(pi.getActiveTools().filter(name => !threadTools.includes(name)));
    return;
  }

  await store.init(ctx);

  setImmediate(() => void inbox.drainInbox(ctx));

  store.startWatcher(inbox.drainInbox, ctx);

  store.startHeartbeat(async () => {
    // Coalesce both heartbeat-driven sources into ONE inject() per tick
    // (§7.5, Errata 3): if drainInbox injected on its own here, its
    // idle-time inFlightSince write would gate out the deadline check for
    // a full heartbeat interval.
    const parts: Injection[] = [];
    await inbox.drainInbox(ctx, parts);
    await inbox.checkDeadlines(ctx, parts);
    inbox.inject(parts, ctx);
  });
};
