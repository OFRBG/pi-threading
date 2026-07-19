import type { CommandDefinition } from "./shared";

export const threadStatus: CommandDefinition = {
  name: "thread-status",
  description: "Show this thread's own state and latest journal entry",
  async handler({ store }, _, ctx) {
    await ctx.waitForIdle();

    const journal = await store.readJournal(store.threadId);

    const lines = journal ? journal.split("\n").slice(-12).join("\n") : "(no journal yet)";

    ctx.ui.notify(
      `Id: ${store.threadId} | State: ${store.state} | Status: ${store.status} | Obligations: ${store.obligations.length} | Owed: ${store.owed.length} | Barriers: ${store.barriers.length}\n\n${lines}`,
      "info",
    );
  },
};
