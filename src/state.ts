import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawn } from "node:child_process";
import type { ThreadStore, ThreadState, ThreadSummary, StateFile } from "./core/types";
import { HEARTBEAT_MS, STALE_MS } from "./core/types";

const JOURNAL_PROMPT = `You are this thread's journal keeper. Based on the conversation above, write a brief status update in exactly this format:

Working on: <the main task in one line>
Done: <what was completed this turn>
Doing: <what is in progress or will continue>
Next: <planned next step>
Blockers: <blockers or "none">

No preamble. No extra text. Just the five lines.`;

export function createThreadStore(pi: ExtensionAPI): ThreadStore {
  let heartbeat: ReturnType<typeof setInterval> | null = null;
  let watcher: fs.FSWatcher | null = null;

  const store: ThreadStore = {
    // --- mutable data ---
    threadId: "",
    threadDir: "",
    threadsRootDir: "",
    parent: null,
    startedAt: "",
    state: "idle",
    status: "running",
    lockEventId: null,
    lockPartner: null,
    subscriptions: [],
    obligations: [],

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
        sessionFile: null,
        state: store.state,
        status: store.status,
        lockEventId: store.lockEventId,
        lockPartner: store.lockPartner,
        subscriptions: store.subscriptions,
        obligations: store.obligations,
        startedAt: store.startedAt,
        lastSeen: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      fs.writeFileSync(
        path.join(store.threadDir, "state.json"),
        JSON.stringify(payload, null, 2),
      );
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
          fs.writeFileSync(
            path.join(store.threadsRootDir, ".migrated"),
            new Date().toISOString(),
          );
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

      store.threadDir = path.join(store.threadsRootDir, store.threadId);
      fs.mkdirSync(path.join(store.threadDir, "inbox", "processed"), { recursive: true });

      // Restore previous state if present.
      const stateFile = path.join(store.threadDir, "state.json");
      if (fs.existsSync(stateFile)) {
        try {
          const s: StateFile = JSON.parse(fs.readFileSync(stateFile, "utf8"));
          store.state = s.state === "done" ? "idle" : s.state;
          store.lockEventId = null; // locks don't survive restarts
          store.lockPartner = null;
          const stale = s.lockEventId;
          store.subscriptions = (s.subscriptions ?? []).filter(sub => sub.eventId !== stale);
          store.obligations = (s.obligations ?? []).filter(ob => ob.requestId !== stale);
          store.parent = store.parent ?? s.parent ?? null;
        } catch (err) {
          console.error("[thread] Failed to restore state.json:", err);
        }
      }

      store.startedAt = new Date().toISOString();
      store.status = "running";
      store.writeFile();
      ctx.ui.setStatus("thread", `[${store.threadId}:${store.state}]`);
    },

    shutdown(reason: string) {
      if (heartbeat) clearInterval(heartbeat);
      if (watcher) watcher.close();
      if (reason === "quit" && store.state !== "done") {
        store.state = "stopped";
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
          "--fork", sessionFile,
          "--session-dir", tmpSes,
          "--model", "deepseek/deepseek-chat",
          "--thinking", "off",
          "--print", JOURNAL_PROMPT,
        ],
        { stdio: ["ignore", "pipe", "ignore"] },
      );
      proc.on("error", () => {
        fs.rmSync(tmpSes, { recursive: true, force: true });
      });
      proc.stdout!.on("data", (d: Buffer) => { out += d.toString(); });
      proc.on("close", () => {
        fs.rmSync(tmpSes, { recursive: true, force: true });
        const entry = out.trim();
        if (!entry) return;
        const ts = new Date().toISOString().slice(0, 16).replace("T", " ");
        fs.appendFileSync(journalPath, `\n<!-- ${ts} -->\n${entry}\n`);
      });
    },

    startHeartbeat() {
      heartbeat = setInterval(() => store.writeFile(), HEARTBEAT_MS);
    },

    stopHeartbeat() {
      if (heartbeat) clearInterval(heartbeat);
    },

    startWatcher(drainInbox, ctx) {
      try {
        watcher = fs.watch(
          path.join(store.threadDir, "inbox"),
          () => drainInbox(ctx),
        );
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
