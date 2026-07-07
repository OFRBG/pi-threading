import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import type { StateFile, InboxMessage, ThreadSummary, ScheduledWake } from "../core/types";
import { PROCESSED_TTL_MS, toSummary } from "../core/types";
import type { StorageAdapter } from "./types";

/** Keep processed/ from growing forever — messages are audit trail, not archive. */
function pruneProcessed(dir: string) {
  let files: string[];
  try {
    files = fs.readdirSync(dir);
  } catch {
    return;
  }
  const cutoff = Date.now() - PROCESSED_TTL_MS;
  for (const f of files) {
    // Filenames start with the epoch-millis send time; fall back to mtime.
    const ts = Number(f.split("-")[0]);
    try {
      const age = Number.isFinite(ts) && ts > 0 ? ts : fs.statSync(path.join(dir, f)).mtimeMs;
      if (age < cutoff) fs.rmSync(path.join(dir, f), { force: true });
    } catch {
      // ignore — GC is best-effort
    }
  }
}

/** 1:1 async wrapper around the original raw node:fs implementation — same
 *  atomic write-temp-then-rename delivery, same processed/ GC, same
 *  "malformed inbox JSON is left in place, never silently dropped" behavior.
 *  No internal awaits: every method runs its fs calls synchronously before
 *  returning, so this backend never introduces cross-message-tick surprises
 *  beyond the microtask hop `await` itself always incurs. */
export function createLocalFsAdapter(): StorageAdapter {
  let root = "";
  const pruned = new Set<string>();

  function threadDir(id: string): string {
    return path.join(root, id);
  }
  function statePath(id: string): string {
    return path.join(threadDir(id), "state.json");
  }
  function journalPath(id: string): string {
    return path.join(threadDir(id), "journal.md");
  }
  function inboxDir(id: string): string {
    return path.join(threadDir(id), "inbox");
  }

  return {
    async configure(baseDir: string) {
      const base = path.join(baseDir, ".thread");
      root = path.join(base, "threads");
      fs.mkdirSync(root, { recursive: true });

      // Migrate flat .thread/state.json → .thread/threads/<id>/state.json.
      const oldStateFile = path.join(base, "state.json");
      if (fs.existsSync(oldStateFile) && !fs.existsSync(path.join(root, ".migrated"))) {
        try {
          const old = JSON.parse(fs.readFileSync(oldStateFile, "utf8"));
          const migratedDir = path.join(root, "thread-legacy");
          fs.mkdirSync(migratedDir, { recursive: true });
          if (!fs.existsSync(path.join(migratedDir, "state.json"))) {
            fs.writeFileSync(path.join(migratedDir, "state.json"), JSON.stringify(old, null, 2));
          }
          const oldJournal = path.join(base, "journal.md");
          if (fs.existsSync(oldJournal) && !fs.existsSync(path.join(migratedDir, "journal.md"))) {
            fs.copyFileSync(oldJournal, path.join(migratedDir, "journal.md"));
          }
          fs.writeFileSync(path.join(root, ".migrated"), new Date().toISOString());
        } catch (err) {
          console.error("[thread] Failed to migrate legacy state.json:", err);
        }
      }
    },

    async loadState(threadId: string): Promise<StateFile | undefined> {
      const f = statePath(threadId);
      if (!fs.existsSync(f)) return undefined;
      try {
        return JSON.parse(fs.readFileSync(f, "utf8")) as StateFile;
      } catch (err) {
        console.error("[thread] Failed to read state.json:", err);
        return undefined;
      }
    },

    async saveState(threadId: string, state: StateFile) {
      fs.mkdirSync(threadDir(threadId), { recursive: true });
      fs.writeFileSync(statePath(threadId), JSON.stringify(state, null, 2));
    },

    async appendJournal(threadId: string, entry: string) {
      fs.appendFileSync(journalPath(threadId), entry);
    },

    async readJournal(threadId: string): Promise<string | undefined> {
      const f = journalPath(threadId);
      if (!fs.existsSync(f)) return undefined;
      const content = fs.readFileSync(f, "utf8").trim();
      return content || undefined;
    },

    async listThreads(): Promise<ThreadSummary[]> {
      if (!fs.existsSync(root)) return [];
      const ids = fs
        .readdirSync(root, { withFileTypes: true })
        .filter(d => d.isDirectory())
        .map(d => d.name);
      const out: ThreadSummary[] = [];
      for (const id of ids) {
        const f = statePath(id);
        if (!fs.existsSync(f)) continue;
        try {
          const s: StateFile = JSON.parse(fs.readFileSync(f, "utf8"));
          out.push(toSummary(s));
        } catch {
          // corrupt/partial — skip.
        }
      }
      return out;
    },

    async threadExists(threadId: string): Promise<boolean> {
      return fs.existsSync(statePath(threadId));
    },

    async enqueueMessage(targetId: string, message: InboxMessage) {
      const dir = inboxDir(targetId);
      fs.mkdirSync(dir, { recursive: true });
      const fname = `${Date.now()}-${crypto.randomUUID()}.json`;
      const tmp = path.join(dir, `.tmp-${fname}`);
      const final = path.join(dir, fname);
      fs.writeFileSync(tmp, JSON.stringify(message, null, 2));
      fs.renameSync(tmp, final);
    },

    async drainInbox(threadId: string): Promise<InboxMessage[]> {
      const dir = inboxDir(threadId);
      const processedDir = path.join(dir, "processed");
      let files: string[];
      try {
        files = fs
          .readdirSync(dir)
          .filter(f => f.endsWith(".json"))
          .sort();
      } catch {
        return [];
      }
      fs.mkdirSync(processedDir, { recursive: true });
      // Best-effort GC of the pre-existing backlog, once per thread per
      // process lifetime, done *before* anything from this drain is moved
      // in — pruneProcessed's filename-prefix age heuristic must never see
      // a message this same call is about to deliver (it would misjudge a
      // small hand-authored filename as an ancient epoch timestamp and
      // delete a message that was never actually processed before now).
      if (!pruned.has(threadId)) {
        pruned.add(threadId);
        pruneProcessed(processedDir);
      }
      const claimed: InboxMessage[] = [];
      for (const f of files) {
        const full = path.join(dir, f);
        let msg: InboxMessage;
        try {
          msg = JSON.parse(fs.readFileSync(full, "utf8"));
        } catch {
          continue; // malformed — left in place, retried every drain, never dropped
        }
        // Rename before returning it as claimed: if the caller throws after
        // this, the message is already moved and won't be redelivered.
        try {
          fs.renameSync(full, path.join(processedDir, f));
        } catch {
          continue; // already claimed — shouldn't happen (single reader)
        }
        claimed.push(msg);
      }
      return claimed;
    },

    watchInbox(threadId: string, cb: () => void): () => void {
      try {
        // A thread that has never received a message has no inbox/ dir yet —
        // fs.watch throws ENOENT on a path that doesn't exist, so create it
        // first rather than leaving this thread with a silently no-op watch
        // (the returned disposer) until its next process restart.
        fs.mkdirSync(inboxDir(threadId), { recursive: true });
        const watcher = fs.watch(inboxDir(threadId), cb);
        return () => watcher.close();
      } catch (err) {
        console.error("[thread] Failed to watch inbox:", err);
        return () => {};
      }
    },

    async scheduleWake(threadId: string, wake: ScheduledWake) {
      const s = await this.loadState(threadId);
      if (!s) return;
      s.schedules = [...(s.schedules ?? []), wake];
      await this.saveState(threadId, s);
    },

    async cancelWake(threadId: string, id: string) {
      const s = await this.loadState(threadId);
      if (!s) return;
      s.schedules = (s.schedules ?? []).filter(w => w.id !== id);
      await this.saveState(threadId, s);
    },
  };
}
