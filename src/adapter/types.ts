import type { StateFile, Envelope, ThreadSummary } from "../core/types";

/**
 * Storage backend for pi-threading (PROTOCOL-FORMALISM.md §5). Domain-shaped
 * (not a generic fs shim) so it maps cleanly onto both a local filesystem and
 * an RPC-based backend like Restate, whose durable state is per-key get/set
 * on a virtual object rather than a file tree.
 *
 * Pure storage: there is no wake/timer member. A future self-wake is a
 * self-addressed envelope with `deliverAfter`, held by the store until due.
 */
export interface StorageAdapter {
  /** One-time setup, called from ThreadStore.init() with the resolved cwd.
   *  For LocalFsAdapter this ensures `.thread/threads` exists. No-op for
   *  backends with no local root. */
  configure(baseDir: string): Promise<void>;

  loadState(threadId: string): Promise<StateFile | undefined>;
  saveState(threadId: string, state: StateFile): Promise<void>;

  listThreads(): Promise<ThreadSummary[]>;
  threadExists(threadId: string): Promise<boolean>;

  /** Deliver a message into the mailbox `message.to` names. The envelope is
   *  self-contained (§6) — there is no separate target parameter. MUST be
   *  durable before it returns; MUST NOT make the envelope drainable before
   *  its `deliverAfter` (if present) has passed. */
  enqueueMessage(message: Envelope): Promise<void>;
  /** Claim and return all *due* pending messages for this thread (FIFO
   *  order), atomically removing them from the pending set. Envelopes whose
   *  `deliverAfter` is still in the future stay queued. */
  drainInbox(threadId: string): Promise<Envelope[]>;
  /** Live-drain trigger. Not a durability guarantee — cold-start drain via
   *  drainInbox() at session_start is what makes delivery durable. Returns
   *  a disposer. */
  watchInbox(threadId: string, cb: () => void): () => void;
}

/** Optional extension (§5): the journal channel. Not part of the message
 *  world proper — a union over it (§8.3). Backends that omit it simply have
 *  no journal channel, and readers degrade gracefully. */
export interface JournalAdapter {
  appendJournal(threadId: string, entry: string): Promise<void>;
  readJournal(threadId: string): Promise<string | undefined>;
}

/** What the client stack actually holds: core storage plus whatever
 *  extensions the backend implements. */
export type ThreadAdapter = StorageAdapter & Partial<JournalAdapter>;
