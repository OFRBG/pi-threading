import type { AgentEndEvent } from "@earendil-works/pi-coding-agent";
import { journalMode, shouldJournal } from "../journal";
import type { ThreadingHookHandler } from "./shared";
import { restingState } from "./shared";

export const agentEnd: ThreadingHookHandler<AgentEndEvent> = async (
  { state, store, inbox, pi },
  _,
  ctx,
) => {
  await store.transition(restingState(store, "done"), ctx);
  // Re-arm the owed-reply nudge gate: each new run gets one fresh chance to
  // remind, while owedSilentStreak (untouched here) keeps climbing across
  // consecutive silent runs — that's what makes the streak>=2 escalation
  // in turn_end's guard reachable at all.
  store.owedNudgePending = false;
  const mode = journalMode(pi);

  const write =
    mode === "done"
      ? shouldJournal(store, state.toolUsedThisTurn, "done")
      : mode === "turn" && shouldJournal(store, state.toolUsedThisTurn, "run-end");

  if (write) {
    const sf = ctx.sessionManager.getSessionFile();

    if (sf) {
      store.forkJournal(sf);
    }
  }

  // Messages steered from agent_end handlers are still consumed: pi checks
  // its queues once more after these handlers settle and continues the run.
  await inbox.drain(ctx);
};
