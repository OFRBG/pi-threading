import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { ThreadStore, ThreadState } from "./core/types";
import type { Inbox, Injection } from "./inbox";
import { threadModelPrompt } from "./core/system-prompt";
import { journalMode, shouldJournal } from "./journal";

/** Wiring into pi's event stream: state transitions across the turn cycle,
 *  the silent-debtor nudge, journal cadence triggers, and the thread-model
 *  system prompt. */

/** Where a thread settles between turns: On Hold must survive the turn
 *  boundary instead of being stomped to open/done (§11.1). */
function restingState(store: ThreadStore, whenFree: ThreadState): ThreadState {
  if (store.state === "on-hold") return "on-hold";
  return whenFree;
}

/** True once this session has stamped its own thread-identity entry — the
 *  signal that lets a later launch of the *same* session stay a thread
 *  without repassing --thread-id. Mirrors the lookup in state.ts's init(). */
function hasThreadIdentity(ctx: ExtensionContext): boolean {
  try {
    for (const e of ctx.sessionManager.getEntries()) {
      if (e.type === "custom" && e.customType === "thread-identity") return true;
    }
  } catch {
    // --no-session or unreadable session — nothing to recover.
  }
  return false;
}

export function registerLifecycle(pi: ExtensionAPI, store: ThreadStore, inbox: Inbox) {
  let toolUsedThisTurn = false;
  // Opt-in gate (§2.3 — participation is opt-in): this extension only turns
  // a directory into a pi-threading workspace when explicitly asked —
  // --thread-id on this launch, or a thread-identity entry already stamped
  // into this session's own history from an earlier one. Every handler below
  // no-ops while this is false, so an unrelated session (including forked
  // children, which never inherit participation) never gets a .thread/ dir,
  // a random identity, the thread_* tools, or the thread-model system prompt.
  let active = false;

  pi.on("session_start", async (_event, ctx) => {
    const flagId = pi.getFlag("thread-id");
    active = (typeof flagId === "string" && flagId.length > 0) || hasThreadIdentity(ctx);
    if (!active) {
      // Keep the thread_* tools out of this session's active set entirely —
      // an unrelated session shouldn't see them offered, let alone have the
      // model attempt one against an uninitialized store.
      pi.setActiveTools(pi.getActiveTools().filter(name => !name.startsWith("thread_")));
      return;
    }

    await store.init(ctx.cwd, ctx);

    // Defer initial drain to next tick — calling pi.sendUserMessage
    // synchronously from session_start deadlocks turn scheduling.
    setImmediate(() => void inbox.drainInbox(ctx));
    store.startWatcher(inbox.drainInbox, ctx);
    // The heartbeat also re-attempts the drain: it is the retry path for
    // messages the injection gate left on disk (compaction, idle preflight)
    // and for deliverAfter envelopes that have come due.
    store.startHeartbeat(async () => {
      // Coalesce both heartbeat-driven sources into ONE inject() per tick
      // (§7.5, Errata 3): if drainInbox injected on its own here, its
      // idle-time inFlightSince write would gate out the deadline check for
      // a full heartbeat interval.
      const parts: Injection[] = [];
      await inbox.drainInbox(ctx, parts);
      await inbox.checkDeadlines(ctx, parts);
      inbox.inject(parts, ctx);
    });
  });

  // The TUI holds user input while a compaction runs; extension-initiated
  // prompts get no such guard, and one injected mid-compaction starts an
  // agent run that races the context rewrite. Mirror the TUI: hold the
  // inbox during compaction, flush as soon as it ends.
  pi.on("session_before_compact", async () => {
    if (active) inbox.noteCompactionStart();
  });

  pi.on("session_compact", async (_event, ctx) => {
    if (!active) return;
    inbox.noteCompactionEnd();
    await inbox.drainInbox(ctx);
  });

  pi.on("session_shutdown", async event => {
    if (active) await store.shutdown(event.reason);
  });

  pi.on("turn_start", async (_event, ctx) => {
    if (!active) return;
    inbox.noteRunStarted();
    const wasOnHold = store.state === "on-hold";
    toolUsedThisTurn = false;
    await store.transition("thinking", ctx);
    if (wasOnHold) {
      // A prompt landing on a suspended thread is an implicit resume.
      store.holdReason = null;
      await store.persist();
      await inbox.drainInbox(ctx);
    }
  });

  pi.on("tool_execution_start", async (_event, ctx) => {
    if (!active) return;
    toolUsedThisTurn = true;
    await store.transition("working", ctx);
  });

  pi.on("turn_end", async (_event, ctx) => {
    if (!active) return;
    await store.transition(restingState(store, "open"), ctx);

    // Silent-debtor nudge (§9.4): a thread holding owed replies that ends a
    // pure-text turn instead of replying via thread_send — the classic
    // channel confusion, where the model "answers" but only the human sees
    // it. Inject a passive reminder (no turn trigger — a forced turn goads
    // the model into acting just to have something to do). Gated by
    // owedNudgePending so a long run of consecutive silent+owed turns queues
    // exactly one reminder, not one per turn; agent_end re-arms the gate so
    // a persistently silent thread still gets one fresh, escalating nudge
    // per run rather than exactly one ever. The reminder solicits the
    // "Standing by" canary — an acknowledged hold is conforming (§9.4/§9.5).
    if (toolUsedThisTurn) {
      store.owedSilentStreak = 0;
      store.owedNudgePending = false;
    } else if (store.owed.length > 0) {
      store.owedSilentStreak = Math.min(store.owedSilentStreak + 1, 3);
      if (!store.owedNudgePending) {
        store.owedNudgePending = true;
        const items = store.owed.map(o => `${o.from} (re #${o.id})`).join(", ");
        const escalation =
          store.owedSilentStreak >= 2
            ? ` This is turn ${store.owedSilentStreak} with no reply — restating it as plain text is invisible to them.`
            : "";
        pi.sendMessage(
          {
            customType: "thread-owed-reminder",
            content: `[thread-system] Automated reminder (not from the human): you still owe a reply to ${items}. Plain text reaches only the human — never them. Reply for real via thread_send with the re id.${escalation} Still working on it? Acknowledge with "Standing by". Missing information from the requester? Pass the ball: reply with what you need and expects=true.`,
            display: true,
          },
          { triggerTurn: false, deliverAs: "nextTurn" },
        );
      }
    }

    if (journalMode(pi) === "turn" && shouldJournal(store, toolUsedThisTurn, "turn")) {
      const sf = ctx.sessionManager.getSessionFile();
      if (sf) store.forkJournal(sf);
    }

    // The turn boundary is the documented "Open" moment — pick up anything
    // the watcher couldn't deliver while the injection gate was closed.
    await inbox.drainInbox(ctx);
  });

  pi.on("agent_end", async (_event, ctx) => {
    if (!active) return;
    await store.transition(restingState(store, "done"), ctx);
    // Re-arm the owed-reply nudge gate: each new run gets one fresh chance to
    // remind, while owedSilentStreak (untouched here) keeps climbing across
    // consecutive silent runs — that's what makes the streak>=2 escalation
    // in turn_end's guard reachable at all.
    store.owedNudgePending = false;
    const mode = journalMode(pi);
    const write =
      mode === "done"
        ? shouldJournal(store, toolUsedThisTurn, "done")
        : mode === "turn" && shouldJournal(store, toolUsedThisTurn, "run-end");
    if (write) {
      const sf = ctx.sessionManager.getSessionFile();
      if (sf) store.forkJournal(sf);
    }

    // Messages steered from agent_end handlers are still consumed: pi checks
    // its queues once more after these handlers settle and continues the run.
    await inbox.drainInbox(ctx);
  });

  pi.on("before_agent_start", async event => {
    if (!active) return;
    return {
      systemPrompt: event.systemPrompt + "\n\n" + threadModelPrompt(store),
    };
  });
}
