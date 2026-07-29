/**
 * store-http.ts — read thread state from a remote HTTP thread-store service.
 *
 * Endpoints (matches pi-threading's http adapter):
 *   GET  /threads                  → ThreadSummary[]
 *   GET  /threads/:id/state        → StateFile
 *   GET  /threads/:id/journal      → { content: string }
 */

import type { StateFile, ThreadSummary, ThreadDetail } from "./types";
import { toSummary } from "./types";
import type { ThreadStoreBackend } from "./store-types";

const enc = (id: string) => encodeURIComponent(id);

export function createHttpStore(baseUrl: string): ThreadStoreBackend {
  const url = baseUrl.replace(/\/+$/, "");

  return {
    async getThreads(): Promise<ThreadSummary[]> {
      const res = await fetch(`${url}/threads`);
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}`);
      }
      return (await res.json()) as ThreadSummary[];
    },

    async getThread(id: string): Promise<ThreadDetail | null> {
      const res = await fetch(`${url}/threads/${enc(id)}/state`);
      if (res.status === 404) {
        return null;
      }
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}`);
      }
      const s = (await res.json()) as StateFile;
      return {
        summary: toSummary(s),
        pid: s.pid,
        cwd: s.cwd,
        holdReason: s.holdReason,
        obligations: s.obligations ?? [],
        owed: s.owed ?? [],
        barriers: s.barriers ?? [],
        startedAt: s.startedAt,
      };
    },

    async getJournal(id: string): Promise<string | null> {
      const res = await fetch(`${url}/threads/${enc(id)}/journal`);
      if (res.status === 404) {
        return null;
      }
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}`);
      }
      const { content } = (await res.json()) as { content: string };
      return content || null;
    },

    watchDir: null,

    async disconnect() {
      // HTTP store has no persistent connections.
    },
  };
}
