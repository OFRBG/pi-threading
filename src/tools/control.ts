import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { ThreadStore } from "../core/types";
import { resumeThread, suspendThread } from "../core/thread-ops";
import type { Inbox } from "../inbox";

/** Self-control: pausing (On Hold) and resuming. Client-local (Layer 2) —
 *  not protocol surface (§14/A.5). Scheduled wakes are ordinary sends with
 *  deliverAfterSeconds (§12.2), not a control tool. */
export function registerControlTools(pi: ExtensionAPI, store: ThreadStore, inbox: Inbox) {
  pi.registerTool({
    name: "thread_suspend",
    label: "Thread Suspend",
    description:
      "Mark this thread On Hold. Cooperative — does not stop the process, just records suspended state for a human/harness to act on. Inbox messages queue until resume.",
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
}
