import type { CommandDefinition } from "./shared";

export const threadSend: CommandDefinition = {
  name: "thread-send",
  description: "Send a note to another thread: /thread-send <to> <body...>",
  async handler({ store, inbox }, args, ctx) {
    const urgency = "high";

    const parts = args.trim().split(/\s+/);

    const [to, ...bodyParts] = parts;
    const body = bodyParts.join(" ");

    if (!to || !body) {
      ctx.ui.notify("Usage: /thread-send <to> <body...>", "warning");
      return;
    }

    try {
      const targets = await inbox.resolveTargets(to);

      if (to === store.threadId || targets.includes(store.threadId)) {
        ctx.ui.notify("Cannot send to self.", "warning");
        return;
      }

      if (!targets.length) {
        ctx.ui.notify(`No matching targets for "${to}".`, "warning");
        return;
      }

      const sent = await inbox.sendMany(targets, body, { urgency });

      const missing = new Set(await inbox.checkMissing(targets));

      for (const s of sent) {
        const unseen = missing.has(s.to);

        if (unseen) {
          ctx.ui.notify(
            `"${s.to}" has not been seen before. Delivery will only happen when it starts a thread.`,
            "warning",
          );
        } else {
          ctx.ui.notify(`Sent to ${s.to}.`, "info");
        }
      }
    } catch (e) {
      ctx.ui.notify(e instanceof Error ? e.message : String(e), "error");
    }
  },
};
