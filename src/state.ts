import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawn } from "node:child_process";
import type { ThreadStore, ThreadState, ThreadSummary, StateFile } from "./core/types";
import { HEARTBEAT_MS } from "./core/types";
import type { StorageAdapter } from "./adapter/types";
import { createLocalFsAdapter } from "./adapter/local-fs";

const JOURNAL_PROMPT = `You are this thread's journal keeper. Based on the conversation above, write a brief status update in exactly this format:

Working on: <the main task in one line>
Done: <what was completed this turn>
Doing: <what is in progress or will continue>
Next: <planned next step>
Blockers: <blockers or "none">

No preamble. No extra text. Just the five lines.`;

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

/** Pure comparison against the last entry in an existing journal's content
 *  (or `undefined` when no journal exists yet). */
export function isDuplicateOfLastEntry(journalContent: string | undefined, entry: string): boolean {
  const content = journalContent?.trim();
  if (!content) return false;
  const entries = content.split(/\n(?=<!--)/).filter(Boolean);
  const last = entries[entries.length - 1];
  if (!last) return false;
  return journalFingerprint(last) === journalFingerprint(entry);
}

export function createThreadStore(
  pi: ExtensionAPI,
  adapter: StorageAdapter = createLocalFsAdapter(),
): ThreadStore {
  let heartbeat: ReturnType<typeof setInterval> | null = null;
  let stopWatching: (() => void) | null = null;

  const store: ThreadStore = {
    // --- mutable data ---
    adapter,
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
    owed: [],
    barriers: [],
    schedules: [],
    sentToPartnerThisTurn: false,
    nudgedSinceLastSend: false,
    lastJournalSignature: null,
    lastJournalAt: 0,
    journalDebt: false,

    // --- operations ---

    async transition(next: ThreadState, ctx?: ExtensionContext) {
      store.state = next;
      await store.writeFile();
      ctx?.ui.setStatus("thread", `[${store.threadId}:${store.state}]`);
    },

    async writeFile() {
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
        owed: store.owed,
        barriers: store.barriers,
        schedules: store.schedules,
        startedAt: store.startedAt,
        lastSeen: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      await store.adapter.saveState(store.threadId, payload);
    },

    async init(cwd: string, ctx: ExtensionContext) {
      await store.adapter.configure(cwd);
      store.threadsRootDir = path.join(cwd, ".thread", "threads");

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

      // Restore previous state if present.
      const s = await store.adapter.loadState(store.threadId);
      if (s) {
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
        // Owed replies are debts to *other* threads, not tied to our own lock
        // — restored unconditionally, same precedent as barriers. This is the
        // whole point of recording them: the requestId a Result/Answer must
        // echo has to survive the session that received the envelope.
        store.owed = s.owed ?? [];
        // Scheduled wakes are thread-local, not tied to any lock — restored
        // unconditionally, same precedent as barriers.
        store.schedules = s.schedules ?? [];
        store.state =
          s.state === "done" || s.state === "stopped"
            ? "idle"
            : s.state === "in-sync" || (s.state === "listening" && !keepLock)
              ? "open"
              : s.state;
        store.holdReason = store.state === "on-hold" ? (s.holdReason ?? null) : null;
        store.parent = store.parent ?? s.parent ?? null;
        store.role = store.role ?? s.role ?? null;
      }

      try {
        store.sessionFile = ctx.sessionManager.getSessionFile() ?? null;
      } catch {
        store.sessionFile = null;
      }
      store.startedAt = new Date().toISOString();
      store.status = "running";
      await store.writeFile();
      ctx.ui.setStatus("thread", `[${store.threadId}:${store.state}]`);
    },

    async shutdown(reason: string) {
      store.stopHeartbeat();
      store.stopWatcher();
      if (reason === "quit") {
        // Deliberate waiting states survive a clean exit (the reply arrives in
        // the durable inbox); only interrupted work reads as "stopped".
        const preserved = new Set(["done", "listening", "on-hold"]);
        if (!preserved.has(store.state)) store.state = "stopped";
        store.status = "stopped";
        await store.writeFile();
      }
    },

    async listThreads(): Promise<ThreadSummary[]> {
      return store.adapter.listThreads();
    },

    async threadExists(threadId: string): Promise<boolean> {
      return store.adapter.threadExists(threadId);
    },

    async readJournal(threadId: string): Promise<string | undefined> {
      return store.adapter.readJournal(threadId);
    },

    forkJournal(sessionFile: string) {
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
        void (async () => {
          fs.rmSync(tmpSes, { recursive: true, force: true });
          const entry = out.trim();
          if (!entry) return;
          const existing = await store.adapter.readJournal(store.threadId);
          if (isDuplicateOfLastEntry(existing, entry)) return;
          const ts = new Date().toISOString().slice(0, 16).replace("T", " ");
          await store.adapter.appendJournal(store.threadId, `\n<!-- ${ts} -->\n${entry}\n`);
        })();
      });
    },

    startHeartbeat(onTick?: () => void | Promise<void>) {
      // session_start can fire more than once in a process lifetime (e.g. a
      // session reload) — dispose the previous interval or it leaks and
      // double-fires every deadline/schedule check.
      if (heartbeat) clearInterval(heartbeat);
      heartbeat = setInterval(() => {
        void (async () => {
          await store.writeFile();
          await onTick?.();
        })().catch(err => console.error("[thread] heartbeat tick failed:", err));
      }, HEARTBEAT_MS);
    },

    stopHeartbeat() {
      if (heartbeat) clearInterval(heartbeat);
      heartbeat = null;
    },

    startWatcher(drainInbox, ctx) {
      stopWatching?.();
      stopWatching = store.adapter.watchInbox(store.threadId, () => drainInbox(ctx));
    },

    stopWatcher() {
      if (stopWatching) stopWatching();
      stopWatching = null;
    },
  };

  return store;
}
