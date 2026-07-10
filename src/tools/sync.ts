import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { ThreadStore } from "../core/types";
import { mintId } from "../core/ids";
import { acquireLock, releaseLock } from "../core/thread-ops";
import type { Inbox } from "../inbox";
import { err } from "./shared";

/** The In Sync rendezvous: mutually-exclusive live conversation lock. */
export function registerSyncTools(pi: ExtensionAPI, store: ThreadStore, inbox: Inbox) {
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
          content: [{ type: "text" as const, text: "Cannot sync with self." }],
          details: { ok: false },
        };
      }
      if (!(await store.threadExists(params.partner))) {
        // Same reasoning as the locking-type guard in thread_send: a sync
        // request to a thread that doesn't exist locks this side forever.
        return err(
          `No thread "${params.partner}" has ever run in this workspace — sync would lock you onto a partner that can never reply. Check thread_list for valid ids.`,
        );
      }
      await acquireLock(store, mintId(`sync.${params.partner}`), params.partner, "sync", ctx);
      try {
        await inbox.sendCrossThread(params.partner, "Sync", `Sync requested by ${store.threadId}`, {
          requestId: store.lockEventId!,
        });
      } catch (e) {
        await releaseLock(store, ctx);
        return err(e instanceof Error ? e.message : String(e));
      }
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
      store.obligations = store.obligations.filter(o => o.requestId !== released);
      await releaseLock(store, ctx);
      const { notified, parts } = await inbox.fireSubscribers(released);
      inbox.inject(parts, ctx);
      if (partner) {
        await inbox.sendCrossThread(partner, "Answer", "sync closed", {
          requestId: released,
        });
      }
      return {
        content: [
          {
            type: "text" as const,
            text: `Sync closed. Released "${released}". ${notified} local waiter(s) notified.${partner ? ` Notified partner ${partner}.` : ""}`,
          },
        ],
        details: { ok: true, released, waitersNotified: notified },
      };
    },
  });
}
