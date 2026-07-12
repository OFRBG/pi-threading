import { connect } from "@restatedev/restate-sdk-clients";
import type { StateFile, Envelope, ThreadSummary } from "../core/types";
import { toSummary } from "../core/types";
import type { StorageAdapter, JournalAdapter } from "../adapter/types";
import type { ThreadObjectApi, ThreadRegistryApi } from "./service";

const ThreadObjectRef = { name: "Thread" } as ThreadObjectApi;
const RegistryRef = { name: "ThreadRegistry" } as ThreadRegistryApi;

const POLL_MS = 2000;

/** Client-side adapter — the `pi` process is a Restate *ingress client*, not
 *  a hosted handler. All storage/mailbox operations become RPCs into the
 *  `Thread`/`ThreadRegistry` virtual objects defined in ./service.ts (run
 *  separately via `npm run restate:serve`, registered with a self-hosted
 *  `restate-server`). See README.md "Running with the Restate adapter".
 *
 *  deliverAfter needs no client-side machinery here: the service holds
 *  future envelopes out of drainInbox until due, and its own durable delayed
 *  self-invocation revives a stopped thread when one comes due. */
export function createRestateAdapter(opts: { url?: string }): StorageAdapter & JournalAdapter {
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

    async enqueueMessage(message: Envelope) {
      await thread(message.to).enqueueMessage(message);
    },

    async drainInbox(threadId: string): Promise<Envelope[]> {
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
  };
}
