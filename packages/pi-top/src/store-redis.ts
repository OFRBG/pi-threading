/**
 * store-redis.ts — read thread state from Redis storage.
 *
 * Key layout (matches pi-threading's redis adapter):
 *   thread:index               Set<threadId>
 *   thread:<id>:state          String (JSON StateFile)
 *   thread:<id>:journal        String (append-only)
 *
 * Uses TWO connections:
 *   client     — commands (SMEMBERS, GET) — never subscribes
 *   subscriber — pub/sub only (SUBSCRIBE to thread:*:mail) — never commands
 *
 * This mirrors pi-threading's own adapter: a subscribed connection cannot
 * issue regular commands, so the wake signal needs its own channel.
 */

import { createRequire } from "node:module";
import type { Redis as RedisClient } from "ioredis";
import type { StateFile, ThreadSummary, ThreadDetail } from "./types.js";
import { toSummary } from "./types.js";
import type { ThreadStoreBackend } from "./store-types.js";

function keyState(id: string): string {
  return `thread:${id}:state`;
}
function keyJournal(id: string): string {
  return `thread:${id}:journal`;
}

export async function createRedisStore(connectionString: string): Promise<ThreadStoreBackend> {
  // require(), not a dynamic import() — ioredis is a CJS `export =` package,
  // and importing it via `import()` forces an ESM-interop namespace wrapper
  // whose `.default` getter is known to recurse infinitely under Bun
  // ("Maximum call stack size exceeded"). require() returns the raw CJS
  // export directly, bypassing that wrapper (see pi-threading's
  // src/adapter/redis.ts for the same fix against the same crash).
  const Redis = createRequire(import.meta.url)("ioredis") as typeof RedisClient;

  // Connection health, surfaced via getStatus() instead of raw console
  // writes: once Blessed owns the terminal, anything written straight to
  // stdout/stderr corrupts its screen buffer, and ioredis's automatic
  // reconnect loop fires a fresh 'error' event on every failed attempt
  // (roughly every 2s by default) for as long as Redis stays unreachable —
  // with no listener at all, ioredis falls back to its own noisy
  // "Unhandled error event" console logging on *every* attempt. Track the
  // latest state instead and let the TUI render it once, in its header.
  // Attached before the first connect() below — an error there needs a
  // listener already in place, not one added after the fact.
  let status = { ok: true, message: "connecting" };
  const onError = (label: string) => (err: Error) => {
    // Connection-refused surfaces as an AggregateError with an empty
    // top-level .message (the real detail is in .errors[]) — fall back
    // through .errors, then .code, before giving up on a real detail.
    const detail =
      err.message ||
      (err as { errors?: Error[] }).errors?.[0]?.message ||
      (err as { code?: string }).code ||
      String(err);
    status = { ok: false, message: `${label}: ${detail}` };
  };
  const onReady = () => {
    status = { ok: true, message: "connected" };
  };

  // Command client — handles all state queries. Never subscribes. Not
  // awaited: with a listener attached, ioredis retries a lazy connect
  // indefinitely in the background rather than rejecting once, so awaiting
  // it here would hang createRedisStore (and the whole app's startup) for
  // as long as Redis stays unreachable. getStatus() reflects the outcome
  // instead — the app starts immediately, showing "connecting"/error state
  // until (if ever) it succeeds. maxRetriesPerRequest bounds each command's
  // own retries so a poll tick fails fast rather than hanging.
  const client = new Redis(connectionString, { lazyConnect: true, maxRetriesPerRequest: 1 });
  client.on("error", onError("redis"));
  client.on("ready", onReady);
  client.connect().catch(() => {});

  // Subscriber client — dedicated pub/sub connection. Never used for commands.
  const subscriber = client.duplicate();
  subscriber.on("error", onError("redis subscriber"));
  subscriber.on("ready", onReady);
  // Fire-and-forget — its "error"/"ready" handlers above already track
  // status; this catch exists only so a failed connect doesn't also
  // surface as an unhandled promise rejection.
  subscriber.connect().catch(() => {});

  return {
    async getThreads(): Promise<ThreadSummary[]> {
      const ids = await client.smembers("thread:index");
      const out: ThreadSummary[] = [];
      for (const id of ids) {
        const raw = await client.get(keyState(id));
        if (!raw) {
          continue;
        }
        try {
          const s: StateFile = JSON.parse(raw);
          out.push(toSummary(s));
        } catch {
          /* skip corrupt */
        }
      }
      return out;
    },

    async getThread(id: string): Promise<ThreadDetail | null> {
      const raw = await client.get(keyState(id));
      if (!raw) {
        return null;
      }
      try {
        const s: StateFile = JSON.parse(raw);
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
      } catch {
        return null;
      }
    },

    async getJournal(id: string): Promise<string | null> {
      const raw = await client.get(keyJournal(id));
      if (!raw) {
        return null;
      }
      const content = raw.trim();
      return content || null;
    },

    watchDir: null,

    /** The subscriber connection — for pub/sub wake signals only. */
    redisSubscriber: subscriber,

    getStatus() {
      return status;
    },

    async disconnect() {
      await Promise.allSettled([client.quit(), subscriber.quit()]);
    },
  };
}
