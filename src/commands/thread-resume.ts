import { resumeThread } from "../core/thread-ops";
import type { CommandDefinition } from "./shared";

export const threadResume: CommandDefinition = {
  name: "thread-resume",
  description: "Resume this thread from On Hold back to Open",
  async handler({ store, inbox }, _, ctx) {
    
    if (!(await resumeThread(store, () => inbox.drainInbox(ctx), ctx))) {
      ctx.ui.notify(`Not on hold (state is ${store.state}).`, "warning");
      return;
    }

    ctx.ui.notify("Thread resumed (Open). Queued inbox drained.", "info");
  },
};
