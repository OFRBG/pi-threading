import { formatThreadLine } from "../core/format";
import type { CommandDefinition } from "./shared";

export const threadList: CommandDefinition = {
  name: "thread-list",
  description: "List all known threads sharing this workspace",
  async handler({ store }, _, ctx) {
    const threads = await store.listThreads();

    if (!threads.length) {
      ctx.ui.notify("(no other threads found)", "info");
      return;
    }

    ctx.ui.notify(threads.map(formatThreadLine).join("\n"), "info");
  },
};
