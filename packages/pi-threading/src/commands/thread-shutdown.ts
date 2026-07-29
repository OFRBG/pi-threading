import type { CommandDefinition } from "./shared";
import { shutdownThread } from "../core/launch";

export const threadShutdown: CommandDefinition = {
  name: "thread-shutdown",
  description:
    "Signal thread(s) to stop: /thread-shutdown <to> [--force]  (to: id, comma list, *, or role:<role>; --force sends SIGKILL instead of SIGTERM)",
  async handler({ store, inbox }, args, ctx) {
    const parts = args.trim().split(/\s+/).filter(Boolean);
    const force = parts.includes("--force");
    const to = parts.find(p => p !== "--force");

    if (!to) {
      ctx.ui.notify("Usage: /thread-shutdown <to> [--force]", "warning");
      return;
    }

    let targets: string[];
    try {
      targets = await inbox.resolveTargets(to);
    } catch (e) {
      ctx.ui.notify(e instanceof Error ? e.message : String(e), "error");
      return;
    }

    if (!targets.length) {
      ctx.ui.notify(`No matching targets for "${to}".`, "warning");
      return;
    }

    for (const id of targets) {
      const outcome = await shutdownThread(store, id, { force });
      ctx.ui.notify(`${id}: ${outcome.message}`, outcome.ok ? "info" : "warning");
    }
  },
};
