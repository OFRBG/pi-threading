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
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { createThreadStore, journalFingerprint, isDuplicateOfLastEntry } from "../src/state";
import { createInbox } from "../src/inbox";
import { registerTools } from "../src/tools";
import { registerCommands } from "../src/commands";
import { journalSignature, shouldJournal } from "../src/lifecycle";

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
  store.threadId = id;
  store.threadsRootDir = join(dir, ".thread", "threads");
  store.threadDir = join(store.threadsRootDir, id);
  mkdirSync(join(store.threadDir, "inbox", "processed"), { recursive: true });

  const inbox = createInbox(store, stubPi);
  registerTools(stubPi, store, inbox);
  registerCommands(stubPi, store, inbox);
  store.writeFile(); // state.json exists from the start, matching real session_start

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
    const r = await callTool(h, "thread_sync_request", { partner: "alice" });
    assert.strictEqual(r.details.ok, true);
    assert.strictEqual(h.store.lockPartner, "alice");
    assert.strictEqual(h.store.lockType, "sync");
    assert.strictEqual(h.store.state, "in-sync");
    assert.strictEqual(inboxFileCount(h, "alice"), 1);
  });

  it("returns locked when already in sync with someone else", async () => {
    const h = makeHarness(tmpDir);
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

  it("close releases the lock, fires local subscribers, and notifies the partner", async () => {
    const h = makeHarness(tmpDir);
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
  it("a Result that resolves a barrier sends exactly one message", () => {
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

    h.inbox.deliver(
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

  it("an Answer clears only the matching obligation", () => {
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
    h.inbox.deliver(
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

  it("clears the lock only when the incoming requestId matches lockEventId", () => {
    const h = makeHarness(tmpDir);
    h.store.lockEventId = "q.1";
    h.store.lockPartner = "alice";
    h.store.lockType = "reply";
    h.store.state = "listening";
    h.inbox.deliver(
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

  it("Sync is accepted and locks this thread when unlocked", () => {
    const h = makeHarness(tmpDir);
    h.inbox.deliver(
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

  it("Sync auto-rejects (sends an Answer back) when already locked", () => {
    const h = makeHarness(tmpDir);
    h.store.lockEventId = "sync.bob.1";
    h.store.lockPartner = "bob";
    h.store.lockType = "sync";
    h.inbox.deliver(
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

  it('"any" mode resolves on the first reply, ignoring the rest', () => {
    const h = makeHarness(tmpDir);
    h.store.barriers.push({
      id: "b.1",
      pending: ["a.1", "a.2"],
      mode: "any",
      createdAt: new Date().toISOString(),
    });
    h.inbox.deliver(
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

  it('"all" mode waits for every pending id before resolving', () => {
    const h = makeHarness(tmpDir);
    h.store.barriers.push({
      id: "b.1",
      pending: ["a.1", "a.2"],
      mode: "all",
      createdAt: new Date().toISOString(),
    });
    h.inbox.deliver(
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

  it("multiple barriers resolved by one requestId fold into one message", () => {
    const h = makeHarness(tmpDir);
    h.store.barriers.push(
      { id: "b.1", pending: ["a.1"], mode: "all", createdAt: new Date().toISOString() },
      { id: "b.2", pending: ["a.1", "a.2"], mode: "any", createdAt: new Date().toISOString() },
    );
    h.inbox.deliver(
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

describe("inbox: drainInbox", () => {
  it("skips malformed JSON without crashing or redelivering it", () => {
    const h = makeHarness(tmpDir);
    const inboxDir = join(h.store.threadDir, "inbox");
    writeFileSync(join(inboxDir, "1-bad.json"), "{not valid json");
    assert.doesNotThrow(() => h.inbox.drainInbox(h.ctx));
    assert.strictEqual(h.calls.length, 0);
    assert.ok(existsSync(join(inboxDir, "1-bad.json"))); // left in place, not moved
  });

  it("processes files in FIFO filename order", () => {
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
    h.inbox.drainInbox(h.ctx);
    assert.strictEqual(h.calls.length, 2);
    assert.match(h.calls[0].content, /first/);
    assert.match(h.calls[1].content, /second/);
  });
});

describe("inbox: checkDeadlines", () => {
  it("an overdue obligation nudges once and not twice", () => {
    const h = makeHarness(tmpDir);
    h.store.obligations.push({
      requestId: "brief.t1.1",
      type: "Brief",
      to: "alice",
      summary: "task",
      sentAt: new Date().toISOString(),
      deadline: new Date(Date.now() - 1000).toISOString(),
    });
    h.inbox.checkDeadlines();
    assert.strictEqual(h.calls.length, 1);
    assert.match(h.calls[0].content, /obligation overdue #brief\.t1\.1/);
    assert.strictEqual(h.store.obligations[0].nudged, true);
    h.inbox.checkDeadlines();
    assert.strictEqual(h.calls.length, 1);
  });

  it("an overdue barrier nudges once and not twice", () => {
    const h = makeHarness(tmpDir);
    h.store.barriers.push({
      id: "barrier.t1.1",
      pending: ["brief.t1.1"],
      mode: "all",
      createdAt: new Date().toISOString(),
      deadline: new Date(Date.now() - 1000).toISOString(),
    });
    h.inbox.checkDeadlines();
    assert.strictEqual(h.calls.length, 1);
    assert.match(h.calls[0].content, /barrier overdue "barrier\.t1\.1"/);
    assert.strictEqual(h.store.barriers[0].nudged, true);
    h.inbox.checkDeadlines();
    assert.strictEqual(h.calls.length, 1);
  });

  it("no nudge before the deadline passes", () => {
    const h = makeHarness(tmpDir);
    h.store.obligations.push({
      requestId: "brief.t1.1",
      type: "Brief",
      to: "alice",
      summary: "task",
      sentAt: new Date().toISOString(),
      deadline: new Date(Date.now() + 60_000).toISOString(),
    });
    h.inbox.checkDeadlines();
    assert.strictEqual(h.calls.length, 0);
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
    const h = makeHarness(tmpDir);
    const journalPath = join(h.store.threadDir, "journal.md");
    writeFileSync(journalPath, journalEntry(nowStamp(), "task A", "same done line"));
    const dup =
      "Working on: task A\nDone: same done line\nDoing: something new\nNext: ship\nBlockers: none";
    assert.strictEqual(isDuplicateOfLastEntry(journalPath, dup), true);
  });

  it("isDuplicateOfLastEntry does not match genuinely different content", () => {
    const h = makeHarness(tmpDir);
    const journalPath = join(h.store.threadDir, "journal.md");
    writeFileSync(journalPath, journalEntry(nowStamp(), "task A", "wrote the middleware"));
    const fresh =
      "Working on: task A\nDone: fixed the bug\nDoing: tests\nNext: ship\nBlockers: none";
    assert.strictEqual(isDuplicateOfLastEntry(journalPath, fresh), false);
  });

  it("isDuplicateOfLastEntry returns false when no journal file exists yet", () => {
    assert.strictEqual(isDuplicateOfLastEntry(join(tmpDir, "nope.md"), "Working on: x"), false);
  });
});

describe("lifecycle: journalSignature / shouldJournal", () => {
  it("an unchanged signature with no tool call skips journaling after the first check", () => {
    const h = makeHarness(tmpDir);
    assert.strictEqual(shouldJournal(h.store, false), true); // first call always differs from initial null
    assert.strictEqual(shouldJournal(h.store, false), false);
  });

  it("a tool call always journals even if the signature is unchanged", () => {
    const h = makeHarness(tmpDir);
    shouldJournal(h.store, false);
    assert.strictEqual(shouldJournal(h.store, true), true);
  });

  it("a changed signature journals even without a tool call", () => {
    const h = makeHarness(tmpDir);
    shouldJournal(h.store, false);
    h.store.state = "listening";
    assert.strictEqual(shouldJournal(h.store, false), true);
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
