import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { Barrier, ThreadStore, Urgency } from "../core/types";
import { mintId } from "../core/ids";
import { deadlineFromSeconds, nowIso } from "../core/time";
import type { Inbox } from "../inbox";
import { err } from "./shared";

/** Shared by thread_send(wait=true) and thread_wait — arm a barrier that
 *  wakes this thread (passively, at next Open) once its envelope ids
 *  resolve. An optional message payload is injected on resolution (§12.1). */
async function armBarrier(
  store: ThreadStore,
  ids: string[],
  mode: "all" | "any",
  deadline?: string,
  message?: string,
): Promise<Barrier> {
  const barrier: Barrier = {
    id: mintId(`barrier.${store.threadId}`),
    pending: [...ids],
    mode,
    createdAt: nowIso(),
    ...(deadline ? { deadline } : {}),
    ...(message ? { message } : {}),
  };
  store.barriers.push(barrier);
  await store.persist();
  return barrier;
}

/** Envelope messaging (PROTOCOL-FORMALISM.md §6): one send tool, one wait
 *  tool. Kind is structural — expects/re — never a type tag. */
export function registerMessagingTools(pi: ExtensionAPI, store: ThreadStore, inbox: Inbox) {
  pi.registerTool({
    name: "thread_send",
    label: "Thread Send",
    description:
      'Send a message to other thread(s). `to` accepts a thread id, a comma-separated list, `*` (all known threads), or `role:<role>` — see thread_list. Set expects=true when you need a reply (a "request" — tracked as an obligation until the reply lands). Set re=<id> to reply to a message you received (this discharges the debt). Both together = a reply that asks a follow-up. Neither = a plain note. To your parent with expects=true and urgency="high" = an escalation. A future-dated send to your OWN id (deliverAfterSeconds) is a scheduled self-wake.',
    parameters: Type.Object({
      to: Type.String({
        description: 'Target: thread id, "a,b,c", "*", or "role:<role>".',
      }),
      body: Type.String({ description: "Message content" }),
      re: Type.Optional(
        Type.String({
          description:
            "Reply correlation: the envelope id you received (from the [#id] header or thread_status owed list). Discharges the owed reply.",
        }),
      ),
      expects: Type.Optional(
        Type.Boolean({
          description:
            "You need a reply: the receiver records an owed reply keyed by this send's id, and you get an obligation with a deadline (default 15m).",
        }),
      ),
      urgency: Type.Optional(
        Type.Union([Type.Literal("high"), Type.Literal("low")], {
          description:
            "Delivery priority: high interrupts the receiver at its next opening; low (default) delivers when it is idle.",
        }),
      ),
      deliverAfterSeconds: Type.Optional(
        Type.Number({
          description:
            "Hold the envelope until N seconds from now. To your own id, this is a scheduled self-wake.",
        }),
      ),
      deadlineSeconds: Type.Optional(
        Type.Number({
          description:
            "With expects=true: seconds until the obligation counts as overdue — you get a one-time reminder to follow up. Default: 15 minutes.",
        }),
      ),
      wait: Type.Optional(
        Type.Boolean({
          description:
            "With expects=true: arm a barrier for the reply right after sending, so you get a passive wake-up when it lands — merges thread_wait into this call. End your turn after calling this.",
        }),
      ),
      waitMode: Type.Optional(
        Type.Union([Type.Literal("all"), Type.Literal("any")], {
          description:
            'With wait=true and multiple targets: wake on "all" replies (default) or the first ("any").',
        }),
      ),
    }),
    async execute(_id, params) {
      const toSpec = params.to;
      const expects = params.expects === true;
      const deliverAfter = params.deliverAfterSeconds
        ? new Date(Date.now() + params.deliverAfterSeconds * 1000).toISOString()
        : undefined;

      // Self-sends are only meaningful with a future delivery time (§12.2 —
      // a scheduled wake); an immediate self-send is noise.
      const selfWake = toSpec === store.threadId && Boolean(deliverAfter);
      const targets = selfWake
        ? [store.threadId]
        : (await inbox.resolveTargets(toSpec)).filter(t => t !== store.threadId);
      if (targets.length === 0) {
        return err(
          toSpec === store.threadId
            ? "Self-sends need deliverAfterSeconds (a scheduled wake) — an immediate send to yourself is a no-op."
            : `No matching targets for "${toSpec}" (self-sends are excluded).`,
        );
      }

      // Soft warning, not a hard failure (§9.1): the discharge gate in the
      // engine is what actually protects the ledger — this is the send-side
      // half of the silent-debtor nudge, catching misdirected replies before
      // they even go out.
      let targetWarning = "";
      if (params.re) {
        const owedMatch = store.owed.find(o => o.id === params.re);
        if (!owedMatch) {
          targetWarning = `Warning: no owed reply matches re "${params.re}" — check thread_status before sending, in case this reply is misdirected or stale.`;
        } else if (!targets.includes(owedMatch.from)) {
          targetWarning = `Warning: re "${params.re}" is owed to ${owedMatch.from}, not "${toSpec}" — double check the target.`;
        }
      }

      // "*"/role: targets come from listThreads and exist by construction; a
      // direct id may be a typo. Queueing is a durable dead-drop (§7.1), so
      // this is a warning, never a refusal.
      const missing = selfWake ? [] : await inbox.findMissingTargets(targets);

      const deadline = deadlineFromSeconds(params.deadlineSeconds);

      let sent: Awaited<ReturnType<Inbox["sendToMany"]>>;
      try {
        // sendEnvelope mints a unique id per target, so fan-out replies stay
        // individually correlatable.
        sent = await inbox.sendToMany(targets, params.body, {
          re: params.re,
          expects,
          urgency: params.urgency as Urgency | undefined,
          deliverAfter,
          deadline,
        });
      } catch (e) {
        return err(e instanceof Error ? e.message : String(e));
      }

      const lines = sent.map(
        s =>
          `Sent to ${s.to}. id=${s.id} (${s.delivered}${deliverAfter ? `, holds until ${deliverAfter}` : ""}).`,
      );
      if (targetWarning) lines.push(targetWarning);
      if (missing.length) {
        lines.push(
          `(note: ${missing.join(", ")} ${missing.length === 1 ? "has" : "have"} never been seen in this workspace — the message is queued durably and delivers if a thread with that id starts. If this was a typo, check thread_list.)`,
        );
      }

      let waitNote = "";
      if (params.wait) {
        if (!expects) {
          waitNote =
            "\n(wait=true ignored — nothing expects a reply. Set expects=true if you need a tracked reply to wait on.)";
        } else {
          const barrier = await armBarrier(
            store,
            sent.map(s => s.id),
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
    name: "thread_wait",
    label: "Thread Wait",
    description:
      "Wait for replies to outstanding requests (envelope ids from thread_send results / thread_status). When all (or any) of them receive a reply, you get a wake-up message — optionally with your own `message` payload injected alongside it. Non-blocking: end your turn after calling this.",
    parameters: Type.Object({
      ids: Type.Array(Type.String(), {
        description: "The envelope ids to wait on (from thread_send results / thread_status)",
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
      message: Type.Optional(
        Type.String({
          description:
            "Injected back to you when the barrier resolves — a note-to-self about what to do next.",
        }),
      ),
    }),
    async execute(_id, params) {
      const known = new Set(store.obligations.map(o => o.id));
      const unknown = params.ids.filter(id => !known.has(id));
      const deadline = deadlineFromSeconds(params.deadlineSeconds);
      const barrier = await armBarrier(
        store,
        params.ids,
        (params.mode as "all" | "any") ?? "all",
        deadline,
        params.message,
      );
      const warn = unknown.length
        ? `\nWarning: no open obligation matches ${unknown.join(", ")} — if no reply ever carries that id, the barrier never resolves.`
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
}
