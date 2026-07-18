import type { TurnEndEvent } from "@earendil-works/pi-coding-agent";
import { journalMode, shouldJournal } from "../journal";
import type { ThreadingHookHandler } from "./shared";
import { restingState } from "./shared";

export const turnEnd: ThreadingHookHandler<TurnEndEvent> = async (
  { state, store, inbox, pi },
  _,
  ctx,
) => {
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
  if (state.toolUsedThisTurn) {
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

  if (journalMode(pi) === "turn" && shouldJournal(store, state.toolUsedThisTurn, "turn")) {
    const sf = ctx.sessionManager.getSessionFile();
    if (sf) store.forkJournal(sf);
  }

  // The turn boundary is the documented "Open" moment — pick up anything
  // the watcher couldn't deliver while the injection gate was closed.
  await inbox.drainInbox(ctx);
};
