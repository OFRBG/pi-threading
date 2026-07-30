import type { MongoClient, Collection, Db } from "mongodb";
import type { StateFile, Mail, ThreadSummary } from "../core/types";
import { PROCESSED_TTL_MS, toSummary } from "../core/types";
import type { StorageAdapter, JournalAdapter, PiFlagParam, AdapterOptions } from "./types";
import { isMailDue, isMailExpired, mailIdTail, requireDep } from "./shared";

// The MongoDB binding — same StorageAdapter/JournalAdapter contract as the
// Appendix B local-fs binding (`./local-fs.ts`), but addressed per-document
// instead of per-file so a fleet of `pi` processes can coordinate over the
// network (multi-host, multi-OS) instead of a shared disk. Every invariant
// below is chosen to reproduce local-fs's *observable* behavior, not its
// file layout — see THREAD-MODEL.md and PROTOCOL-FORMALISM.md §6-§10.

/** Mail as stored: the full envelope id (`<from>/<ulid>`) becomes `_id` so a
 *  retried send upserts the same document (idempotence), plus a separate
 *  `tail` field carrying just the ULID — FIFO ordering sorts on `tail`, not
 *  `_id`, so delivery order is by send time *across* senders rather than
 *  grouped by sender prefix (§6.2, same key local-fs's sorted-`readdir`
 *  uses). Two claim-tracking fields round it out; none have a wire
 *  representation, none leave this adapter. */
interface MailDoc extends Omit<Mail, "id"> {
  _id: string;
  /** The `_id`'s ULID tail (`mailIdTail`) — the FIFO sort key (see above). */
  tail: string;
  /** Flipped atomically by `findOneAndUpdate` at claim time — this is the
   *  "rename into processed/" of the Mongo binding: once true, no reader
   *  will ever see this document as a candidate again (deliver-once). */
  delivered: boolean;
  /** Set the instant `delivered` flips. Backs the TTL index that replicates
   *  local-fs's `pruneProcessed()` — Mongo expires the document server-side
   *  once `processedAt` is older than `PROCESSED_TTL_MS`, so there is no
   *  per-thread GC bookkeeping to replicate (§Appendix B "processed/ GC"). */
  processedAt?: Date;
}

/** State as stored: `id` (already present on `StateFile`) becomes `_id` too
 *  — redundant but harmless, and it means a `find({})` over this collection
 *  alone is enough for `listThreads()`, with no secondary index to keep in
 *  sync. */
type StateDoc = StateFile & { _id: string };

interface JournalDoc {
  _id: string;
  /** One append-only string per thread — the Mongo analogue of
   *  `journal.md`. Appended via an aggregation-pipeline update (`$concat`),
   *  which is a single atomic document write: no read-modify-write race
   *  between two appenders (there normally is only one, the journal fork,
   *  but the update is atomic regardless). */
  content: string;
}

function mailDocToMail(doc: MailDoc): Mail {
  const { _id, tail: _tail, delivered: _delivered, processedAt: _processedAt, ...rest } = doc;
  return { id: _id, ...rest } as Mail;
}

/** How often the polling fallback re-checks the mail collection when change
 *  streams aren't available (standalone `mongod`, no replica set/mongos).
 *  Short enough to feel "live" without hammering the server — the heartbeat
 *  (20s, `HEARTBEAT_MS`) is the backstop that guarantees eventual delivery
 *  even if this never fires. */
const POLL_INTERVAL_MS = 1000;

export const options = {
  "connection-string": {
    type: "string",
    description:
      "(Storage: mongo) Connection string for MongoDB storage. Default: mongodb://localhost:27017.",
    default: "mongodb://localhost:27017",
  },
  database: {
    type: "string",
    description: '(Storage: mongo) Database name for thread storage. Default: "pi-threading".',
    default: "pi-threading",
  },
} satisfies Record<string, PiFlagParam>;

export function createAdapter({
  "connection-string": connectionString,
  database,
}: AdapterOptions<typeof options>): StorageAdapter & JournalAdapter & { close(): Promise<void> } {
  let client: MongoClient;
  let db: Db;
  let mail: Collection<MailDoc>;
  let states: Collection<StateDoc>;
  let journals: Collection<JournalDoc>;
  // Detected once at configure() time (§"Live push" — change streams
  // require the server to be a replica set or mongos; a standalone
  // `mongod` — including every `mongodb-memory-server` instance used by
  // this project's own unit tests — throws on `.watch()`, so `watchMail`
  // needs to know in advance rather than discover it via a thrown error
  // on every call).
  let supportsChangeStreams = false;

  return {
    async configure() {
      // Loaded here rather than at module top-level: `mongodb` is only
      // actually needed when `--thread-storage mongo` is selected, and
      // eagerly loading it (this module is imported unconditionally by
      // registry.ts to read `options` for flag registration) crashes
      // under Bun — its dependency graph triggers "Maximum call stack
      // size exceeded" in Bun's module resolver even when the module is
      // never used. `requireDep` (`./shared.ts`) rather than a dynamic
      // `import()` for the same reason as redis.ts.
      const { MongoClient: MongoClientCtor } = requireDep<{ MongoClient: typeof MongoClient }>(
        "mongodb",
        import.meta.url,
      );
      client = new MongoClientCtor(connectionString);
      await client.connect();
      db = client.db(database);
      mail = db.collection<MailDoc>("mail");
      states = db.collection<StateDoc>("states");
      journals = db.collection<JournalDoc>("journal");

      // Query shape is always "undelivered mail for this recipient, FIFO
      // by tail" — a compound index makes that an index-only scan.
      await mail.createIndex({ to: 1, delivered: 1, tail: 1 });
      // TTL index — the Mongo analogue of local-fs's `pruneProcessed()`
      // (7-day retention, `PROCESSED_TTL_MS`). `partialFilterExpression`
      // keeps it scoped to claimed documents only, mirroring
      // `pruneProcessed()` only ever touching `inbox/processed/`, never
      // the live `inbox/` backlog.
      await mail.createIndex(
        { processedAt: 1 },
        {
          expireAfterSeconds: Math.floor(PROCESSED_TTL_MS / 1000),
          partialFilterExpression: { delivered: true },
        },
      );

      // `hello` (modern) / `isMaster` (servers too old to know `hello`) —
      // both report `setName` only when the node is a member of a replica
      // set, and report `msg: "isdbgrid"` when talking to a `mongos`
      // router in front of a sharded cluster. Anything else (a bare
      // standalone `mongod`) supports neither change streams nor
      // multi-document transactions.
      try {
        const hello = await db.admin().command({ hello: 1 });
        supportsChangeStreams = typeof hello.setName === "string" || hello.msg === "isdbgrid";
      } catch {
        try {
          const isMaster = await db.admin().command({ isMaster: 1 });
          supportsChangeStreams =
            typeof isMaster.setName === "string" || isMaster.msg === "isdbgrid";
        } catch {
          supportsChangeStreams = false;
        }
      }
    },

    async loadState(threadId: string): Promise<StateFile | undefined> {
      const doc = await states.findOne({ _id: threadId });
      if (!doc) {
        return undefined;
      }
      const { _id: _omit, ...state } = doc;
      return state;
    },

    async saveState(threadId: string, state: StateFile) {
      // A single upsert of one document — Mongo document writes are
      // atomic, so a concurrent `loadState` never observes a torn/partial
      // write (§8.1, the presence-read invariant `local-fs` gets from
      // write-temp+rename). No `_id` in the replacement: for an upsert,
      // MongoDB takes it from the filter, so `state` (shape `StateFile`,
      // i.e. `WithoutId<StateDoc>`) is the replacement as-is.
      await states.replaceOne({ _id: threadId }, state, { upsert: true });
    },

    async listThreads(): Promise<ThreadSummary[]> {
      const docs = await states.find({}).toArray();
      return docs.map(({ _id: _omit, ...state }) => toSummary(state));
    },

    async threadExists(threadId: string): Promise<boolean> {
      const doc = await states.findOne({ _id: threadId }, { projection: { _id: 1 } });
      return doc !== null;
    },

    async sendMail(msg: Mail) {
      const { id, ...rest } = msg;
      // Upsert keyed by the envelope id: a retried send with the same id
      // overwrites its own (still-undelivered) document instead of
      // enqueuing a duplicate — enqueue idempotence (§7.6), the same
      // property local-fs gets for free from same-named files. `tail` is
      // stored alongside so `receiveMail` can sort FIFO by it.
      await mail.updateOne(
        { _id: id },
        { $set: { ...rest, tail: mailIdTail(id) }, $setOnInsert: { delivered: false } },
        { upsert: true },
      );
    },

    async receiveMail(threadId: string): Promise<Mail[]> {
      const now = new Date();
      const nowMs = now.getTime();
      // Sorted by `tail` (the envelope id's ULID) — FIFO by send order
      // across senders, same guarantee local-fs gets from a sorted `readdir`
      // (§6.2).
      const candidates = await mail
        .find({ to: threadId, delivered: false })
        .sort({ tail: 1 })
        .toArray();

      const claimed: Mail[] = [];
      for (const candidate of candidates) {
        // Not due yet (§6 deliverAfter): leave it alone entirely — don't
        // even attempt to claim it. A later drain (heartbeat, watcher,
        // boot) will pick it up once the instant passes.
        if (!isMailDue(candidate, nowMs)) {
          continue;
        }

        // The claim itself: atomically flip `delivered` from false to
        // true, conditioned on it still being false. This is the one
        // primitive that makes deliver-once safe under concurrent
        // readers — two processes racing on the same document, only one
        // `findOneAndUpdate` matches (the other gets `null` back and
        // moves on), so nothing is ever handed to two callers. Crash
        // safety mirrors local-fs's rename-before-return contract: this
        // update happens *before* the message is added to `claimed` and
        // returned, so a caller that throws after this point has already
        // durably claimed the message and it will not be redelivered —
        // the protocol's one declared loss window (§7.7, Erratum 5),
        // reproduced exactly rather than improved on.
        const result = await mail.findOneAndUpdate(
          { _id: candidate._id, delivered: false },
          { $set: { delivered: true, processedAt: now } },
        );
        if (!result) {
          // Lost the claim race to a concurrent receiveMail — theirs now.
          continue;
        }

        // Expired (Rev 10 §6 expiresAt): claimed (so it's not redrained
        // forever) but never delivered — same "audit trail, not injected"
        // treatment local-fs gives an expired file moved into processed/.
        if (isMailExpired(candidate, nowMs)) {
          continue;
        }

        claimed.push(mailDocToMail(result));
      }
      return claimed;
    },

    watchMail(threadId: string, cb: () => void): () => void {
      // The change-stream path: fires the instant a matching document is
      // inserted — the Mongo analogue of local-fs's `fs.watch` on
      // `inbox/`. Only attempted when `configure()` detected a replica
      // set / mongos; a bare `mongod` throws synchronously on `.watch()`.
      if (supportsChangeStreams) {
        try {
          const stream = mail.watch([
            { $match: { operationType: "insert", "fullDocument.to": threadId } },
          ]);
          stream.on("change", () => cb());
          // A change stream can also fail *after* being opened (e.g. the
          // replica set loses its primary mid-tail) — fall back to
          // polling rather than silently going deaf for the rest of the
          // process's life.
          let pollTimer: ReturnType<typeof setInterval> | undefined;
          stream.on("error", () => {
            stream.close().catch(() => {});
            if (!pollTimer) {
              pollTimer = setInterval(cb, POLL_INTERVAL_MS);
            }
          });
          return () => {
            if (pollTimer) {
              clearInterval(pollTimer);
            }
            stream.close().catch(() => {});
          };
        } catch (err) {
          console.error("[thread] change stream unavailable, falling back to polling:", err);
          // fall through to the polling branch below
        }
      }

      // Polling fallback — the only option against a standalone `mongod`
      // (no replica set, so no oplog to tail). `cb` is just a "go drain"
      // signal, identical in spirit to every other drain trigger
      // (heartbeat, turn_end, session_start): `receiveMail` is cheap and
      // idempotent when there's nothing new, so polling unconditionally
      // rather than trying to detect "did anything change" server-side is
      // simplest and correct.
      const timer = setInterval(cb, POLL_INTERVAL_MS);
      return () => clearInterval(timer);
    },

    async appendJournal(threadId: string, entry: string) {
      // Aggregation-pipeline update: `content` is computed server-side
      // from its own prior value in the same atomic operation, so this is
      // safe even if it ever gets called concurrently — no client-side
      // read-modify-write race, unlike a naive read-then-writeFile would
      // be.
      await journals.updateOne(
        { _id: threadId },
        [{ $set: { content: { $concat: [{ $ifNull: ["$content", ""] }, entry] } } }],
        { upsert: true },
      );
    },

    async readJournal(threadId: string): Promise<string | undefined> {
      const doc = await journals.findOne({ _id: threadId });
      const content = doc?.content?.trim();
      return content || undefined;
    },

    // Not part of `StorageAdapter`/`JournalAdapter` — the protocol never
    // needed a lifecycle hook because local-fs has no persistent
    // connection to release. Exposed here purely so tests (and any
    // embedder that wants a clean shutdown) can close the driver's socket
    // pool instead of leaning on process exit.
    async close() {
      await client.close();
    },
  };
}
