import type { StateFile, InboxMessage, ThreadSummary, ScheduledWake } from "../core/types";

/**
 * Storage/scheduling backend for pi-threading. Domain-shaped (not a generic
 * fs shim) so it maps cleanly onto both a local filesystem and an RPC-based
 * backend like Restate, whose durable state is per-key get/set on a virtual
 * object rather than a file tree.
 */
export interface StorageAdapter {
  /** One-time setup, called from ThreadStore.init() with the resolved cwd.
   *  For LocalFsAdapter this ensures `.thread/threads` exists and runs the
   *  legacy flat-state migration. No-op for backends with no local root. */
  configure(baseDir: string): Promise<void>;

  loadState(threadId: string): Promise<StateFile | undefined>;
  saveState(threadId: string, state: StateFile): Promise<void>;

  appendJournal(threadId: string, entry: string): Promise<void>;
  readJournal(threadId: string): Promise<string | undefined>;

  listThreads(): Promise<ThreadSummary[]>;
  threadExists(threadId: string): Promise<boolean>;

  /** Deliver a message into the target thread's own durable inbox. */
  enqueueMessage(targetId: string, message: InboxMessage): Promise<void>;
  /** Claim and return all pending messages for this thread (FIFO order),
   *  atomically removing them from the pending set. */
  drainInbox(threadId: string): Promise<InboxMessage[]>;
  /** Live-drain trigger. Not a durability guarantee — cold-start drain via
   *  drainInbox() at session_start is what makes delivery durable. Returns
   *  a disposer. */
  watchInbox(threadId: string, cb: () => void): () => void;

  scheduleWake(threadId: string, wake: ScheduledWake): Promise<void>;
  cancelWake(threadId: string, id: string): Promise<void>;
}
