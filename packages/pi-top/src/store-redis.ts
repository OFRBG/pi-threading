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

import type { StateFile, ThreadSummary, ThreadDetail } from "./types";
import { toSummary } from "./types";
import type { ThreadStoreBackend } from "./store-types";

function keyState(id: string): string {
  return `thread:${id}:state`;
}
function keyJournal(id: string): string {
  return `thread:${id}:journal`;
}

export async function createRedisStore(connectionString: string): Promise<ThreadStoreBackend> {
  const { default: Redis } = await import("ioredis");

  // Command client — handles all state queries. Never subscribes.
  const client = new Redis(connectionString, { lazyConnect: true });
  await client.connect();

  // Subscriber client — dedicated pub/sub connection. Never used for commands.
  const subscriber = client.duplicate();
  // Fire-and-forget connect (subscribe happens in watcher).
  subscriber.connect().catch(err => {
    console.error("[pi-top] redis subscriber connect failed:", err.message);
  });

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

    async disconnect() {
      await Promise.allSettled([client.quit(), subscriber.quit()]);
    },
  };
}
