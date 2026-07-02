/**
 * Functional tests for the thread extension.
 *
 * Each test runs pi with the extension and verifies observable side-effects:
 * the per-thread state file, the journal, and subscription/message delivery.
 *
 * These are end-to-end tests — they call real pi with real models.
 * Run: npm test
 *
 * Cross-thread scenarios use SEQUENTIAL pi invocations rather than truly
 * concurrent ones. A `--print` run exits as soon as its turn finishes, so
 * there's no way for a target thread to be "live" and receiving a message
 * mid-conversation without an interactive/idle-waiting session — that would
 * need TTY automation, out of scope here. What IS deterministically testable,
 * and is exactly what makes delivery durable, is drain-on-session_start: a
 * message sent while the target isn't running sits in its inbox until the
 * target's next invocation. Every cross-thread test below proves that path.
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
const PI_SCRIPT = join(
  HOME,
  ".volta/tools/image/packages/@earendil-works/pi-coding-agent/bin/pi",
);

function runPi(
  prompt: string,
  cwd: string,
  opts: { session?: boolean; threadId?: string } = {},
): { stdout: string; stderr: string; ok: boolean } {
  // --no-session means getSessionFile() returns undefined, blocking journal forks.
  // Use a real session dir when the test needs the journal to be written.
  const sessionArgs = opts.session
    ? ["--session-dir", join(cwd, ".sessions"), "--session-id", "test-session"]
    : ["--no-session"];
  const threadArgs = opts.threadId ? ["--thread-id", opts.threadId] : [];
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

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "pi-thread-test-"));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("state tracking", () => {
  it("state file ends at done after a simple run", { timeout: TIMEOUT }, () => {
    const r = runPi("Say the word 'hello' and nothing else.", tmpDir, { threadId: "t1" });
    assert.ok(r.ok);

    const s = readState(tmpDir, "t1");
    assert.ok(s !== null);
    assert.strictEqual(s.id, "t1");
    assert.strictEqual(s.state, "done");
    assert.match(s.updatedAt, /^\d{4}-/);
  });

  it("lock is null after a run with no sync", { timeout: TIMEOUT }, () => {
    runPi("Say 'hi'.", tmpDir, { threadId: "t1" });
    const s = readState(tmpDir, "t1");
    assert.strictEqual(s?.lockEventId ?? null, null);
  });
});

describe("journal", () => {
  it("journal is written after a turn that uses tools", { timeout: TIMEOUT }, () => {
    // Must use a real session: --no-session makes getSessionFile() return undefined,
    // which blocks forkJournal. The forked child keeps the parent alive until done,
    // so spawnSync already waits for the journal to be written — no sleep needed.
    runPi("List the files in the current directory using the bash tool. Then say done.", tmpDir, {
      session: true,
      threadId: "t1",
    });

    const journal = readJournal(tmpDir, "t1");
    assert.ok(journal.length > 10);
    assert.match(journal, /Working on:/i);
  });
});

describe("event subscription and emit", () => {
  it(
    "subscribe then emit delivers the message and clears the subscription",
    { timeout: TIMEOUT },
    () => {
      const prompt = `You have access to thread_subscribe and thread_emit tools.
Do the following steps in order:
1. Call thread_subscribe with eventId="ready", message="Task is ready", delivery="steer"
2. Call thread_emit with eventId="ready"
3. Report how many subscribers were notified (from the tool result)
Say only the subscriber count as a number.`;

      const r = runPi(prompt, tmpDir, { threadId: "t1" });
      assert.ok(r.ok);

      // State file is the ground-truth check; stdout check is just a sanity signal.
      assert.match(r.stdout.trim(), /^1$/m);

      const s = readState(tmpDir, "t1");
      assert.strictEqual(s?.subscriptions?.length ?? 0, 0);
    },
  );

  it(
    "subscribing to an event that never fires persists in state",
    { timeout: TIMEOUT },
    () => {
      const prompt = `Call thread_subscribe with eventId="never", message="hello", delivery="follow-up". Then say done.`;
      runPi(prompt, tmpDir, { threadId: "t1" });

      const s = readState(tmpDir, "t1");
      assert.strictEqual(s?.subscriptions?.length, 1);
      assert.strictEqual(s?.subscriptions[0].eventId, "never");
    },
  );
});

describe("lock (In Sync) — local behavior", () => {
  it(
    "first sync_request acquires the lock, second returns locked",
    { timeout: TIMEOUT },
    () => {
      const prompt = `You have access to thread_sync_request.
Call thread_sync_request with partner="alice", then call thread_sync_request with partner="bob".
For the second call, say only "second=ok" or "second=locked" based on the tool result.`;

      const r = runPi(prompt, tmpDir, { threadId: "t1" });
      assert.ok(r.ok);

      const s = readState(tmpDir, "t1");
      assert.match(s?.lockEventId ?? "", /^sync\.alice\./);
      assert.strictEqual(s?.lockPartner, "alice");

      assert.match(r.stdout, /second=locked/i);
    },
  );

  it(
    "sync_close releases the lock and notifies local waiters",
    { timeout: TIMEOUT },
    () => {
      const prompt = `You have access to thread_sync_request, thread_subscribe, and thread_sync_close tools.
Do the following in order:
1. Call thread_sync_request with partner="alice" to acquire the lock — note the eventId returned
2. Call thread_subscribe with eventId=<that eventId>, message="lock released", delivery="steer"
3. Call thread_sync_close
4. Report how many waiters were notified (from the tool result).
Say only the waiter count as a number.`;

      const r = runPi(prompt, tmpDir, { threadId: "t1" });
      assert.ok(r.ok);
      assert.match(r.stdout.trim(), /^1$/m);

      const s = readState(tmpDir, "t1");
      assert.strictEqual(s?.lockEventId ?? null, null);
      assert.strictEqual(s?.subscriptions?.length ?? 0, 0);
    },
  );
});

describe("cross-thread messaging", () => {
  it(
    "Note sent while target isn't running is drained on its next session_start",
    { timeout: TIMEOUT * 2 },
    () => {
      // thread-b sends first — thread-a doesn't exist yet.
      const sendPrompt = `Call thread_send with to="thread-a", type="Note", body="hello from b". Then say done.`;
      const sendResult = runPi(sendPrompt, tmpDir, { threadId: "thread-b" });
      assert.ok(sendResult.ok);
      assert.strictEqual(inboxFiles(tmpDir, "thread-a").length, 1);

      // thread-a starts for the first time — session_start should drain it.
      const recvResult = runPi("Say 'ok'.", tmpDir, { threadId: "thread-a" });
      assert.ok(recvResult.ok);

      assert.strictEqual(inboxFiles(tmpDir, "thread-a").length, 0);
      const processed = inboxFiles(tmpDir, "thread-a", "processed");
      assert.strictEqual(processed.length, 1);
      const delivered = JSON.parse(
        readFileSync(
          join(tmpDir, ".thread", "threads", "thread-a", "inbox", "processed", processed[0]),
          "utf8",
        ),
      );
      assert.strictEqual(delivered.type, "Note");
      assert.strictEqual(delivered.from, "thread-b");
      assert.strictEqual(delivered.body, "hello from b");
    },
  );

  it(
    "a message written directly into an inbox is drained on the target's first session_start",
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
    "Brief creates an obligation that a matching Result clears",
    { timeout: TIMEOUT * 3 },
    () => {
      const briefPrompt = `Call thread_send with to="thread-b", type="Brief", body="please do the thing". Then say done.`;
      runPi(briefPrompt, tmpDir, { threadId: "thread-a" });

      let s = readState(tmpDir, "thread-a");
      assert.strictEqual(s?.obligations?.length, 1);
      assert.strictEqual(s.obligations[0].type, "Brief");
      const requestId = s.obligations[0].requestId;
      assert.match(requestId, /^brief\.thread-a\./);

      const resultPrompt = `Call thread_send with to="thread-a", type="Result", body="done", requestId="${requestId}". Then say done.`;
      runPi(resultPrompt, tmpDir, { threadId: "thread-b" });

      // thread-a needs to run again to drain thread-b's Result out of its inbox.
      runPi("Say 'ok'.", tmpDir, { threadId: "thread-a" });

      s = readState(tmpDir, "thread-a");
      assert.strictEqual(s?.obligations?.length ?? 0, 0);
    },
  );

  it(
    "Question puts the sender's lockEventId on hold until a matching Answer clears it",
    { timeout: TIMEOUT * 3 },
    () => {
      const questionPrompt = `Call thread_send with to="thread-b", type="Question", body="what's the status?". Then say done.`;
      runPi(questionPrompt, tmpDir, { threadId: "thread-a" });

      let s = readState(tmpDir, "thread-a");
      assert.strictEqual(s?.obligations?.length, 1);
      assert.strictEqual(s.obligations[0].type, "Question");
      const requestId = s.obligations[0].requestId;

      const answerPrompt = `Call thread_send with to="thread-a", type="Answer", body="all good", requestId="${requestId}". Then say done.`;
      runPi(answerPrompt, tmpDir, { threadId: "thread-b" });

      runPi("Say 'ok'.", tmpDir, { threadId: "thread-a" });

      s = readState(tmpDir, "thread-a");
      assert.strictEqual(s?.obligations?.length ?? 0, 0);
      assert.strictEqual(s?.lockEventId ?? null, null);
    },
  );

  it(
    "Sync rendezvous: request lands as a lock on the partner, close unwinds both",
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

  it(
    "thread_list surfaces every thread that has ever run in this workspace",
    { timeout: TIMEOUT * 3 },
    () => {
      runPi("Say 'ok'.", tmpDir, { threadId: "thread-a" });
      runPi("Say 'ok'.", tmpDir, { threadId: "thread-b" });

      const a = readState(tmpDir, "thread-a");
      const b = readState(tmpDir, "thread-b");
      assert.strictEqual(a?.id, "thread-a");
      assert.strictEqual(b?.id, "thread-b");

      const r = runPi(
        `Call thread_list and report the ids you see, comma-separated.`,
        tmpDir,
        { threadId: "thread-c" },
      );
      assert.match(r.stdout, /thread-a/);
      assert.match(r.stdout, /thread-b/);
    },
  );

  it(
    "a thread with a stale lastSeen is reported as stopped",
    { timeout: TIMEOUT },
    () => {
      const dir = join(tmpDir, ".thread", "threads", "ghost");
      mkdirSync(join(dir, "inbox", "processed"), { recursive: true });
      const staleTime = new Date(Date.now() - 5 * 60_000).toISOString();
      writeFileSync(
        join(dir, "state.json"),
        JSON.stringify(
          {
            id: "ghost",
            pid: 999999,
            cwd: tmpDir,
            parent: null,
            sessionFile: null,
            state: "open",
            status: "running",
            lockEventId: null,
            lockPartner: null,
            subscriptions: [],
            obligations: [],
            startedAt: staleTime,
            lastSeen: staleTime,
            updatedAt: staleTime,
          },
          null,
          2,
        ),
      );

      const r = runPi(
        `Call thread_list and report the status you see for "ghost".`,
        tmpDir,
        { threadId: "observer" },
      );
      assert.match(r.stdout, /stopped/i);
    },
  );
});