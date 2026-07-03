/**
 * Curated end-to-end tests — each spawns a real `pi` subprocess with a real
 * DeepSeek model call. Every test here exists because it proves something
 * a unit test (test/unit.test.ts) structurally cannot: genuine ambiguity
 * resolution by the model, comprehension of rendered structured text, or a
 * real subprocess/cross-process boundary (lifecycle hooks, `pi --fork`
 * journal spawning, two independently-started processes sharing a
 * filesystem). See TESTING.md before adding a case here — if the prompt is
 * fully scripted ("call X with params Y"), the thing it exercises probably
 * already has (or belongs in) a unit test instead.
 *
 * Assertions read state.json / written files as ground truth. Where a
 * stdout check adds real signal it's kept loose — never a strict regex on
 * the model's exact phrasing (that's the single biggest source of flaky
 * failures this suite has hit historically).
 *
 * Run: npm run test:e2e (minutes, real API cost)
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  readFileSync,
  existsSync,
  readdirSync,
  mkdirSync,
  writeFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const EXT = join(import.meta.dirname!, "..", "src", "index.ts");
const TIMEOUT = 120_000;

// Volta refuses to resolve `pi` outside a project that declares it, and its
// shim uses the pinned Node. Use node 22.21.1 + pi binary directly.
const HOME = process.env.HOME ?? "";
const PI_NODE = join(HOME, ".volta/tools/image/node/22.21.1/bin/node");
const PI_SCRIPT = join(HOME, ".volta/tools/image/packages/@earendil-works/pi-coding-agent/bin/pi");

function runPi(
  prompt: string,
  cwd: string,
  opts: { session?: boolean; threadId?: string; parent?: string } = {},
): { stdout: string; stderr: string; ok: boolean } {
  // --no-session means getSessionFile() returns undefined, blocking journal forks.
  // Use a real session dir when the test needs the journal to be written.
  const sessionArgs = opts.session
    ? ["--session-dir", join(cwd, ".sessions"), "--session-id", "test-session"]
    : ["--no-session"];
  const threadArgs = [
    ...(opts.threadId ? ["--thread-id", opts.threadId] : []),
    ...(opts.parent ? ["--thread-parent", opts.parent] : []),
  ];
  const result = spawnSync(
    PI_NODE,
    [
      PI_SCRIPT,
      "--extension",
      EXT,
      "--model",
      "deepseek/deepseek-chat",
      "--thinking",
      "off",
      ...sessionArgs,
      ...threadArgs,
      "--print",
      prompt,
    ],
    { cwd, timeout: TIMEOUT, encoding: "utf8" },
  );
  return {
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    ok: result.status === 0,
  };
}

function readState(dir: string, threadId: string) {
  const f = join(dir, ".thread", "threads", threadId, "state.json");
  if (!existsSync(f)) return null;
  return JSON.parse(readFileSync(f, "utf8"));
}

function readJournal(dir: string, threadId: string): string {
  const f = join(dir, ".thread", "threads", threadId, "journal.md");
  return existsSync(f) ? readFileSync(f, "utf8") : "";
}

function inboxFiles(dir: string, threadId: string, sub: "" | "processed" = ""): string[] {
  const d = join(dir, ".thread", "threads", threadId, "inbox", sub);
  if (!existsSync(d)) return [];
  return readdirSync(d).filter(f => f.endsWith(".json"));
}

// The system prompt tells agents to check thread_list and avoid dead threads,
// so fictional partners must exist with a fresh lastSeen or the model refuses.
function seedThread(dir: string, id: string, opts: { stale?: boolean } = {}) {
  const threadDir = join(dir, ".thread", "threads", id);
  mkdirSync(join(threadDir, "inbox", "processed"), { recursive: true });
  const now = opts.stale
    ? new Date(Date.now() - 5 * 60_000).toISOString()
    : new Date().toISOString();
  writeFileSync(
    join(threadDir, "state.json"),
    JSON.stringify({
      id,
      pid: 999999,
      cwd: dir,
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
      barriers: [],
      startedAt: now,
      lastSeen: now,
      updatedAt: now,
    }),
  );
}

function seedResult(dir: string, ownerThreadId: string, from: string, requestId: string) {
  const inboxDir = join(dir, ".thread", "threads", ownerThreadId, "inbox");
  mkdirSync(inboxDir, { recursive: true });
  writeFileSync(
    join(inboxDir, `${Date.now()}-${requestId}.json`),
    JSON.stringify({
      from,
      to: ownerThreadId,
      type: "Result",
      body: "done",
      requestId,
      delivery: "follow-up",
      sentAt: new Date().toISOString(),
    }),
  );
}

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "pi-thread-e2e-"));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("lifecycle", () => {
  it("a run with no tool calls ends at done with no lock held", { timeout: TIMEOUT }, () => {
    const r = runPi("Say the word 'hello' and nothing else.", tmpDir, { threadId: "t1" });
    assert.ok(r.ok);

    const s = readState(tmpDir, "t1");
    assert.ok(s !== null);
    assert.strictEqual(s.state, "done");
    assert.strictEqual(s.lockEventId ?? null, null);
  });
});

describe("journal", () => {
  it("a turn that uses a tool produces a forked journal entry", { timeout: TIMEOUT }, () => {
    // Must use a real session: --no-session makes getSessionFile() return undefined,
    // which blocks forkJournal. The forked child keeps the parent alive until done,
    // so spawnSync already waits for the journal to be written — no sleep needed.
    // Needs the real `pi --fork` subprocess spawn — not reachable from a unit test.
    runPi("List the files in the current directory using the bash tool. Then say done.", tmpDir, {
      session: true,
      threadId: "t1",
    });

    const journal = readJournal(tmpDir, "t1");
    assert.ok(journal.length > 10);
    assert.match(journal, /Working on:/i);
  });
});

describe("cross-process durability", () => {
  it(
    "a message written before the target ever starts is drained on its first session_start",
    { timeout: TIMEOUT },
    () => {
      const inboxDir = join(tmpDir, ".thread", "threads", "thread-a", "inbox");
      mkdirSync(inboxDir, { recursive: true });
      writeFileSync(
        join(inboxDir, "1-manual.json"),
        JSON.stringify({
          from: "outside",
          to: "thread-a",
          type: "Update",
          body: "seeded before start",
          requestId: "update.outside.1",
          delivery: "follow-up",
          sentAt: new Date().toISOString(),
        }),
      );

      const r = runPi("Say 'ok'.", tmpDir, { threadId: "thread-a" });
      assert.ok(r.ok);

      assert.strictEqual(inboxFiles(tmpDir, "thread-a").length, 0);
      assert.strictEqual(inboxFiles(tmpDir, "thread-a", "processed").length, 1);
    },
  );

  it(
    "a natural request to notify a teammate is discovered, delivered, and drains on their next start",
    { timeout: TIMEOUT * 2 },
    () => {
      // Needs to exist with a fresh lastSeen for the model to find it via
      // thread_list (the system prompt requires that lookup before sending)
      // — but thread-a itself hasn't actually run yet, so this still proves
      // real drain-on-first-session_start, just discovered rather than
      // hardcoded as the target the way the old scripted version was.
      seedThread(tmpDir, "thread-a");
      const r = runPi(
        "Let thread-a know you're starting work on the auth module. Then say done.",
        tmpDir,
        { threadId: "thread-b" },
      );
      assert.ok(r.ok);

      const files = inboxFiles(tmpDir, "thread-a");
      assert.strictEqual(files.length, 1);
      const delivered = JSON.parse(
        readFileSync(join(tmpDir, ".thread", "threads", "thread-a", "inbox", files[0]), "utf8"),
      );
      // The model chooses the message type — Note/Update/Brief are all
      // defensible for "let them know"; assert the reasonable set, not one
      // hardcoded answer (that's what the unit layer is for).
      assert.ok(["Note", "Update", "Brief"].includes(delivered.type));
      assert.strictEqual(delivered.from, "thread-b");

      const r2 = runPi("Say 'ok'.", tmpDir, { threadId: "thread-a" });
      assert.ok(r2.ok);
      assert.strictEqual(inboxFiles(tmpDir, "thread-a").length, 0);
      assert.strictEqual(inboxFiles(tmpDir, "thread-a", "processed").length, 1);
    },
  );
});

describe("delegation", () => {
  it(
    "a natural request to delegate work creates an obligation a matching Result clears",
    { timeout: TIMEOUT * 2 },
    () => {
      seedThread(tmpDir, "thread-b");
      const r = runPi("Ask thread-b to implement the login form. Then say done.", tmpDir, {
        threadId: "thread-a",
      });
      assert.ok(r.ok);

      let s = readState(tmpDir, "thread-a");
      assert.strictEqual(s?.obligations?.length, 1);
      assert.strictEqual(s.obligations[0].type, "Brief");
      const requestId = s.obligations[0].requestId;

      seedResult(tmpDir, "thread-a", "thread-b", requestId);
      runPi("Say 'ok'.", tmpDir, { threadId: "thread-a" });

      s = readState(tmpDir, "thread-a");
      assert.strictEqual(s?.obligations?.length ?? 0, 0);
    },
  );
});

describe("query", () => {
  it(
    "a natural question enters Listening until a matching Answer clears it",
    { timeout: TIMEOUT * 2 },
    () => {
      seedThread(tmpDir, "thread-b");
      const r = runPi(
        "Ask thread-b what the current status of the migration is. Then say done.",
        tmpDir,
        { threadId: "thread-a" },
      );
      assert.ok(r.ok);

      let s = readState(tmpDir, "thread-a");
      assert.strictEqual(s?.obligations?.length, 1);
      assert.strictEqual(s.obligations[0].type, "Question");
      assert.strictEqual(s.state, "listening");
      const requestId = s.obligations[0].requestId;

      const inboxDir = join(tmpDir, ".thread", "threads", "thread-a", "inbox");
      mkdirSync(inboxDir, { recursive: true });
      writeFileSync(
        join(inboxDir, "1-answer.json"),
        JSON.stringify({
          from: "thread-b",
          to: "thread-a",
          type: "Answer",
          body: "60% done",
          requestId,
          delivery: "steer",
          sentAt: new Date().toISOString(),
        }),
      );
      runPi("Say 'ok'.", tmpDir, { threadId: "thread-a" });

      s = readState(tmpDir, "thread-a");
      assert.strictEqual(s?.obligations?.length ?? 0, 0);
      assert.strictEqual(s?.lockEventId ?? null, null);
    },
  );
});

describe("escalation", () => {
  it("a natural 'I'm stuck' escalates to the parent as a Blocker", { timeout: TIMEOUT }, () => {
    seedThread(tmpDir, "boss");
    const r = runPi(
      "You're stuck and can't proceed without a decision. Let your parent know. Then say done.",
      tmpDir,
      { threadId: "t1", parent: "boss" },
    );
    assert.ok(r.ok);

    const s = readState(tmpDir, "t1");
    assert.strictEqual(s?.obligations?.length, 1);
    assert.strictEqual(s.obligations[0].type, "Blocker");
    assert.strictEqual(s.obligations[0].to, "boss");
    assert.strictEqual(s.state, "listening");
    assert.strictEqual(s.lockPartner, "boss");
  });
});

describe("sync rendezvous", () => {
  it(
    "request lands as a lock on the partner across two real processes; close unwinds both",
    { timeout: TIMEOUT * 4 },
    () => {
      const requestPrompt = `Call thread_sync_request with partner="thread-b". Then say done.`;
      runPi(requestPrompt, tmpDir, { threadId: "thread-a" });

      const a1 = readState(tmpDir, "thread-a");
      assert.match(a1?.lockEventId ?? "", /^sync\.thread-b\./);
      const requestId = a1!.lockEventId;

      // thread-b starts, drains the Sync message, and should end up locked with thread-a.
      runPi("Say 'ok'.", tmpDir, { threadId: "thread-b" });
      const b1 = readState(tmpDir, "thread-b");
      assert.strictEqual(b1?.lockEventId, requestId);
      assert.strictEqual(b1?.lockPartner, "thread-a");

      // thread-b closes the sync — this notifies thread-a via an Answer.
      runPi("Call thread_sync_close. Then say done.", tmpDir, { threadId: "thread-b" });
      const b2 = readState(tmpDir, "thread-b");
      assert.strictEqual(b2?.lockEventId ?? null, null);

      // thread-a needs to run again to drain the close notice.
      runPi("Say 'ok'.", tmpDir, { threadId: "thread-a" });
      const a2 = readState(tmpDir, "thread-a");
      assert.strictEqual(a2?.lockEventId ?? null, null);
    },
  );
});

describe("envelope comprehension", () => {
  it(
    "a received Question carries its requestId so the model can correctly echo it back",
    { timeout: TIMEOUT },
    () => {
      seedThread(tmpDir, "boss");
      const inboxDir = join(tmpDir, ".thread", "threads", "t1", "inbox");
      mkdirSync(inboxDir, { recursive: true });
      writeFileSync(
        join(inboxDir, "1-q.json"),
        JSON.stringify({
          from: "boss",
          to: "t1",
          type: "Question",
          body: "What is 2+2? Reply with just the number.",
          requestId: "question.boss.42",
          delivery: "steer",
          sentAt: new Date().toISOString(),
        }),
      );

      const r = runPi(
        "If you received a question from another thread, answer it via the tool indicated in the message. Then say done.",
        tmpDir,
        { threadId: "t1" },
      );
      assert.ok(r.ok);

      const bossInbox = inboxFiles(tmpDir, "boss");
      assert.strictEqual(bossInbox.length, 1);
      const reply = JSON.parse(
        readFileSync(join(tmpDir, ".thread", "threads", "boss", "inbox", bossInbox[0]), "utf8"),
      );
      assert.strictEqual(reply.type, "Answer");
      assert.strictEqual(reply.requestId, "question.boss.42");
      assert.strictEqual(reply.from, "t1");
    },
  );
});

describe("thread_list", () => {
  it("surfaces real threads and reports a stale one as stopped", { timeout: TIMEOUT * 3 }, () => {
    runPi("Say 'ok'.", tmpDir, { threadId: "thread-a" });
    runPi("Say 'ok'.", tmpDir, { threadId: "thread-b" });
    seedThread(tmpDir, "ghost", { stale: true });

    const r = runPi(`Call thread_list and report every id you see along with its status.`, tmpDir, {
      threadId: "thread-c",
    });
    assert.match(r.stdout, /thread-a/);
    assert.match(r.stdout, /thread-b/);
    assert.match(r.stdout, /ghost/);
    assert.match(r.stdout, /stopped/i);
  });
});

describe("fan-out and wait", () => {
  it(
    "delegating to two threads and waiting on both arms a barrier the replies resolve",
    { timeout: TIMEOUT * 2 },
    () => {
      seedThread(tmpDir, "alice");
      seedThread(tmpDir, "bob");

      const r1 = runPi(
        `Send a Brief to alice and a separate Brief to bob asking them to review the PR. Note the requestId each reply gives you, then call thread_await waiting on both of those requestIds together (mode="all"). Then say done.`,
        tmpDir,
        { threadId: "t1" },
      );
      assert.ok(r1.ok);

      let s = readState(tmpDir, "t1");
      assert.strictEqual(s?.obligations?.length, 2);
      assert.strictEqual(s?.barriers?.length, 1);

      // Seed a Result per unique id across obligations and the barrier — the
      // model occasionally mistranscribes an id into thread_await, and this
      // test is about the resolution mechanics, not model copying accuracy.
      const ids = new Set<string>([
        ...s.obligations.map((o: { requestId: string }) => o.requestId),
        ...s.barriers[0].pending,
      ]);
      let i = 0;
      for (const requestId of ids) {
        seedResult(tmpDir, "t1", ++i === 1 ? "alice" : "bob", requestId);
      }

      const r2 = runPi("Say 'ok'.", tmpDir, { threadId: "t1" });
      assert.ok(r2.ok);

      s = readState(tmpDir, "t1");
      assert.strictEqual(s?.obligations?.length ?? 0, 0);
      assert.strictEqual(s?.barriers?.length ?? 0, 0);
    },
  );
});

describe("subscribe and emit", () => {
  it(
    "a self-triggered event delivers the subscribed message and clears the subscription",
    { timeout: TIMEOUT },
    () => {
      const r = runPi(
        `Subscribe a message to fire when the event "ready" happens, then trigger that event yourself. Then say done.`,
        tmpDir,
        { threadId: "t1" },
      );
      assert.ok(r.ok);

      const s = readState(tmpDir, "t1");
      assert.strictEqual(s?.subscriptions?.length ?? 0, 0);
    },
  );
});
