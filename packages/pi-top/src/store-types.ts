/**
 * Backend type — each storage backend implements this interface.
 * All methods are async since redis/mongo/http backends are network-bound.
 */

import type { ThreadSummary, ThreadDetail } from "./types.js";

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
  /** Optional connection health for network backends (redis/mongo/http) —
   *  the TUI renders this in its header instead of letting raw connection
   *  errors hit the terminal and corrupt the Blessed screen. Backends that
   *  can't fail this way (local-fs) omit it entirely. */
  getStatus?(): { ok: boolean; message: string };
}
