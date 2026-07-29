/**
 * store-mongo.ts — read thread state from MongoDB storage.
 *
 * Collections (matches pi-threading's mongo adapter):
 *   states    — one doc per thread (_id = threadId)
 *   journal   — one doc per thread (_id = threadId, content: string)
 */

import type { StateFile, ThreadSummary, ThreadDetail } from "./types";
import { toSummary } from "./types";
import type { ThreadStoreBackend } from "./store-types";

interface StateDoc extends StateFile {
  _id: string;
}

interface JournalDoc {
  _id: string;
  content: string;
}

export async function createMongoStore(
  connectionString: string,
  database: string,
): Promise<ThreadStoreBackend> {
  const { MongoClient } = await import("mongodb");
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
