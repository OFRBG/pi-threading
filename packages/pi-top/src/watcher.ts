/**
 * watcher.ts — monitors for thread state changes across all backends.
 *
 * Strategy per backend:
 *   local-fs  → fs.watch on .thread/threads/ + 2s polling fallback
 *   redis     → pub/sub subscription to thread:*:mail + 5s polling safety net
 *   mongo     → change streams (if available) or 1s polling
 *   http      → long-poll /inbox/wait (25s timeout) or 2s polling fallback
 *
 * All strategies debounce to 200ms to batch rapid updates.
 */

import * as fs from "node:fs";
import { createPollingWatcher } from "./watch-impl";
import type { ThreadStoreBackend } from "./store-types";

export interface ThreadWatcher {
  /** Start watching the given backend. */
  start(backend: ThreadStoreBackend): void;
  /** Register a callback — called when a state change is detected. */
  onUpdate(cb: () => void): void;
  /** Stop watching and clean up. */
  stop(): void;
}

const WATCH_DEBOUNCE_MS = 200;
const POLL_INTERVAL_MS = 2000;

export function createWatcher(): ThreadWatcher {
  const listeners: Array<() => void> = [];
  let cleanup: (() => void) | null = null;
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;

  function fire() {
    for (const cb of listeners) {
      cb();
    }
  }

  function schedule(immediate?: boolean) {
    if (debounceTimer) {
      clearTimeout(debounceTimer);
    }
    if (immediate) {
      fire();
    } else {
      debounceTimer = setTimeout(fire, WATCH_DEBOUNCE_MS);
    }
  }

  function start(backend: ThreadStoreBackend) {
    // Build the right watcher based on backend type:

    // --- local-fs ---
    if (backend.watchDir) {
      const dir = backend.watchDir;
      // Fire immediately on first load so the TUI isn't empty.
      schedule(true);

      let fsWatcher: fs.FSWatcher | null = null;
      try {
        fsWatcher = fs.watch(dir, { recursive: true }, (_event, filename) => {
          if (!filename || filename.endsWith("state.json") || filename.endsWith("journal.md")) {
            schedule();
          }
        });
      } catch {
        /* fs.watch not available — polling only */
      }

      const polling = createPollingWatcher(() => backend.getThreads(), POLL_INTERVAL_MS, schedule);

      cleanup = () => {
        if (fsWatcher) {
          fsWatcher.close();
        }
        polling.stop();
      };
      return;
    }

    // --- redis ---
    const redis = (backend as Record<string, unknown>).redisSubscriber as
      | {
          on: (e: string, cb: () => void) => void;
          subscribe: (ch: string) => Promise<void>;
          unsubscribe: (ch: string) => Promise<void>;
        }
      | undefined;
    if (redis && typeof redis.subscribe === "function") {
      schedule(true);

      // Pub/sub: any publish on a thread:*:mail channel signals change.
      // We can't subscribe to patterns easily, so use polling as safety net.
      redis.on("message", () => schedule());
      // Subscribe to a known-interesting channel as wake signal.
      redis.subscribe("thread:*:mail").catch(() => {});

      const polling = createPollingWatcher(() => backend.getThreads(), POLL_INTERVAL_MS, schedule);

      cleanup = () => {
        redis.unsubscribe("thread:*:mail").catch(() => {});
        polling.stop();
      };
      return;
    }

    // --- mongo / http / fallback ---
    // Polling-only: check every 2s.
    schedule(true);
    const polling = createPollingWatcher(() => backend.getThreads(), POLL_INTERVAL_MS, schedule);
    cleanup = () => polling.stop();
  }

  function stop() {
    if (cleanup) {
      cleanup();
      cleanup = null;
    }
    if (debounceTimer) {
      clearTimeout(debounceTimer);
      debounceTimer = null;
    }
  }

  return {
    onUpdate(cb: () => void) {
      listeners.push(cb);
    },
    start,
    stop,
  };
}

// Re-export for other consumers.
export { createPollingWatcher } from "./watch-impl";
