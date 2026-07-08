/**
 * Fast, deterministic tests — no subprocess, no model call. Every tool and
 * slash command is reachable directly via a capture harness that stubs
 * `pi.registerTool`/`pi.registerCommand`, so their deterministic logic
 * (targeting, locking, correlation, dedup, error handling) is tested here
 * rather than through a live model call. See TESTING.md before adding a
 * test — the short version: if the test's outcome doesn't depend on what a
 * model decides, it belongs in this file, not test/e2e.test.ts.
 *
 * Run: npm run test:unit (milliseconds, no API cost)
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
  existsSync,
  readFileSync,
  readdirSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { createThreadStore } from "../src/state";
import { createInbox } from "../src/inbox";
import { registerTools } from "../src/tools";
import { registerCommands } from "../src/commands";
import {
  journalFingerprint,
  isDuplicateOfLastEntry,
  journalForkArgs,
  journalSignature,
  piSelfCommand,
  shouldJournal,
  JOURNAL_MIN_INTERVAL_MS,
} from "../src/journal";
import { buildWakeLaunch } from "../src/restate/wake-launch";
import { createLocalFsAdapter } from "../src/adapter/local-fs";
import type { StorageAdapter } from "../src/adapter/types";
import type { StateFile, InboxMessage, ThreadSummary } from "../src/core/types";
import { STALE_MS, toSummary } from "../src/core/types";

// --- harness -----------------------------------------------------------

type Call = { content: string; options?: { deliverAs?: string } };
type Notify = { text: string; level?: string };
// `details` shape is genuinely per-tool (mirrors the SDK's own TDetails =
// unknown default) — one documented `any` here beats ad-hoc casts at every
// call site below.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type ToolResult = { content: { type: string; text: string }[]; details: any };
type AnyTool = {
  execute: (
    toolCallId: string,
    params: unknown,
    signal: undefined,
    onUpdate: undefined,
    ctx: ExtensionCommandContext,
  ) => Promise<ToolResult>;
};
type AnyCommand = { handler: (args: string, ctx: ExtensionCommandContext) => Promise<void> };

function makeHarness(dir: string, id = "t1") {
  const calls: Call[] = [];
  const notifications: Notify[] = [];
  const tools: Record<string, AnyTool> = {};
  const commands: Record<string, AnyCommand> = {};

  const stubPi = {
    sendUserMessage: (content: string, options?: { deliverAs?: string }) => {
      calls.push({ content, options });
    },
    registerTool: (tool: AnyTool & { name: string }) => {
      tools[tool.name] = tool;
    },
    registerCommand: (name: string, opts: AnyCommand) => {
      commands[name] = opts;
    },
  } as unknown as ExtensionAPI;

  const store = createThreadStore(stubPi);
  // No internal `await` in LocalFsAdapter.configure — this synchronously
  // sets its root before the call returns, same reasoning as writeFile()
  // below, so the harness doesn't need to become async just for this.
  void store.adapter.configure(dir);
  store.threadId = id;
  store.threadsRootDir = join(dir, ".thread", "threads");
  store.threadDir = join(store.threadsRootDir, id);
  mkdirSync(join(store.threadDir, "inbox", "processed"), { recursive: true });

  const inbox = createInbox(store, stubPi);
  registerTools(stubPi, store, inbox);
  registerCommands(stubPi, store, inbox);
  // Fire-and-forget: LocalFsAdapter's writes have no internal `await`, so the
  // fs side effect (state.json existing, matching real session_start) has
  // already happened synchronously by the time this call returns, even
  // though the returned promise itself settles a microtask later.
  void store.writeFile();

  const ctx = {
    ui: {
      setStatus: () => {},
      notify: (text: string, level?: string) => notifications.push({ text, level }),
    },
    waitForIdle: async () => {},
  } as unknown as ExtensionCommandContext;

  return { store, inbox, tools, commands, ctx, calls, notifications, dir };
}

type Harness = ReturnType<typeof makeHarness>;

function callTool(h: Harness, name: string, params: unknown = {}) {
  return h.tools[name].execute("test", params, undefined, undefined, h.ctx);
}

function callCommand(h: Harness, name: string, args = "") {
  return h.commands[name].handler(args, h.ctx);
}

function seedRemoteThread(h: Harness, id: string, opts: { role?: string; stale?: boolean } = {}) {
  const dir = join(h.store.threadsRootDir, id);
  mkdirSync(join(dir, "inbox", "processed"), { recursive: true });
  const lastSeen = opts.stale
    ? new Date(Date.now() - 5 * 60_000).toISOString()
    : new Date().toISOString();
  writeFileSync(
    join(dir, "state.json"),
    JSON.stringify({
      id,
      pid: 999999,
      cwd: h.dir,
      parent: null,
      role: opts.role ?? null,
      sessionFile: null,
      state: "open",
      status: "running",
      lockEventId: null,
      lockPartner: null,
      lockType: null,
      holdReason: null,
      subscriptions: [],
      obligations: [],
      barriers: [],
      startedAt: lastSeen,
      lastSeen,
      updatedAt: lastSeen,
    }),
  );
}

function seedInboxMessage(
  h: Harness,
  ownId: string,
  msg: { from: string; type: string; body: string; requestId: string },
) {
  const dir = join(h.store.threadsRootDir, ownId, "inbox");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, `${Date.now()}-seed.json`),
    JSON.stringify({ ...msg, to: ownId, delivery: "steer", sentAt: new Date().toISOString() }),
  );
}

function inboxFileCount(h: Harness, id: string): number {
  const dir = join(h.store.threadsRootDir, id, "inbox");
  if (!existsSync(dir)) return 0;
  return readdirSync(dir).filter(f => f.endsWith(".json")).length;
}

function readInboxFile(h: Harness, id: string, index = 0) {
  const dir = join(h.store.threadsRootDir, id, "inbox");
  const files = readdirSync(dir)
    .filter(f => f.endsWith(".json"))
    .sort();
  return JSON.parse(readFileSync(join(dir, files[index]), "utf8"));
}

function stamp(d: Date): string {
  return d.toISOString().slice(0, 16).replace("T", " ");
}
function nowStamp(): string {
  return stamp(new Date());
}
function journalEntry(ts: string, workingOn: string, done = "did stuff"): string {
  return `\n<!-- ${ts} -->\nWorking on: ${workingOn}\nDone: ${done}\nDoing: more\nNext: ship\nBlockers: none\n`;
}
function writeJournal(h: Harness, id: string, content: string) {
  const dir = join(h.store.threadsRootDir, id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "journal.md"), content.trim() + "\n");
}

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "pi-thread-unit-"));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

// --- tests ---------------------------------------------------------------

describe("tools: thread_send", () => {
  it("targets a single explicit id", async () => {
    const h = makeHarness(tmpDir);
    const r = await callTool(h, "thread_send", { to: "alice", type: "Note", body: "hi" });
    assert.strictEqual(r.details.ok, true);
    assert.strictEqual(r.details.sent.length, 1);
    assert.strictEqual(r.details.sent[0].to, "alice");
  });

  it('to="*" fans out to every known thread except self', async () => {
    const h = makeHarness(tmpDir);
    seedRemoteThread(h, "alice");
    seedRemoteThread(h, "bob");
    const r = await callTool(h, "thread_send", { to: "*", type: "Update", body: "standup" });
    assert.strictEqual(r.details.sent.length, 2);
    assert.deepStrictEqual(r.details.sent.map((s: { to: string }) => s.to).sort(), [
      "alice",
      "bob",
    ]);
  });

  it('to="role:x" targets only threads with that role', async () => {
    const h = makeHarness(tmpDir);
    seedRemoteThread(h, "alice", { role: "dev" });
    seedRemoteThread(h, "bob", { role: "qa" });
    const r = await callTool(h, "thread_send", { to: "role:dev", type: "Note", body: "hi" });
    assert.strictEqual(r.details.sent.length, 1);
    assert.strictEqual(r.details.sent[0].to, "alice");
  });

  it("comma-separated targets exclude self", async () => {
    const h = makeHarness(tmpDir);
    const r = await callTool(h, "thread_send", { to: "alice,t1,bob", type: "Note", body: "hi" });
    assert.deepStrictEqual(r.details.sent.map((s: { to: string }) => s.to).sort(), [
      "alice",
      "bob",
    ]);
  });

  it("locking types (Question/Blocker/Sync) reject more than one target", async () => {
    const h = makeHarness(tmpDir);
    const r = await callTool(h, "thread_send", { to: "alice,bob", type: "Question", body: "?" });
    assert.strictEqual(r.details.ok, false);
  });

  it("Answer/Result require a requestId", async () => {
    const h = makeHarness(tmpDir);
    const r = await callTool(h, "thread_send", { to: "alice", type: "Answer", body: "ok" });
    assert.strictEqual(r.details.ok, false);
  });

  it("Blocker with no `to` defaults to the parent", async () => {
    const h = makeHarness(tmpDir);
    h.store.parent = "boss";
    seedRemoteThread(h, "boss");
    const r = await callTool(h, "thread_send", { type: "Blocker", body: "stuck" });
    assert.strictEqual(r.details.sent[0].to, "boss");
    assert.strictEqual(h.store.lockPartner, "boss");
    assert.strictEqual(h.store.state, "listening");
  });

  it("Blocker with no `to` and no parent errors", async () => {
    const h = makeHarness(tmpDir);
    const r = await callTool(h, "thread_send", { type: "Blocker", body: "stuck" });
    assert.strictEqual(r.details.ok, false);
  });

  it("wait=true on Brief arms a barrier carrying the given deadline", async () => {
    const h = makeHarness(tmpDir);
    const r = await callTool(h, "thread_send", {
      to: "alice",
      type: "Brief",
      body: "task",
      wait: true,
      deadlineSeconds: 60,
    });
    assert.strictEqual(h.store.barriers.length, 1);
    assert.ok(h.store.barriers[0].deadline);
    assert.match(r.content[0].text, /Waiting \(barrier/);
  });

  it("wait=true no-ops for a locking type", async () => {
    const h = makeHarness(tmpDir);
    seedRemoteThread(h, "alice");
    const r = await callTool(h, "thread_send", {
      to: "alice",
      type: "Question",
      body: "?",
      wait: true,
    });
    assert.strictEqual(h.store.barriers.length, 0);
    assert.match(r.content[0].text, /wait=true ignored.*lock/);
  });

  it("wait=true no-ops for Note (no reply protocol)", async () => {
    const h = makeHarness(tmpDir);
    const r = await callTool(h, "thread_send", {
      to: "alice",
      type: "Note",
      body: "fyi",
      wait: true,
    });
    assert.strictEqual(h.store.barriers.length, 0);
    assert.match(r.content[0].text, /wait=true ignored.*no reply protocol/);
  });

  it("a Question to a never-seen id is refused instead of locking forever", async () => {
    const h = makeHarness(tmpDir);
    const r = await callTool(h, "thread_send", { to: "alcie", type: "Question", body: "?" });
    assert.strictEqual(r.details.ok, false);
    assert.match(r.content[0].text, /No thread "alcie" has ever run/);
    assert.strictEqual(h.store.lockEventId, null);
    assert.strictEqual(h.store.state, "idle");
    assert.strictEqual(h.store.obligations.length, 0);
    assert.strictEqual(inboxFileCount(h, "alcie"), 0);
  });

  it("a Brief to a never-seen id queues durably but carries a typo warning", async () => {
    const h = makeHarness(tmpDir);
    const r = await callTool(h, "thread_send", {
      to: "future-worker",
      type: "Brief",
      body: "task",
    });
    assert.strictEqual(r.details.ok, true);
    assert.match(r.content[0].text, /never been seen/);
    assert.strictEqual(inboxFileCount(h, "future-worker"), 1);
  });

  it("a Brief to a known thread carries no typo warning", async () => {
    const h = makeHarness(tmpDir);
    seedRemoteThread(h, "alice");
    const r = await callTool(h, "thread_send", { to: "alice", type: "Brief", body: "task" });
    assert.doesNotMatch(r.content[0].text, /never been seen/);
  });
});

describe("inbox: requestId minting", () => {
  it("two sends of the same type in the same millisecond get distinct requestIds", async () => {
    const h = makeHarness(tmpDir);
    const a = await h.inbox.sendCrossThread("alice", "Note", "one");
    const b = await h.inbox.sendCrossThread("alice", "Note", "two");
    assert.notStrictEqual(a.requestId, b.requestId);
  });

  it("a fan-out send mints a distinct requestId per target", async () => {
    const h = makeHarness(tmpDir);
    seedRemoteThread(h, "alice");
    seedRemoteThread(h, "bob");
    const r = await callTool(h, "thread_send", { to: "*", type: "Update", body: "standup" });
    const ids = r.details.sent.map((s: { requestId: string }) => s.requestId);
    assert.strictEqual(new Set(ids).size, ids.length);
  });
});

describe("tools: thread_await", () => {
  it("arms a barrier with deadlineSeconds converted to an ISO deadline", async () => {
    const h = makeHarness(tmpDir);
    const r = await callTool(h, "thread_await", { requestIds: ["a.1"], deadlineSeconds: 30 });
    assert.strictEqual(h.store.barriers.length, 1);
    assert.ok(h.store.barriers[0].deadline);
    assert.strictEqual(r.details.barrier.pending.length, 1);
  });

  it("warns when a requestId has no matching obligation", async () => {
    const h = makeHarness(tmpDir);
    const r = await callTool(h, "thread_await", { requestIds: ["ghost.1"] });
    assert.match(r.content[0].text, /Warning: no open obligation/);
  });

  it("does not warn when the requestId matches an open obligation", async () => {
    const h = makeHarness(tmpDir);
    h.store.obligations.push({
      requestId: "brief.t1.1",
      type: "Brief",
      to: "alice",
      summary: "x",
      sentAt: new Date().toISOString(),
    });
    const r = await callTool(h, "thread_await", { requestIds: ["brief.t1.1"] });
    assert.doesNotMatch(r.content[0].text, /Warning/);
  });
});

describe("tools: thread_sync_request / thread_sync_close", () => {
  it("acquires the lock when unlocked", async () => {
    const h = makeHarness(tmpDir);
    seedRemoteThread(h, "alice");
    const r = await callTool(h, "thread_sync_request", { partner: "alice" });
    assert.strictEqual(r.details.ok, true);
    assert.strictEqual(h.store.lockPartner, "alice");
    assert.strictEqual(h.store.lockType, "sync");
    assert.strictEqual(h.store.state, "in-sync");
    assert.strictEqual(inboxFileCount(h, "alice"), 1);
  });

  it("returns locked when already in sync with someone else", async () => {
    const h = makeHarness(tmpDir);
    seedRemoteThread(h, "alice");
    await callTool(h, "thread_sync_request", { partner: "alice" });
    const r = await callTool(h, "thread_sync_request", { partner: "bob" });
    assert.strictEqual(r.details.locked, true);
    assert.strictEqual(h.store.lockPartner, "alice");
  });

  it("rejects syncing with self", async () => {
    const h = makeHarness(tmpDir);
    const r = await callTool(h, "thread_sync_request", { partner: "t1" });
    assert.strictEqual(r.details.ok, false);
    assert.strictEqual(h.store.lockEventId, null);
  });

  it("rejects syncing with a never-seen partner and leaves no lock", async () => {
    const h = makeHarness(tmpDir);
    const r = await callTool(h, "thread_sync_request", { partner: "gohst" });
    assert.strictEqual(r.details.ok, false);
    assert.match(r.content[0].text, /No thread "gohst" has ever run/);
    assert.strictEqual(h.store.lockEventId, null);
    assert.strictEqual(inboxFileCount(h, "gohst"), 0);
  });

  it("close releases the lock, fires local subscribers, and notifies the partner", async () => {
    const h = makeHarness(tmpDir);
    seedRemoteThread(h, "alice");
    await callTool(h, "thread_sync_request", { partner: "alice" });
    const eventId = h.store.lockEventId!;
    await callTool(h, "thread_subscribe", {
      eventId,
      message: "lock released",
      delivery: "steer",
    });
    const r = await callTool(h, "thread_sync_close", {});
    assert.strictEqual(h.store.lockEventId, null);
    assert.strictEqual(r.details.waitersNotified, 1);
    assert.strictEqual(h.calls.length, 1);
    assert.strictEqual(h.calls[0].content, "lock released");
    assert.strictEqual(inboxFileCount(h, "alice"), 2); // Sync request + Answer close notice
  });

  it("close is a no-op when not in sync", async () => {
    const h = makeHarness(tmpDir);
    const r = await callTool(h, "thread_sync_close", {});
    assert.strictEqual(r.details.ok, false);
  });
});

describe("tools: thread_suspend / thread_resume", () => {
  it("suspend sets on-hold with the given reason", async () => {
    const h = makeHarness(tmpDir);
    await callTool(h, "thread_suspend", { reason: "waiting on review" });
    assert.strictEqual(h.store.state, "on-hold");
    assert.strictEqual(h.store.holdReason, "waiting on review");
  });

  it("resume clears on-hold and drains the queued inbox", async () => {
    const h = makeHarness(tmpDir);
    await callTool(h, "thread_suspend", {});
    seedInboxMessage(h, "t1", {
      from: "alice",
      type: "Note",
      body: "hi",
      requestId: "note.alice.1",
    });
    const r = await callTool(h, "thread_resume", {});
    assert.strictEqual(r.details.ok, true);
    assert.strictEqual(h.store.state, "open");
    assert.strictEqual(h.calls.length, 1);
  });

  it("resume is a no-op when not on-hold", async () => {
    const h = makeHarness(tmpDir);
    const r = await callTool(h, "thread_resume", {});
    assert.strictEqual(r.details.ok, false);
  });
});

describe("tools: thread_status", () => {
  it("itemizes obligations and barriers in the text output", async () => {
    const h = makeHarness(tmpDir);
    h.store.obligations.push({
      requestId: "brief.t1.1",
      type: "Brief",
      to: "alice",
      summary: "task",
      sentAt: new Date().toISOString(),
    });
    h.store.barriers.push({
      id: "barrier.t1.1",
      pending: ["brief.t1.1"],
      mode: "all",
      createdAt: new Date().toISOString(),
    });
    const r = await callTool(h, "thread_status", {});
    assert.match(r.content[0].text, /Brief to alice #brief\.t1\.1/);
    assert.match(r.content[0].text, /barrier\.t1\.1 \(all\) pending: brief\.t1\.1/);
  });

  it("itemizes scheduled wakes in the text output", async () => {
    const h = makeHarness(tmpDir);
    h.store.schedules.push({
      id: "wake.t1.1",
      fireAt: new Date().toISOString(),
      reason: "check in",
    });
    const r = await callTool(h, "thread_status", {});
    assert.match(r.content[0].text, /wake\.t1\.1 at .* "check in"/);
  });

  it("shows 'none' for empty obligations and barriers", async () => {
    const h = makeHarness(tmpDir);
    const r = await callTool(h, "thread_status", {});
    assert.match(r.content[0].text, /Obligations: none/);
    assert.match(r.content[0].text, /Barriers: none/);
  });
});

describe("tools: thread_list", () => {
  it("reports a stale thread as stopped regardless of its stored status", async () => {
    const h = makeHarness(tmpDir);
    seedRemoteThread(h, "ghost", { stale: true });
    const r = await callTool(h, "thread_list", {});
    assert.match(r.content[0].text, /ghost.*stopped/s);
  });
});

describe("tools: thread_journal", () => {
  it("returns the full journal with no filters", async () => {
    const h = makeHarness(tmpDir);
    writeJournal(
      h,
      "t1",
      journalEntry("2026-01-01 00:00", "task A") + journalEntry("2026-01-02 00:00", "task B"),
    );
    const r = await callTool(h, "thread_journal", { id: "t1" });
    assert.match(r.details.journal, /task A/);
    assert.match(r.details.journal, /task B/);
  });

  it("tail limits to the last N entries", async () => {
    const h = makeHarness(tmpDir);
    writeJournal(
      h,
      "t1",
      journalEntry("2026-01-01 00:00", "task A") + journalEntry("2026-01-02 00:00", "task B"),
    );
    const r = await callTool(h, "thread_journal", { id: "t1", tail: 1 });
    assert.doesNotMatch(r.details.journal, /task A/);
    assert.match(r.details.journal, /task B/);
  });

  it("lookbackMinutes excludes entries older than the cutoff", async () => {
    const h = makeHarness(tmpDir);
    const oldStamp = stamp(new Date(Date.now() - 120 * 60_000));
    writeJournal(
      h,
      "t1",
      journalEntry(oldStamp, "old task") + journalEntry(nowStamp(), "recent task"),
    );
    const r = await callTool(h, "thread_journal", { id: "t1", lookbackMinutes: 60 });
    assert.doesNotMatch(r.details.journal, /old task/);
    assert.match(r.details.journal, /recent task/);
  });

  it("errors for an unknown thread id", async () => {
    const h = makeHarness(tmpDir);
    const r = await callTool(h, "thread_journal", { id: "nobody" });
    assert.strictEqual(r.details.ok, false);
  });
});

describe("tools: thread_subscribe / thread_emit", () => {
  it("emit notifies only subscribers of the matching eventId", async () => {
    const h = makeHarness(tmpDir);
    await callTool(h, "thread_subscribe", { eventId: "ready", message: "go", delivery: "steer" });
    await callTool(h, "thread_subscribe", {
      eventId: "other",
      message: "nope",
      delivery: "steer",
    });
    const r = await callTool(h, "thread_emit", { eventId: "ready" });
    assert.strictEqual(r.details.notified, 1);
    assert.strictEqual(h.calls.length, 1);
    assert.strictEqual(h.calls[0].content, "go");
    assert.strictEqual(h.store.subscriptions.length, 1); // "other" persists
  });

  it("multiple subscribers to the same event are all notified", async () => {
    const h = makeHarness(tmpDir);
    await callTool(h, "thread_subscribe", { eventId: "ready", message: "a", delivery: "steer" });
    await callTool(h, "thread_subscribe", {
      eventId: "ready",
      message: "b",
      delivery: "follow-up",
    });
    const r = await callTool(h, "thread_emit", { eventId: "ready" });
    assert.strictEqual(r.details.notified, 2);
    assert.strictEqual(h.store.subscriptions.length, 0);
  });

  it("emit on an unknown eventId notifies nobody", async () => {
    const h = makeHarness(tmpDir);
    const r = await callTool(h, "thread_emit", { eventId: "nothing-subscribed" });
    assert.strictEqual(r.details.notified, 0);
  });

  it("subscribing to an event that never fires persists in state", async () => {
    const h = makeHarness(tmpDir);
    await callTool(h, "thread_subscribe", {
      eventId: "never",
      message: "x",
      delivery: "follow-up",
    });
    assert.strictEqual(h.store.subscriptions.length, 1);
    assert.strictEqual(h.store.subscriptions[0].eventId, "never");
  });
});

describe("inbox: deliver", () => {
  it("a Result that resolves a barrier sends exactly one message", async () => {
    const h = makeHarness(tmpDir);
    h.store.obligations.push({
      requestId: "brief.t1.1",
      type: "Brief",
      to: "alice",
      summary: "task",
      sentAt: new Date().toISOString(),
    });
    h.store.barriers.push({
      id: "barrier.t1.1",
      pending: ["brief.t1.1"],
      mode: "all",
      createdAt: new Date().toISOString(),
    });

    await h.inbox.deliver(
      {
        from: "alice",
        to: "t1",
        type: "Result",
        body: "done",
        requestId: "brief.t1.1",
        delivery: "follow-up",
        sentAt: new Date().toISOString(),
      },
      h.ctx,
    );

    assert.strictEqual(h.calls.length, 1);
    assert.match(h.calls[0].content, /barrier "barrier\.t1\.1" resolved/);
    assert.match(h.calls[0].content, /Result from alice/);
    assert.strictEqual(h.store.barriers.length, 0);
    assert.strictEqual(h.store.obligations.length, 0);
  });

  it("an Answer clears only the matching obligation", async () => {
    const h = makeHarness(tmpDir);
    h.store.obligations.push(
      {
        requestId: "q.1",
        type: "Question",
        to: "alice",
        summary: "x",
        sentAt: new Date().toISOString(),
      },
      {
        requestId: "q.2",
        type: "Question",
        to: "bob",
        summary: "y",
        sentAt: new Date().toISOString(),
      },
    );
    await h.inbox.deliver(
      {
        from: "alice",
        to: "t1",
        type: "Answer",
        body: "ok",
        requestId: "q.1",
        delivery: "steer",
        sentAt: new Date().toISOString(),
      },
      h.ctx,
    );
    assert.strictEqual(h.store.obligations.length, 1);
    assert.strictEqual(h.store.obligations[0].requestId, "q.2");
  });

  it("clears the lock only when the incoming requestId matches lockEventId", async () => {
    const h = makeHarness(tmpDir);
    h.store.lockEventId = "q.1";
    h.store.lockPartner = "alice";
    h.store.lockType = "reply";
    h.store.state = "listening";
    await h.inbox.deliver(
      {
        from: "bob",
        to: "t1",
        type: "Answer",
        body: "ok",
        requestId: "unrelated.1",
        delivery: "steer",
        sentAt: new Date().toISOString(),
      },
      h.ctx,
    );
    assert.strictEqual(h.store.lockEventId, "q.1");
    assert.strictEqual(h.store.state, "listening");
  });

  it("Sync is accepted and locks this thread when unlocked", async () => {
    const h = makeHarness(tmpDir);
    await h.inbox.deliver(
      {
        from: "alice",
        to: "t1",
        type: "Sync",
        body: "sync up",
        requestId: "sync.alice.1",
        delivery: "steer",
        sentAt: new Date().toISOString(),
      },
      h.ctx,
    );
    assert.strictEqual(h.store.lockEventId, "sync.alice.1");
    assert.strictEqual(h.store.lockPartner, "alice");
    assert.strictEqual(h.store.lockType, "sync");
    assert.strictEqual(h.store.state, "in-sync");
  });

  it("Sync auto-rejects (sends an Answer back) when already locked", async () => {
    const h = makeHarness(tmpDir);
    h.store.lockEventId = "sync.bob.1";
    h.store.lockPartner = "bob";
    h.store.lockType = "sync";
    await h.inbox.deliver(
      {
        from: "alice",
        to: "t1",
        type: "Sync",
        body: "sync?",
        requestId: "sync.alice.2",
        delivery: "steer",
        sentAt: new Date().toISOString(),
      },
      h.ctx,
    );
    assert.strictEqual(h.store.lockPartner, "bob"); // unchanged
    const reply = readInboxFile(h, "alice");
    assert.strictEqual(reply.type, "Answer");
    assert.strictEqual(reply.requestId, "sync.alice.2");
  });

  it('"any" mode resolves on the first reply, ignoring the rest', async () => {
    const h = makeHarness(tmpDir);
    h.store.barriers.push({
      id: "b.1",
      pending: ["a.1", "a.2"],
      mode: "any",
      createdAt: new Date().toISOString(),
    });
    await h.inbox.deliver(
      {
        from: "alice",
        to: "t1",
        type: "Result",
        body: "done",
        requestId: "a.1",
        delivery: "follow-up",
        sentAt: new Date().toISOString(),
      },
      h.ctx,
    );
    assert.strictEqual(h.store.barriers.length, 0);
    assert.match(h.calls[0].content, /barrier "b\.1" resolved/);
  });

  it('"all" mode waits for every pending id before resolving', async () => {
    const h = makeHarness(tmpDir);
    h.store.barriers.push({
      id: "b.1",
      pending: ["a.1", "a.2"],
      mode: "all",
      createdAt: new Date().toISOString(),
    });
    await h.inbox.deliver(
      {
        from: "alice",
        to: "t1",
        type: "Result",
        body: "done",
        requestId: "a.1",
        delivery: "follow-up",
        sentAt: new Date().toISOString(),
      },
      h.ctx,
    );
    assert.strictEqual(h.store.barriers.length, 1);
    assert.strictEqual(h.store.barriers[0].pending.length, 1);
    assert.doesNotMatch(h.calls[0].content, /barrier/);
  });

  it("multiple barriers resolved by one requestId fold into one message", async () => {
    const h = makeHarness(tmpDir);
    h.store.barriers.push(
      { id: "b.1", pending: ["a.1"], mode: "all", createdAt: new Date().toISOString() },
      { id: "b.2", pending: ["a.1", "a.2"], mode: "any", createdAt: new Date().toISOString() },
    );
    await h.inbox.deliver(
      {
        from: "alice",
        to: "t1",
        type: "Result",
        body: "done",
        requestId: "a.1",
        delivery: "follow-up",
        sentAt: new Date().toISOString(),
      },
      h.ctx,
    );
    assert.strictEqual(h.calls.length, 1);
    assert.match(h.calls[0].content, /barrier "b\.1" resolved/);
    assert.match(h.calls[0].content, /barrier "b\.2" resolved/);
  });
});

describe("inbox: owed replies (recipient-side durability)", () => {
  function envelope(type: "Brief" | "Question" | "Blocker" | "Note", requestId: string) {
    return {
      from: "alice",
      to: "t1",
      type,
      body: "please do the thing",
      requestId,
      delivery: "steer" as const,
      sentAt: new Date().toISOString(),
    };
  }

  it("delivering a Brief records a durable owed reply with the requestId to echo", async () => {
    const h = makeHarness(tmpDir);
    await h.inbox.deliver(envelope("Brief", "brief.alice.1"), h.ctx);
    assert.deepStrictEqual(
      h.store.owed.map(o => ({ requestId: o.requestId, type: o.type, from: o.from })),
      [{ requestId: "brief.alice.1", type: "Brief", from: "alice" }],
    );
    // Durable, not just in memory: the record must survive this process.
    const onDisk: StateFile = JSON.parse(
      readFileSync(join(h.store.threadDir, "state.json"), "utf8"),
    );
    assert.strictEqual(onDisk.owed[0].requestId, "brief.alice.1");
  });

  it("Note does not record an owed reply (no reply protocol)", async () => {
    const h = makeHarness(tmpDir);
    await h.inbox.deliver(envelope("Note", "note.alice.1"), h.ctx);
    assert.strictEqual(h.store.owed.length, 0);
  });

  it("redelivering the same requestId does not double-record", async () => {
    const h = makeHarness(tmpDir);
    await h.inbox.deliver(envelope("Question", "q.alice.1"), h.ctx);
    await h.inbox.deliver(envelope("Question", "q.alice.1"), h.ctx);
    assert.strictEqual(h.store.owed.length, 1);
  });

  it("sending the matching Result settles the owed reply, on disk too", async () => {
    const h = makeHarness(tmpDir);
    seedRemoteThread(h, "alice");
    await h.inbox.deliver(envelope("Brief", "brief.alice.1"), h.ctx);
    await h.inbox.sendCrossThread("alice", "Result", "done", { requestId: "brief.alice.1" });
    assert.strictEqual(h.store.owed.length, 0);
    const onDisk: StateFile = JSON.parse(
      readFileSync(join(h.store.threadDir, "state.json"), "utf8"),
    );
    assert.strictEqual(onDisk.owed.length, 0);
  });

  it("an Answer with a different requestId leaves the owed reply intact", async () => {
    const h = makeHarness(tmpDir);
    seedRemoteThread(h, "alice");
    await h.inbox.deliver(envelope("Blocker", "blocker.alice.1"), h.ctx);
    await h.inbox.sendCrossThread("alice", "Answer", "about something else", {
      requestId: "other.id",
    });
    assert.strictEqual(h.store.owed.length, 1);
    assert.strictEqual(h.store.owed[0].requestId, "blocker.alice.1");
  });

  it("thread_status itemizes owed replies with the requestId to echo", async () => {
    const h = makeHarness(tmpDir);
    await h.inbox.deliver(envelope("Brief", "brief.alice.1"), h.ctx);
    const res = await callTool(h, "thread_status");
    assert.match(res.content[0].text, /Owed replies:/);
    assert.match(res.content[0].text, /you owe a Result to alice .* #brief\.alice\.1/);
  });
});

describe("inbox: drainInbox", () => {
  it("skips malformed JSON without crashing or redelivering it", async () => {
    const h = makeHarness(tmpDir);
    const inboxDir = join(h.store.threadDir, "inbox");
    writeFileSync(join(inboxDir, "1-bad.json"), "{not valid json");
    await assert.doesNotReject(() => h.inbox.drainInbox(h.ctx));
    assert.strictEqual(h.calls.length, 0);
    assert.ok(existsSync(join(inboxDir, "1-bad.json"))); // left in place, not moved
  });

  it("processes files in FIFO filename order", async () => {
    const h = makeHarness(tmpDir);
    const inboxDir = join(h.store.threadDir, "inbox");
    const msg = (body: string, requestId: string) =>
      JSON.stringify({
        from: "alice",
        to: "t1",
        type: "Note",
        body,
        requestId,
        delivery: "steer",
        sentAt: new Date().toISOString(),
      });
    writeFileSync(join(inboxDir, "1-first.json"), msg("first", "n.1"));
    writeFileSync(join(inboxDir, "2-second.json"), msg("second", "n.2"));
    await h.inbox.drainInbox(h.ctx);
    assert.strictEqual(h.calls.length, 2);
    assert.match(h.calls[0].content, /first/);
    assert.match(h.calls[1].content, /second/);
  });
});

describe("inbox: checkDeadlines", () => {
  it("an overdue obligation nudges once and not twice", async () => {
    const h = makeHarness(tmpDir);
    h.store.obligations.push({
      requestId: "brief.t1.1",
      type: "Brief",
      to: "alice",
      summary: "task",
      sentAt: new Date().toISOString(),
      deadline: new Date(Date.now() - 1000).toISOString(),
    });
    await h.inbox.checkDeadlines();
    assert.strictEqual(h.calls.length, 1);
    assert.match(h.calls[0].content, /obligation overdue #brief\.t1\.1/);
    assert.strictEqual(h.store.obligations[0].nudged, true);
    await h.inbox.checkDeadlines();
    assert.strictEqual(h.calls.length, 1);
  });

  it("an overdue barrier nudges once and not twice", async () => {
    const h = makeHarness(tmpDir);
    h.store.barriers.push({
      id: "barrier.t1.1",
      pending: ["brief.t1.1"],
      mode: "all",
      createdAt: new Date().toISOString(),
      deadline: new Date(Date.now() - 1000).toISOString(),
    });
    await h.inbox.checkDeadlines();
    assert.strictEqual(h.calls.length, 1);
    assert.match(h.calls[0].content, /barrier overdue "barrier\.t1\.1"/);
    assert.strictEqual(h.store.barriers[0].nudged, true);
    await h.inbox.checkDeadlines();
    assert.strictEqual(h.calls.length, 1);
  });

  it("no nudge before the deadline passes", async () => {
    const h = makeHarness(tmpDir);
    h.store.obligations.push({
      requestId: "brief.t1.1",
      type: "Brief",
      to: "alice",
      summary: "task",
      sentAt: new Date().toISOString(),
      deadline: new Date(Date.now() + 60_000).toISOString(),
    });
    await h.inbox.checkDeadlines();
    assert.strictEqual(h.calls.length, 0);
  });
});

describe("inbox: checkSchedules", () => {
  it("an overdue scheduled wake fires once and is pruned from state", async () => {
    const h = makeHarness(tmpDir);
    h.store.schedules.push({
      id: "wake.t1.1",
      fireAt: new Date(Date.now() - 1000).toISOString(),
      reason: "check in on the auth task",
    });
    await h.inbox.checkSchedules();
    assert.strictEqual(h.calls.length, 1);
    assert.match(h.calls[0].content, /scheduled wake #wake\.t1\.1.*check in on the auth task/);
    assert.strictEqual(h.store.schedules.length, 0);
    const persisted = await h.store.adapter.loadState("t1");
    assert.strictEqual(persisted?.schedules.length, 0);
    await h.inbox.checkSchedules();
    assert.strictEqual(h.calls.length, 1);
  });

  it("a wake already fired elsewhere (nudged) is pruned without re-firing", async () => {
    const h = makeHarness(tmpDir);
    h.store.schedules.push({
      id: "wake.t1.1",
      fireAt: new Date(Date.now() - 1000).toISOString(),
      reason: "already delivered by the restate runner",
      nudged: true,
    });
    await h.inbox.checkSchedules();
    assert.strictEqual(h.calls.length, 0);
    assert.strictEqual(h.store.schedules.length, 0);
  });

  it("no nudge before fireAt passes", async () => {
    const h = makeHarness(tmpDir);
    h.store.schedules.push({
      id: "wake.t1.1",
      fireAt: new Date(Date.now() + 60_000).toISOString(),
      reason: "too early",
    });
    await h.inbox.checkSchedules();
    assert.strictEqual(h.calls.length, 0);
  });
});

describe("tools: thread_schedule / thread_schedule_cancel", () => {
  it("arms a wake fireInSeconds from now and persists it via the adapter", async () => {
    const h = makeHarness(tmpDir);
    const before = Date.now();
    const r = await callTool(h, "thread_schedule", { fireInSeconds: 60, reason: "ping me" });
    assert.strictEqual(r.details.ok, true);
    assert.strictEqual(h.store.schedules.length, 1);
    const wake = h.store.schedules[0];
    assert.strictEqual(wake.reason, "ping me");
    assert.ok(new Date(wake.fireAt).getTime() >= before + 59_000);
    const persisted = await h.store.adapter.loadState("t1");
    assert.strictEqual(persisted?.schedules.length, 1);
    assert.strictEqual(persisted?.schedules[0].id, wake.id);
  });

  it("cancel removes a scheduled wake by id, from memory and the adapter", async () => {
    const h = makeHarness(tmpDir);
    const r1 = await callTool(h, "thread_schedule", { fireInSeconds: 60, reason: "ping me" });
    const id = r1.details.wake.id;
    const r2 = await callTool(h, "thread_schedule_cancel", { id });
    assert.strictEqual(r2.details.ok, true);
    assert.strictEqual(h.store.schedules.length, 0);
    const persisted = await h.store.adapter.loadState("t1");
    assert.strictEqual(persisted?.schedules.length, 0);
  });

  it("cancel errors on an unknown id", async () => {
    const h = makeHarness(tmpDir);
    const r = await callTool(h, "thread_schedule_cancel", { id: "ghost" });
    assert.strictEqual(r.details.ok, false);
  });
});

describe("state: journal gating", () => {
  it("journalFingerprint keeps only Working on / Done lines, case/whitespace-insensitive", () => {
    const a = journalFingerprint(
      "Working on: auth\nDone: wrote middleware\nDoing: tests\nNext: review\nBlockers: none",
    );
    const b = journalFingerprint(
      "working on:  auth \ndone: wrote middleware\nDoing: something else entirely\nNext: ship\nBlockers: flaky CI",
    );
    assert.strictEqual(a, b);
  });

  it("isDuplicateOfLastEntry matches when Working on/Done are identical to the last entry", () => {
    const content = journalEntry(nowStamp(), "task A", "same done line");
    const dup =
      "Working on: task A\nDone: same done line\nDoing: something new\nNext: ship\nBlockers: none";
    assert.strictEqual(isDuplicateOfLastEntry(content, dup), true);
  });

  it("isDuplicateOfLastEntry does not match genuinely different content", () => {
    const content = journalEntry(nowStamp(), "task A", "wrote the middleware");
    const fresh =
      "Working on: task A\nDone: fixed the bug\nDoing: tests\nNext: ship\nBlockers: none";
    assert.strictEqual(isDuplicateOfLastEntry(content, fresh), false);
  });

  it("isDuplicateOfLastEntry returns false when no journal content exists yet", () => {
    assert.strictEqual(isDuplicateOfLastEntry(undefined, "Working on: x"), false);
  });
});

describe("lifecycle: journalSignature / shouldJournal", () => {
  it("an unchanged signature with no tool call skips journaling after the first check", () => {
    const h = makeHarness(tmpDir);
    assert.strictEqual(shouldJournal(h.store, false), true); // first call always differs from initial null
    assert.strictEqual(shouldJournal(h.store, false), false);
  });

  it("a tool-using turn inside the rate-limit window defers to a run-end wrap-up", () => {
    const h = makeHarness(tmpDir);
    shouldJournal(h.store, false); // baseline write — lastJournalAt is now
    assert.strictEqual(shouldJournal(h.store, true, "turn"), false);
    assert.strictEqual(h.store.journalDebt, true);
    assert.strictEqual(shouldJournal(h.store, true, "run-end"), true); // the owed wrap-up
    assert.strictEqual(shouldJournal(h.store, true, "run-end"), false); // exactly once
  });

  it("a tool-using turn past the rate-limit window journals immediately", () => {
    const h = makeHarness(tmpDir);
    shouldJournal(h.store, false);
    h.store.lastJournalAt = Date.now() - JOURNAL_MIN_INTERVAL_MS - 1;
    assert.strictEqual(shouldJournal(h.store, true, "turn"), true);
  });

  it("a changed signature journals even without a tool call, ignoring the rate limit", () => {
    const h = makeHarness(tmpDir);
    shouldJournal(h.store, false);
    h.store.state = "listening";
    assert.strictEqual(shouldJournal(h.store, false), true);
  });

  it('phase "done" journals a run that used tools, exactly once', () => {
    const h = makeHarness(tmpDir);
    shouldJournal(h.store, false);
    assert.strictEqual(shouldJournal(h.store, true, "done"), true);
    assert.strictEqual(shouldJournal(h.store, false, "done"), false);
  });

  it("the journal fork opts out of extensions so it can never become a thread itself", () => {
    // Regression: with pi-threading installed via discovery, a fork without
    // --no-extensions loaded the extension, minted a ghost thread identity,
    // and forked another journal pi at its own turn_end — chaining forever.
    const args = journalForkArgs("/sessions/parent.jsonl", "/tmp/jf");
    assert.ok(args.includes("--no-extensions"));
    assert.deepStrictEqual(args.slice(0, 2), ["--fork", "/sessions/parent.jsonl"]);
    assert.ok(!args.includes("--thread-id"));
  });

  it("piSelfCommand re-invokes pi the way this process was started", () => {
    // Regression: spawn("pi") is ENOENT on Windows, where npm installs pi as
    // a .cmd shim that child_process.spawn cannot execute.
    const viaNode = piSelfCommand(["--fork", "s.jsonl"], "/usr/local/bin/node", "/opt/pi/bin.js");
    assert.deepStrictEqual(viaNode, {
      cmd: "/usr/local/bin/node",
      args: ["/opt/pi/bin.js", "--fork", "s.jsonl"],
    });
    const winNode = piSelfCommand(
      ["--fork", "s.jsonl"],
      "C:\\Program Files\\nodejs\\node.exe",
      "C:\\npm\\node_modules\\pi\\bin.js",
    );
    assert.strictEqual(winNode.cmd, "C:\\Program Files\\nodejs\\node.exe");
    assert.strictEqual(winNode.args[0], "C:\\npm\\node_modules\\pi\\bin.js");
    const standalone = piSelfCommand(["--fork", "s.jsonl"], "/usr/local/bin/pi", "--fork");
    assert.deepStrictEqual(standalone, { cmd: "/usr/local/bin/pi", args: ["--fork", "s.jsonl"] });
    const noEntry = piSelfCommand(["--fork"], "/usr/local/bin/node", "");
    assert.strictEqual(noEntry.cmd, "pi");
  });

  it("the journal fork inherits the session's model unless one is pinned", () => {
    // Regression: a hardcoded cheap model only resolves on machines whose
    // provider serves it — everywhere else every fork died before printing
    // and journal.md silently never appeared.
    assert.ok(!journalForkArgs("/s.jsonl", "/tmp/jf").includes("--model"));
    const pinned = journalForkArgs("/s.jsonl", "/tmp/jf", "deepseek/deepseek-chat");
    const i = pinned.indexOf("--model");
    assert.ok(i > -1);
    assert.strictEqual(pinned[i + 1], "deepseek/deepseek-chat");
  });

  it("journalSignature changes when an obligation is added", () => {
    const h = makeHarness(tmpDir);
    const sig1 = journalSignature(h.store);
    h.store.obligations.push({
      requestId: "a.1",
      type: "Brief",
      to: "alice",
      summary: "x",
      sentAt: new Date().toISOString(),
    });
    assert.notStrictEqual(journalSignature(h.store), sig1);
  });
});

describe("commands: slash commands", () => {
  it("/thread-status notification includes the barrier count", async () => {
    const h = makeHarness(tmpDir);
    h.store.barriers.push({
      id: "b.1",
      pending: ["a.1"],
      mode: "all",
      createdAt: new Date().toISOString(),
    });
    await callCommand(h, "/thread-status", "");
    assert.strictEqual(h.notifications.length, 1);
    assert.match(h.notifications[0].text, /Barriers: 1/);
  });

  it("/thread-status notification includes the schedules count", async () => {
    const h = makeHarness(tmpDir);
    h.store.schedules.push({ id: "w.1", fireAt: new Date().toISOString(), reason: "check in" });
    await callCommand(h, "/thread-status", "");
    assert.match(h.notifications[0].text, /Schedules: 1/);
  });

  it("/thread-suspend then /thread-resume round-trips on-hold state", async () => {
    const h = makeHarness(tmpDir);
    await callCommand(h, "/thread-suspend", "waiting on review");
    assert.strictEqual(h.store.state, "on-hold");
    assert.strictEqual(h.store.holdReason, "waiting on review");
    await callCommand(h, "/thread-resume", "");
    assert.strictEqual(h.store.state, "open");
    assert.strictEqual(h.store.holdReason, null);
  });

  it("/thread-send rejects sending to self", async () => {
    const h = makeHarness(tmpDir);
    await callCommand(h, "/thread-send", "t1 Note hello");
    assert.match(h.notifications[0].text, /Cannot send to self/);
  });

  it("/thread-send rejects an unknown message type", async () => {
    const h = makeHarness(tmpDir);
    await callCommand(h, "/thread-send", "alice Bogus hello there");
    assert.match(h.notifications[0].text, /Usage:/);
  });

  it("/thread-emit reports the number of subscribers notified", async () => {
    const h = makeHarness(tmpDir);
    await callTool(h, "thread_subscribe", { eventId: "ready", message: "go", delivery: "steer" });
    await callCommand(h, "/thread-emit", "ready");
    assert.match(h.notifications[h.notifications.length - 1].text, /1 subscriber\(s\) notified/);
  });
});

// --- adapter layer --------------------------------------------------------

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

describe("adapter: LocalFsAdapter", () => {
  it("saveState/loadState round-trips through state.json", async () => {
    const adapter = createLocalFsAdapter();
    await adapter.configure(tmpDir);
    await adapter.saveState("a", baseState("a"));
    const loaded = await adapter.loadState("a");
    assert.strictEqual(loaded?.id, "a");
    assert.ok(existsSync(join(tmpDir, ".thread", "threads", "a", "state.json")));
  });

  it("loadState returns undefined for an unknown thread", async () => {
    const adapter = createLocalFsAdapter();
    await adapter.configure(tmpDir);
    assert.strictEqual(await adapter.loadState("ghost"), undefined);
  });

  it("threadExists reflects whether state.json is present", async () => {
    const adapter = createLocalFsAdapter();
    await adapter.configure(tmpDir);
    assert.strictEqual(await adapter.threadExists("a"), false);
    await adapter.saveState("a", baseState("a"));
    assert.strictEqual(await adapter.threadExists("a"), true);
  });

  it("enqueueMessage + drainInbox delivers everything enqueued exactly once, then clears the pending set", async () => {
    const adapter = createLocalFsAdapter();
    await adapter.configure(tmpDir);
    const msg = (body: string): InboxMessage => ({
      from: "alice",
      to: "bob",
      type: "Note",
      body,
      requestId: `n.${body}`,
      delivery: "steer",
      sentAt: new Date().toISOString(),
    });
    await adapter.enqueueMessage("bob", msg("first"));
    await adapter.enqueueMessage("bob", msg("second"));
    const claimed = await adapter.drainInbox("bob");
    // Filenames tie on Date.now() when enqueued this close together, so
    // exact order isn't guaranteed by this scheme (real FIFO-under-normal-
    // timing is covered by "processes files in FIFO filename order" below,
    // using distinguishable filenames) — what must hold is both delivered
    // exactly once, none lost or duplicated.
    assert.deepStrictEqual(claimed.map(m => m.body).sort(), ["first", "second"]);
    assert.deepStrictEqual(await adapter.drainInbox("bob"), []);
  });

  it("drainInbox leaves malformed JSON in place and never returns it", async () => {
    const adapter = createLocalFsAdapter();
    await adapter.configure(tmpDir);
    const dir = join(tmpDir, ".thread", "threads", "bob", "inbox");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "1-bad.json"), "{not valid json");
    const claimed = await adapter.drainInbox("bob");
    assert.strictEqual(claimed.length, 0);
    assert.ok(existsSync(join(dir, "1-bad.json")));
  });

  it("listThreads reports a thread stale past STALE_MS as stopped", async () => {
    const adapter = createLocalFsAdapter();
    await adapter.configure(tmpDir);
    await adapter.saveState(
      "ghost",
      baseState("ghost", { lastSeen: new Date(Date.now() - STALE_MS - 1000).toISOString() }),
    );
    const threads = await adapter.listThreads();
    assert.strictEqual(threads[0]?.status, "stopped");
  });

  it("scheduleWake persists a wake and cancelWake removes it", async () => {
    const adapter = createLocalFsAdapter();
    await adapter.configure(tmpDir);
    await adapter.saveState("a", baseState("a"));
    await adapter.scheduleWake("a", {
      id: "w.1",
      fireAt: new Date().toISOString(),
      reason: "check in",
    });
    let loaded = await adapter.loadState("a");
    assert.strictEqual(loaded?.schedules.length, 1);
    await adapter.cancelWake("a", "w.1");
    loaded = await adapter.loadState("a");
    assert.strictEqual(loaded?.schedules.length, 0);
  });

  it("watchInbox doesn't throw for a thread that has never received a message (no inbox/ dir yet)", async () => {
    const adapter = createLocalFsAdapter();
    await adapter.configure(tmpDir);
    await adapter.saveState("fresh", baseState("fresh"));
    assert.ok(!existsSync(join(tmpDir, ".thread", "threads", "fresh", "inbox")));
    let fired = false;
    const dispose = adapter.watchInbox("fresh", () => {
      fired = true;
    });
    // Dispose in finally: a leaked FSWatcher keeps the node:test process
    // alive forever if an assertion throws first (observed as a 5-minute
    // hang when the fixed 50ms wait flaked under load).
    try {
      assert.ok(existsSync(join(tmpDir, ".thread", "threads", "fresh", "inbox")));
      // A message arriving after the (now-live) watch should still be observed.
      await adapter.enqueueMessage("fresh", {
        from: "other",
        to: "fresh",
        type: "Note",
        body: "hi",
        requestId: "n.1",
        delivery: "steer",
        sentAt: new Date().toISOString(),
      });
      for (let i = 0; i < 40 && !fired; i++) {
        await new Promise(resolve => setTimeout(resolve, 50));
      }
      assert.strictEqual(fired, true);
    } finally {
      dispose();
    }
  });
});

/** Minimal in-memory StorageAdapter — proves state.ts/inbox.ts never reach
 *  into fs directly, only through store.adapter, by running the same
 *  cross-thread send/deliver flow against a backend with no filesystem at
 *  all (the shape any future non-local adapter, e.g. Restate, must fit). */
function createFakeAdapter(): StorageAdapter {
  const states = new Map<string, StateFile>();
  const inboxes = new Map<string, InboxMessage[]>();
  const journals = new Map<string, string>();

  return {
    async configure() {},
    async loadState(id) {
      return states.get(id);
    },
    async saveState(id, state) {
      states.set(id, structuredClone(state));
    },
    async appendJournal(id, entry) {
      journals.set(id, (journals.get(id) ?? "") + entry);
    },
    async readJournal(id) {
      return journals.get(id)?.trim() || undefined;
    },
    async listThreads(): Promise<ThreadSummary[]> {
      return [...states.values()].map(toSummary);
    },
    async threadExists(id) {
      return states.has(id);
    },
    async enqueueMessage(targetId, message) {
      const arr = inboxes.get(targetId) ?? [];
      arr.push(message);
      inboxes.set(targetId, arr);
    },
    async drainInbox(id) {
      const arr = inboxes.get(id) ?? [];
      inboxes.set(id, []);
      return arr;
    },
    watchInbox() {
      return () => {};
    },
    async scheduleWake(id, wake) {
      const s = states.get(id);
      if (!s) return;
      s.schedules = [...s.schedules, wake];
    },
    async cancelWake(id, wakeId) {
      const s = states.get(id);
      if (!s) return;
      s.schedules = s.schedules.filter(w => w.id !== wakeId);
    },
  };
}

describe("adapter seam: core logic against a fake in-memory adapter", () => {
  it("a Note sent from one thread is drained and delivered on the other, with no fs involved", async () => {
    const fake = createFakeAdapter();
    const calls: Call[] = [];
    const stubPi = {
      sendUserMessage: (content: string, options?: { deliverAs?: string }) => {
        calls.push({ content, options });
      },
      registerTool: () => {},
      registerCommand: () => {},
    } as unknown as ExtensionAPI;
    const ctx = { ui: { setStatus: () => {} } } as unknown as ExtensionCommandContext;

    const sender = createThreadStore(stubPi, fake);
    sender.threadId = "sender";
    sender.threadsRootDir = "/virtual";
    sender.threadDir = "/virtual/sender";
    await sender.writeFile();
    const senderInbox = createInbox(sender, stubPi);

    const receiver = createThreadStore(stubPi, fake);
    receiver.threadId = "receiver";
    receiver.threadsRootDir = "/virtual";
    receiver.threadDir = "/virtual/receiver";
    await receiver.writeFile();
    const receiverInbox = createInbox(receiver, stubPi);

    const { delivered } = await senderInbox.sendCrossThread(
      "receiver",
      "Note",
      "hi from fake adapter",
    );
    assert.strictEqual(delivered, "live"); // receiver's state.json already exists and is fresh

    await receiverInbox.drainInbox(ctx);
    assert.strictEqual(calls.length, 1);
    assert.match(calls[0].content, /hi from fake adapter/);
  });

  it("transition persists through adapter.saveState, not raw fs", async () => {
    const fake = createFakeAdapter();
    const stubPi = {
      sendUserMessage: () => {},
      registerTool: () => {},
      registerCommand: () => {},
    } as unknown as ExtensionAPI;
    const store = createThreadStore(stubPi, fake);
    store.threadId = "solo";
    store.threadDir = "/virtual/solo";
    await store.transition("open");
    const loaded = await fake.loadState("solo");
    assert.strictEqual(loaded?.state, "open");
  });
});

describe("restate: buildWakeLaunch", () => {
  const wake = { id: "wake.t1.1", fireAt: new Date().toISOString(), reason: "resume the report" };

  it("spawns pi against the restate backend, in the thread's own cwd", () => {
    const l = buildWakeLaunch("t1", wake, "/work/space", {});
    assert.strictEqual(l.cmd, "pi");
    assert.strictEqual(l.cwd, "/work/space");
    const args = l.args.join(" ");
    assert.match(args, /--thread-id t1/);
    assert.match(args, /--thread-storage restate/);
    assert.match(args, /--thread-storage-url http:\/\/localhost:8080/);
    assert.match(args, /--print \[scheduled wake #wake\.t1\.1\]: resume the report/);
    assert.doesNotMatch(args, /--extension/); // only when PI_THREAD_EXTENSION is set
  });

  it("honors RESTATE_INGRESS_URL, PI_THREAD_EXTENSION, and PI_BIN from the service environment", () => {
    const l = buildWakeLaunch("t1", wake, "/w", {
      RESTATE_INGRESS_URL: "http://restate.internal:8080",
      PI_THREAD_EXTENSION: "/opt/pi-threading/src/index.ts",
      PI_BIN: "/opt/pi/bin/pi",
    });
    assert.strictEqual(l.cmd, "/opt/pi/bin/pi");
    const args = l.args.join(" ");
    assert.match(args, /--thread-storage-url http:\/\/restate\.internal:8080/);
    assert.match(args, /--extension \/opt\/pi-threading\/src\/index\.ts/);
  });
});

describe("bin/thread-cli.mjs: external observability", () => {
  const cli = join(import.meta.dirname, "..", "bin", "thread-cli.mjs");
  const runCli = (dir: string, ...cliArgs: string[]) =>
    execFileSync(process.execPath, [cli, ...cliArgs, "--dir", dir], { encoding: "utf8" });

  async function seedCoordination(h: Harness) {
    h.store.obligations.push({
      requestId: "brief.t1.1",
      type: "Brief",
      to: "alice",
      summary: "build the lexer",
      sentAt: new Date().toISOString(),
      deadline: new Date(Date.now() + 60_000).toISOString(),
    });
    h.store.owed.push({
      requestId: "q.boss.1",
      type: "Question",
      from: "boss",
      summary: "which parser?",
      receivedAt: new Date().toISOString(),
    });
    h.store.barriers.push({
      id: "barrier.t1.1",
      pending: ["brief.t1.1"],
      mode: "all",
      createdAt: new Date().toISOString(),
    });
    h.store.schedules.push({
      id: "wake.t1.1",
      fireAt: new Date(Date.now() + 120_000).toISOString(),
      reason: "check CI",
    });
    await h.store.writeFile();
  }

  it("status itemizes obligations, owed, barriers, schedules, and pending inbox", async () => {
    const h = makeHarness(tmpDir);
    await seedCoordination(h);
    seedInboxMessage(h, "t1", {
      from: "alice",
      type: "Note",
      body: "queued while away",
      requestId: "note.alice.1",
    });
    const out = runCli(h.dir, "status", "t1");
    assert.match(out, /Brief to alice #brief\.t1\.1 "build the lexer" .*due in/);
    assert.match(out, /Answer to boss for their Question #q\.boss\.1 "which parser\?"/);
    assert.match(out, /barrier\.t1\.1 \(all\) pending: brief\.t1\.1/);
    assert.match(out, /wake\.t1\.1 fires in .*"check CI"/);
    assert.match(out, /Inbox pending \(1\):/);
    assert.match(out, /\[Note alice→t1 #note\.alice\.1\]/);
  });

  it("status --json dumps the raw state plus pending inbox", async () => {
    const h = makeHarness(tmpDir);
    await seedCoordination(h);
    const parsed = JSON.parse(runCli(h.dir, "status", "t1", "--json"));
    assert.strictEqual(parsed.id, "t1");
    assert.strictEqual(parsed.barriers.length, 1);
    assert.strictEqual(parsed.owed.length, 1);
    assert.deepStrictEqual(parsed.inboxPending, []);
  });

  it("status errors for an unknown thread", () => {
    const h = makeHarness(tmpDir);
    void h;
    assert.throws(() => runCli(tmpDir, "status", "ghost"));
  });

  it("list table carries coordination-count columns", async () => {
    const h = makeHarness(tmpDir);
    await seedCoordination(h);
    const out = runCli(h.dir, "list");
    assert.match(out, /OBLG\s+OWED\s+BARR\s+SCHED\s+INBOX/);
    assert.match(out, /t1\s+/);
    const row = out.split("\n").find(l => l.startsWith("t1"))!;
    assert.match(row, /1\s+1\s+1\s+1\s+0/); // oblg owed barr sched inbox
  });
});

describe("core: toSummary / formatThreadLine coordination counts", () => {
  it("thread_list lines show non-zero coordination counts only", async () => {
    const h = makeHarness(tmpDir);
    seedRemoteThread(h, "alice");
    h.store.obligations.push({
      requestId: "b.1",
      type: "Brief",
      to: "alice",
      summary: "x",
      sentAt: new Date().toISOString(),
    });
    await h.store.writeFile();
    const r = await callTool(h, "thread_list");
    const own = (r.details.threads as ThreadSummary[]).find(t => t.id === "t1")!;
    assert.strictEqual(own.obligations, 1);
    assert.strictEqual(own.owed, 0);
    const text = r.content[0].text;
    const ownLine = text.split("\n").find((l: string) => l.startsWith("t1"))!;
    assert.match(ownLine, /obligations=1/);
    assert.doesNotMatch(ownLine, /owed=/);
    // seedRemoteThread writes a legacy state.json without owed/schedules —
    // counts must tolerate that instead of crashing.
    const alice = (r.details.threads as ThreadSummary[]).find(t => t.id === "alice")!;
    assert.strictEqual(alice.owed, 0);
  });
});

describe("state: watcher idempotency", () => {
  it("startWatcher twice keeps exactly one live watch; stopWatcher is idempotent", () => {
    let active = 0;
    const counting: StorageAdapter = {
      ...createFakeAdapter(),
      watchInbox() {
        active++;
        return () => active--;
      },
    };
    const stubPi = {
      sendUserMessage: () => {},
      registerTool: () => {},
      registerCommand: () => {},
    } as unknown as ExtensionAPI;
    const store = createThreadStore(stubPi, counting);
    store.threadId = "w1";
    const ctx = { ui: { setStatus: () => {} } } as unknown as ExtensionContext;
    store.startWatcher(() => {}, ctx);
    store.startWatcher(() => {}, ctx); // e.g. a second session_start
    assert.strictEqual(active, 1);
    store.stopWatcher();
    assert.strictEqual(active, 0);
    store.stopWatcher();
    assert.strictEqual(active, 0);
  });
});
