import { connect, rpc } from "@restatedev/restate-sdk-clients";
import type { StateFile, InboxMessage, ThreadSummary, ScheduledWake } from "../core/types";
import { toSummary } from "../core/types";
import type { StorageAdapter } from "../adapter/types";
import type { ThreadObjectApi, ThreadRegistryApi } from "./service";

const ThreadObjectRef = { name: "Thread" } as ThreadObjectApi;
const RegistryRef = { name: "ThreadRegistry" } as ThreadRegistryApi;

const POLL_MS = 2000;

/** Client-side adapter — the `pi` process is a Restate *ingress client*, not
 *  a hosted handler. All storage/mailbox operations become RPCs into the
 *  `Thread`/`ThreadRegistry` virtual objects defined in ./service.ts (run
 *  separately via `npm run restate:serve`, registered with a self-hosted
 *  `restate-server`). See README.md "Running with the Restate adapter". */
export function createRestateAdapter(opts: { url?: string }): StorageAdapter {
  const ingress = connect({ url: opts.url ?? "http://localhost:8080" });
  const thread = (id: string) => ingress.objectClient(ThreadObjectRef, id);

  return {
    async configure() {
      // No local root — each thread is addressed by id against the ingress
      // URL, not a cwd-scoped directory.
    },

    async loadState(threadId: string): Promise<StateFile | undefined> {
      return (await thread(threadId).loadState()) ?? undefined;
    },

    async saveState(threadId: string, state: StateFile) {
      await thread(threadId).saveState(state);
    },

    async appendJournal(threadId: string, entry: string) {
      await thread(threadId).appendJournal(entry);
    },

    async readJournal(threadId: string): Promise<string | undefined> {
      return (await thread(threadId).readJournal()) ?? undefined;
    },

    async listThreads(): Promise<ThreadSummary[]> {
      const ids = await ingress.objectClient(RegistryRef, "all").list();
      const out: ThreadSummary[] = [];
      for (const id of ids) {
        const s = await thread(id).loadState();
        if (s) out.push(toSummary(s));
      }
      return out;
    },

    async threadExists(threadId: string): Promise<boolean> {
      return (await thread(threadId).loadState()) != null;
    },

    async enqueueMessage(targetId: string, message: InboxMessage) {
      await thread(targetId).enqueueMessage(message);
    },

    async drainInbox(threadId: string): Promise<InboxMessage[]> {
      return thread(threadId).drainInbox();
    },

    watchInbox(_threadId: string, cb: () => void): () => void {
      // No push-based watch across a network boundary — poll instead. Worse
      // live-latency than local fs.watch, same durability guarantee (the
      // cold-start drain at session_start is what actually guarantees
      // delivery, same as the local backend).
      const timer = setInterval(cb, POLL_MS);
      return () => clearInterval(timer);
    },

    async scheduleWake(threadId: string, wake: ScheduledWake) {
      // Persist first — mirrors LocalFsAdapter.scheduleWake's read-modify-
      // write, so thread_status sees it immediately regardless of backend —
      // then arm the durable delayed invocation that actually fires it.
      const s = await thread(threadId).loadState();
      if (s) {
        s.schedules = [...s.schedules, wake];
        await thread(threadId).saveState(s);
      }
      const delayMs = Math.max(0, new Date(wake.fireAt).getTime() - Date.now());
      await ingress
        .objectSendClient(ThreadObjectRef, threadId)
        .fireWake(wake, rpc.sendOpts({ delay: delayMs }));
    },

    async cancelWake(threadId: string, id: string) {
      // Restate's client API can't cancel an already-armed delayed send —
      // fireWake() re-checks the persisted schedules list at fire time and
      // no-ops if it's gone, so removing it from state here is sufficient.
      const s = await thread(threadId).loadState();
      if (!s) return;
      s.schedules = s.schedules.filter(w => w.id !== id);
      await thread(threadId).saveState(s);
    },
  };
}
