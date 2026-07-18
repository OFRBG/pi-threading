import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { formatThreadLine } from "./core/format";
import { resumeThread, suspendThread } from "./core/thread-ops";
import type { ThreadingContext } from "./context";

/** Slash commands: the human operator's view of the same operations the
 *  thread_* tools give the model. */

const NOT_ACTIVE =
  "This session hasn't opted into pi-threading — restart pi with --thread-id <id> to activate.";

function checkActive(threading: ThreadingContext, ctx: ExtensionCommandContext): boolean {
  if (threading.state.active) return true;
  ctx.ui.notify(NOT_ACTIVE, "warning");
  return false;
}

export function registerCommands(threading: ThreadingContext) {
  const { pi, store, inbox } = threading;
  pi.registerCommand("/thread-status", {
    description: "Show this thread's own state and latest journal entry",
    async handler(_args, ctx) {
      if (!checkActive(threading, ctx)) return;
      await ctx.waitForIdle();
      const journal = await store.readJournal(store.threadId);
      const lines = journal ? journal.split("\n").slice(-12).join("\n") : "(no journal yet)";
      ctx.ui.notify(
        `Id: ${store.threadId} | State: ${store.state} | Status: ${store.status} | Obligations: ${store.obligations.length} | Owed: ${store.owed.length} | Barriers: ${store.barriers.length}\n\n${lines}`,
        "info",
      );
    },
  });

  pi.registerCommand("/thread-list", {
    description: "List all known threads sharing this workspace",
    async handler(_args, ctx) {
      if (!checkActive(threading, ctx)) return;
      const threads = await store.listThreads();
      if (!threads.length) {
        ctx.ui.notify("(no other threads found)", "info");
        return;
      }
      ctx.ui.notify(threads.map(formatThreadLine).join("\n"), "info");
    },
  });

  pi.registerCommand("/thread-send", {
    description: "Send a note to another thread: /thread-send <to> <body...>",
    async handler(args, ctx) {
      if (!checkActive(threading, ctx)) return;
      const parts = args.trim().split(/\s+/);
      const [to, ...bodyParts] = parts;
      const body = bodyParts.join(" ");
      if (!to || !body) {
        ctx.ui.notify("Usage: /thread-send <to> <body...>", "warning");
        return;
      }
      if (to === store.threadId) {
        ctx.ui.notify("Cannot send to self.", "warning");
        return;
      }
      try {
        const targets = (await inbox.resolveTargets(to)).filter(t => t !== store.threadId);
        if (!targets.length) {
          ctx.ui.notify(`No matching targets for "${to}".`, "warning");
          return;
        }
        const missing = new Set(await inbox.findMissingTargets(targets));
        // Operator sends are urgent by default — a human steering a thread
        // wants it seen at the next opening, not when the target goes idle.
        const sent = await inbox.sendToMany(targets, body, { urgency: "high" });
        for (const s of sent) {
          const unseen = missing.has(s.to);
          ctx.ui.notify(
            `Sent to ${s.to}. id=${s.id} (${s.delivered}).${unseen ? ` Warning: "${s.to}" has never been seen in this workspace — delivers only if a thread with that id starts.` : ""}`,
            unseen ? "warning" : "info",
          );
        }
      } catch (e) {
        ctx.ui.notify(e instanceof Error ? e.message : String(e), "error");
      }
    },
  });

  pi.registerCommand("/thread-suspend", {
    description: "Mark this thread On Hold: /thread-suspend [reason]",
    async handler(args, ctx) {
      if (!checkActive(threading, ctx)) return;
      await suspendThread(store, args.trim() || null, ctx);
      ctx.ui.notify(
        `Thread suspended (On Hold)${store.holdReason ? `: ${store.holdReason}` : ""}. Inbox queues until resume.`,
        "info",
      );
    },
  });

  pi.registerCommand("/thread-resume", {
    description: "Resume this thread from On Hold back to Open",
    async handler(_args, ctx) {
      if (!checkActive(threading, ctx)) return;
      if (!(await resumeThread(store, () => inbox.drainInbox(ctx), ctx))) {
        ctx.ui.notify(`Not on hold (state is ${store.state}).`, "warning");
        return;
      }
      ctx.ui.notify("Thread resumed (Open). Queued inbox drained.", "info");
    },
  });
}
