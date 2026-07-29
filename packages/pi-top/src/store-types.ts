/**
 * Backend type — each storage backend implements this interface.
 * All methods are async since redis/mongo/http backends are network-bound.
 */

import type { ThreadSummary, ThreadDetail } from "./types";

export interface ThreadStoreBackend {
  getThreads(): Promise<ThreadSummary[]>;
  getThread(id: string): Promise<ThreadDetail | null>;
  getJournal(id: string): Promise<string | null>;
  /** For local-fs: the base directory to watch. null for network backends. */
  watchDir: string | null;
  /** Extensible: backends can attach extra context for watchers. */
  [key: string]: unknown;
  /** Optional cleanup — close connections, release resources. */
  disconnect?(): Promise<void>;
}
