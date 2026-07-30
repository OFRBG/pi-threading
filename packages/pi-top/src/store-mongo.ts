/**
 * store-mongo.ts — read thread state from MongoDB storage.
 *
 * Collections (matches pi-threading's mongo adapter):
 *   states    — one doc per thread (_id = threadId)
 *   journal   — one doc per thread (_id = threadId, content: string)
 */

import { createRequire } from "node:module";
import type { MongoClient as MongoClientType } from "mongodb";
import type { StateFile, ThreadSummary, ThreadDetail } from "./types.js";
import { toSummary } from "./types.js";
import type { ThreadStoreBackend } from "./store-types.js";

interface StateDoc extends StateFile {
  _id: string;
}

interface JournalDoc {
  _id: string;
  content: string;
}

/** See store-redis.ts's `requireOptionalDep` — same reasoning (require()
 *  over a dynamic import() to avoid Bun's ESM-interop recursion), same
 *  optional-dependency framing, duplicated rather than shared since each
 *  call site's message differs and there are only two of them. */
function requireOptionalDep<T>(pkg: string): T {
  try {
    return createRequire(import.meta.url)(pkg) as T;
  } catch (e) {
    throw new Error(
      `Could not load "${pkg}" (needed for --storage mongo). ` +
        `It's an optional dependency of pi-top — install it directly: "npm install ${pkg}" ` +
        `(or "bun add ${pkg}") wherever pi-top itself is installed. ` +
        `Original error: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
}

export async function createMongoStore(
  connectionString: string,
  database: string,
): Promise<ThreadStoreBackend> {
  const { MongoClient } = requireOptionalDep<{ MongoClient: typeof MongoClientType }>("mongodb");
  const client = new MongoClient(connectionString);
  await client.connect();
  const db = client.db(database);
  const states = db.collection<StateDoc>("states");
  const journals = db.collection<JournalDoc>("journal");

  return {
    async getThreads(): Promise<ThreadSummary[]> {
      const docs = await states.find({}).toArray();
      return docs.map(({ _id: _omit, ...state }) => toSummary(state));
    },

    async getThread(id: string): Promise<ThreadDetail | null> {
      const doc = await states.findOne({ _id: id });
      if (!doc) {
        return null;
      }
      const { _id: _omit, ...rest } = doc;
      const state = rest as unknown as StateFile;
      return {
        summary: toSummary(state),
        pid: state.pid,
        cwd: state.cwd,
        holdReason: state.holdReason,
        obligations: state.obligations ?? [],
        owed: state.owed ?? [],
        barriers: state.barriers ?? [],
        startedAt: state.startedAt,
      };
    },

    async getJournal(id: string): Promise<string | null> {
      const doc = await journals.findOne({ _id: id });
      const content = doc?.content?.trim();
      return content || null;
    },

    watchDir: null,
    mongoClient: client,

    async disconnect() {
      await client.close();
    },
  };
}
