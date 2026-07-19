import * as fs from "node:fs";
import * as path from "node:path";
import type { StateFile, Mail, ThreadSummary } from "../core/types";
import { PROCESSED_TTL_MS, toSummary } from "../core/types";
import { ulid } from "../core/ids";
import type { StorageAdapter, JournalAdapter, PiFlagParam, AdapterOptions } from "./types";

function pruneProcessed(dir: string) {
  let files: string[];
  try {
    files = fs.readdirSync(dir);
  } catch {
    return;
  }
  const cutoff = Date.now() - PROCESSED_TTL_MS;
  for (const f of files) {
    try {
      if (fs.statSync(path.join(dir, f)).mtimeMs < cutoff) {
        fs.rmSync(path.join(dir, f), { force: true });
      }
    } catch {
      // ignore — GC is best-effort
    }
  }
}

function mailFileName(id: string): string {
  const tail = id.includes("/") ? id.slice(id.lastIndexOf("/") + 1) : id;
  const safe = tail.replace(/[^A-Za-z0-9._-]/g, "_");
  return `${safe || ulid()}.json`;
}

const PRUNE_INTERVAL_MS = 60 * 60 * 1000;

export const options = {
  'base-dir': {
    type: "string",
    description:
      "(Storage: local) Base directory for local fs storage. Default: current working directory.",
    default: ".",
  },
} satisfies Record<string, PiFlagParam>;

export function createAdapter({"base-dir": baseDir}: AdapterOptions<typeof options>): StorageAdapter & JournalAdapter {
  let root = "";
  const lastPruned = new Map<string, number>();

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
  function stagingDir(id: string): string {
    return path.join(threadDir(id), "inbox.tmp");
  }

  return {
    async configure() {
      root = path.join(baseDir, ".thread", "threads");
      fs.mkdirSync(root, { recursive: true });
    },

    async loadState(threadId: string): Promise<StateFile | undefined> {
      const f = statePath(threadId);
      if (!fs.existsSync(f)) return undefined;
      try {
        return JSON.parse(fs.readFileSync(f, "utf8")) as StateFile;
      } catch (err) {
        console.error("[thread] failed to read state.json:", err);
        return undefined;
      }
    },

    async saveState(threadId: string, state: StateFile) {
      fs.mkdirSync(threadDir(threadId), { recursive: true });
      // Write-temp + rename: presence readers (§8.1) never see a torn file.
      const tmp = statePath(threadId) + ".tmp";
      fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
      fs.renameSync(tmp, statePath(threadId));
    },

    async appendJournal(threadId: string, entry: string) {
      fs.mkdirSync(threadDir(threadId), { recursive: true });
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

    async sendMail(mail: Mail) {
      const dir = inboxDir(mail.to);
      const staging = stagingDir(mail.to);
      fs.mkdirSync(dir, { recursive: true });
      fs.mkdirSync(staging, { recursive: true });
      // Filename = the id's ULID tail: unique per sender by construction,
      // and a retry with the same id overwrites its own file — enqueue
      // idempotence (§7.6) for free.
      const fname = mailFileName(mail.id);
      const tmp = path.join(staging, fname);
      fs.writeFileSync(tmp, JSON.stringify(mail, null, 2));
      fs.renameSync(tmp, path.join(dir, fname));
    },

    async receiveMail(threadId: string): Promise<Mail[]> {
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
      // Best-effort GC of the expired backlog, at most once per
      // PRUNE_INTERVAL_MS per thread, done *before* anything from this
      // drain is moved in.
      const last = lastPruned.get(threadId) ?? 0;
      if (Date.now() - last >= PRUNE_INTERVAL_MS) {
        lastPruned.set(threadId, Date.now());
        pruneProcessed(processedDir);
      }
      const now = Date.now();
      const claimed: Mail[] = [];
      for (const f of files) {
        const full = path.join(dir, f);
        let msg: Mail;
        try {
          msg = JSON.parse(fs.readFileSync(full, "utf8"));
        } catch {
          continue; // malformed — left in place, retried every drain, never dropped
        }
        // Not due yet (§6 deliverAfter): stays queued; a later drain
        // (heartbeat, boot) picks it up once the instant passes.
        if (msg.deliverAfter && new Date(msg.deliverAfter).getTime() > now) continue;
        // Expired (Rev 10 §6 expiresAt): never delivered — claimed into
        // processed/ as audit trail without being returned.
        if (msg.expiresAt && new Date(msg.expiresAt).getTime() <= now) {
          try {
            fs.renameSync(full, path.join(processedDir, f));
          } catch {
            // claim race — theirs now
          }
          continue;
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

    watchMail(threadId: string, cb: () => void): () => void {
      try {
        // A thread that has never received a message has no inbox/ dir yet —
        // fs.watch throws ENOENT on a path that doesn't exist, so create it
        // first rather than leaving this thread with a silently no-op watch
        // (the returned disposer) until its next process restart.
        fs.mkdirSync(inboxDir(threadId), { recursive: true });
        const watcher = fs.watch(inboxDir(threadId), cb);
        return () => watcher.close();
      } catch (err) {
        console.error("[thread] failed to watch inbox:", err);
        return () => {};
      }
    },
  };
}
