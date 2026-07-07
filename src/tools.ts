import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { ThreadStore, MessageType, Barrier, ScheduledWake } from "./core/types";
import type { Inbox } from "./inbox";
import { mintId } from "./core/ids";

function err(text: string) {
  return {
    content: [{ type: "text" as const, text }],
    details: { ok: false },
  };
}

/** Shared by thread_status and /thread-status. */
export function scheduleLines(schedules: ScheduledWake[]): string {
  return schedules.length
    ? "\n" +
        schedules
          .map(w => `  - ${w.id} at ${w.fireAt}: "${w.reason}"${w.nudged ? " (fired)" : ""}`)
          .join("\n")
    : " none";
}

/** Shared by thread_send(wait=true) and thread_await — arm a barrier that
 *  wakes this thread (passively, at next Open) once its requestIds resolve. */
async function armBarrier(
  store: ThreadStore,
  requestIds: string[],
  mode: "all" | "any",
  deadline?: string,
): Promise<Barrier> {
  const barrier: Barrier = {
    id: mintId(`barrier.${store.threadId}`),
    pending: [...requestIds],
    mode,
    createdAt: new Date().toISOString(),
    ...(deadline ? { deadline } : {}),
  };
  store.barriers.push(barrier);
  await store.writeFile();
  return barrier;
}

export function registerTools(pi: ExtensionAPI, store: ThreadStore, inbox: Inbox) {
  pi.registerTool({
    name: "thread_status",
    label: "Thread Status",
    description:
      "Read this thread's own state and journal. Use this to understand what you were doing before a compaction.",
    parameters: Type.Object({}),
    async execute() {
      const journal =
        (await store.readJournal(store.threadId)) ?? "(no journal yet — this is the first turn)";
      const lockDesc = `${store.lockEventId ?? "none"}${store.lockPartner ? ` (with ${store.lockPartner})` : ""}`;
      const obligationLines = store.obligations.length
        ? "\n" +
          store.obligations
            .map(
              o =>
                `  - ${o.type} to ${o.to} #${o.requestId} "${o.summary}"${o.deadline ? ` (deadline ${o.deadline})` : ""}`,
            )
            .join("\n")
        : " none";
      const barrierLines = store.barriers.length
        ? "\n" +
          store.barriers
            .map(
              b =>
                `  - ${b.id} (${b.mode}) pending: ${b.pending.join(", ")}${b.deadline ? ` (deadline ${b.deadline})` : ""}`,
            )
            .join("\n")
        : " none";
      const owedLines = store.owed.length
        ? "\n" +
          store.owed
            .map(
              o =>
                `  - you owe ${o.type === "Brief" ? "a Result" : "an Answer"} to ${o.from} for their ${o.type} #${o.requestId} "${o.summary}" — echo that exact requestId`,
            )
            .join("\n")
        : " none";
      return {
        content: [
          {
            type: "text" as const,
            text: `Id: ${store.threadId}\nRole: ${store.role ?? "-"}\nState: ${store.state}${store.holdReason ? ` (${store.holdReason})` : ""}\nStatus: ${store.status}\nLock: ${lockDesc}\nSubscriptions: ${store.subscriptions.length}\nBarriers:${barrierLines}\nObligations:${obligationLines}\nOwed replies:${owedLines}\nSchedules:${scheduleLines(store.schedules)}\n\n${journal}`,
          },
        ],
        details: {
          id: store.threadId,
          role: store.role,
          state: store.state,
          status: store.status,
          holdReason: store.holdReason,
          lockEventId: store.lockEventId,
          lockPartner: store.lockPartner,
          lockType: store.lockType,
          subscriptions: store.subscriptions,
          obligations: store.obligations,
          owed: store.owed,
          barriers: store.barriers,
          schedules: store.schedules,
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
      const threads = await store.listThreads();
      const lines = threads.map(
        t =>
          `${t.id.padEnd(16)} [${t.state}]  ${t.status}  role=${t.role ?? "-"}  parent=${t.parent ?? "-"}  lastSeen=${t.lastSeen}`,
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
    name: "thread_journal",
    label: "Thread Journal",
    description:
      "Read another thread's journal (or your own) without messaging it — the self-written status trail visible via thread_status, but for anyone. Use to check what a teammate has been doing before deciding whether to interrupt them.",
    parameters: Type.Object({
      id: Type.String({
        description: "Thread id to read (see thread_list). Use your own id for your own journal.",
      }),
      tail: Type.Optional(
        Type.Number({
          description:
            "Only return the last N journal entries (each entry is one turn/session). Default: all.",
        }),
      ),
      lookbackMinutes: Type.Optional(
        Type.Number({
          description:
            "Only return entries timestamped within the last N minutes. Combine with tail to cap both age and count.",
        }),
      ),
    }),
    async execute(_id, params) {
      if (!(await store.threadExists(params.id))) {
        return err(`No thread "${params.id}" found. Call thread_list to see known ids.`);
      }
      let journal = (await store.readJournal(params.id)) ?? "(no journal entries yet)";
      if ((params.tail || params.lookbackMinutes) && journal) {
        let entries = journal.split(/\n(?=<!--)/).filter(Boolean);
        if (params.lookbackMinutes) {
          const cutoff = Date.now() - params.lookbackMinutes * 60_000;
          entries = entries.filter(e => {
            const m = /^<!--\s*(.+?)\s*-->/.exec(e);
            if (!m) return true; // no timestamp — keep rather than silently drop
            const ts = new Date(m[1].replace(" ", "T") + ":00Z").getTime();
            return !Number.isFinite(ts) || ts >= cutoff;
          });
        }
        if (params.tail) entries = entries.slice(-params.tail);
        journal = entries.join("\n") || "(no entries in range)";
      }
      return {
        content: [{ type: "text" as const, text: `Journal for ${params.id}:\n\n${journal}` }],
        details: { ok: true, id: params.id, journal },
      };
    },
  });

  pi.registerTool({
    name: "thread_send",
    label: "Thread Send",
    description:
      "Send a typed message to other thread(s). `to` accepts a thread id, a comma-separated list, `*` (all known threads), or `role:<role>` — see thread_list. Question/Blocker make this thread enter Listening until a matching Answer arrives; Brief/Question/Sync/Blocker leave an obligation visible via thread_status until closed by a matching Answer/Result.",
    parameters: Type.Object({
      to: Type.Optional(
        Type.String({
          description:
            'Target: thread id, "a,b,c", "*", or "role:<role>". Optional for Blocker (defaults to parent).',
        }),
      ),
      type: Type.Union(
        [
          Type.Literal("Brief"),
          Type.Literal("Note"),
          Type.Literal("Question"),
          Type.Literal("Answer"),
          Type.Literal("Update"),
          Type.Literal("Result"),
          Type.Literal("Blocker"),
          Type.Literal("Sync"),
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
      deadlineSeconds: Type.Optional(
        Type.Number({
          description:
            "For Brief/Question/Blocker: seconds until the obligation counts as overdue — you get a one-time reminder to follow up.",
        }),
      ),
      wait: Type.Optional(
        Type.Boolean({
          description:
            "Arm a barrier for the reply right after sending, so you get a passive wake-up when it lands — merges thread_await into this call. Only meaningful for Brief (Question/Blocker/Sync already wait via the lock, and Note/Update have no reply protocol to wait on — wait is ignored for all of them). End your turn after calling this.",
        }),
      ),
      waitMode: Type.Optional(
        Type.Union([Type.Literal("all"), Type.Literal("any")], {
          description:
            'With wait=true and multiple targets: wake on "all" replies (default) or the first ("any").',
        }),
      ),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const type = params.type as MessageType;
      const toSpec = params.to ?? (type === "Blocker" ? (store.parent ?? "") : "");
      if (!toSpec) {
        return err(
          type === "Blocker"
            ? "No target: this thread has no parent — pass `to` explicitly."
            : "`to` is required.",
        );
      }
      if ((type === "Answer" || type === "Result") && !params.requestId) {
        return err(
          `requestId is required for ${type} — it must match the original Question/Brief's requestId.`,
        );
      }

      const targets = (await inbox.resolveTargets(toSpec)).filter(t => t !== store.threadId);
      if (targets.length === 0) {
        return err(`No matching targets for "${toSpec}" (self-sends are excluded).`);
      }
      const locking = type === "Question" || type === "Blocker" || type === "Sync";
      if (locking && targets.length > 1) {
        return err(
          `${type} needs exactly one target (it locks this thread onto one reply). For a fan-out, send individual ${type}s with deadlines and use thread_await.`,
        );
      }

      // "*"/role: targets come from listThreads and exist by construction; a
      // direct id may be a typo. For locking types a typo is fatal — the lock
      // waits forever for a reply that can never come — so refuse. Queueing
      // types legitimately target threads that will boot later (durable
      // dead-drop), so those get a warning instead.
      const missing: string[] = [];
      for (const t of targets) {
        if (!(await store.threadExists(t))) missing.push(t);
      }
      if (locking && missing.length) {
        return err(
          `No thread "${missing[0]}" has ever run in this workspace — a ${type} would lock you in a wait for a reply that can never come. Check thread_list for valid ids${type === "Sync" ? "" : `, or use a Brief/Note if "${missing[0]}" will be created later`}.`,
        );
      }

      const deadline = params.deadlineSeconds
        ? new Date(Date.now() + params.deadlineSeconds * 1000).toISOString()
        : undefined;

      const sent: { to: string; requestId: string; delivered: string }[] = [];
      try {
        for (const to of targets) {
          // No explicit requestId: sendCrossThread mints a unique one per
          // target, so fan-out replies stay individually correlatable.
          const r = await inbox.sendCrossThread(to, type, params.body, {
            requestId: params.requestId,
            delivery: params.delivery as "steer" | "follow-up" | undefined,
            deadline,
          });
          sent.push({ to, requestId: r.requestId, delivered: r.delivered });
        }
      } catch (e) {
        return err(e instanceof Error ? e.message : String(e));
      }

      if (type === "Question" || type === "Blocker") {
        store.lockEventId = sent[0].requestId;
        store.lockPartner = sent[0].to;
        store.lockType = "reply";
        await store.transition("listening", ctx);
      }

      const lines = sent.map(
        s => `${type} sent to ${s.to}. requestId=${s.requestId} (${s.delivered}).`,
      );
      if (missing.length) {
        lines.push(
          `(note: ${missing.join(", ")} ${missing.length === 1 ? "has" : "have"} never been seen in this workspace — the message is queued durably and delivers if a thread with that id starts. If this was a typo, check thread_list.)`,
        );
      }

      let waitNote = "";
      if (params.wait) {
        if (locking) {
          waitNote = `\n(wait=true ignored — ${type} already put you in a wait state via the lock.)`;
        } else if (type !== "Brief") {
          waitNote = `\n(wait=true ignored — ${type} has no reply protocol, so there's nothing to wait for. Use Brief if you need a tracked reply.)`;
        } else {
          const barrier = await armBarrier(
            store,
            sent.map(s => s.requestId),
            (params.waitMode as "all" | "any") ?? "all",
            deadline,
          );
          waitNote = `\nWaiting (barrier ${barrier.id}) for ${barrier.mode} of ${barrier.pending.length} repl${barrier.pending.length === 1 ? "y" : "ies"}. You'll be woken when it resolves — end your turn now.`;
        }
      }

      return {
        content: [{ type: "text" as const, text: lines.join("\n") + waitNote }],
        details: { ok: true, sent },
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
      delivery: Type.Union([Type.Literal("steer"), Type.Literal("follow-up")], {
        description: "steer = at next Open (urgent), follow-up = when done (deferred)",
      }),
    }),
    async execute(_id, params) {
      store.subscriptions.push({
        eventId: params.eventId,
        message: params.message,
        delivery: params.delivery as "steer" | "follow-up",
      });
      await store.writeFile();
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
      const n = await inbox.fireSubscribers(params.eventId);
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
    name: "thread_await",
    label: "Thread Await",
    description:
      "Wait for replies to multiple outstanding obligations at once (fan-out Briefs/Questions). When all (or any) of the given requestIds receive their Answer/Result, you get a wake-up message. Non-blocking: end your turn after calling this.",
    parameters: Type.Object({
      requestIds: Type.Array(Type.String(), {
        description: "The requestIds to wait on (from thread_send results / thread_status)",
        minItems: 1,
      }),
      mode: Type.Optional(
        Type.Union([Type.Literal("all"), Type.Literal("any")], {
          description: 'Wake when "all" replies arrived (default) or on the first ("any")',
        }),
      ),
      deadlineSeconds: Type.Optional(
        Type.Number({
          description:
            "Seconds until this barrier counts as overdue — you get a one-time reminder if it hasn't resolved by then.",
        }),
      ),
    }),
    async execute(_id, params) {
      const known = new Set(store.obligations.map(o => o.requestId));
      const unknown = params.requestIds.filter(id => !known.has(id));
      const deadline = params.deadlineSeconds
        ? new Date(Date.now() + params.deadlineSeconds * 1000).toISOString()
        : undefined;
      const barrier = await armBarrier(
        store,
        params.requestIds,
        (params.mode as "all" | "any") ?? "all",
        deadline,
      );
      const warn = unknown.length
        ? `\nWarning: no open obligation matches ${unknown.join(", ")} — if no reply ever carries that requestId, the barrier never resolves.`
        : "";
      return {
        content: [
          {
            type: "text" as const,
            text: `Barrier ${barrier.id} armed: waiting for ${barrier.mode} of ${barrier.pending.length} replies. You'll be woken when it resolves.${warn}`,
          },
        ],
        details: { ok: true, barrier },
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
      store.lockEventId = mintId(`sync.${params.partner}`);
      store.lockPartner = params.partner;
      store.lockType = "sync";
      await store.transition("in-sync", ctx);
      try {
        await inbox.sendCrossThread(params.partner, "Sync", `Sync requested by ${store.threadId}`, {
          requestId: store.lockEventId,
        });
      } catch (e) {
        store.lockEventId = null;
        store.lockPartner = null;
        store.lockType = null;
        await store.transition("open", ctx);
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
      store.lockEventId = null;
      store.lockPartner = null;
      store.lockType = null;
      store.obligations = store.obligations.filter(o => o.requestId !== released);
      await store.transition("open", ctx);
      const n = await inbox.fireSubscribers(released);
      if (partner) {
        await inbox.sendCrossThread(partner, "Answer", "sync closed", {
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
    async execute(_id, params, _signal, _onUpdate, ctx) {
      store.holdReason = params.reason ?? null;
      await store.transition("on-hold", ctx);
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
      store.holdReason = null;
      await store.transition("open", ctx);
      await inbox.drainInbox(ctx);
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
