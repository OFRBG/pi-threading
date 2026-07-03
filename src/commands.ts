import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import * as fs from "node:fs";
import * as path from "node:path";
import type { ThreadStore, MessageType } from "./core/types";
import type { Inbox } from "./inbox";

export function registerCommands(pi: ExtensionAPI, store: ThreadStore, inbox: Inbox) {
  pi.registerCommand("/thread-status", {
    description: "Show this thread's own state and latest journal entry",
    async handler(_args, ctx) {
      await ctx.waitForIdle();
      const journalPath = path.join(store.threadDir, "journal.md");
      const lines = fs.existsSync(journalPath)
        ? fs.readFileSync(journalPath, "utf8").trim().split("\n").slice(-12).join("\n")
        : "(no journal yet)";
      const lockDesc = `${store.lockEventId ?? "none"}${store.lockPartner ? ` (with ${store.lockPartner})` : ""}`;
      ctx.ui.notify(
        `Id: ${store.threadId} | State: ${store.state} | Status: ${store.status} | Lock: ${lockDesc} | Subs: ${store.subscriptions.length} | Obligations: ${store.obligations.length} | Barriers: ${store.barriers.length}\n\n${lines}`,
        "info",
      );
    },
  });

  pi.registerCommand("/thread-emit", {
    description: "Emit a named event: /thread-emit <eventId>",
    async handler(args, ctx) {
      const eventId = args.trim();
      if (!eventId) {
        ctx.ui.notify("Usage: /thread-emit <eventId>", "warning");
        return;
      }
      const n = inbox.fireSubscribers(eventId);
      ctx.ui.notify(`Event "${eventId}" fired. ${n} subscriber(s) notified.`, "info");
    },
  });

  pi.registerCommand("/thread-list", {
    description: "List all known threads sharing this workspace",
    async handler(_args, ctx) {
      const threads = store.listThreads();
      if (!threads.length) {
        ctx.ui.notify("(no other threads found)", "info");
        return;
      }
      const lines = threads.map(
        t =>
          `${t.id.padEnd(16)} [${t.state}]  ${t.status}  role=${t.role ?? "-"}  parent=${t.parent ?? "-"}  lastSeen=${t.lastSeen}`,
      );
      ctx.ui.notify(lines.join("\n"), "info");
    },
  });

  pi.registerCommand("/thread-send", {
    description: "Send a message to another thread: /thread-send <to> <type> <body...>",
    async handler(args, ctx) {
      const parts = args.trim().split(/\s+/);
      const [to, type, ...bodyParts] = parts;
      const body = bodyParts.join(" ");
      const validTypes: MessageType[] = [
        "Brief",
        "Note",
        "Question",
        "Answer",
        "Update",
        "Result",
        "Blocker",
        "Sync",
      ];
      if (!to || !type || !body || !validTypes.includes(type as MessageType)) {
        ctx.ui.notify(`Usage: /thread-send <to> <${validTypes.join("|")}> <body...>`, "warning");
        return;
      }
      if (to === store.threadId) {
        ctx.ui.notify("Cannot send to self.", "warning");
        return;
      }
      try {
        const targets = inbox.resolveTargets(to).filter(t => t !== store.threadId);
        if (!targets.length) {
          ctx.ui.notify(`No matching targets for "${to}".`, "warning");
          return;
        }
        for (const t of targets) {
          const { requestId, delivered } = inbox.sendCrossThread(t, type as MessageType, body);
          ctx.ui.notify(`${type} sent to ${t}. requestId=${requestId} (${delivered}).`, "info");
        }
      } catch (e) {
        ctx.ui.notify(e instanceof Error ? e.message : String(e), "error");
      }
    },
  });

  pi.registerCommand("/thread-suspend", {
    description: "Mark this thread On Hold: /thread-suspend [reason]",
    async handler(args, ctx) {
      store.holdReason = args.trim() || null;
      store.transition("on-hold", ctx);
      ctx.ui.notify(
        `Thread suspended (On Hold)${store.holdReason ? `: ${store.holdReason}` : ""}. Inbox queues until resume.`,
        "info",
      );
    },
  });

  pi.registerCommand("/thread-resume", {
    description: "Resume this thread from On Hold back to Open",
    async handler(_args, ctx) {
      if (store.state !== "on-hold") {
        ctx.ui.notify(`Not on hold (state is ${store.state}).`, "warning");
        return;
      }
      store.holdReason = null;
      store.transition("open", ctx);
      inbox.drainInbox(ctx);
      ctx.ui.notify("Thread resumed (Open). Queued inbox drained.", "info");
    },
  });
}
