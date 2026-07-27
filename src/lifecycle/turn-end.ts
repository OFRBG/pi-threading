import type { ExtensionAPI, TurnEndEvent } from "@earendil-works/pi-coding-agent";
import { journalMode, shouldJournal } from "../journal";
import type { ThreadingHookHandler } from "./shared";
import { restingState } from "./shared";
import type { ThreadStore } from "../core/types";
import type { ThreadingState } from "../context";

const getReminderPrompt = (store: ThreadStore) => {
  const items = store.owed.map(o => `${o.from} (re #${o.id})`).join(", ");

  const escalation =
    store.owedSilentStreak >= 2
      ? ` This is turn ${store.owedSilentStreak} with no reply — restating it as plain text is invisible to them.`
      : "";

  return `
[thread-system]
Plain text reaches only the human: never other agents. Reply to other agents via thread_send with the re id.${escalation}

Automated reminder: you still owe a reply to ${items}.
- Still working on it? Acknowledge and reply.
- Missing information from the requester? Pass the ball: reply with what you need and expects=true.
[/thread-system]`.trim();
};

/**
 * Check if debt reminders need to be sent to the agent
 */
function handleDebtReminder(state: ThreadingState, store: ThreadStore, pi: ExtensionAPI) {
  // A tool-using turn means the thread is actively working, not silently
  // sitting on the debt — reset the streak and re-arm the gate, and stay
  // quiet this turn. Falling through here would immediately re-increment and
  // nudge, defeating the reset.
  if (state.toolUsedThisTurn) {
    store.owedSilentStreak = 0;
    store.owedNudgePending = false;
    return;
  }

  if (!store.owed.length) {
    return;
  }

  store.owedSilentStreak = Math.min(store.owedSilentStreak + 1, 3);

  if (store.owedNudgePending) {
    return;
  }

  store.owedNudgePending = true;

  pi.sendMessage(
    {
      customType: "thread-owed-reminder",
      content: getReminderPrompt(store),
      display: true,
    },
    {
      triggerTurn: false,
      deliverAs: "nextTurn",
    },
  );
}

export const turnEnd: ThreadingHookHandler<TurnEndEvent> = async (
  { state, store, inbox, pi },
  _,
  ctx,
) => {
  await store.transition(restingState(store, "open"), ctx);

  handleDebtReminder(state, store, pi);

  if (journalMode(pi) === "turn" && shouldJournal(store, state.toolUsedThisTurn, "turn")) {
    const sf = ctx.sessionManager.getSessionFile();
    if (sf) {
      store.forkJournal(sf);
    }
  }

  // The turn boundary is the documented "Open" moment — pick up anything
  // the watcher couldn't deliver while the injection gate was closed.
  await inbox.drain(ctx);
};
