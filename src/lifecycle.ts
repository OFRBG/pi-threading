import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { ThreadStore, ThreadState } from "./core/types";
import type { Inbox } from "./inbox";
import { threadModelPrompt } from "./core/system-prompt";

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
      await store.writeFile();
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

function journalMode(pi: ExtensionAPI): "turn" | "done" | "off" {
  const v = pi.getFlag("thread-journal");
  return v === "done" || v === "off" ? v : "turn";
}

/** Fingerprint of everything a journal entry could newly report. Unchanged
 *  since the last journal write + no tool call this turn means the turn was
 *  a pure "still waiting" restatement — not worth a forked LLM call. */
export function journalSignature(store: ThreadStore): string {
  return [
    store.state,
    store.lockEventId ?? "",
    store.obligations
      .map(o => o.requestId)
      .sort()
      .join(","),
    store.barriers
      .map(b => b.id)
      .sort()
      .join(","),
  ].join("|");
}

/** Minimum spacing between per-turn journal forks. Structural changes (new
 *  obligation, lock, barrier — the things teammates key off) still journal
 *  immediately; this only rate-limits the "another tool turn on the same
 *  task" entries that used to land once per turn, ~17 near-duplicates per
 *  work session. */
export const JOURNAL_MIN_INTERVAL_MS = 120_000;

/** Decide whether this moment deserves a forked journal entry.
 *
 *  - "turn"    — turn_end in per-turn mode: journal on structural change, or
 *                on tool-using turns at most every JOURNAL_MIN_INTERVAL_MS;
 *                a rate-limited turn records a debt instead.
 *  - "run-end" — agent_end in per-turn mode: journal only if a debt is
 *                outstanding, so the run's final state is always captured
 *                exactly once (the state flip to done/open on agent_end
 *                itself is not news — the last turn already covered it).
 *  - "done"    — agent_end in journal-mode "done": one entry per run when
 *                anything happened.
 */
export function shouldJournal(
  store: ThreadStore,
  toolUsedThisTurn: boolean,
  phase: "turn" | "run-end" | "done" = "turn",
): boolean {
  const sig = journalSignature(store);
  const changed = sig !== store.lastJournalSignature;
  let write: boolean;
  if (phase === "run-end") {
    write = store.journalDebt;
  } else if (phase === "done") {
    write = changed || toolUsedThisTurn;
  } else {
    if (!changed && !toolUsedThisTurn) return false;
    write = changed || Date.now() - store.lastJournalAt >= JOURNAL_MIN_INTERVAL_MS;
    if (!write) store.journalDebt = true;
  }
  if (write) {
    store.lastJournalSignature = sig;
    store.lastJournalAt = Date.now();
    store.journalDebt = false;
  }
  return write;
}
