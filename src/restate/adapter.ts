import { connect, rpc } from "@restatedev/restate-sdk-clients";
import type { StateFile, InboxMessage, ThreadSummary, ScheduledWake } from "../core/types";
import { STALE_MS } from "../core/types";
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

  return {
    async configure() {
      // No local root — each thread is addressed by id against the ingress
      // URL, not a cwd-scoped directory.
    },

    async loadState(threadId: string): Promise<StateFile | undefined> {
      const s = await ingress.objectClient(ThreadObjectRef, threadId).loadState();
      return s ?? undefined;
    },

    async saveState(threadId: string, state: StateFile) {
      await ingress.objectClient(ThreadObjectRef, threadId).saveState(state);
    },

    async appendJournal(threadId: string, entry: string) {
      await ingress.objectClient(ThreadObjectRef, threadId).appendJournal(entry);
    },

    async readJournal(threadId: string): Promise<string | undefined> {
      const j = await ingress.objectClient(ThreadObjectRef, threadId).readJournal();
      return j ?? undefined;
    },

    async listThreads(): Promise<ThreadSummary[]> {
      const ids = await ingress.objectClient(RegistryRef, "all").list();
      const out: ThreadSummary[] = [];
      for (const id of ids) {
        const s = await ingress.objectClient(ThreadObjectRef, id).loadState();
        if (!s) continue;
        const stale = Date.now() - new Date(s.lastSeen).getTime() > STALE_MS;
        out.push({
          id: s.id,
          state: s.state,
          status: stale ? "stopped" : s.status,
          parent: s.parent,
          role: s.role ?? null,
          lastSeen: s.lastSeen,
        });
      }
      return out;
    },

    async threadExists(threadId: string): Promise<boolean> {
      const s = await ingress.objectClient(ThreadObjectRef, threadId).loadState();
      return s != null;
    },

    async enqueueMessage(targetId: string, message: InboxMessage) {
      await ingress.objectClient(ThreadObjectRef, targetId).enqueueMessage(message);
    },

    async drainInbox(threadId: string): Promise<InboxMessage[]> {
      return ingress.objectClient(ThreadObjectRef, threadId).drainInbox();
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
      const s = await ingress.objectClient(ThreadObjectRef, threadId).loadState();
      if (s) {
        s.schedules = [...s.schedules, wake];
        await ingress.objectClient(ThreadObjectRef, threadId).saveState(s);
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
      const s = await ingress.objectClient(ThreadObjectRef, threadId).loadState();
      if (!s) return;
      s.schedules = s.schedules.filter(w => w.id !== id);
      await ingress.objectClient(ThreadObjectRef, threadId).saveState(s);
    },
  };
}
