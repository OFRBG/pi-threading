import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import * as fs from "node:fs";
import * as path from "node:path";
import type { ThreadStore, MessageType } from "./types";
import type { Inbox } from "./inbox";

export function registerTools(pi: ExtensionAPI, store: ThreadStore, inbox: Inbox) {
  pi.registerTool({
    name: "thread_status",
    label: "Thread Status",
    description:
      "Read this thread's own state and journal. Use this to understand what you were doing before a compaction.",
    parameters: Type.Object({}),
    async execute() {
      const journalPath = path.join(store.threadDir, "journal.md");
      const journal = fs.existsSync(journalPath)
        ? fs.readFileSync(journalPath, "utf8").trim()
        : "(no journal yet — this is the first turn)";
      const lockDesc =
        `${store.lockEventId ?? "none"}${store.lockPartner ? ` (with ${store.lockPartner})` : ""}`;
      return {
        content: [
          {
            type: "text" as const,
            text: `Id: ${store.threadId}\nState: ${store.state}\nStatus: ${store.status}\nLock: ${lockDesc}\nSubscriptions: ${store.subscriptions.length}\nObligations: ${store.obligations.length}\n\n${journal}`,
          },
        ],
        details: {
          id: store.threadId,
          state: store.state,
          status: store.status,
          lockEventId: store.lockEventId,
          lockPartner: store.lockPartner,
          subscriptions: store.subscriptions,
          obligations: store.obligations,
        },
      };
    },
  });

  pi.registerTool({
    name: "thread_list",
    label: "Thread List",
    description:
      "List all known threads sharing this workspace and their last known state. Use this to find a valid `to` id before calling thread_send or thread_sync_request.",
    parameters: Type.Object({}),
    async execute() {
      const threads = store.listThreads();
      const lines = threads.map(
        t =>
          `${t.id.padEnd(16)} [${t.state}]  ${t.status}  parent=${t.parent ?? "-"}  lastSeen=${t.lastSeen}`,
      );
      return {
        content: [
          {
            type: "text" as const,
            text: lines.length ? lines.join("\n") : "(no other threads found)",
          },
        ],
        details: { threads },
      };
    },
  });

  pi.registerTool({
    name: "thread_send",
    label: "Thread Send",
    description:
      "Send a typed message to another thread by id. See thread_list for valid ids. Question makes this thread enter Listening until a matching Answer arrives; Brief/Question/Sync leave an obligation visible via thread_status until closed by a matching Answer/Result.",
    parameters: Type.Object({
      to: Type.String({ description: "Target thread id (see thread_list)" }),
      type: Type.Union(
        [
          Type.Literal("Brief"), Type.Literal("Note"), Type.Literal("Question"),
          Type.Literal("Answer"), Type.Literal("Update"), Type.Literal("Result"),
          Type.Literal("Blocker"), Type.Literal("Sync"),
        ],
        {
          description:
            "Brief/Note/Question/Answer/Update/Result/Blocker/Sync. Answer and Result require requestId.",
        },
      ),
      body: Type.String({ description: "Message content" }),
      requestId: Type.Optional(
        Type.String({
          description:
            "Correlation id. Required for Answer/Result — must match the original Question/Brief's requestId.",
        }),
      ),
      delivery: Type.Optional(
        Type.Union([Type.Literal("steer"), Type.Literal("follow-up")], {
          description: "Override the type's default delivery",
        }),
      ),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      if (params.to === store.threadId) {
        return {
          content: [
            {
              type: "text" as const,
              text: "Cannot send to self — use thread_subscribe/thread_emit for intra-thread notifications.",
            },
          ],
          details: { ok: false },
        };
      }
      const type = params.type as MessageType;
      if ((type === "Answer" || type === "Result") && !params.requestId) {
        return {
          content: [
            {
              type: "text" as const,
              text: `requestId is required for ${type} — it must match the original Question/Brief's requestId.`,
            },
          ],
          details: { ok: false },
        };
      }
      const { requestId, delivered } = inbox.sendCrossThread(
        params.to,
        type,
        params.body,
        {
          requestId: params.requestId,
          delivery: params.delivery as "steer" | "follow-up" | undefined,
        },
      );
      if (type === "Question") {
        store.lockEventId = requestId;
        store.transition("listening", ctx);
      }
      return {
        content: [
          {
            type: "text" as const,
            text: `${type} sent to ${params.to}. requestId=${requestId} (${delivered}).`,
          },
        ],
        details: { ok: true, requestId, delivered },
      };
    },
  });

  pi.registerTool({
    name: "thread_subscribe",
    label: "Thread Subscribe",
    description:
      "Subscribe a message to a named event in THIS thread. When that event fires (locally, or via a matching cross-thread Answer/Result), the message is injected into this thread.",
    parameters: Type.Object({
      eventId: Type.String({
        description: "Event name (or requestId) to subscribe to",
      }),
      message: Type.String({
        description: "Message to inject when the event fires",
      }),
      delivery: Type.Union(
        [Type.Literal("steer"), Type.Literal("follow-up")],
        {
          description:
            "steer = at next Open (urgent), follow-up = when done (deferred)",
        },
      ),
    }),
    async execute(_id, params) {
      store.subscriptions.push({
        eventId: params.eventId,
        message: params.message,
        delivery: params.delivery as "steer" | "follow-up",
      });
      store.writeFile();
      return {
        content: [
          {
            type: "text" as const,
            text: `Subscribed to "${params.eventId}". Message will arrive as ${params.delivery}.`,
          },
        ],
        details: { ok: true, eventId: params.eventId },
      };
    },
  });

  pi.registerTool({
    name: "thread_emit",
    label: "Thread Emit",
    description:
      "Emit a named event in THIS thread, delivering queued messages to all local subscribers of that event.",
    parameters: Type.Object({
      eventId: Type.String({ description: "Event name to emit" }),
    }),
    async execute(_id, params) {
      const n = inbox.fireSubscribers(params.eventId);
      return {
        content: [
          {
            type: "text" as const,
            text: `Event "${params.eventId}" fired. ${n} subscriber(s) notified.`,
          },
        ],
        details: { eventId: params.eventId, notified: n },
      };
    },
  });

  pi.registerTool({
    name: "thread_sync_request",
    label: "Thread Sync Request",
    description:
      "Enter In Sync (rendezvous) with another thread by id. Returns ok with a lockEventId if unlocked, or locked with an eventId if this thread is already in sync with someone else.",
    parameters: Type.Object({
      partner: Type.String({
        description: "Target thread id to rendezvous with (see thread_list)",
      }),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      if (store.lockEventId) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Thread is locked (in sync). EventId to wait on: ${store.lockEventId}`,
            },
          ],
          details: { locked: true, eventId: store.lockEventId },
        };
      }
      if (params.partner === store.threadId) {
        return {
          content: [
            { type: "text" as const, text: "Cannot sync with self." },
          ],
          details: { ok: false },
        };
      }
      store.lockEventId = `sync.${params.partner}.${Date.now()}`;
      store.lockPartner = params.partner;
      store.transition("in-sync", ctx);
      inbox.sendCrossThread(
        params.partner,
        "Sync",
        `Sync requested by ${store.threadId}`,
        { requestId: store.lockEventId },
      );
      return {
        content: [
          {
            type: "text" as const,
            text: `Sync acquired with ${params.partner}. EventId: ${store.lockEventId}`,
          },
        ],
        details: { ok: true, eventId: store.lockEventId },
      };
    },
  });

  pi.registerTool({
    name: "thread_sync_close",
    label: "Thread Sync Close",
    description:
      "End the current In Sync session. Releases the lock, fires local subscribers, and notifies the sync partner so its side unwinds too.",
    parameters: Type.Object({}),
    async execute(_id, _params, _signal, _onUpdate, ctx) {
      if (!store.lockEventId) {
        return {
          content: [
            {
              type: "text" as const,
              text: "Not currently in sync — nothing to close.",
            },
          ],
          details: { ok: false },
        };
      }
      const released = store.lockEventId;
      const partner = store.lockPartner;
      store.lockEventId = null;
      store.lockPartner = null;
      store.transition("open", ctx);
      const n = inbox.fireSubscribers(released);
      if (partner) {
        inbox.sendCrossThread(partner, "Answer", "sync closed", {
          requestId: released,
        });
      }
      return {
        content: [
          {
            type: "text" as const,
            text: `Sync closed. Released "${released}". ${n} local waiter(s) notified.${partner ? ` Notified partner ${partner}.` : ""}`,
          },
        ],
        details: { ok: true, released, waitersNotified: n },
      };
    },
  });

  pi.registerTool({
    name: "thread_suspend",
    label: "Thread Suspend",
    description:
      "Mark this thread On Hold. Cooperative — does not stop the process, just records suspended state for a human/harness to act on.",
    parameters: Type.Object({
      reason: Type.Optional(Type.String()),
    }),
    async execute(_id, _params, _signal, _onUpdate, ctx) {
      store.transition("on-hold", ctx);
      return {
        content: [
          { type: "text" as const, text: "Thread suspended (On Hold)." },
        ],
        details: { ok: true },
      };
    },
  });

  pi.registerTool({
    name: "thread_resume",
    label: "Thread Resume",
    description: "Resume this thread from On Hold back to Open.",
    parameters: Type.Object({}),
    async execute(_id, _params, _signal, _onUpdate, ctx) {
      if (store.state !== "on-hold") {
        return {
          content: [
            {
              type: "text" as const,
              text: `Not on hold (state is ${store.state}) — nothing to resume.`,
            },
          ],
          details: { ok: false },
        };
      }
      store.transition("open", ctx);
      return {
        content: [
          { type: "text" as const, text: "Thread resumed (Open)." },
        ],
        details: { ok: true },
      };
    },
  });
}