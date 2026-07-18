import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import * as path from "node:path";
import type { ThreadStore, ThreadState, ThreadSummary, StateFile } from "./core/types";
import { HEARTBEAT_MS, CLIENT_CAPABILITIES } from "./core/types";
import { nowIso } from "./core/time";
import { forkJournalEntry } from "./journal";
import type { ThreadAdapter } from "./adapter/types";
import type { ThreadingState } from "./context";

/** The ThreadStore: this thread's identity and mutable coordination state,
 *  restored from the storage adapter at init, persisted on every change, kept
 *  fresh by the heartbeat, and live-drained by the inbox watcher. */

const KNOWN_STATES: readonly ThreadState[] = [
  "idle",
  "thinking",
  "working",
  "open",
  "on-hold",
  "stopped",
  "done",
];

export function createStore(
  pi: ExtensionAPI,
  adapter: ThreadAdapter,
  _: ThreadingState,
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
    holdReason: null,
    obligations: [],
    owed: [],
    barriers: [],
    owedNudgePending: false,
    owedSilentStreak: 0,
    lastJournalSignature: null,
    lastJournalAt: 0,
    journalDebt: false,

    // --- operations ---

    async transition(next: ThreadState, ctx?: ExtensionContext) {
      store.state = next;
      await store.persist();
      ctx?.ui.setStatus("thread", `[${store.threadId}:${store.state}]`);
    },

    async persist() {
      if (!store.threadId) return; // init() hasn't resolved an identity yet
      const payload: StateFile = {
        id: store.threadId,
        pid: process.pid,
        cwd: process.cwd(),
        parent: store.parent,
        role: store.role,
        sessionFile: store.sessionFile,
        state: store.state,
        status: store.status,
        holdReason: store.holdReason,
        obligations: store.obligations,
        owed: store.owed,
        barriers: store.barriers,
        startedAt: store.startedAt,
        lastSeen: nowIso(),
        updatedAt: nowIso(),
        capabilities: [...CLIENT_CAPABILITIES],
        // Advisory revive recipe (Rev 10 §8.1) — published only when the
        // operator provides one: the extension can't guess a correct launch
        // incantation across machines and process managers.
        ...(process.env.PI_THREAD_WAKE ? { wake: process.env.PI_THREAD_WAKE } : {}),
      };
      await store.adapter.saveState(store.threadId, payload);
    },

    async init(ctx: ExtensionContext) {
      await store.adapter.configure();
      store.threadsRootDir = path.join(ctx.cwd, ".thread", "threads");

      // Identity is flag-only, every launch (§2.3 — no auto-generated ids):
      // lifecycle.ts's opt-in gate already requires --thread-id before this
      // runs, so a missing flag here means the gate and init() have gone
      // out of sync, not a normal runtime path.
      const flagId = pi.getFlag("thread-id");
      if (typeof flagId !== "string" || !flagId) {
        throw new Error("pi-threading requires --thread-id (no auto-generated ids)");
      }
      store.threadId = flagId;

      const flagParent = pi.getFlag("thread-parent");
      store.parent = typeof flagParent === "string" && flagParent ? flagParent : null;
      const flagRole = pi.getFlag("thread-role");
      store.role = typeof flagRole === "string" && flagRole ? flagRole : null;

      store.threadDir = path.join(store.threadsRootDir, store.threadId);

      // Restore previous state if present. Debts and barriers are durable
      // waits — restored unconditionally (§13.2): a reply may arrive while
      // we're down, and the id a reply must echo has to survive the session
      // that received the envelope. No state encodes a wait anymore (§11.2),
      // so the only boot repair is done/stopped → idle; states this revision
      // no longer knows (old files) settle to open.
      const s = await store.adapter.loadState(store.threadId);
      if (s) {
        store.obligations = s.obligations ?? [];
        store.owed = s.owed ?? [];
        store.barriers = s.barriers ?? [];
        store.state =
          s.state === "done" || s.state === "stopped"
            ? "idle"
            : KNOWN_STATES.includes(s.state)
              ? s.state
              : "open";
        store.holdReason = store.state === "on-hold" ? (s.holdReason ?? null) : null;
        store.parent = store.parent ?? s.parent ?? null;
        store.role = store.role ?? s.role ?? null;
      }

      try {
        store.sessionFile = ctx.sessionManager.getSessionFile() ?? null;
      } catch {
        store.sessionFile = null;
      }
      store.startedAt = nowIso();
      store.status = "running";
      await store.persist();
      ctx.ui.setStatus("thread", `[${store.threadId}:${store.state}]`);
    },

    async shutdown(reason: string) {
      store.stopHeartbeat();
      store.stopWatcher();
      if (reason === "quit") {
        // Deliberate resting states survive a clean exit (replies arrive in
        // the durable inbox); only interrupted work reads as "stopped".
        const preserved = new Set(["done", "on-hold"]);
        if (!preserved.has(store.state)) store.state = "stopped";
        store.status = "stopped";
        await store.persist();
      }
    },

    async listThreads(): Promise<ThreadSummary[]> {
      return store.adapter.listThreads();
    },

    async threadExists(threadId: string): Promise<boolean> {
      return store.adapter.threadExists(threadId);
    },

    async readJournal(threadId: string): Promise<string | undefined> {
      // The journal channel is an optional backend extension (§5) —
      // undefined on backends without it.
      return store.adapter.readJournal?.(threadId);
    },

    forkJournal(sessionFile: string) {
      const m = pi.getFlag("thread-journal-model");
      forkJournalEntry(store, sessionFile, typeof m === "string" && m ? m : undefined);
    },

    startHeartbeat(onTick?: () => void | Promise<void>) {
      // session_start can fire more than once in a process lifetime (e.g. a
      // session reload) — dispose the previous interval or it leaks and
      // double-fires every deadline check.
      if (heartbeat) clearInterval(heartbeat);
      heartbeat = setInterval(() => {
        void (async () => {
          await store.persist();
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
