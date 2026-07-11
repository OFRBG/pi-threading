import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { Barrier, Delivery, MessageType, ThreadStore } from "../core/types";
import { DEFAULT_LOCK_DEADLINE_MS } from "../core/types";
import { mintId } from "../core/ids";
import { deadlineFromSeconds, nowIso } from "../core/time";
import { acquireLock } from "../core/thread-ops";
import type { Inbox } from "../inbox";
import { err } from "./shared";

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
    createdAt: nowIso(),
    ...(deadline ? { deadline } : {}),
  };
  store.barriers.push(barrier);
  await store.persist();
  return barrier;
}

/** Typed cross-thread messaging: send, fan-out waits, local events. */
export function registerMessagingTools(pi: ExtensionAPI, store: ThreadStore, inbox: Inbox) {
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

      // Soft warning, not a hard failure: a Sync's closing Answer never
      // creates an OwedReply in the first place (Sync is excluded from
      // OwedType — its reply is produced by thread_sync_close via the lock),
      // so a hard check here would misfire on a legitimate sync-close Answer
      // sent this way instead. This is the send-side half of the owed-reply
      // nudge in lifecycle.ts's turn_end: without it, a misdirected Answer/
      // Result still silently clears store.owed as if it had been correct.
      let targetWarning = "";
      if (type === "Answer" || type === "Result") {
        const owedMatch = store.owed.find(o => o.requestId === params.requestId);
        if (!owedMatch) {
          targetWarning = `Warning: no owed reply matches requestId "${params.requestId}" — check thread_status before sending, in case this reply is misdirected or stale.`;
        } else if (!targets.includes(owedMatch.from)) {
          targetWarning = `Warning: requestId "${params.requestId}" is owed to ${owedMatch.from}, not "${toSpec}" — double check the target.`;
        }
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
      const missing = await inbox.findMissingTargets(targets);
      if (locking && missing.length) {
        return err(
          `No thread "${missing[0]}" has ever run in this workspace — a ${type} would lock you in a wait for a reply that can never come. Check thread_list for valid ids${type === "Sync" ? "" : `, or use a Brief/Note if "${missing[0]}" will be created later`}.`,
        );
      }

      // Synchronous 2-cycle guard for reply locks: if the single target is
      // already Listening on a reply from THIS thread, committing our own lock
      // onto it forms an immediate a→b→a deadlock. Unlike Sync (which has a
      // receiver-side rejection path), Question/Blocker locks are inert — nothing
      // observes the cycle — so reject the straight-line case up front, before a
      // message is even sent (§3, Finding 2b). This does NOT close the TOCTOU
      // window where both sides lock concurrently — that's unfixable without a
      // real distributed lock — only the case where the target is *already*
      // provably locked back onto us at send time.
      if (type === "Question" || type === "Blocker") {
        const targetState = await store.adapter.loadState(targets[0]);
        if (
          targetState &&
          targetState.lockType === "reply" &&
          targetState.lockPartner === store.threadId
        ) {
          return err(
            `${targets[0]} is already Listening on a reply from you (#${targetState.lockEventId}) — a ${type} back to it would deadlock both threads. Answer their pending request first, or coordinate through a third thread.`,
          );
        }
      }

      // Locking replies (Question/Blocker) fall back to a default deadline when
      // the caller omits one, so a forgotten deadlineSeconds can't leave a true
      // 2-cycle with zero automatic recovery (§3, Finding 2a). Sync is excluded:
      // it flows through thread_sync_request and self-heals via its receiver-side
      // rejection Answer, so it needs no obligation-timer fallback.
      const isReplyLock = type === "Question" || type === "Blocker";
      const deadline =
        deadlineFromSeconds(params.deadlineSeconds) ??
        (isReplyLock ? new Date(Date.now() + DEFAULT_LOCK_DEADLINE_MS).toISOString() : undefined);

      let sent: Awaited<ReturnType<Inbox["sendToMany"]>>;
      try {
        // No explicit requestId: sendCrossThread mints a unique one per
        // target, so fan-out replies stay individually correlatable.
        sent = await inbox.sendToMany(targets, type, params.body, {
          requestId: params.requestId,
          delivery: params.delivery as Delivery | undefined,
          deadline,
        });
      } catch (e) {
        return err(e instanceof Error ? e.message : String(e));
      }

      if (type === "Question" || type === "Blocker") {
        await acquireLock(store, sent[0].requestId, sent[0].to, "reply", ctx);
      }

      const lines = sent.map(
        s => `${type} sent to ${s.to}. requestId=${s.requestId} (${s.delivered}).`,
      );
      if (targetWarning) lines.push(targetWarning);
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
      const deadline = deadlineFromSeconds(params.deadlineSeconds);
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
        delivery: params.delivery as Delivery,
      });
      await store.persist();
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
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const { notified, parts } = await inbox.fireSubscribers(params.eventId);
      inbox.inject(parts, ctx);
      return {
        content: [
          {
            type: "text" as const,
            text: `Event "${params.eventId}" fired. ${notified} subscriber(s) notified.`,
          },
        ],
        details: { eventId: params.eventId, notified },
      };
    },
  });
}
