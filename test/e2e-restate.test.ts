/**
 * Small, curated proof that RestateAdapter and the ThreadObject/ThreadRegistry
 * service actually work against a real Restate server — no fs involved, no
 * model calls. Needs Docker (spins up a real restate-server container via
 * @restatedev/restate-sdk-testcontainers) and takes real wall-clock time to
 * start/stop the container, so it's kept separate from both test:unit (no
 * subprocess at all) and test:e2e (real `pi` + model calls) — see
 * package.json's `test:e2e:restate` script.
 *
 * What's deliberately NOT covered here: the `fireWake` handler's "spawn pi
 * when the thread isn't live" branch. Proving a stopped thread actually gets
 * resumed needs a real `pi` binary + API key, which belongs in a manual
 * sanity check (see README.md "Running with the Restate adapter"), not an
 * automated test — the storage/scheduling-persistence behavior below is
 * what's actually verifiable without that cost.
 *
 * Run: npm run test:e2e:restate (needs Docker; a few seconds container
 * startup/teardown, no API cost)
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { RestateTestEnvironment } from "@restatedev/restate-sdk-testcontainers";
import { ThreadObject, ThreadRegistry } from "../src/restate/service";
import { createRestateAdapter } from "../src/restate/adapter";
import type { StorageAdapter } from "../src/adapter/types";
import type { StateFile, InboxMessage } from "../src/core/types";

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
    lockEventId: null,
    lockPartner: null,
    lockType: null,
    holdReason: null,
    subscriptions: [],
    obligations: [],
    owed: [],
    barriers: [],
    schedules: [],
    startedAt: now,
    lastSeen: now,
    updatedAt: now,
    ...overrides,
  };
}

let env: RestateTestEnvironment;
let adapter: StorageAdapter;

describe("RestateAdapter against a real restate-server (testcontainers)", () => {
  before(async () => {
    env = await RestateTestEnvironment.start({ services: [ThreadObject, ThreadRegistry] });
    adapter = createRestateAdapter({ url: env.baseUrl() });
  });

  after(async () => {
    await env.stop();
  });

  it("saveState/loadState round-trips through the Thread virtual object", async () => {
    await adapter.configure("/unused");
    await adapter.saveState("thread-a", baseState("thread-a"));
    const loaded = await adapter.loadState("thread-a");
    assert.strictEqual(loaded?.id, "thread-a");
  });

  it("loadState/threadExists reflect an unknown thread correctly", async () => {
    assert.strictEqual(await adapter.loadState("ghost"), undefined);
    assert.strictEqual(await adapter.threadExists("ghost"), false);
  });

  it("enqueueMessage + drainInbox delivers durably with no local filesystem involved", async () => {
    const msg: InboxMessage = {
      from: "thread-a",
      to: "thread-b",
      type: "Note",
      body: "hi via restate",
      requestId: "n.thread-a.1",
      delivery: "steer",
      sentAt: new Date().toISOString(),
    };
    await adapter.enqueueMessage("thread-b", msg);
    const claimed = await adapter.drainInbox("thread-b");
    assert.strictEqual(claimed.length, 1);
    assert.strictEqual(claimed[0].body, "hi via restate");
    assert.deepStrictEqual(await adapter.drainInbox("thread-b"), []);
  });

  it("listThreads enumerates threads via the registry, not a directory listing", async () => {
    await adapter.saveState("thread-c", baseState("thread-c"));
    const threads = await adapter.listThreads();
    assert.ok(threads.some(t => t.id === "thread-c"));
  });

  it("scheduleWake persists the wake; cancelWake removes it before it fires", async () => {
    await adapter.saveState("thread-d", baseState("thread-d"));
    await adapter.scheduleWake("thread-d", {
      id: "wake.thread-d.1",
      fireAt: new Date(Date.now() + 60_000).toISOString(),
      reason: "far future — never fires during this test",
    });
    let loaded = await adapter.loadState("thread-d");
    assert.strictEqual(loaded?.schedules.length, 1);
    await adapter.cancelWake("thread-d", "wake.thread-d.1");
    loaded = await adapter.loadState("thread-d");
    assert.strictEqual(loaded?.schedules.length, 0);
  });
});
