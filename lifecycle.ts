import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { ThreadStore } from "./types";
import type { Inbox } from "./inbox";
import { threadModelPrompt } from "./system-prompt";

export function registerLifecycle(
  pi: ExtensionAPI,
  store: ThreadStore,
  inbox: Inbox,
) {
  pi.on("session_start", (_event, ctx) => {
    store.init(ctx.cwd, ctx);

    // Defer initial drain to next tick — calling pi.sendUserMessage
    // synchronously from session_start deadlocks turn scheduling.
    setImmediate(() => inbox.drainInbox(ctx));
    store.startWatcher(inbox.drainInbox, ctx);
    store.startHeartbeat();
  });

  pi.on("session_shutdown", event => {
    store.shutdown(event.reason);
  });

  pi.on("turn_start", (_event, ctx) => store.transition("thinking", ctx));

  pi.on("tool_execution_start", (_event, ctx) =>
    store.transition("working", ctx),
  );

  pi.on("turn_end", (_event, ctx) => {
    store.transition("open", ctx);
    const sf = ctx.sessionManager.getSessionFile();
    if (sf) store.forkJournal(sf);
  });

  pi.on("agent_end", (_event, ctx) => {
    store.transition("done", ctx);
  });

  pi.on("before_agent_start", async event => {
    return {
      systemPrompt: event.systemPrompt + "\n\n" + threadModelPrompt(store),
    };
  });
}