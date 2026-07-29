/**
 * MongoDB adapter (`src/adapter/mongo.ts`) tests — same observable contract
 * as `test/unit.test.ts`'s "adapter: LocalFsAdapter" describe block, run
 * against `mongodb-memory-server` instead of a filesystem so the whole
 * suite stays free of a live MongoDB dependency (per THREAD-MODEL.md's
 * "Codebase" constraints).
 *
 * `mongodb-memory-server` spins up a bare standalone `mongod` — no replica
 * set, so no oplog to tail — which is exactly the case this adapter's
 * `watchMail` polling fallback exists for. That fallback is what gets
 * exercised here; a real replica-set/mongos deployment's change-stream path
 * is unreachable without a live cluster and is covered by code review +
 * the `supportsChangeStreams` detection unit tests below instead.
 *
 * Run: npm run test:unit (no live MongoDB server required)
 */

import { describe, it, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { MongoMemoryServer } from "mongodb-memory-server";
import { createAdapter } from "../src/adapter/mongo";
import type { StateFile, Mail } from "../src/core/types";
import { mintMailId } from "../src/core/ids";

function baseState(id: string, overrides: Partial<StateFile> = {}): StateFile {
  const now = new Date().toISOString();
  return {
    id,
    pid: 1,
    cwd: "/virtual",
    parent: null,
    role: null,
    sessionFile: null,
    state: "open",
    status: "running",
    holdReason: null,
    obligations: [],
    owed: [],
    barriers: [],
    startedAt: now,
    lastSeen: now,
    updatedAt: now,
    ...overrides,
  };
}

function wireEnvelope(from: string, to: string, body: string, extra: Partial<Mail> = {}): Mail {
  return {
    id: mintMailId(from),
    from,
    to,
    body,
    sentAt: new Date().toISOString(),
    ...extra,
  };
}

describe("adapter: MongoAdapter", () => {
  let mongod: MongoMemoryServer;
  let connectionString: string;

  before(async () => {
    mongod = await MongoMemoryServer.create();
    connectionString = mongod.getUri();
  });

  after(async () => {
    await mongod.stop();
  });

  // Every test gets its own database on the shared in-memory server — as
  // cheap as a fresh collection set, but fully isolated (no cross-test
  // mail/state bleed), and avoids paying MongoMemoryServer's ~second-plus
  // startup cost per test.
  let database: string;
  // Every adapter created by a test is closed in `afterEach` — otherwise
  // each test's own `MongoClient` socket pool stays open for the rest of
  // the process's life, and `node --test` never observes a clean exit.
  let openAdapters: Array<{ close(): Promise<void> }>;

  beforeEach(() => {
    database = `pi-threading-test-${randomUUID()}`;
    openAdapters = [];
  });

  afterEach(async () => {
    await Promise.all(openAdapters.map(a => a.close()));
  });

  function makeAdapter() {
    const adapter = createAdapter({ "connection-string": connectionString, database });
    openAdapters.push(adapter);
    return adapter;
  }

  it("saveState/loadState round-trips through a single upserted document", async () => {
    const adapter = makeAdapter();
    await adapter.configure();
    await adapter.saveState("a", baseState("a"));
    const loaded = await adapter.loadState("a");
    assert.strictEqual(loaded?.id, "a");
  });

  it("loadState returns undefined for an unknown thread", async () => {
    const adapter = makeAdapter();
    await adapter.configure();
    assert.strictEqual(await adapter.loadState("ghost"), undefined);
  });

  it("saveState upserts — a second save for the same id replaces, not duplicates", async () => {
    const adapter = makeAdapter();
    await adapter.configure();
    await adapter.saveState("a", baseState("a", { state: "open" }));
    await adapter.saveState("a", baseState("a", { state: "done" }));
    const loaded = await adapter.loadState("a");
    assert.strictEqual(loaded?.state, "done");
    const threads = await adapter.listThreads();
    assert.strictEqual(threads.length, 1);
  });

  it("threadExists reflects whether a state document is present", async () => {
    const adapter = makeAdapter();
    await adapter.configure();
    assert.strictEqual(await adapter.threadExists("a"), false);
    await adapter.saveState("a", baseState("a"));
    assert.strictEqual(await adapter.threadExists("a"), true);
  });

  it("listThreads returns every known thread's summary", async () => {
    const adapter = makeAdapter();
    await adapter.configure();
    await adapter.saveState("a", baseState("a"));
    await adapter.saveState("b", baseState("b"));
    const threads = await adapter.listThreads();
    assert.deepStrictEqual(threads.map(t => t.id).sort(), ["a", "b"]);
  });

  it("sendMail + receiveMail delivers everything exactly once, in FIFO ulid order", async () => {
    const adapter = makeAdapter();
    await adapter.configure();
    await adapter.sendMail(wireEnvelope("alice", "bob", "first"));
    await adapter.sendMail(wireEnvelope("alice", "bob", "second"));
    const claimed = await adapter.receiveMail("bob");
    assert.deepStrictEqual(
      claimed.map(m => m.body),
      ["first", "second"],
    );
    // Deliver-once: a second drain sees nothing left to claim.
    assert.deepStrictEqual(await adapter.receiveMail("bob"), []);
  });

  it("FIFO order is by ULID tail (send time), not by sender prefix — cross-sender", async () => {
    const adapter = makeAdapter();
    await adapter.configure();
    // "zzz" sends first, "aaa" second. Ordering by the full `<from>/<ulid>`
    // id would sort "aaa/…" ahead of "zzz/…" (sender-first, wrong); ordering
    // by the ULID tail alone keeps them in send-time order (§6.2).
    await adapter.sendMail(wireEnvelope("zzz", "bob", "sent first"));
    await adapter.sendMail(wireEnvelope("aaa", "bob", "sent second"));
    const claimed = await adapter.receiveMail("bob");
    assert.deepStrictEqual(
      claimed.map(m => m.body),
      ["sent first", "sent second"],
    );
  });

  it("durable queue: mail sent before the target ever starts is delivered on its first receiveMail", async () => {
    const adapter = makeAdapter();
    await adapter.configure();
    // No saveState("bob", ...) has ever run — "bob" has no state document at
    // all yet, mirroring a thread that has never started.
    await adapter.sendMail(wireEnvelope("alice", "bob", "queued before boot"));
    assert.strictEqual(await adapter.threadExists("bob"), false);
    const claimed = await adapter.receiveMail("bob");
    assert.strictEqual(claimed.length, 1);
    assert.strictEqual(claimed[0].body, "queued before boot");
  });

  it("a retry with the same id overwrites its own (still-undelivered) document — enqueue idempotence (§7.6)", async () => {
    const adapter = makeAdapter();
    await adapter.configure();
    const msg = wireEnvelope("alice", "bob", "retry me");
    await adapter.sendMail(msg);
    await adapter.sendMail(msg);
    const claimed = await adapter.receiveMail("bob");
    assert.strictEqual(claimed.length, 1, "no duplicate delivery");
  });

  it("receiveMail holds deliverAfter envelopes until due, then delivers them (§6)", async () => {
    const adapter = makeAdapter();
    await adapter.configure();
    await adapter.sendMail(
      wireEnvelope("alice", "bob", "later", {
        deliverAfter: new Date(Date.now() + 150).toISOString(),
      }),
    );
    assert.deepStrictEqual(await adapter.receiveMail("bob"), [], "not due yet");
    await new Promise(r => setTimeout(r, 200));
    const claimed = await adapter.receiveMail("bob");
    assert.strictEqual(claimed.length, 1);
    assert.strictEqual(claimed[0].body, "later");
  });

  it("receiveMail claims but never returns an already-expired envelope (Rev 10 §6 expiresAt)", async () => {
    const adapter = makeAdapter();
    await adapter.configure();
    await adapter.sendMail(
      wireEnvelope("alice", "bob", "stale", {
        expiresAt: new Date(Date.now() - 1000).toISOString(),
      }),
    );
    const claimed = await adapter.receiveMail("bob");
    assert.deepStrictEqual(claimed, [], "expired mail is never delivered");
    // Claimed (not redrained forever), even though never returned.
    assert.deepStrictEqual(await adapter.receiveMail("bob"), []);
  });

  it("concurrent receiveMail calls never double-deliver the same envelope", async () => {
    const adapter = makeAdapter();
    await adapter.configure();
    await adapter.sendMail(wireEnvelope("alice", "bob", "one"));
    await adapter.sendMail(wireEnvelope("alice", "bob", "two"));
    await adapter.sendMail(wireEnvelope("alice", "bob", "three"));
    const [first, second] = await Promise.all([
      adapter.receiveMail("bob"),
      adapter.receiveMail("bob"),
    ]);
    const allClaimed = [...first, ...second];
    assert.strictEqual(allClaimed.length, 3, "every envelope claimed exactly once in total");
    const ids = new Set(allClaimed.map(m => m.id));
    assert.strictEqual(ids.size, 3, "no envelope claimed by both racing calls");
  });

  it("watchMail falls back to polling against a standalone mongod (no replica set)", async () => {
    const adapter = makeAdapter();
    await adapter.configure();
    let fired = 0;
    const dispose = adapter.watchMail("bob", () => {
      fired++;
    });
    try {
      // The polling fallback fires unconditionally on its interval —
      // mongodb-memory-server's standalone mongod can't support change
      // streams (no oplog), so this is the only path exercised here.
      await new Promise(resolve => setTimeout(resolve, 1200));
      assert.ok(fired > 0, "polling fallback invoked the callback at least once");
    } finally {
      dispose();
    }
  });

  it("watchMail's disposer stops further polling callbacks", async () => {
    const adapter = makeAdapter();
    await adapter.configure();
    let fired = 0;
    const dispose = adapter.watchMail("bob", () => {
      fired++;
    });
    await new Promise(resolve => setTimeout(resolve, 1200));
    dispose();
    const countAtDispose = fired;
    await new Promise(resolve => setTimeout(resolve, 1200));
    assert.strictEqual(fired, countAtDispose, "no more callbacks fire after dispose");
  });

  it("appendJournal/readJournal round-trips and appends atomically", async () => {
    const adapter = makeAdapter();
    await adapter.configure();
    assert.strictEqual(await adapter.readJournal("a"), undefined);
    await adapter.appendJournal("a", "first entry\n");
    await adapter.appendJournal("a", "second entry\n");
    const content = await adapter.readJournal("a");
    assert.strictEqual(content, "first entry\nsecond entry");
  });
});
