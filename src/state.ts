import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawn } from "node:child_process";
import type { ThreadStore, ThreadState, ThreadSummary, StateFile } from "./core/types";
import { HEARTBEAT_MS, STALE_MS, PROCESSED_TTL_MS } from "./core/types";

const JOURNAL_PROMPT = `You are this thread's journal keeper. Based on the conversation above, write a brief status update in exactly this format:

Working on: <the main task in one line>
Done: <what was completed this turn>
Doing: <what is in progress or will continue>
Next: <planned next step>
Blockers: <blockers or "none">

No preamble. No extra text. Just the five lines.`;

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

/** "Working on"/"Done" carry the actual news; "Doing"/"Next"/"Blockers" are
 *  restated every idle turn even when nothing happened, so they're excluded
 *  from the comparison — otherwise a re-forked entry with fresh phrasing of
 *  the same wait would never match and noise would keep accumulating. */
export function journalFingerprint(entry: string): string {
  return entry
    .split("\n")
    .filter(l => /^(Working on|Done):/i.test(l.trim()))
    .join("\n")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

export function isDuplicateOfLastEntry(journalPath: string, entry: string): boolean {
  if (!fs.existsSync(journalPath)) return false;
  let content: string;
  try {
    content = fs.readFileSync(journalPath, "utf8").trim();
  } catch {
    return false;
  }
  if (!content) return false;
  const entries = content.split(/\n(?=<!--)/).filter(Boolean);
  const last = entries[entries.length - 1];
  if (!last) return false;
  return journalFingerprint(last) === journalFingerprint(entry);
}

export function createThreadStore(pi: ExtensionAPI): ThreadStore {
  let heartbeat: ReturnType<typeof setInterval> | null = null;
  let watcher: fs.FSWatcher | null = null;

  const store: ThreadStore = {
    // --- mutable data ---
    threadId: "",
    threadDir: "",
    threadsRootDir: "",
    parent: null,
    role: null,
    sessionFile: null,
    startedAt: "",
    state: "idle",
    status: "running",
    lockEventId: null,
    lockPartner: null,
    lockType: null,
    holdReason: null,
    subscriptions: [],
    obligations: [],
    barriers: [],
    sentToPartnerThisTurn: false,
    nudgedSinceLastSend: false,
    lastJournalSignature: null,

    // --- operations ---

    transition(next: ThreadState, ctx?: ExtensionContext) {
      store.state = next;
      store.writeFile();
      ctx?.ui.setStatus("thread", `[${store.threadId}:${store.state}]`);
    },

    writeFile() {
      if (!store.threadDir) return;
      const payload: StateFile = {
        id: store.threadId,
        pid: process.pid,
        cwd: process.cwd(),
        parent: store.parent,
        role: store.role,
        sessionFile: store.sessionFile,
        state: store.state,
        status: store.status,
        lockEventId: store.lockEventId,
        lockPartner: store.lockPartner,
        lockType: store.lockType,
        holdReason: store.holdReason,
        subscriptions: store.subscriptions,
        obligations: store.obligations,
        barriers: store.barriers,
        startedAt: store.startedAt,
        lastSeen: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      fs.writeFileSync(path.join(store.threadDir, "state.json"), JSON.stringify(payload, null, 2));
    },

    init(cwd: string, ctx: ExtensionContext) {
      const baseDir = path.join(cwd, ".thread");
      store.threadsRootDir = path.join(baseDir, "threads");
      fs.mkdirSync(store.threadsRootDir, { recursive: true });

      // Migrate flat .thread/state.json → .thread/threads/<id>/state.json.
      const oldStateFile = path.join(baseDir, "state.json");
      if (
        fs.existsSync(oldStateFile) &&
        !fs.existsSync(store.threadsRootDir + path.sep + ".migrated")
      ) {
        try {
          const old = JSON.parse(fs.readFileSync(oldStateFile, "utf8"));
          const migratedDir = path.join(store.threadsRootDir, "thread-legacy");
          fs.mkdirSync(migratedDir, { recursive: true });
          if (!fs.existsSync(path.join(migratedDir, "state.json"))) {
            fs.writeFileSync(path.join(migratedDir, "state.json"), JSON.stringify(old, null, 2));
          }
          const oldJournal = path.join(baseDir, "journal.md");
          if (fs.existsSync(oldJournal) && !fs.existsSync(path.join(migratedDir, "journal.md"))) {
            fs.copyFileSync(oldJournal, path.join(migratedDir, "journal.md"));
          }
          fs.writeFileSync(path.join(store.threadsRootDir, ".migrated"), new Date().toISOString());
        } catch (err) {
          console.error("[thread] Failed to migrate legacy state.json:", err);
        }
      }

      // Resolve thread identity.
      const flagId = pi.getFlag("thread-id");
      if (typeof flagId === "string" && flagId) {
        store.threadId = flagId;
      } else {
        let existingId: string | undefined;
        try {
          const entries = ctx.sessionManager.getEntries();
          for (const e of entries) {
            if (e.type === "custom" && e.customType === "thread-identity") {
              const entry = e as { data?: { id?: string } };
              if (entry.data?.id) existingId = entry.data.id;
            }
          }
        } catch {
          // --no-session or unreadable session — generate a new id.
        }
        store.threadId = existingId ?? `thread-${crypto.randomUUID().slice(0, 8)}`;
        if (!existingId) pi.appendEntry("thread-identity", { id: store.threadId });
      }

      const flagParent = pi.getFlag("thread-parent");
      store.parent = typeof flagParent === "string" && flagParent ? flagParent : null;
      const flagRole = pi.getFlag("thread-role");
      store.role = typeof flagRole === "string" && flagRole ? flagRole : null;

      store.threadDir = path.join(store.threadsRootDir, store.threadId);
      fs.mkdirSync(path.join(store.threadDir, "inbox", "processed"), { recursive: true });
      pruneProcessed(path.join(store.threadDir, "inbox", "processed"));

      // Restore previous state if present.
      const stateFile = path.join(store.threadDir, "state.json");
      if (fs.existsSync(stateFile)) {
        try {
          const s: StateFile = JSON.parse(fs.readFileSync(stateFile, "utf8"));
          // Reply locks (Question/Blocker) are durable waits — the Answer may
          // arrive while we're down, so they survive restarts. Sync locks are
          // live conversations and don't (legacy files without lockType too).
          const keepLock = Boolean(s.lockEventId) && s.lockType === "reply";
          store.lockEventId = keepLock ? s.lockEventId : null;
          store.lockPartner = keepLock ? (s.lockPartner ?? null) : null;
          store.lockType = keepLock ? "reply" : null;
          const stale = keepLock ? null : s.lockEventId;
          store.subscriptions = (s.subscriptions ?? []).filter(sub => sub.eventId !== stale);
          store.obligations = (s.obligations ?? []).filter(ob => ob.requestId !== stale);
          store.barriers = s.barriers ?? [];
          store.state =
            s.state === "done" || s.state === "stopped"
              ? "idle"
              : s.state === "in-sync" || (s.state === "listening" && !keepLock)
                ? "open"
                : s.state;
          store.holdReason = store.state === "on-hold" ? (s.holdReason ?? null) : null;
          store.parent = store.parent ?? s.parent ?? null;
          store.role = store.role ?? s.role ?? null;
        } catch (err) {
          console.error("[thread] Failed to restore state.json:", err);
        }
      }

      try {
        store.sessionFile = ctx.sessionManager.getSessionFile() ?? null;
      } catch {
        store.sessionFile = null;
      }
      store.startedAt = new Date().toISOString();
      store.status = "running";
      store.writeFile();
      ctx.ui.setStatus("thread", `[${store.threadId}:${store.state}]`);
    },

    shutdown(reason: string) {
      if (heartbeat) clearInterval(heartbeat);
      if (watcher) watcher.close();
      if (reason === "quit") {
        // Deliberate waiting states survive a clean exit (the reply arrives in
        // the durable inbox); only interrupted work reads as "stopped".
        const preserved = new Set(["done", "listening", "on-hold"]);
        if (!preserved.has(store.state)) store.state = "stopped";
        store.status = "stopped";
        store.writeFile();
      }
    },

    listThreads(): ThreadSummary[] {
      if (!fs.existsSync(store.threadsRootDir)) return [];
      const ids = fs
        .readdirSync(store.threadsRootDir, { withFileTypes: true })
        .filter(d => d.isDirectory())
        .map(d => d.name);
      const out: ThreadSummary[] = [];
      for (const id of ids) {
        const f = path.join(store.threadsRootDir, id, "state.json");
        if (!fs.existsSync(f)) continue;
        try {
          const s: StateFile = JSON.parse(fs.readFileSync(f, "utf8"));
          const stale = Date.now() - new Date(s.lastSeen).getTime() > STALE_MS;
          out.push({
            id: s.id,
            state: s.state,
            status: stale ? "stopped" : s.status,
            parent: s.parent,
            role: s.role ?? null,
            lastSeen: s.lastSeen,
          });
        } catch {
          // corrupt/partial — skip.
        }
      }
      return out;
    },

    forkJournal(sessionFile: string) {
      const journalPath = path.join(store.threadDir, "journal.md");
      const tmpSes = fs.mkdtempSync(path.join(os.tmpdir(), "pi-journal-"));
      let out = "";
      const proc = spawn(
        "pi",
        [
          "--fork",
          sessionFile,
          "--session-dir",
          tmpSes,
          "--model",
          "deepseek/deepseek-chat",
          "--thinking",
          "off",
          "--print",
          JOURNAL_PROMPT,
        ],
        { stdio: ["ignore", "pipe", "ignore"] },
      );
      proc.on("error", () => {
        fs.rmSync(tmpSes, { recursive: true, force: true });
      });
      proc.stdout!.on("data", (d: Buffer) => {
        out += d.toString();
      });
      proc.on("close", () => {
        fs.rmSync(tmpSes, { recursive: true, force: true });
        const entry = out.trim();
        if (!entry || isDuplicateOfLastEntry(journalPath, entry)) return;
        const ts = new Date().toISOString().slice(0, 16).replace("T", " ");
        fs.appendFileSync(journalPath, `\n<!-- ${ts} -->\n${entry}\n`);
      });
    },

    startHeartbeat(onTick?: () => void) {
      heartbeat = setInterval(() => {
        store.writeFile();
        onTick?.();
      }, HEARTBEAT_MS);
    },

    stopHeartbeat() {
      if (heartbeat) clearInterval(heartbeat);
    },

    startWatcher(drainInbox, ctx) {
      try {
        watcher = fs.watch(path.join(store.threadDir, "inbox"), () => drainInbox(ctx));
      } catch (err) {
        console.error("[thread] Failed to watch inbox:", err);
      }
    },

    stopWatcher() {
      if (watcher) watcher.close();
    },
  };

  return store;
}
