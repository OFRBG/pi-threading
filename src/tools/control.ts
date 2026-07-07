import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { ScheduledWake, ThreadStore } from "../core/types";
import { mintId } from "../core/ids";
import { resumeThread, suspendThread } from "../core/thread-ops";
import type { Inbox } from "../inbox";
import { err } from "./shared";

/** Self-control: pausing (On Hold) and pacing (scheduled wakes). */
export function registerControlTools(pi: ExtensionAPI, store: ThreadStore, inbox: Inbox) {
  pi.registerTool({
    name: "thread_suspend",
    label: "Thread Suspend",
    description:
      "Mark this thread On Hold. Cooperative — does not stop the process, just records suspended state for a human/harness to act on.",
    parameters: Type.Object({
      reason: Type.Optional(Type.String()),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      await suspendThread(store, params.reason ?? null, ctx);
      return {
        content: [
          {
            type: "text" as const,
            text: `Thread suspended (On Hold)${params.reason ? `: ${params.reason}` : ""}. Inbox messages queue until resume.`,
          },
        ],
        details: { ok: true, reason: params.reason ?? null },
      };
    },
  });

  pi.registerTool({
    name: "thread_resume",
    label: "Thread Resume",
    description: "Resume this thread from On Hold back to Open.",
    parameters: Type.Object({}),
    async execute(_id, _params, _signal, _onUpdate, ctx) {
      if (!(await resumeThread(store, () => inbox.drainInbox(ctx), ctx))) {
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
      return {
        content: [{ type: "text" as const, text: "Thread resumed (Open). Queued inbox drained." }],
        details: { ok: true },
      };
    },
  });

  pi.registerTool({
    name: "thread_schedule",
    label: "Thread Schedule",
    description:
      "Arm a future wake-up for THIS thread. When it fires, `reason` is delivered back to you like an obligation reminder — a passive nudge, not a forced turn. Backend-dependent: the local filesystem backend only fires while this process is still running; the Restate backend can wake a stopped thread.",
    parameters: Type.Object({
      fireInSeconds: Type.Number({ description: "Seconds from now until this wake fires" }),
      reason: Type.String({ description: "Delivered back to you verbatim when the wake fires" }),
    }),
    async execute(_id, params) {
      const wake: ScheduledWake = {
        id: mintId(`wake.${store.threadId}`),
        fireAt: new Date(Date.now() + params.fireInSeconds * 1000).toISOString(),
        reason: params.reason,
      };
      await store.adapter.scheduleWake(store.threadId, wake);
      store.schedules.push(wake);
      return {
        content: [
          { type: "text" as const, text: `Scheduled wake ${wake.id} armed for ${wake.fireAt}.` },
        ],
        details: { ok: true, wake },
      };
    },
  });

  pi.registerTool({
    name: "thread_schedule_cancel",
    label: "Thread Schedule Cancel",
    description: "Cancel a previously armed scheduled wake by id (see thread_status).",
    parameters: Type.Object({
      id: Type.String({ description: "The scheduled wake's id" }),
    }),
    async execute(_id, params) {
      if (!store.schedules.some(w => w.id === params.id)) {
        return err(
          `No scheduled wake with id "${params.id}". Call thread_status to see known ids.`,
        );
      }
      await store.adapter.cancelWake(store.threadId, params.id);
      store.schedules = store.schedules.filter(w => w.id !== params.id);
      return {
        content: [{ type: "text" as const, text: `Cancelled scheduled wake ${params.id}.` }],
        details: { ok: true },
      };
    },
  });
}
