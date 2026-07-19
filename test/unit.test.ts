/**
 * Fast, deterministic tests — no subprocess, no model call. Every tool and
 * slash command is reachable directly via a capture harness that stubs
 * `pi.registerTool`/`pi.registerCommand`, so their deterministic logic
 * (targeting, correlation, dedup, error handling) is tested here rather than
 * through a live model call. See TESTING.md before adding a test — the short
 * version: if the test's outcome doesn't depend on what a model decides, it
 * belongs in this file, not test/e2e.test.ts.
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
  utimesSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { createStore } from "../src/state";
import { createInbox } from "../src/inbox";
import type { Injection } from "../src/inbox";
import { registerLifecycle } from "../src/lifecycle/lifecycle";
import { registerTools } from "../src/tools/index";
import { registerCommands } from "../src/commands/commands";
import type { ThreadingContext, ThreadingState } from "../src/context";
import { journalSignature, shouldJournal, JOURNAL_MIN_INTERVAL_MS } from "../src/journal";
import { createAdapter } from "../src/adapter/local-fs";
import type { StorageAdapter } from "../src/adapter/types";
import type { StateFile, Mail, ThreadSummary } from "../src/core/types";
import { STALE_MS, PROCESSED_TTL_MS, CLIENT_CAPABILITIES, toSummary } from "../src/core/types";
import { ulid, mintMailId } from "../src/core/ids";

// --- harness -----------------------------------------------------------

/** LocalFsAdapter's on-disk layout (`src/adapter/local-fs.ts`) — the store
 *  itself has no notion of a filesystem path, so tests that reach past the
 *  adapter to poke at fixture files compute it here instead. */
function threadsRoot(dir: string): string {
  return join(dir, ".thread", "threads");
}
function threadDirFor(dir: string, id: string): string {
  return join(threadsRoot(dir), id);
}

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

  const state: ThreadingState = {
    active: true,
    toolUsedThisTurn: false,
    inFlightSince: null,
    compactingSince: null,
  };
  const store = createStore(stubPi, createAdapter({ "base-dir": dir }), state);
  // No internal `await` in LocalFsAdapter.configure — this synchronously
  // sets its root before the call returns, same reasoning as persist()
  // below, so the harness doesn't need to become async just for this.
  void store.adapter.configure();
  store.threadId = id;
  mkdirSync(join(threadDirFor(dir, id), "inbox", "processed"), { recursive: true });

  const inbox = createInbox(stubPi, store, state);
  const threading: ThreadingContext = {
    pi: stubPi,
    store,
    inbox,
    state,
  };
  registerTools(threading);
  registerCommands(threading);
  // Fire-and-forget: LocalFsAdapter's writes have no internal `await`, so the
  // fs side effect (state.json existing, matching real session_start) has
  // already happened synchronously by the time this call returns, even
  // though the returned promise itself settles a microtask later.
  void store.persist();

  // Mutable so gate tests can flip between "agent idle" (injections start a
  // run) and "agent streaming" (injections queue). Default mirrors mid-run.
  const agent = { idle: false };

  const ctx = {
    ui: {
      setStatus: () => {},
      notify: (text: string, level?: string) => notifications.push({ text, level }),
    },
    isIdle: () => agent.idle,
    waitForIdle: async () => {},
  } as unknown as ExtensionCommandContext;

  return {
    store,
    inbox,
    threading,
    tools,
    commands,
    ctx,
    calls,
    notifications,
    dir,
    get idle() {
      return agent.idle;
    },
    set idle(v: boolean) {
      agent.idle = v;
    },
  };
}

type Harness = ReturnType<typeof makeHarness>;

function callTool(h: Harness, name: string, params: unknown = {}) {
  return h.tools[name].execute("test", params, undefined, undefined, h.ctx);
}

function callCommand(h: Harness, name: string, args = "") {
  return h.commands[name].handler(args, h.ctx);
}

function seedRemoteThread(h: Harness, id: string, opts: { role?: string; stale?: boolean } = {}) {
  const dir = threadDirFor(h.dir, id);
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
      holdReason: null,
      obligations: [],
      owed: [],
      barriers: [],
      startedAt: lastSeen,
      lastSeen,
      updatedAt: lastSeen,
    }),
  );
}

/** Write an envelope file directly into a thread's inbox, the way an
 *  external C1 actor would (Appendix B). `name` controls FIFO order. */
function seedEnvelope(
  h: Harness,
  ownId: string,
  msg: Partial<Mail> & { from: string; body: string },
  name = `${ulid()}.json`,
) {
  const dir = join(threadDirFor(h.dir, ownId), "inbox");
  mkdirSync(dir, { recursive: true });
  const envelope: Mail = {
    id: msg.id ?? mintMailId(msg.from),
    to: ownId,
    sentAt: new Date().toISOString(),
    ...msg,
  } as Mail;
  writeFileSync(join(dir, name), JSON.stringify(envelope));
  return envelope;
}

function inboxFileCount(h: Harness, id: string): number {
  const dir = join(threadDirFor(h.dir, id), "inbox");
  if (!existsSync(dir)) return 0;
  return readdirSync(dir).filter(f => f.endsWith(".json")).length;
}

function readInboxFile(h: Harness, id: string, index = 0): Mail {
  const dir = join(threadDirFor(h.dir, id), "inbox");
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
  const dir = threadDirFor(h.dir, id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "journal.md"), content.trim() + "\n");
}

function owedRecord(from: string, id: string, summary = "?") {
  return { id, from, summary, receivedAt: new Date().toISOString() };
}

// A second harness, separate from makeHarness above: that one sets
// store.threadId directly and never touches lifecycle.ts, so it can't
// exercise the opt-in gate that lives in registerLifecycle's session_start
// handler. This one goes through the real pi.on(...) wiring instead.
type CustomEntry = { type: "custom"; customType: string; data?: unknown };

type SentMessage = { customType: string; content: string };

function makeLifecycleHarness(dir: string) {
  const handlers: Record<string, (event: unknown, ctx: unknown) => unknown> = {};
  const setActiveToolsCalls: string[][] = [];
  const sentMessages: SentMessage[] = [];
  const registeredThreadTools = [
    "thread_status",
    "thread_list",
    "thread_journal",
    "thread_send",
    "thread_wait",
    "thread_suspend",
    "thread_resume",
  ];
  let activeTools = [...registeredThreadTools, "bash", "read_file"]; // some unrelated tool too

  const flags: Record<string, string | boolean | undefined> = {};

  const stubPi = {
    on: (event: string, handler: (event: unknown, ctx: unknown) => unknown) => {
      handlers[event] = handler;
    },
    getFlag: (name: string) => flags[name],
    getActiveTools: () => activeTools,
    setActiveTools: (names: string[]) => {
      setActiveToolsCalls.push(names);
      activeTools = names;
    },
    sendMessage: (msg: SentMessage) => {
      sentMessages.push({ customType: msg.customType, content: msg.content });
    },
    sendUserMessage: () => {},
    appendEntry: () => {},
  } as unknown as ExtensionAPI;

  const state: ThreadingState = {
    active: false,
    toolUsedThisTurn: false,
    inFlightSince: null,
    compactingSince: null,
  };
  const store = createStore(stubPi, createAdapter({ "base-dir": dir }), state);
  const inbox = createInbox(stubPi, store, state);
  const threading: ThreadingContext = {
    pi: stubPi,
    store,
    inbox,
    state,
  };
  registerLifecycle(threading);

  function makeCtx(entries: CustomEntry[] = []) {
    return {
      cwd: dir,
      ui: { setStatus: () => {}, notify: () => {} },
      sessionManager: {
        getEntries: () => entries,
        getSessionFile: () => undefined,
      },
      isIdle: () => true,
    } as unknown as ExtensionContext;
  }

  return {
    store,
    inbox,
    dir,
    setFlag(name: string, value: string) {
      flags[name] = value;
    },
    fire(event: string, ctx: unknown, payload: unknown = {}) {
      return handlers[event]?.(payload, ctx);
    },
    makeCtx,
    setActiveToolsCalls,
    sentMessages,
    get activeTools() {
      return activeTools;
    },
    registeredThreadTools,
  };
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
    const r = await callTool(h, "thread_send", { to: "alice", body: "hi" });
    assert.strictEqual(r.details.ok, true);
    assert.strictEqual(r.details.sent.length, 1);
    assert.strictEqual(r.details.sent[0].to, "alice");
  });

  it('to="*" fans out to every known thread except self', async () => {
    const h = makeHarness(tmpDir);
    seedRemoteThread(h, "alice");
    seedRemoteThread(h, "bob");
    const r = await callTool(h, "thread_send", { to: "*", body: "standup" });
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
    const r = await callTool(h, "thread_send", { to: "role:dev", body: "hi" });
    assert.strictEqual(r.details.sent.length, 1);
    assert.strictEqual(r.details.sent[0].to, "alice");
  });

  it("comma-separated targets exclude self", async () => {
    const h = makeHarness(tmpDir);
    const r = await callTool(h, "thread_send", { to: "alice,t1,bob", body: "hi" });
    assert.deepStrictEqual(r.details.sent.map((s: { to: string }) => s.to).sort(), [
      "alice",
      "bob",
    ]);
  });

  it("a reply (re) with no matching owed record gets a soft warning, not a failure", async () => {
    const h = makeHarness(tmpDir);
    seedRemoteThread(h, "alice");
    const r = await callTool(h, "thread_send", { to: "alice", body: "ok", re: "alice/999" });
    assert.strictEqual(r.details.ok, true);
    assert.match(r.content[0].text, /no owed reply matches re "alice\/999"/);
  });

  it("a reply to the wrong thread for a real owed id warns with the correct target", async () => {
    const h = makeHarness(tmpDir);
    seedRemoteThread(h, "alice");
    seedRemoteThread(h, "bob");
    h.store.owed.push(owedRecord("alice", "alice/q1"));
    const r = await callTool(h, "thread_send", { to: "bob", body: "ok", re: "alice/q1" });
    assert.strictEqual(r.details.ok, true);
    assert.match(r.content[0].text, /owed to alice, not "bob"/);
  });

  it("a correctly targeted reply carries no warning", async () => {
    const h = makeHarness(tmpDir);
    seedRemoteThread(h, "alice");
    h.store.owed.push(owedRecord("alice", "alice/q1"));
    const r = await callTool(h, "thread_send", { to: "alice", body: "ok", re: "alice/q1" });
    assert.strictEqual(r.details.ok, true);
    assert.doesNotMatch(r.content[0].text, /Warning/);
  });

  it("expects=true records an obligation with the default deadline (§9.2)", async () => {
    const h = makeHarness(tmpDir);
    seedRemoteThread(h, "alice");
    await callTool(h, "thread_send", { to: "alice", body: "do it", expects: true });
    assert.strictEqual(h.store.obligations.length, 1);
    assert.ok(h.store.obligations[0].deadline, "default deadline must be applied");
  });

  it("an explicit deadlineSeconds overrides the default", async () => {
    const h = makeHarness(tmpDir);
    seedRemoteThread(h, "alice");
    await callTool(h, "thread_send", {
      to: "alice",
      body: "do it",
      expects: true,
      deadlineSeconds: 60,
    });
    const d = new Date(h.store.obligations[0].deadline!).getTime() - Date.now();
    assert.ok(d > 50_000 && d < 70_000, `deadline ~60s out, got ${d}ms`);
  });

  it("a plain note creates no obligation and no owed record", async () => {
    const h = makeHarness(tmpDir);
    seedRemoteThread(h, "alice");
    await callTool(h, "thread_send", { to: "alice", body: "fyi" });
    assert.strictEqual(h.store.obligations.length, 0);
    const written = readInboxFile(h, "alice");
    assert.strictEqual(written.expects, undefined);
    assert.strictEqual(written.re, undefined);
  });

  it("re + expects together (reply+request) discharges the old debt and opens a new one", async () => {
    const h = makeHarness(tmpDir);
    seedRemoteThread(h, "alice");
    h.store.owed.push(owedRecord("alice", "alice/q1", "what's the ETA?"));
    const r = await callTool(h, "thread_send", {
      to: "alice",
      body: "need the deploy env first — which one?",
      re: "alice/q1",
      expects: true,
    });
    assert.strictEqual(r.details.ok, true);
    // Old debt discharged (ball passed)...
    assert.strictEqual(h.store.owed.length, 0);
    // ...new debt opened the other way.
    assert.strictEqual(h.store.obligations.length, 1);
    const written = readInboxFile(h, "alice");
    assert.strictEqual(written.re, "alice/q1");
    assert.strictEqual(written.expects, true);
  });

  it("wait=true with expects arms a barrier carrying the given deadline", async () => {
    const h = makeHarness(tmpDir);
    seedRemoteThread(h, "alice");
    const r = await callTool(h, "thread_send", {
      to: "alice",
      body: "do it",
      expects: true,
      deadlineSeconds: 120,
      wait: true,
    });
    assert.match(r.content[0].text, /Waiting \(barrier/);
    assert.strictEqual(h.store.barriers.length, 1);
    assert.ok(h.store.barriers[0].deadline);
    assert.deepStrictEqual(h.store.barriers[0].pending, [r.details.sent[0].id]);
  });

  it("wait=true without expects is ignored with a note", async () => {
    const h = makeHarness(tmpDir);
    seedRemoteThread(h, "alice");
    const r = await callTool(h, "thread_send", { to: "alice", body: "fyi", wait: true });
    assert.match(r.content[0].text, /wait=true ignored/);
    assert.strictEqual(h.store.barriers.length, 0);
  });

  it("a send to a never-seen id queues durably but carries a typo warning", async () => {
    const h = makeHarness(tmpDir);
    const r = await callTool(h, "thread_send", { to: "ghost", body: "hello?", expects: true });
    assert.strictEqual(r.details.ok, true);
    assert.match(r.content[0].text, /never been seen in this workspace/);
    assert.strictEqual(inboxFileCount(h, "ghost"), 1);
  });

  it("a send to a known thread carries no typo warning", async () => {
    const h = makeHarness(tmpDir);
    seedRemoteThread(h, "alice");
    const r = await callTool(h, "thread_send", { to: "alice", body: "hi" });
    assert.doesNotMatch(r.content[0].text, /never been seen/);
  });

  it("an immediate self-send is refused", async () => {
    const h = makeHarness(tmpDir);
    const r = await callTool(h, "thread_send", { to: "t1", body: "note to self" });
    assert.strictEqual(r.details.ok, false);
    assert.match(r.content[0].text, /deliverAfterSeconds/);
  });

  it("a self-send with deliverAfterSeconds is a scheduled wake (§12.2)", async () => {
    const h = makeHarness(tmpDir);
    const r = await callTool(h, "thread_send", {
      to: "t1",
      body: "check CI",
      deliverAfterSeconds: 120,
    });
    assert.strictEqual(r.details.ok, true);
    const written = readInboxFile(h, "t1");
    assert.strictEqual(written.to, "t1");
    assert.strictEqual(written.from, "t1");
    assert.ok(written.deliverAfter, "deliverAfter must be set");
    const holdMs = new Date(written.deliverAfter!).getTime() - Date.now();
    assert.ok(holdMs > 110_000 && holdMs < 130_000, `~120s hold, got ${holdMs}ms`);
  });

  it("urgency=high is written on the wire; low is absence (§6)", async () => {
    const h = makeHarness(tmpDir);
    seedRemoteThread(h, "alice");
    await callTool(h, "thread_send", { to: "alice", body: "now!", urgency: "high" });
    await callTool(h, "thread_send", { to: "alice", body: "later" });
    const first = readInboxFile(h, "alice", 0);
    const second = readInboxFile(h, "alice", 1);
    assert.strictEqual(first.urgency, "high");
    assert.strictEqual(second.urgency, undefined);
  });
});

describe("Errata 1: misdirected replies do not discharge the owed ledger (§9.1)", () => {
  it("a reply sent to the wrong thread leaves the owed record intact", async () => {
    const h = makeHarness(tmpDir);
    seedRemoteThread(h, "alice");
    seedRemoteThread(h, "bob");
    h.store.owed.push(owedRecord("alice", "alice/q1"));
    await callTool(h, "thread_send", { to: "bob", body: "ok", re: "alice/q1" });
    assert.strictEqual(h.store.owed.length, 1, "misdirected reply must not discharge");
  });

  it("a reply reaching the correct owed thread discharges it, on disk too", async () => {
    const h = makeHarness(tmpDir);
    seedRemoteThread(h, "alice");
    h.store.owed.push(owedRecord("alice", "alice/q1"));
    await h.store.persist();
    await callTool(h, "thread_send", { to: "alice", body: "ok", re: "alice/q1" });
    assert.strictEqual(h.store.owed.length, 0);
    const onDisk = JSON.parse(
      readFileSync(join(threadDirFor(h.dir, h.store.threadId), "state.json"), "utf8"),
    ) as StateFile;
    assert.strictEqual(onDisk.owed.length, 0);
  });
});

describe("Errata 1, obligation side: misdirected replies do not clear the sender's ledger (§9.3)", () => {
  function seedObligation(h: Harness, id: string, to: string) {
    h.store.obligations.push({
      id,
      to,
      summary: "do the thing",
      sentAt: new Date().toISOString(),
    });
  }

  it("a reply from the wrong thread leaves the obligation and its barrier intact", async () => {
    const h = makeHarness(tmpDir);
    seedObligation(h, "t1/q1", "alice");
    h.store.barriers.push({
      id: "barrier.t1.1",
      pending: ["t1/q1"],
      mode: "all",
      createdAt: new Date().toISOString(),
    });
    seedEnvelope(h, "t1", { from: "bob", body: "done!", re: "t1/q1" });
    await h.inbox.drain(h.ctx);
    assert.strictEqual(h.store.obligations.length, 1, "wrong sender must not discharge");
    assert.strictEqual(h.store.barriers.length, 1, "wrong sender must not resolve the barrier");
    assert.deepStrictEqual(h.store.barriers[0].pending, ["t1/q1"]);
    // The envelope still renders — as an inert reply, not a discharge.
    assert.strictEqual(h.calls.length, 1);
    assert.doesNotMatch(h.calls[0].content, /barrier .* resolved/);
  });

  it("the real reply still discharges and resolves after a misdirected one", async () => {
    const h = makeHarness(tmpDir);
    seedObligation(h, "t1/q1", "alice");
    h.store.barriers.push({
      id: "barrier.t1.1",
      pending: ["t1/q1"],
      mode: "all",
      createdAt: new Date().toISOString(),
    });
    seedEnvelope(h, "t1", { from: "bob", body: "done!", re: "t1/q1" }, "0-bob.json");
    seedEnvelope(h, "t1", { from: "alice", body: "actually done", re: "t1/q1" }, "1-alice.json");
    await h.inbox.drain(h.ctx);
    assert.strictEqual(h.store.obligations.length, 0, "correct sender discharges");
    assert.strictEqual(h.store.barriers.length, 0, "correct sender resolves the barrier");
  });
});

describe("expiresAt: stale mail self-discards at drain (Rev 10 §6)", () => {
  it("an expired envelope is claimed into processed/ but never delivered", async () => {
    const h = makeHarness(tmpDir);
    seedEnvelope(h, "t1", {
      from: "alice",
      body: "standup in 5 min",
      expiresAt: new Date(Date.now() - 1000).toISOString(),
    });
    seedEnvelope(h, "t1", { from: "alice", body: "still relevant" });
    await h.inbox.drain(h.ctx);
    assert.strictEqual(h.calls.length, 1, "only the unexpired envelope delivers");
    assert.match(h.calls[0].content, /still relevant/);
    assert.doesNotMatch(h.calls[0].content, /standup/);
    assert.strictEqual(inboxFileCount(h, "t1"), 0, "expired envelope is not left queued");
  });

  it("a future expiresAt does not block delivery", async () => {
    const h = makeHarness(tmpDir);
    seedEnvelope(h, "t1", {
      from: "alice",
      body: "hurry",
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });
    await h.inbox.drain(h.ctx);
    assert.strictEqual(h.calls.length, 1);
    assert.match(h.calls[0].content, /hurry/);
  });

  it("thread_send expiresAfterSeconds writes expiresAt on the wire", async () => {
    const h = makeHarness(tmpDir);
    seedRemoteThread(h, "alice");
    await callTool(h, "thread_send", { to: "alice", body: "now-ish", expiresAfterSeconds: 30 });
    const written = readInboxFile(h, "alice");
    assert.ok(written.expiresAt, "expiresAt must be set");
    const ttl = new Date(written.expiresAt!).getTime() - Date.now();
    assert.ok(ttl > 20_000 && ttl < 40_000, `~30s ttl, got ${ttl}ms`);
  });
});

describe("presence: capabilities and wake (Rev 10 §8.1)", () => {
  it("persist publishes the client capability tokens", async () => {
    const h = makeHarness(tmpDir);
    await h.store.persist();
    const onDisk = JSON.parse(
      readFileSync(join(threadDirFor(h.dir, h.store.threadId), "state.json"), "utf8"),
    ) as StateFile;
    assert.deepStrictEqual(onDisk.capabilities, [...CLIENT_CAPABILITIES]);
    assert.strictEqual(onDisk.wake, undefined, "no wake recipe unless the operator sets one");
  });
});

describe("local-fs: processed/ GC (Appendix B)", () => {
  it("drain prunes processed files older than PROCESSED_TTL_MS", async () => {
    const h = makeHarness(tmpDir, "gc1");
    const processed = join(threadDirFor(h.dir, h.store.threadId), "inbox", "processed");
    const oldFile = join(processed, "ancient.json");
    const freshFile = join(processed, "fresh.json");
    writeFileSync(oldFile, "{}");
    writeFileSync(freshFile, "{}");
    const past = new Date(Date.now() - PROCESSED_TTL_MS - 60_000);
    utimesSync(oldFile, past, past);
    await h.inbox.drain(h.ctx);
    assert.strictEqual(existsSync(oldFile), false, "expired file must be GC'd");
    assert.strictEqual(existsSync(freshFile), true, "fresh file must survive");
  });
});

describe("ids: envelope identity (§6.2)", () => {
  it("two sends in the same millisecond get distinct ids", async () => {
    const h = makeHarness(tmpDir);
    const [a] = await h.inbox.sendMany(["alice"], "one");
    const [b] = await h.inbox.sendMany(["alice"], "two");
    assert.notStrictEqual(a.id, b.id);
  });

  it("a fan-out send mints a distinct id per target", async () => {
    const h = makeHarness(tmpDir);
    seedRemoteThread(h, "alice");
    seedRemoteThread(h, "bob");
    const r = await callTool(h, "thread_send", { to: "*", body: "go", expects: true });
    const ids = r.details.sent.map((s: { id: string }) => s.id);
    assert.strictEqual(new Set(ids).size, 2);
  });

  it("envelope ids carry the sender scope: <from>/<ulid>", async () => {
    const h = makeHarness(tmpDir);
    const [{ id }] = await h.inbox.sendMany(["alice"], "hi");
    assert.match(id, /^t1\/[0-9A-HJKMNP-TV-Z]{26}$/);
  });
});

describe("tools: thread_wait", () => {
  it("arms a barrier with deadlineSeconds converted to an ISO deadline", async () => {
    const h = makeHarness(tmpDir);
    await callTool(h, "thread_wait", { ids: ["t1/a", "t1/b"], deadlineSeconds: 60 });
    assert.strictEqual(h.store.barriers.length, 1);
    assert.ok(h.store.barriers[0].deadline);
    assert.deepStrictEqual(h.store.barriers[0].pending, ["t1/a", "t1/b"]);
  });

  it("warns when an id has no matching obligation", async () => {
    const h = makeHarness(tmpDir);
    const r = await callTool(h, "thread_wait", { ids: ["t1/nope"] });
    assert.match(r.content[0].text, /no open obligation matches t1\/nope/);
  });

  it("does not warn when the id matches an open obligation", async () => {
    const h = makeHarness(tmpDir);
    seedRemoteThread(h, "alice");
    const send = await callTool(h, "thread_send", { to: "alice", body: "do", expects: true });
    const r = await callTool(h, "thread_wait", { ids: [send.details.sent[0].id] });
    assert.doesNotMatch(r.content[0].text, /Warning/);
  });

  it("stores an optional message payload on the barrier (§12.1)", async () => {
    const h = makeHarness(tmpDir);
    await callTool(h, "thread_wait", { ids: ["t1/a"], message: "now merge the results" });
    assert.strictEqual(h.store.barriers[0].message, "now merge the results");
  });
});

describe("tools: thread_suspend / thread_resume", () => {
  it("suspend sets on-hold with the given reason", async () => {
    const h = makeHarness(tmpDir);
    await callTool(h, "thread_suspend", { reason: "lunch" });
    assert.strictEqual(h.store.state, "on-hold");
    assert.strictEqual(h.store.holdReason, "lunch");
  });

  it("resume clears on-hold and drains the queued inbox", async () => {
    const h = makeHarness(tmpDir);
    await callTool(h, "thread_suspend", { reason: "wait" });
    seedEnvelope(h, "t1", { from: "alice", body: "queued while held" });
    await h.inbox.drain(h.ctx); // on-hold: must NOT deliver
    assert.strictEqual(h.calls.length, 0);
    await callTool(h, "thread_resume", {});
    assert.strictEqual(h.store.state, "open");
    assert.strictEqual(h.calls.length, 1);
    assert.match(h.calls[0].content, /queued while held/);
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
      id: "t1/b1",
      to: "alice",
      summary: "build the lexer",
      sentAt: new Date().toISOString(),
      deadline: new Date(Date.now() + 60_000).toISOString(),
    });
    h.store.barriers.push({
      id: "barrier.t1.1",
      pending: ["t1/b1"],
      mode: "all",
      createdAt: new Date().toISOString(),
    });
    const r = await callTool(h, "thread_status");
    const text = r.content[0].text;
    assert.match(text, /request to alice #t1\/b1 "build the lexer" \(deadline /);
    assert.match(text, /barrier\.t1\.1 \(all\) pending: t1\/b1/);
  });

  it("itemizes owed replies with the id to echo", async () => {
    const h = makeHarness(tmpDir);
    h.store.owed.push(owedRecord("boss", "boss/q1", "which parser?"));
    const r = await callTool(h, "thread_status");
    assert.match(
      r.content[0].text,
      /you owe a reply to boss for their request #boss\/q1 "which parser\?" — reply with re="boss\/q1"/,
    );
  });

  it("shows 'none' for empty obligations and barriers", async () => {
    const h = makeHarness(tmpDir);
    const r = await callTool(h, "thread_status");
    assert.match(r.content[0].text, /Obligations: none/);
    assert.match(r.content[0].text, /Barriers: none/);
  });
});

describe("tools: thread_list", () => {
  it("reports a stale thread as stopped regardless of its stored status", async () => {
    const h = makeHarness(tmpDir);
    seedRemoteThread(h, "ghost", { stale: true });
    const r = await callTool(h, "thread_list");
    const ghost = (r.details.threads as ThreadSummary[]).find(t => t.id === "ghost")!;
    assert.strictEqual(ghost.status, "stopped");
  });
});

describe("tools: thread_journal", () => {
  it("returns the full journal with no filters", async () => {
    const h = makeHarness(tmpDir);
    seedRemoteThread(h, "alice");
    writeJournal(h, "alice", journalEntry(nowStamp(), "task A") + journalEntry(nowStamp(), "B"));
    const r = await callTool(h, "thread_journal", { id: "alice" });
    assert.match(r.content[0].text, /task A/);
    assert.match(r.content[0].text, /Working on: B/);
  });

  it("tail limits to the last N entries", async () => {
    const h = makeHarness(tmpDir);
    seedRemoteThread(h, "alice");
    writeJournal(h, "alice", journalEntry(nowStamp(), "old") + journalEntry(nowStamp(), "newest"));
    const r = await callTool(h, "thread_journal", { id: "alice", tail: 1 });
    assert.doesNotMatch(r.content[0].text, /Working on: old/);
    assert.match(r.content[0].text, /Working on: newest/);
  });

  it("lookbackMinutes excludes entries older than the cutoff", async () => {
    const h = makeHarness(tmpDir);
    seedRemoteThread(h, "alice");
    const oldTs = stamp(new Date(Date.now() - 3 * 60 * 60_000));
    writeJournal(h, "alice", journalEntry(oldTs, "ancient") + journalEntry(nowStamp(), "fresh"));
    const r = await callTool(h, "thread_journal", { id: "alice", lookbackMinutes: 60 });
    assert.doesNotMatch(r.content[0].text, /Working on: ancient/);
    assert.match(r.content[0].text, /Working on: fresh/);
  });

  it("errors for an unknown thread id", async () => {
    const h = makeHarness(tmpDir);
    const r = await callTool(h, "thread_journal", { id: "ghost" });
    assert.strictEqual(r.details.ok, false);
  });
});

describe("inbox: receive (correlation, §9)", () => {
  it("a reply that resolves a barrier ships as exactly one message", async () => {
    const h = makeHarness(tmpDir);
    seedRemoteThread(h, "alice");
    const [sent] = await h.inbox.sendMany(["alice"], "do it", { expects: true });
    h.store.barriers.push({
      id: "b1",
      pending: [sent.id],
      mode: "all",
      createdAt: new Date().toISOString(),
    });
    seedEnvelope(h, "t1", { from: "alice", body: "done", re: sent.id });
    await h.inbox.drain(h.ctx);
    assert.strictEqual(h.calls.length, 1);
    assert.match(h.calls[0].content, /done/);
    assert.match(h.calls[0].content, /Barrier "b1" resolved/);
    assert.strictEqual(h.store.barriers.length, 0);
  });

  it("a reply clears only the matching obligation", async () => {
    const h = makeHarness(tmpDir);
    const [a] = await h.inbox.sendMany(["alice"], "one", { expects: true });
    const [b] = await h.inbox.sendMany(["bob"], "two", { expects: true });
    seedEnvelope(h, "t1", { from: "alice", body: "ok", re: a.id });
    await h.inbox.drain(h.ctx);
    assert.deepStrictEqual(
      h.store.obligations.map(o => o.id),
      [b.id],
    );
  });

  it('"any" mode resolves on the first reply, ignoring the rest', async () => {
    const h = makeHarness(tmpDir);
    const [a] = await h.inbox.sendMany(["alice"], "one", { expects: true });
    const [b] = await h.inbox.sendMany(["bob"], "two", { expects: true });
    h.store.barriers.push({
      id: "race",
      pending: [a.id, b.id],
      mode: "any",
      createdAt: new Date().toISOString(),
    });
    seedEnvelope(h, "t1", { from: "bob", body: "first!", re: b.id });
    await h.inbox.drain(h.ctx);
    assert.strictEqual(h.store.barriers.length, 0);
    assert.match(h.calls[0].content, /first reply arrived/);
  });

  it('"all" mode waits for every pending id before resolving', async () => {
    const h = makeHarness(tmpDir);
    const [a] = await h.inbox.sendMany(["alice"], "one", { expects: true });
    const [b] = await h.inbox.sendMany(["bob"], "two", { expects: true });
    h.store.barriers.push({
      id: "gate",
      pending: [a.id, b.id],
      mode: "all",
      createdAt: new Date().toISOString(),
    });
    seedEnvelope(h, "t1", { from: "alice", body: "ok", re: a.id });
    await h.inbox.drain(h.ctx);
    assert.strictEqual(h.store.barriers.length, 1);
    assert.deepStrictEqual(h.store.barriers[0].pending, [b.id]);
    seedEnvelope(h, "t1", { from: "bob", body: "ok", re: b.id });
    await h.inbox.drain(h.ctx);
    assert.strictEqual(h.store.barriers.length, 0);
    assert.match(h.calls[1].content, /all awaited replies have arrived/);
  });

  it("multiple barriers resolved by one reply fold into one delivery", async () => {
    const h = makeHarness(tmpDir);
    const [a] = await h.inbox.sendMany(["alice"], "one", { expects: true });
    h.store.barriers.push(
      { id: "b1", pending: [a.id], mode: "all", createdAt: new Date().toISOString() },
      { id: "b2", pending: [a.id], mode: "any", createdAt: new Date().toISOString() },
    );
    seedEnvelope(h, "t1", { from: "alice", body: "ok", re: a.id });
    await h.inbox.drain(h.ctx);
    assert.strictEqual(h.calls.length, 1);
    assert.match(h.calls[0].content, /Barrier "b1" resolved/);
    assert.match(h.calls[0].content, /Barrier "b2" resolved/);
  });

  it("a resolved barrier's message payload is injected alongside the reply (§12.1)", async () => {
    const h = makeHarness(tmpDir);
    const [a] = await h.inbox.sendMany(["alice"], "one", { expects: true });
    h.store.barriers.push({
      id: "b1",
      pending: [a.id],
      mode: "all",
      createdAt: new Date().toISOString(),
      message: "now merge the branches",
    });
    seedEnvelope(h, "t1", { from: "alice", body: "ok", re: a.id });
    await h.inbox.drain(h.ctx);
    assert.strictEqual(h.calls.length, 1);
    assert.match(h.calls[0].content, /now merge the branches/);
  });

  it("a reply+request discharges the pending wait AND records a new owed reply", async () => {
    const h = makeHarness(tmpDir);
    const [a] = await h.inbox.sendMany(["alice"], "do it", { expects: true });
    const counter = seedEnvelope(h, "t1", { from: "alice", body: "which env?", re: a.id, expects: true });
    await h.inbox.drain(h.ctx);
    // Their counter-request discharged our obligation...
    assert.strictEqual(h.store.obligations.length, 0);
    // ...and we now owe them a reply keyed by THEIR envelope id.
    assert.deepStrictEqual(
      h.store.owed.map(o => o.id),
      [counter.id],
    );
  });

  it("renders kind from field presence, with a reply hint on requests (§6.1)", async () => {
    const h = makeHarness(tmpDir);
    const req = seedEnvelope(h, "t1", { from: "alice", body: "need this", expects: true });
    await h.inbox.drain(h.ctx);
    assert.match(
      h.calls[0].content,
      new RegExp(`\\[Request from alice \\(#${req.id.replace("/", "\\/")}\\)\\]`),
    );
    assert.match(h.calls[0].content, /expects an answer/);
    seedEnvelope(h, "t1", { from: "alice", body: "fyi" });
    await h.inbox.drain(h.ctx);
    assert.match(h.calls[1].content, /\[Note from alice/);
    assert.doesNotMatch(h.calls[1].content, /expects an answer/);
  });
});

describe("inbox: owed replies (recipient-side durability)", () => {
  function requestEnvelope(
    from: string,
    id: string,
    body = "do the thing",
  ): Partial<Mail> & { from: string; body: string } {
    return { id, from, body, expects: true };
  }

  it("delivering a request records a durable owed reply with the id to echo", async () => {
    const h = makeHarness(tmpDir);
    seedEnvelope(h, "t1", requestEnvelope("boss", "boss/b1"));
    await h.inbox.drain(h.ctx);
    assert.strictEqual(h.store.owed.length, 1);
    assert.strictEqual(h.store.owed[0].id, "boss/b1");
    const onDisk = JSON.parse(
      readFileSync(join(threadDirFor(h.dir, h.store.threadId), "state.json"), "utf8"),
    ) as StateFile;
    assert.strictEqual(onDisk.owed[0]?.id, "boss/b1");
  });

  it("a note does not record an owed reply", async () => {
    const h = makeHarness(tmpDir);
    seedEnvelope(h, "t1", { id: "boss/n1", from: "boss", body: "fyi" });
    await h.inbox.drain(h.ctx);
    assert.strictEqual(h.store.owed.length, 0);
  });

  it("redelivering the same id does not double-record", async () => {
    const h = makeHarness(tmpDir);
    seedEnvelope(h, "t1", requestEnvelope("boss", "boss/b1"));
    await h.inbox.drain(h.ctx);
    seedEnvelope(h, "t1", requestEnvelope("boss", "boss/b1"));
    await h.inbox.drain(h.ctx);
    assert.strictEqual(h.store.owed.length, 1);
  });

  it("sending the matching reply settles the owed record", async () => {
    const h = makeHarness(tmpDir);
    seedRemoteThread(h, "boss");
    seedEnvelope(h, "t1", requestEnvelope("boss", "boss/b1"));
    await h.inbox.drain(h.ctx);
    await callTool(h, "thread_send", { to: "boss", body: "done", re: "boss/b1" });
    assert.strictEqual(h.store.owed.length, 0);
  });

  it("a reply with a different re leaves the owed record intact", async () => {
    const h = makeHarness(tmpDir);
    seedRemoteThread(h, "boss");
    seedEnvelope(h, "t1", requestEnvelope("boss", "boss/b1"));
    await h.inbox.drain(h.ctx);
    await callTool(h, "thread_send", { to: "boss", body: "unrelated", re: "boss/other" });
    assert.strictEqual(h.store.owed.length, 1);
  });
});

describe("inbox: drain", () => {
  it("skips malformed JSON without crashing or redelivering it", async () => {
    const h = makeHarness(tmpDir);
    const dir = join(threadDirFor(h.dir, "t1"), "inbox");
    writeFileSync(join(dir, "0-bad.json"), "{nope");
    seedEnvelope(h, "t1", { from: "alice", body: "good one" });
    await h.inbox.drain(h.ctx);
    assert.strictEqual(h.calls.length, 1);
    assert.match(h.calls[0].content, /good one/);
    assert.ok(existsSync(join(dir, "0-bad.json")), "malformed file stays put");
  });

  it("coalesces one drain into one message, envelopes in FIFO filename order", async () => {
    const h = makeHarness(tmpDir);
    seedEnvelope(h, "t1", { from: "alice", body: "FIRST" }, "1-a.json");
    seedEnvelope(h, "t1", { from: "bob", body: "SECOND" }, "2-b.json");
    await h.inbox.drain(h.ctx);
    assert.strictEqual(h.calls.length, 1);
    const text = h.calls[0].content;
    assert.ok(text.indexOf("FIRST") < text.indexOf("SECOND"), "FIFO order preserved");
  });

  it("a batch with any high-urgency part delivers as steer, all-low as followUp (§7.5)", async () => {
    const h = makeHarness(tmpDir);
    seedEnvelope(h, "t1", { from: "alice", body: "calm" }, "1-a.json");
    seedEnvelope(h, "t1", { from: "bob", body: "urgent!", urgency: "high" }, "2-b.json");
    await h.inbox.drain(h.ctx);
    assert.strictEqual(h.calls[0].options?.deliverAs, "steer");

    seedEnvelope(h, "t1", { from: "alice", body: "calm again" }, "3-c.json");
    await h.inbox.drain(h.ctx);
    assert.strictEqual(h.calls[1].options?.deliverAs, "followUp");
  });

  it("a deliverAfter envelope stays queued until due (§6)", async () => {
    const h = makeHarness(tmpDir);
    seedEnvelope(h, "t1", {
      from: "alice",
      body: "future",
      deliverAfter: new Date(Date.now() + 60_000).toISOString(),
    });
    await h.inbox.drain(h.ctx);
    assert.strictEqual(h.calls.length, 0, "not deliverable yet");
    assert.strictEqual(inboxFileCount(h, "t1"), 1, "still durably queued");
  });
});

describe("inbox: injection gate (§7.3/§7.7)", () => {
  it("holds the drain shut during compaction and flushes after it ends", async () => {
    const h = makeHarness(tmpDir);
    seedEnvelope(h, "t1", { from: "alice", body: "during compaction" });
    h.inbox.markCompactionStart();
    await h.inbox.drain(h.ctx);
    assert.strictEqual(h.calls.length, 0);
    assert.strictEqual(inboxFileCount(h, "t1"), 1, "§7.7: not even claimed while gated");
    h.inbox.markCompactionEnd();
    await h.inbox.drain(h.ctx);
    assert.strictEqual(h.calls.length, 1);
  });

  it("an idle-time injection blocks further drains until a turn starts", async () => {
    const h = makeHarness(tmpDir);
    h.idle = true;
    seedEnvelope(h, "t1", { from: "alice", body: "first" });
    await h.inbox.drain(h.ctx);
    assert.strictEqual(h.calls.length, 1);
    seedEnvelope(h, "t1", { from: "alice", body: "second" });
    await h.inbox.drain(h.ctx); // gated by the preflight hold
    assert.strictEqual(h.calls.length, 1);
    assert.strictEqual(inboxFileCount(h, "t1"), 1, "second stays durable");
    h.inbox.markRunStarted();
    await h.inbox.drain(h.ctx);
    assert.strictEqual(h.calls.length, 2);
  });

  it("mid-run injections never arm the preflight hold", async () => {
    const h = makeHarness(tmpDir);
    h.idle = false;
    seedEnvelope(h, "t1", { from: "alice", body: "one" });
    await h.inbox.drain(h.ctx);
    seedEnvelope(h, "t1", { from: "alice", body: "two" });
    await h.inbox.drain(h.ctx);
    assert.strictEqual(h.calls.length, 2);
  });

  it("deadline nudges wait out the gate instead of being lost", async () => {
    const h = makeHarness(tmpDir);
    h.store.obligations.push({
      id: "t1/late",
      to: "alice",
      summary: "overdue",
      sentAt: new Date().toISOString(),
      deadline: new Date(Date.now() - 1000).toISOString(),
    });
    h.inbox.markCompactionStart();
    await h.inbox.checkDeadlines(h.ctx);
    assert.strictEqual(h.calls.length, 0);
    assert.strictEqual(h.store.obligations[0].nudged, undefined, "not consumed while gated");
    h.inbox.markCompactionEnd();
    await h.inbox.checkDeadlines(h.ctx);
    assert.strictEqual(h.calls.length, 1);
    assert.strictEqual(h.store.obligations[0].nudged, true);
  });
});

describe("inbox: checkDeadlines (§9.2)", () => {
  it("an overdue obligation nudges once and not twice", async () => {
    const h = makeHarness(tmpDir);
    h.store.obligations.push({
      id: "t1/late",
      to: "alice",
      summary: "the report",
      sentAt: new Date().toISOString(),
      deadline: new Date(Date.now() - 1000).toISOString(),
    });
    await h.inbox.checkDeadlines(h.ctx);
    assert.strictEqual(h.calls.length, 1);
    assert.match(h.calls[0].content, /Obligation #t1\/late overdue/);
    await h.inbox.checkDeadlines(h.ctx);
    assert.strictEqual(h.calls.length, 1, "one-shot nudge");
  });

  it("an overdue barrier nudges once and not twice", async () => {
    const h = makeHarness(tmpDir);
    h.store.barriers.push({
      id: "b.late",
      pending: ["t1/x"],
      mode: "all",
      createdAt: new Date().toISOString(),
      deadline: new Date(Date.now() - 1000).toISOString(),
    });
    await h.inbox.checkDeadlines(h.ctx);
    assert.strictEqual(h.calls.length, 1);
    assert.match(h.calls[0].content, /Barrier "b\.late" pending/);
    await h.inbox.checkDeadlines(h.ctx);
    assert.strictEqual(h.calls.length, 1);
  });

  it("no nudge before the deadline passes", async () => {
    const h = makeHarness(tmpDir);
    h.store.obligations.push({
      id: "t1/early",
      to: "alice",
      summary: "x",
      sentAt: new Date().toISOString(),
      deadline: new Date(Date.now() + 60_000).toISOString(),
    });
    await h.inbox.checkDeadlines(h.ctx);
    assert.strictEqual(h.calls.length, 0);
  });
});

describe("Errata 3: heartbeat coalesces its sources into one inject (§7.5)", () => {
  it("the shared-array batch ships drain + deadline nudge in a single user message when idle", async () => {
    const h = makeHarness(tmpDir);
    h.idle = true;
    seedEnvelope(h, "t1", { from: "alice", body: "queued envelope" });
    h.store.obligations.push({
      id: "t1/late",
      to: "bob",
      summary: "overdue thing",
      sentAt: new Date().toISOString(),
      deadline: new Date(Date.now() - 1000).toISOString(),
    });
    const parts: Injection[] = [];
    await h.inbox.drain(h.ctx, parts);
    await h.inbox.checkDeadlines(h.ctx, parts);
    h.inbox.inject(parts, h.ctx);
    assert.strictEqual(h.calls.length, 1, "one coalesced message");
    assert.match(h.calls[0].content, /queued envelope/);
    assert.match(h.calls[0].content, /Obligation #t1\/late overdue/);
  });

  it("standalone idle calls still self-serialize — the tax the batch avoids", async () => {
    const h = makeHarness(tmpDir);
    h.idle = true;
    seedEnvelope(h, "t1", { from: "alice", body: "queued envelope" });
    h.store.obligations.push({
      id: "t1/late",
      to: "bob",
      summary: "overdue thing",
      sentAt: new Date().toISOString(),
      deadline: new Date(Date.now() - 1000).toISOString(),
    });
    await h.inbox.drain(h.ctx); // injects, arms the preflight hold
    await h.inbox.checkDeadlines(h.ctx); // gated by that hold
    assert.strictEqual(h.calls.length, 1);
    assert.doesNotMatch(h.calls[0].content, /Obligation #.*overdue/);
  });

  it("standalone (no shared array) still injects its own batch — unchanged callers", async () => {
    const h = makeHarness(tmpDir);
    seedEnvelope(h, "t1", { from: "alice", body: "solo drain" });
    await h.inbox.drain(h.ctx);
    assert.strictEqual(h.calls.length, 1);
    assert.match(h.calls[0].content, /solo drain/);
  });
});

describe("lifecycle: journalSignature / shouldJournal", () => {
  function bareStore() {
    const h = makeHarness(tmpDir);
    return h.store;
  }

  it("an unchanged signature with no tool call skips journaling after the first check", () => {
    const store = bareStore();
    assert.strictEqual(shouldJournal(store, true), true); // first: signature unset
    assert.strictEqual(shouldJournal(store, false), false);
  });

  it("a tool-using turn inside the rate-limit window defers to a run-end wrap-up", () => {
    const store = bareStore();
    assert.strictEqual(shouldJournal(store, true), true);
    assert.strictEqual(shouldJournal(store, true), false); // rate-limited, records debt
    assert.strictEqual(store.journalDebt, true);
    assert.strictEqual(shouldJournal(store, false, "run-end"), true); // debt repaid
    assert.strictEqual(store.journalDebt, false);
  });

  it("a tool-using turn past the rate-limit window journals immediately", () => {
    const store = bareStore();
    assert.strictEqual(shouldJournal(store, true), true);
    store.lastJournalAt = Date.now() - JOURNAL_MIN_INTERVAL_MS - 1;
    assert.strictEqual(shouldJournal(store, true), true);
  });

  it("a changed signature journals even without a tool call, ignoring the rate limit", () => {
    const store = bareStore();
    assert.strictEqual(shouldJournal(store, true), true);
    store.obligations.push({
      id: "t1/new",
      to: "alice",
      summary: "x",
      sentAt: new Date().toISOString(),
    });
    assert.strictEqual(shouldJournal(store, false), true);
  });

  it('phase "done" journals a run that used tools, exactly once', () => {
    const store = bareStore();
    assert.strictEqual(shouldJournal(store, true, "done"), true);
    assert.strictEqual(shouldJournal(store, false, "done"), false);
  });

  it("journalSignature changes when an obligation is added", () => {
    const store = bareStore();
    const before = journalSignature(store);
    store.obligations.push({
      id: "t1/x",
      to: "alice",
      summary: "s",
      sentAt: new Date().toISOString(),
    });
    assert.notStrictEqual(journalSignature(store), before);
  });
});

describe("lifecycle: opt-in gate (§2.3)", () => {
  it("no --thread-id and no prior identity: stays inactive, never touches disk, hides thread_* tools", async () => {
    const h = makeLifecycleHarness(tmpDir);
    await h.fire("session_start", h.makeCtx());
    assert.ok(!existsSync(join(tmpDir, ".thread")), "no .thread/ dir for a non-thread session");
    assert.strictEqual(h.setActiveToolsCalls.length, 1);
    assert.deepStrictEqual(h.activeTools, ["bash", "read_file"]);
  });

  it("--thread-id passed: activates, creates .thread/, leaves the tool list alone", async () => {
    const h = makeLifecycleHarness(tmpDir);
    h.setFlag("thread-id", "t9");
    await h.fire("session_start", h.makeCtx());
    assert.ok(existsSync(join(tmpDir, ".thread", "threads", "t9", "state.json")));
    assert.strictEqual(h.setActiveToolsCalls.length, 0);
    h.store.stopHeartbeat();
    h.store.stopWatcher();
  });

  it("no flag: a leftover thread-identity entry from an old session does not reactivate it (no recall)", async () => {
    const h = makeLifecycleHarness(tmpDir);
    const ctx = h.makeCtx([{ type: "custom", customType: "thread-identity", data: { id: "t7" } }]);
    await h.fire("session_start", ctx);
    assert.ok(
      !existsSync(join(tmpDir, ".thread")),
      "no .thread/ dir without an explicit --thread-id",
    );
  });

  it("while inactive, every other lifecycle handler no-ops instead of touching an uninitialized store", async () => {
    const h = makeLifecycleHarness(tmpDir);
    const ctx = h.makeCtx();
    await h.fire("session_start", ctx);
    await h.fire("turn_start", ctx);
    await h.fire("tool_execution_start", ctx);
    await h.fire("turn_end", ctx);
    await h.fire("agent_end", ctx);
    await h.fire("session_shutdown", ctx, { reason: "quit" });
    assert.ok(!existsSync(join(tmpDir, ".thread")));
    assert.strictEqual(h.store.threadId, "");
  });
});

describe("lifecycle: silent-debtor nudge (§9.4)", () => {
  async function activeHarness() {
    const h = makeLifecycleHarness(tmpDir);
    h.setFlag("thread-id", "t9");
    const ctx = h.makeCtx();
    await h.fire("session_start", ctx);
    h.store.stopHeartbeat();
    h.store.stopWatcher();
    return { h, ctx };
  }

  function owe(h: ReturnType<typeof makeLifecycleHarness>, from = "boss", id = "boss/q1") {
    h.store.owed.push({ id, from, summary: "?", receivedAt: new Date().toISOString() });
  }

  it("fires once on the first silent turn with an owed reply outstanding, soliciting the canary", async () => {
    const { h, ctx } = await activeHarness();
    owe(h);
    await h.fire("turn_start", ctx);
    await h.fire("turn_end", ctx);
    assert.strictEqual(h.sentMessages.length, 1);
    assert.strictEqual(h.sentMessages[0].customType, "thread-owed-reminder");
    assert.match(h.sentMessages[0].content, /boss \(re #boss\/q1\)/);
    assert.match(h.sentMessages[0].content, /"Standing by"/);
    assert.match(h.sentMessages[0].content, /Pass the ball/);
  });

  it("does not fire again on a second consecutive silent turn within the same run", async () => {
    const { h, ctx } = await activeHarness();
    owe(h);
    await h.fire("turn_start", ctx);
    await h.fire("turn_end", ctx);
    await h.fire("turn_end", ctx);
    assert.strictEqual(h.sentMessages.length, 1);
  });

  it("a tool-using turn resets streak and gate; the next silent turn fires again", async () => {
    const { h, ctx } = await activeHarness();
    owe(h);
    await h.fire("turn_start", ctx);
    await h.fire("turn_end", ctx);
    assert.strictEqual(h.sentMessages.length, 1);
    await h.fire("tool_execution_start", ctx);
    await h.fire("turn_end", ctx);
    assert.strictEqual(h.store.owedSilentStreak, 0);
    await h.fire("turn_start", ctx);
    await h.fire("turn_end", ctx);
    assert.strictEqual(h.sentMessages.length, 2);
  });

  it("escalates at streak >= 2 once agent_end re-arms the gate across a second silent run", async () => {
    const { h, ctx } = await activeHarness();
    owe(h);
    await h.fire("turn_start", ctx);
    await h.fire("turn_end", ctx); // streak 1, nudge 1
    await h.fire("agent_end", ctx); // re-arms the gate, streak stays
    await h.fire("turn_start", ctx);
    await h.fire("turn_end", ctx); // streak 2, nudge 2 — escalated
    assert.strictEqual(h.sentMessages.length, 2);
    assert.match(h.sentMessages[1].content, /turn 2 with no reply/);
  });

  it("streak caps at 3 across repeated silent runs", async () => {
    const { h, ctx } = await activeHarness();
    owe(h);
    for (let run = 0; run < 5; run++) {
      await h.fire("turn_start", ctx);
      await h.fire("turn_end", ctx);
      await h.fire("agent_end", ctx);
    }
    assert.strictEqual(h.store.owedSilentStreak, 3);
    assert.match(h.sentMessages.at(-1)!.content, /turn 3 with no reply/);
  });

  it("never fires when the thread never activated", async () => {
    const h = makeLifecycleHarness(tmpDir);
    const ctx = h.makeCtx();
    await h.fire("session_start", ctx);
    h.store.owed.push({
      id: "x/1",
      from: "x",
      summary: "?",
      receivedAt: new Date().toISOString(),
    });
    await h.fire("turn_end", ctx);
    assert.strictEqual(h.sentMessages.length, 0);
  });
});

describe("commands: slash commands", () => {
  it("refuses to run when the thread never activated (opt-in gate never ran)", async () => {
    const h = makeHarness(tmpDir);
    h.threading.state.active = false; // simulate: opt-in gate closed, init() never ran
    await callCommand(h, "thread-status");
    assert.match(h.notifications[0].text, /pi-threading is disabled/);
  });

  it("/thread-status notification includes the coordination counts", async () => {
    const h = makeHarness(tmpDir);
    h.store.barriers.push({
      id: "b1",
      pending: ["t1/x"],
      mode: "all",
      createdAt: new Date().toISOString(),
    });
    h.store.owed.push(owedRecord("boss", "boss/q1"));
    await callCommand(h, "thread-status");
    assert.match(h.notifications[0].text, /Barriers: 1/);
    assert.match(h.notifications[0].text, /Owed: 1/);
  });

  it("/thread-suspend then /thread-resume round-trips on-hold state", async () => {
    const h = makeHarness(tmpDir);
    await callCommand(h, "thread-suspend", "coffee");
    assert.strictEqual(h.store.state, "on-hold");
    assert.strictEqual(h.store.holdReason, "coffee");
    await callCommand(h, "thread-resume");
    assert.strictEqual(h.store.state, "open");
  });

  it("/thread-send rejects sending to self", async () => {
    const h = makeHarness(tmpDir);
    await callCommand(h, "thread-send", "t1 hello");
    assert.match(h.notifications[0].text, /Cannot send to self/);
  });

  it("/thread-send writes a high-urgency envelope (operator sends interrupt)", async () => {
    const h = makeHarness(tmpDir);
    seedRemoteThread(h, "alice");
    await callCommand(h, "thread-send", "alice please pause");
    const written = readInboxFile(h, "alice");
    assert.strictEqual(written.body, "please pause");
    assert.strictEqual(written.urgency, "high");
    assert.strictEqual(written.from, "t1");
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

function wireEnvelope(
  from: string,
  to: string,
  body: string,
  extra: Partial<Mail> = {},
): Mail {
  return {
    id: mintMailId(from),
    from,
    to,
    body,
    sentAt: new Date().toISOString(),
    ...extra,
  };
}

describe("adapter: LocalFsAdapter (Appendix B binding)", () => {
  it("saveState/loadState round-trips through state.json", async () => {
    const adapter = createAdapter({ "base-dir": tmpDir });
    await adapter.configure();
    await adapter.saveState("a", baseState("a"));
    const loaded = await adapter.loadState("a");
    assert.strictEqual(loaded?.id, "a");
    assert.ok(existsSync(join(tmpDir, ".thread", "threads", "a", "state.json")));
  });

  it("loadState returns undefined for an unknown thread", async () => {
    const adapter = createAdapter({ "base-dir": tmpDir });
    await adapter.configure();
    assert.strictEqual(await adapter.loadState("ghost"), undefined);
  });

  it("threadExists reflects whether state.json is present", async () => {
    const adapter = createAdapter({ "base-dir": tmpDir });
    await adapter.configure();
    assert.strictEqual(await adapter.threadExists("a"), false);
    await adapter.saveState("a", baseState("a"));
    assert.strictEqual(await adapter.threadExists("a"), true);
  });

  it("sendMail + receiveMail delivers everything exactly once, in FIFO ulid order", async () => {
    const adapter = createAdapter({ "base-dir": tmpDir });
    await adapter.configure();
    await adapter.sendMail(wireEnvelope("alice", "bob", "first"));
    await adapter.sendMail(wireEnvelope("alice", "bob", "second"));
    const claimed = await adapter.receiveMail("bob");
    // Monotonic ULIDs make FIFO exact even in the same millisecond.
    assert.deepStrictEqual(
      claimed.map(m => m.body),
      ["first", "second"],
    );
    assert.deepStrictEqual(await adapter.receiveMail("bob"), []);
  });

  it("enqueue goes through inbox.tmp staging and leaves nothing behind", async () => {
    const adapter = createAdapter({ "base-dir": tmpDir });
    await adapter.configure();
    await adapter.sendMail(wireEnvelope("alice", "bob", "hi"));
    const staging = join(tmpDir, ".thread", "threads", "bob", "inbox.tmp");
    assert.ok(existsSync(staging), "staging dir exists");
    assert.strictEqual(readdirSync(staging).length, 0, "no leftover temp files");
    assert.strictEqual(
      readdirSync(join(tmpDir, ".thread", "threads", "bob", "inbox")).filter(f =>
        f.endsWith(".json"),
      ).length,
      1,
    );
  });

  it("a retry with the same id overwrites its own file — enqueue idempotence (§7.6)", async () => {
    const adapter = createAdapter({ "base-dir": tmpDir });
    await adapter.configure();
    const msg = wireEnvelope("alice", "bob", "retry me");
    await adapter.sendMail(msg);
    await adapter.sendMail(msg);
    const claimed = await adapter.receiveMail("bob");
    assert.strictEqual(claimed.length, 1, "no duplicate delivery");
  });

  it("receiveMail holds deliverAfter envelopes until due, then delivers them (§6)", async () => {
    const adapter = createAdapter({ "base-dir": tmpDir });
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

  it("receiveMail leaves malformed JSON in place and never returns it", async () => {
    const adapter = createAdapter({ "base-dir": tmpDir });
    await adapter.configure();
    const dir = join(tmpDir, ".thread", "threads", "bob", "inbox");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "1-bad.json"), "{not valid json");
    const claimed = await adapter.receiveMail("bob");
    assert.strictEqual(claimed.length, 0);
    assert.ok(existsSync(join(dir, "1-bad.json")));
  });

  it("listThreads reports a thread stale past STALE_MS as stopped", async () => {
    const adapter = createAdapter({ "base-dir": tmpDir });
    await adapter.configure();
    await adapter.saveState(
      "ghost",
      baseState("ghost", { lastSeen: new Date(Date.now() - STALE_MS - 1000).toISOString() }),
    );
    const threads = await adapter.listThreads();
    assert.strictEqual(threads[0]?.status, "stopped");
  });

  it("watchMail doesn't throw for a thread that has never received a message (no inbox/ dir yet)", async () => {
    const adapter = createAdapter({ "base-dir": tmpDir });
    await adapter.configure();
    await adapter.saveState("fresh", baseState("fresh"));
    assert.ok(!existsSync(join(tmpDir, ".thread", "threads", "fresh", "inbox")));
    let fired = false;
    const dispose = adapter.watchMail("fresh", () => {
      fired = true;
    });
    // Dispose in finally: a leaked FSWatcher keeps the node:test process
    // alive forever if an assertion throws first (observed as a 5-minute
    // hang when the fixed 50ms wait flaked under load).
    try {
      assert.ok(existsSync(join(tmpDir, ".thread", "threads", "fresh", "inbox")));
      // A message arriving after the (now-live) watch should still be observed.
      await adapter.sendMail(wireEnvelope("other", "fresh", "hi"));
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
 *  all. Deliberately implements ONLY the core contract, no JournalAdapter —
 *  which also exercises the journal channel's optionality (§5). */
function createFakeAdapter(): StorageAdapter {
  const states = new Map<string, StateFile>();
  const inboxes = new Map<string, Mail[]>();

  return {
    async configure() {},
    async loadState(id) {
      return states.get(id);
    },
    async saveState(id, state) {
      states.set(id, structuredClone(state));
    },
    async listThreads(): Promise<ThreadSummary[]> {
      return [...states.values()].map(toSummary);
    },
    async threadExists(id) {
      return states.has(id);
    },
    async sendMail(mail) {
      const arr = inboxes.get(mail.to) ?? [];
      arr.push(mail);
      inboxes.set(mail.to, arr);
    },
    async receiveMail(id) {
      const arr = inboxes.get(id) ?? [];
      const now = Date.now();
      const due = arr.filter(m => !m.deliverAfter || new Date(m.deliverAfter).getTime() <= now);
      inboxes.set(
        id,
        arr.filter(m => m.deliverAfter && new Date(m.deliverAfter).getTime() > now),
      );
      return due;
    },
    watchMail() {
      return () => {};
    },
  };
}

describe("adapter seam: core logic against a fake in-memory adapter", () => {
  const stubPiWith = (calls: Call[]) =>
    ({
      sendUserMessage: (content: string, options?: { deliverAs?: string }) => {
        calls.push({ content, options });
      },
      registerTool: () => {},
      registerCommand: () => {},
    }) as unknown as ExtensionAPI;

  const freshState = (): ThreadingState => ({
    active: true,
    toolUsedThisTurn: false,
    inFlightSince: null,
    compactingSince: null,
  });

  it("a note sent from one thread is drained and delivered on the other, with no fs involved", async () => {
    const fake = createFakeAdapter();
    const calls: Call[] = [];
    const stubPi = stubPiWith(calls);
    const ctx = {
      ui: { setStatus: () => {} },
      isIdle: () => false,
    } as unknown as ExtensionCommandContext;

    const senderState = freshState();
    const sender = createStore(stubPi, fake, senderState);
    sender.threadId = "sender";
    await sender.persist();
    const senderInbox = createInbox(stubPi, sender, senderState);

    const receiverState = freshState();
    const receiver = createStore(stubPi, fake, receiverState);
    receiver.threadId = "receiver";
    await receiver.persist();
    const receiverInbox = createInbox(stubPi, receiver, receiverState);

    const [{ delivered }] = await senderInbox.sendMany(["receiver"], "hi from fake adapter");
    assert.strictEqual(delivered, "live"); // receiver's state already exists and is fresh

    await receiverInbox.drain(ctx as unknown as ExtensionContext);
    assert.strictEqual(calls.length, 1);
    assert.match(calls[0].content, /hi from fake adapter/);
  });

  it("transition persists through adapter.saveState, not raw fs", async () => {
    const fake = createFakeAdapter();
    const stubPi = stubPiWith([]);
    const store = createStore(stubPi, fake, freshState());
    store.threadId = "solo";
    await store.transition("open");
    const loaded = await fake.loadState("solo");
    assert.strictEqual(loaded?.state, "open");
  });

  it("readJournal degrades to undefined on a backend without the JournalAdapter extension", async () => {
    const fake = createFakeAdapter();
    const stubPi = stubPiWith([]);
    const store = createStore(stubPi, fake, freshState());
    store.threadId = "solo";
    assert.strictEqual(await store.readJournal("solo"), undefined);
  });

  it("thread_journal errors cleanly on a backend without the journal channel", async () => {
    const fake = createFakeAdapter();
    const tools: Record<string, AnyTool> = {};
    const stubPi = {
      sendUserMessage: () => {},
      registerTool: (tool: AnyTool & { name: string }) => {
        tools[tool.name] = tool;
      },
      registerCommand: () => {},
    } as unknown as ExtensionAPI;
    const state = freshState();
    const store = createStore(stubPi, fake, state);
    store.threadId = "solo";
    await store.persist();
    const inbox = createInbox(stubPi, store, state);
    registerTools({ pi: stubPi, store, inbox, state });
    const ctx = { ui: { setStatus: () => {} } } as unknown as ExtensionCommandContext;
    const r = await tools["thread_journal"].execute("t", { id: "solo" }, undefined, undefined, ctx);
    assert.strictEqual(r.details.ok, false);
    assert.match(r.content[0].text, /no journal channel/);
  });
});

describe("bin/thread-cli.mjs: external C1 actor", () => {
  const cli = join(import.meta.dirname, "..", "bin", "thread-cli.mjs");
  const runCli = (dir: string, ...cliArgs: string[]) =>
    execFileSync(process.execPath, [cli, ...cliArgs, "--dir", dir], { encoding: "utf8" });

  async function seedCoordination(h: Harness) {
    h.store.obligations.push({
      id: "t1/b1",
      to: "alice",
      summary: "build the lexer",
      sentAt: new Date().toISOString(),
      deadline: new Date(Date.now() + 60_000).toISOString(),
    });
    h.store.owed.push(owedRecord("boss", "boss/q1", "which parser?"));
    h.store.barriers.push({
      id: "barrier.t1.1",
      pending: ["t1/b1"],
      mode: "all",
      createdAt: new Date().toISOString(),
    });
    await h.store.persist();
  }

  it("status itemizes obligations, owed, barriers, and pending inbox", async () => {
    const h = makeHarness(tmpDir);
    await seedCoordination(h);
    seedEnvelope(h, "t1", { from: "alice", body: "queued while away", id: "alice/n1" });
    const out = runCli(h.dir, "status", "t1");
    assert.match(out, /request to alice #t1\/b1 "build the lexer" .*due in/);
    assert.match(out, /reply to boss for #boss\/q1 "which parser\?"/);
    assert.match(out, /barrier\.t1\.1 \(all\) pending: t1\/b1/);
    assert.match(out, /Inbox pending \(1\):/);
    assert.match(out, /\[note alice→t1 #alice\/n1\]/);
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
    makeHarness(tmpDir); // materializes .thread/threads so only the id is missing
    assert.throws(() => runCli(tmpDir, "status", "ghost"));
  });

  it("list table carries coordination-count columns", async () => {
    const h = makeHarness(tmpDir);
    await seedCoordination(h);
    const out = runCli(h.dir, "list");
    assert.match(out, /OBLG\s+OWED\s+BARR\s+INBOX/);
    const row = out.split("\n").find(l => l.startsWith("t1"))!;
    assert.match(row, /1\s+1\s+1\s+0/); // oblg owed barr inbox
  });

  it("send writes a conforming envelope the extension's drain understands end-to-end", async () => {
    const h = makeHarness(tmpDir);
    runCli(h.dir, "send", "t1", "what", "is", "the", "plan?", "--from", "user", "--expects");
    const written = readInboxFile(h, "t1");
    assert.match(written.id, /^user\//);
    assert.strictEqual(written.expects, true);
    assert.strictEqual(written.body, "what is the plan?");
    // The extension side delivers it and records the owed reply — the full
    // C1-to-C3 interop loop, files only.
    await h.inbox.drain(h.ctx);
    assert.strictEqual(h.store.owed.length, 1);
    assert.strictEqual(h.store.owed[0].id, written.id);
    assert.strictEqual(h.store.owed[0].from, "user");
  });

  it("send --re settles the loop back: a human reply discharges the thread's obligation shape", async () => {
    const h = makeHarness(tmpDir);
    const [sent] = await h.inbox.sendMany(["user"], "please review", { expects: true });
    runCli(h.dir, "send", "t1", "looks", "good", "--from", "user", "--re", sent.id);
    await h.inbox.drain(h.ctx);
    assert.strictEqual(h.store.obligations.length, 0, "obligation discharged by CLI reply");
  });
});

describe("core: toSummary / formatThreadLine coordination counts", () => {
  it("thread_list lines show non-zero coordination counts only", async () => {
    const h = makeHarness(tmpDir);
    seedRemoteThread(h, "alice");
    h.store.obligations.push({
      id: "t1/b1",
      to: "alice",
      summary: "x",
      sentAt: new Date().toISOString(),
    });
    await h.store.persist();
    const r = await callTool(h, "thread_list");
    const own = (r.details.threads as ThreadSummary[]).find(t => t.id === "t1")!;
    assert.strictEqual(own.obligations, 1);
    assert.strictEqual(own.owed, 0);
    const text = r.content[0].text;
    const ownLine = text.split("\n").find((l: string) => l.startsWith("t1"))!;
    assert.match(ownLine, /obligations=1/);
    assert.doesNotMatch(ownLine, /owed=/);
  });
});

describe("state: restore rules (§11.2)", () => {
  it("done/stopped restore to idle; unknown legacy states settle to open", async () => {
    const adapter = createAdapter({ "base-dir": tmpDir });
    await adapter.configure();
    await adapter.saveState("a", baseState("a", { state: "done" }));
    // A state.json from a pre-Rev-8 file may carry a state this revision
    // no longer knows (e.g. "listening") — it must settle to open.
    await adapter.saveState("b", {
      ...baseState("b"),
      state: "listening" as unknown as StateFile["state"],
    });

    const stubPi = {
      sendUserMessage: () => {},
      registerTool: () => {},
      registerCommand: () => {},
      getFlag: (name: string) => (name === "thread-id" ? "a" : undefined),
      appendEntry: () => {},
    } as unknown as ExtensionAPI;
    const mkCtx = () =>
      ({
        cwd: tmpDir,
        ui: { setStatus: () => {} },
        sessionManager: { getEntries: () => [], getSessionFile: () => undefined },
      }) as unknown as ExtensionContext;

    const freshState = (): ThreadingState => ({
      active: true,
      toolUsedThisTurn: false,
      inFlightSince: null,
      compactingSince: null,
    });

    const storeA = createStore(stubPi, createAdapter({ "base-dir": tmpDir }), freshState());
    await storeA.init(mkCtx());
    assert.strictEqual(storeA.state, "idle");

    const stubPiB = {
      ...stubPi,
      getFlag: (name: string) => (name === "thread-id" ? "b" : undefined),
    } as unknown as ExtensionAPI;
    const storeB = createStore(stubPiB, createAdapter({ "base-dir": tmpDir }), freshState());
    await storeB.init(mkCtx());
    assert.strictEqual(storeB.state, "open");
  });

  it("debts and barriers survive a restart unconditionally (§13.2)", async () => {
    const adapter = createAdapter({ "base-dir": tmpDir });
    await adapter.configure();
    await adapter.saveState(
      "a",
      baseState("a", {
        state: "open",
        obligations: [{ id: "a/x", to: "bob", summary: "s", sentAt: new Date().toISOString() }],
        owed: [{ id: "boss/q", from: "boss", summary: "?", receivedAt: new Date().toISOString() }],
        barriers: [
          { id: "b1", pending: ["a/x"], mode: "all", createdAt: new Date().toISOString() },
        ],
      }),
    );
    const stubPi = {
      sendUserMessage: () => {},
      registerTool: () => {},
      registerCommand: () => {},
      getFlag: (name: string) => (name === "thread-id" ? "a" : undefined),
      appendEntry: () => {},
    } as unknown as ExtensionAPI;
    const store = createStore(stubPi, createAdapter({ "base-dir": tmpDir }), {
      active: true,
      toolUsedThisTurn: false,
      inFlightSince: null,
      compactingSince: null,
    });
    await store.init({
      cwd: tmpDir,
      ui: { setStatus: () => {} },
      sessionManager: { getEntries: () => [], getSessionFile: () => undefined },
    } as unknown as ExtensionContext);
    assert.strictEqual(store.obligations.length, 1);
    assert.strictEqual(store.owed.length, 1);
    assert.strictEqual(store.barriers.length, 1);
  });
});

describe("state: watcher idempotency", () => {
  it("startWatcher twice keeps exactly one live watch; stopWatcher is idempotent", () => {
    let active = 0;
    const counting: StorageAdapter = {
      ...createFakeAdapter(),
      watchMail() {
        active++;
        return () => active--;
      },
    };
    const stubPi = {
      sendUserMessage: () => {},
      registerTool: () => {},
      registerCommand: () => {},
    } as unknown as ExtensionAPI;
    const store = createStore(stubPi, counting, {
      active: true,
      toolUsedThisTurn: false,
      inFlightSince: null,
      compactingSince: null,
    });
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
