import { suspendThread } from "../core/thread-ops";
import type { CommandDefinition } from "./shared";

export const threadSuspend: CommandDefinition = {
  name: "thread-suspend",
  description: "Mark this thread On Hold: /thread-suspend [reason]",
  async handler({ store }, args, ctx) {
    await suspendThread(store, args.trim() || null, ctx);

    ctx.ui.notify(
      `Thread suspended (On Hold)${store.holdReason ? `: ${store.holdReason}` : ""}. Inbox queues until resume.`,
      "info",
    );
  },
};
