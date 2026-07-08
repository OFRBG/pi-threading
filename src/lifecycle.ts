import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { ThreadStore, ThreadState } from "./core/types";
import type { Inbox } from "./inbox";
import { threadModelPrompt } from "./core/system-prompt";
import { journalMode, shouldJournal } from "./journal";

/** Wiring into pi's event stream: state transitions across the turn cycle,
 *  the sync-channel confusion nudge, journal cadence triggers, and the
 *  thread-model system prompt. */

/** Where a thread settles between turns: waiting states and On Hold must
 *  survive the turn boundary instead of being stomped to open/done. */
function restingState(store: ThreadStore, whenUnlocked: ThreadState): ThreadState {
  if (store.state === "on-hold") return "on-hold";
  if (store.lockEventId) return store.lockType === "sync" ? "in-sync" : "listening";
  return whenUnlocked;
}

export function registerLifecycle(pi: ExtensionAPI, store: ThreadStore, inbox: Inbox) {
  let toolUsedThisTurn = false;

  pi.on("session_start", async (_event, ctx) => {
    await store.init(ctx.cwd, ctx);

    // Defer initial drain to next tick — calling pi.sendUserMessage
    // synchronously from session_start deadlocks turn scheduling.
    setImmediate(() => void inbox.drainInbox(ctx));
    store.startWatcher(inbox.drainInbox, ctx);
    store.startHeartbeat(async () => {
      await inbox.checkDeadlines();
      await inbox.checkSchedules();
    });
  });

  pi.on("session_shutdown", async event => {
    await store.shutdown(event.reason);
  });

  pi.on("turn_start", async (_event, ctx) => {
    const wasOnHold = store.state === "on-hold";
    store.sentToPartnerThisTurn = false;
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
    toolUsedThisTurn = true;
    await store.transition("working", ctx);
  });

  pi.on("turn_end", async (_event, ctx) => {
    await store.transition(restingState(store, "open"), ctx);

    // Channel-confusion guard: a pure-text turn while In Sync is the classic
    // failure — the model "talks" to its partner but only the user sees it.
    // Inject a passive reminder (no turn trigger — a forced turn here goads
    // the model into acting, e.g. closing the sync just to have something to
    // do). It surfaces at the next natural turn; once per silence.
    if (
      store.lockType === "sync" &&
      store.lockPartner &&
      !toolUsedThisTurn &&
      !store.sentToPartnerThisTurn &&
      !store.nudgedSinceLastSend
    ) {
      store.nudgedSinceLastSend = true;
      pi.sendMessage(
        {
          customType: "thread-sync-reminder",
          content: `[thread-system] Automated reminder (not from the human): your last plain-text message reached only the human user — not your sync partner ${store.lockPartner}. If it was meant for them, resend it via thread_send to="${store.lockPartner}" type="Note". If you were just waiting for them, no action is needed.`,
          display: true,
        },
        { triggerTurn: false, deliverAs: "nextTurn" },
      );
    }

    if (journalMode(pi) === "turn" && shouldJournal(store, toolUsedThisTurn, "turn")) {
      const sf = ctx.sessionManager.getSessionFile();
      if (sf) store.forkJournal(sf);
    }
  });

  pi.on("agent_end", async (_event, ctx) => {
    await store.transition(restingState(store, "done"), ctx);
    const mode = journalMode(pi);
    const write =
      mode === "done"
        ? shouldJournal(store, toolUsedThisTurn, "done")
        : mode === "turn" && shouldJournal(store, toolUsedThisTurn, "run-end");
    if (write) {
      const sf = ctx.sessionManager.getSessionFile();
      if (sf) store.forkJournal(sf);
    }
  });

  pi.on("before_agent_start", async event => {
    return {
      systemPrompt: event.systemPrompt + "\n\n" + threadModelPrompt(store),
    };
  });
}
