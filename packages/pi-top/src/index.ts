/**
 * index.ts — Bootstrap: parse args, wire up backend + watcher → TUI.
 *
 * This is the glue between the data layer (multi-backend store + watcher)
 * and the TUI layer (Blessed app).
 *
 * Architecture:
 *   Backend (async)  →  Cache (sync)  →  TUI
 *        ↑ watcher fires on change → refreshes cache → TUI re-renders
 */

import type { ThreadSummary, ThreadDetail } from "./types.js";
import { createStore, type StoreOptions } from "./store.js";
import type { ThreadStoreBackend } from "./store-types.js";
import { createWatcher } from "./watcher.js";
import { createApp } from "./tui/app.js";
import type { DataProvider } from "./tui/app.js";

export type { ThreadStoreBackend } from "./store-types.js";
export type { StoreOptions } from "./store.js";

export async function run(options: StoreOptions): Promise<void> {
  // 1. Create the storage backend.
  const backend: ThreadStoreBackend = await createStore(options);

  try {
    // 2. Build a synchronous cache over the async backend.
    //    The watcher fires → we async-refresh → TUI re-renders with cached data.
    let cachedThreads: ThreadSummary[] = [];
    const detailCache = new Map<string, ThreadDetail | null>();
    const journalCache = new Map<string, string | null>();

    async function refreshAll() {
      try {
        cachedThreads = await backend.getThreads();

        // Eagerly populate detail cache for all known threads.
        // This ensures the detail panel shows obligations, journal, etc.
        // on first render, not just after a re-fetch.
        for (const t of cachedThreads) {
          const d = await backend.getThread(t.id);
          if (d) {
            try {
              const journal = await backend.getJournal(t.id);
              if (journal) {
                d.journal = journal;
              }
            } catch {
              /* journal fetch is optional */
            }
            detailCache.set(t.id, d);
          }
        }

        // Prune stale entries from caches
        const liveIds = new Set(cachedThreads.map(t => t.id));
        for (const id of detailCache.keys()) {
          if (!liveIds.has(id)) {
            detailCache.delete(id);
          }
        }
        for (const id of journalCache.keys()) {
          if (!liveIds.has(id)) {
            journalCache.delete(id);
          }
        }
      } catch {
        // Deliberately not console.error'd: once the TUI is up, this runs
        // on every poll tick (every 2s — see watcher.ts), and anything
        // written straight to the terminal while Blessed owns it corrupts
        // the screen. backend.getStatus() (surfaced in the header, below)
        // is the visible signal for network backends; local-fs has no
        // analogous failure mode to report.
      }
    }

    // 3. The data provider the TUI consumes — synchronous reads from the cache.
    const provider: DataProvider = {
      getThreads() {
        return cachedThreads;
      },
      getThread(id: string) {
        return detailCache.get(id) ?? null;
      },
      getJournal(id: string) {
        return journalCache.get(id) ?? null;
      },
      getStatus() {
        return backend.getStatus?.() ?? null;
      },
      onUpdate(cb: () => void) {
        watcher.onUpdate(cb);
      },
    };

    // 4. Wire up the watcher — fires on backend changes, refreshes caches.
    const watcher = createWatcher();
    watcher.onUpdate(async () => {
      await refreshAll();
    });

    // 5. Initial load.
    await refreshAll();
    watcher.start(backend);

    // 6. Start the TUI — blocks until the user quits.
    await new Promise<void>(resolve => {
      const exit = () => {
        watcher.stop();
        resolve();
      };

      try {
        const app = createApp(provider, exit);
        app.start();
      } catch (err) {
        console.error("[pi-top] failed to start TUI:", err);
        exit();
      }
    });
  } finally {
    await backend.disconnect?.();
  }
}
