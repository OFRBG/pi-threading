/**
 * store-local.ts — read thread state from local-fs storage.
 *
 * Layout (matches pi-threading's local-fs adapter):
 *   .thread/threads/<id>/state.json
 *   .thread/threads/<id>/journal.md
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { StateFile, ThreadSummary, ThreadDetail } from "./types";
import { toSummary } from "./types";
import type { ThreadStoreBackend } from "./store-types";

function statePath(base: string, id: string): string {
  return path.join(base, id, "state.json");
}
function journalPath(base: string, id: string): string {
  return path.join(base, id, "journal.md");
}

function readJson<T>(f: string): T | null {
  if (!fs.existsSync(f)) {
    return null;
  }
  try {
    return JSON.parse(fs.readFileSync(f, "utf8")) as T;
  } catch {
    return null;
  }
}

export function createLocalStore(workspace: string): ThreadStoreBackend {
  const base = path.join(workspace, ".thread", "threads");

  // Ensure base dir exists for watching.
  fs.mkdirSync(base, { recursive: true });

  return {
    async getThreads(): Promise<ThreadSummary[]> {
      if (!fs.existsSync(base)) {
        return [];
      }
      const ids = fs
        .readdirSync(base, { withFileTypes: true })
        .filter(d => d.isDirectory())
        .map(d => d.name)
        .sort();
      const out: ThreadSummary[] = [];
      for (const id of ids) {
        const s = readJson<StateFile>(statePath(base, id));
        if (s) {
          out.push(toSummary(s));
        }
      }
      return out;
    },

    async getThread(id: string): Promise<ThreadDetail | null> {
      const s = readJson<StateFile>(statePath(base, id));
      if (!s) {
        return null;
      }
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
      const f = journalPath(base, id);
      if (!fs.existsSync(f)) {
        return null;
      }
      try {
        const content = fs.readFileSync(f, "utf8").trim();
        return content || null;
      } catch {
        return null;
      }
    },

    /** Returns the base directory for fs.watch. */
    watchDir: base,

    async disconnect() {
      // No-op.
    },
  };
}
