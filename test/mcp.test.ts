/**
 * Tests for bin/postbox-mcp.mjs — the zero-dependency MCP stdio server that makes
 * a foreign coding agent a Postbox citizen over the local-fs binding (Appendix B).
 * Unlike unit.test.ts these drive the *real* server as a child process and
 * speak JSON-RPC over its stdio, because the thing under test is exactly that
 * boundary: JSON-RPC in, conforming files on disk out. Interop is proven both
 * ways against the extension's own adapter (createLocalFsAdapter). Every child
 * is killed in a finally block — a leaked child hangs the test runner.
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  rmSync,
  existsSync,
  readFileSync,
  readdirSync,
  mkdirSync,
  writeFileSync,
  renameSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { createLocalFsAdapter } from "../src/adapter/local-fs";
import type { Envelope, StateFile } from "../src/core/types";

const SERVER = join(dirname(fileURLToPath(import.meta.url)), "..", "bin", "postbox-mcp.mjs");

interface RpcResponse {
  jsonrpc: "2.0";
  id: number | string | null;
  result?: unknown;
  error?: { code: number; message: string };
}

/** A live server child plus a JSON-RPC round-tripper over its stdio. */
class McpClient {
  private child: ChildProcessWithoutNullStreams;
  private buf = "";
  private waiters = new Map<number, (r: RpcResponse) => void>();
  private nextId = 1;

  constructor(dir: string, threadId: string, extraEnv: Record<string, string> = {}) {
    this.child = spawn("node", [SERVER], {
      env: { ...process.env, POSTBOX_THREAD_ID: threadId, POSTBOX_DIR: dir, ...extraEnv },
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.child.stdout.setEncoding("utf8");
    this.child.stdout.on("data", chunk => {
      this.buf += chunk;
      let nl: number;
      while ((nl = this.buf.indexOf("\n")) >= 0) {
        const line = this.buf.slice(0, nl).trim();
        this.buf = this.buf.slice(nl + 1);
        if (!line) continue;
        const msg = JSON.parse(line) as RpcResponse;
        const w = typeof msg.id === "number" ? this.waiters.get(msg.id) : undefined;
        if (w && typeof msg.id === "number") {
          this.waiters.delete(msg.id);
          w(msg);
        }
      }
    });
  }

  /** Send one request and await its matching-id response — with a timeout so a
   *  hang fails the test fast instead of stalling the whole suite. */
  request(method: string, params?: unknown, timeoutMs = 8000): Promise<RpcResponse> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`timeout waiting for response to ${method} (id=${id})`)),
        timeoutMs,
      );
      this.waiters.set(id, r => {
        clearTimeout(timer);
        resolve(r);
      });
      this.child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    });
  }

  notify(method: string, params?: unknown): void {
    this.child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n");
  }

  async call(name: string, args?: unknown): Promise<{ text: string; isError: boolean }> {
    const r = await this.request("tools/call", { name, arguments: args ?? {} });
    assert.ok(!r.error, `tools/call ${name} returned JSON-RPC error: ${r.error?.message}`);
    const result = r.result as { content: { type: string; text: string }[]; isError?: boolean };
    return { text: result.content.map(c => c.text).join("\n"), isError: result.isError ?? false };
  }

  get pid(): number | undefined {
    return this.child.pid;
  }

  /** Resolve once the child has fully exited — used after SIGTERM so the
   *  stopped-status assertion reads the child's own final write, not a race. */
  waitExit(): Promise<void> {
    return new Promise(resolve => {
      if (this.child.exitCode !== null || this.child.signalCode !== null) return resolve();
      this.child.once("exit", () => resolve());
    });
  }

  signal(sig: NodeJS.Signals): void {
    this.child.kill(sig);
  }

  kill(): void {
    if (this.child.exitCode === null && this.child.signalCode === null) this.child.kill("SIGKILL");
  }
}

/** Handshake a fresh client (initialize + initialized) and return it live. */
async function connect(
  dir: string,
  id: string,
  extraEnv: Record<string, string> = {},
): Promise<McpClient> {
  const c = new McpClient(dir, id, extraEnv);
  await c.request("initialize", { protocolVersion: "2024-11-05", capabilities: {} });
  c.notify("notifications/initialized");
  return c;
}

function readState(dir: string, id: string): StateFile | null {
  const f = join(dir, ".thread", "threads", id, "state.json");
  return existsSync(f) ? (JSON.parse(readFileSync(f, "utf8")) as StateFile) : null;
}

function inboxFiles(dir: string, id: string, sub: "" | "processed" = ""): string[] {
  const d = join(dir, ".thread", "threads", id, "inbox", sub);
  return existsSync(d) ? readdirSync(d).filter(f => f.endsWith(".json")) : [];
}

/** Write an envelope straight into a mailbox the way bin/thread-cli.mjs would —
 *  inbox.tmp staging + rename — with no MCP server involved on the send side. */
function enqueueRaw(dir: string, to: string, msg: Envelope): void {
  const base = join(dir, ".thread", "threads", to);
  mkdirSync(join(base, "inbox"), { recursive: true });
  mkdirSync(join(base, "inbox.tmp"), { recursive: true });
  const tail = msg.id.includes("/") ? msg.id.slice(msg.id.lastIndexOf("/") + 1) : msg.id;
  const name = `${tail}.json`;
  const staged = join(base, "inbox.tmp", name);
  writeFileSync(staged, JSON.stringify(msg, null, 2));
  renameSync(staged, join(base, "inbox", name));
}

describe("unit: postbox-mcp server", () => {
  let dir: string;
  const live: McpClient[] = [];

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "postbox-mcp-"));
  });
  afterEach(() => {
    for (const c of live) c.kill();
    live.length = 0;
    rmSync(dir, { recursive: true, force: true });
  });

  function spawnClient(id: string, extraEnv?: Record<string, string>): Promise<McpClient> {
    return connect(dir, id, extraEnv).then(c => {
      live.push(c);
      return c;
    });
  }

  it("initialize returns tools capability and tools/list names all six tools", async () => {
    const c = await spawnClient("a");
    const init = await c.request("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
    });
    const result = init.result as {
      capabilities: { tools?: object };
      protocolVersion: string;
    };
    assert.ok(result.capabilities.tools, "initialize advertises a tools capability");
    assert.equal(result.protocolVersion, "2024-11-05");

    const listed = await c.request("tools/list");
    const tools = (listed.result as { tools: { name: string }[] }).tools.map(t => t.name).sort();
    assert.deepEqual(tools, [
      "thread_inbox",
      "thread_journal",
      "thread_list",
      "thread_send",
      "thread_status",
      "thread_wait",
    ]);
  });

  it("unknown JSON-RPC method returns -32601", async () => {
    const c = await spawnClient("a");
    const r = await c.request("does/not/exist");
    assert.equal(r.error?.code, -32601);
  });

  it("thread_send writes a conforming envelope and records an obligation with a default deadline", async () => {
    const c = await spawnClient("a");
    // Give the target a home so the file lands somewhere a drain would find it.
    await spawnClient("b");

    const before = Date.now();
    const res = await c.call("thread_send", { to: "b", body: "need an ETA", expects: true });
    assert.ok(!res.isError, res.text);

    const files = inboxFiles(dir, "b");
    assert.equal(files.length, 1, "exactly one envelope written to b's inbox");
    // Staging dir must be left empty after the rename (Appendix B enqueue).
    assert.equal(inboxFiles(dir, "b").length + inboxFiles(dir, "b", "processed").length, 1);
    assert.equal(readdirSync(join(dir, ".thread", "threads", "b", "inbox.tmp")).length, 0);

    const env = JSON.parse(
      readFileSync(join(dir, ".thread", "threads", "b", "inbox", files[0]), "utf8"),
    ) as Envelope;
    assert.ok(env.id.startsWith("a/"), `id is <from>/<ulid>, got ${env.id}`);
    assert.equal(env.from, "a");
    assert.equal(env.to, "b");
    assert.equal(env.body, "need an ETA");
    assert.equal(env.expects, true);
    assert.ok(env.sentAt);

    const st = readState(dir, "a")!;
    assert.equal(st.obligations.length, 1);
    const ob = st.obligations[0];
    assert.equal(ob.id, env.id);
    assert.equal(ob.to, "b");
    // §9.2 default deadline: ~15 minutes out.
    const dl = new Date(ob.deadline!).getTime();
    assert.ok(
      dl > before + 14 * 60_000 && dl < before + 16 * 60_000,
      `deadline ~15m, got ${ob.deadline}`,
    );
  });

  it("drains an externally-written request, renders the reply hint, and records the owed reply", async () => {
    const c = await spawnClient("a");
    const id = "b/01ABCDEFGHREQUEST0000000001";
    enqueueRaw(dir, "a", {
      id,
      from: "b",
      to: "a",
      body: "please review the plan",
      sentAt: new Date().toISOString(),
      expects: true,
    });

    const res = await c.call("thread_inbox");
    assert.ok(res.text.includes(id), "rendered text carries the id to echo back");
    assert.ok(res.text.includes("please review the plan"));
    assert.match(res.text, /reply with thread_send re=/);

    // Claimed file moved into processed/, inbox drained.
    assert.equal(inboxFiles(dir, "a").length, 0);
    assert.equal(inboxFiles(dir, "a", "processed").length, 1);

    const st = readState(dir, "a")!;
    assert.equal(st.owed.length, 1);
    assert.equal(st.owed[0].id, id);
    assert.equal(st.owed[0].from, "b");
  });

  it("empty inbox renders (no messages)", async () => {
    const c = await spawnClient("a");
    const res = await c.call("thread_inbox");
    assert.equal(res.text, "(no messages)");
  });

  it("thread_send re settles the owed record only for the right target and warns otherwise", async () => {
    const c = await spawnClient("a");
    await spawnClient("b");
    await spawnClient("wrong");

    const id = "b/01ABCDEFGHREQUEST0000000002";
    enqueueRaw(dir, "a", {
      id,
      from: "b",
      to: "a",
      body: "what's the status?",
      sentAt: new Date().toISOString(),
      expects: true,
    });
    await c.call("thread_inbox");
    assert.equal(readState(dir, "a")!.owed.length, 1);

    // Wrong target: debt is owed to b, reply addressed to wrong → left, warned.
    const misdirected = await c.call("thread_send", { to: "wrong", body: "done", re: id });
    assert.match(misdirected.text, /warning/i);
    assert.equal(readState(dir, "a")!.owed.length, 1, "misdirected reply must not discharge");

    // Right target: debt cleared.
    const ok = await c.call("thread_send", { to: "b", body: "done", re: id });
    assert.doesNotMatch(ok.text, /warning/i);
    assert.equal(readState(dir, "a")!.owed.length, 0, "correct reply discharges the debt");
  });

  it("draining a reply clears the obligation only when it comes from the right thread", async () => {
    const c = await spawnClient("a");
    await spawnClient("b");
    const sent = await c.call("thread_send", { to: "b", body: "do it", expects: true });
    const idMatch = /id=(\S+)/.exec(sent.text);
    assert.ok(idMatch, `sent text carries the envelope id: ${sent.text}`);
    const id = idMatch![1];
    assert.equal(readState(dir, "a")!.obligations.length, 1);

    // A reply from an unrelated thread echoing the same re must not discharge.
    enqueueRaw(dir, "a", {
      id: "c/01ABCDEFGHIMPOSTOR000000001",
      from: "c",
      to: "a",
      body: "done!",
      sentAt: new Date().toISOString(),
      re: id,
    });
    await c.call("thread_inbox");
    assert.equal(
      readState(dir, "a")!.obligations.length,
      1,
      "reply from the wrong thread must not clear the obligation",
    );

    // The real reply from b discharges it.
    enqueueRaw(dir, "a", {
      id: "b/01ABCDEFGHREALREPLY00000001",
      from: "b",
      to: "a",
      body: "actually done",
      sentAt: new Date().toISOString(),
      re: id,
    });
    await c.call("thread_inbox");
    assert.equal(readState(dir, "a")!.obligations.length, 0, "real reply discharges");
  });

  it("deliverAfter in the future is not drained; drains once it passes", async () => {
    const c = await spawnClient("a");
    const now = Date.now();
    const future: Envelope = {
      id: "b/01ABCDEFGHFUTURE00000000001",
      from: "b",
      to: "a",
      body: "later",
      sentAt: new Date(now).toISOString(),
      deliverAfter: new Date(now + 3600_000).toISOString(),
    };
    enqueueRaw(dir, "a", future);
    const held = await c.call("thread_inbox");
    assert.equal(held.text, "(no messages)", "future deliverAfter stays queued");
    assert.equal(inboxFiles(dir, "a").length, 1, "held envelope left in place");

    // Same id, now in the past → drains.
    const past: Envelope = { ...future, deliverAfter: new Date(now - 1000).toISOString() };
    enqueueRaw(dir, "a", past);
    const drained = await c.call("thread_inbox");
    assert.ok(drained.text.includes("later"));
    assert.equal(inboxFiles(dir, "a").length, 0);
  });

  it("state.json reads running while alive and stopped after SIGTERM", async () => {
    const c = await spawnClient("a");
    // The server wrote state.json on startup with a fresh lastSeen.
    const alive = readState(dir, "a")!;
    assert.equal(alive.status, "running");
    assert.ok(Date.now() - new Date(alive.lastSeen).getTime() < 60_000);

    c.signal("SIGTERM");
    await c.waitExit();
    const dead = readState(dir, "a")!;
    assert.equal(dead.status, "stopped");
    assert.equal(dead.state, "done");
  });

  it("obligations/owed survive a restart (durable ledger)", async () => {
    const c1 = await spawnClient("a");
    await spawnClient("b");
    await c1.call("thread_send", { to: "b", body: "q", expects: true });
    assert.equal(readState(dir, "a")!.obligations.length, 1);
    c1.signal("SIGTERM");
    await c1.waitExit();

    const c2 = await spawnClient("a");
    const status = await c2.call("thread_status");
    assert.match(status.text, /request to b/, "obligation restored from state.json on restart");
    assert.equal(readState(dir, "a")!.obligations.length, 1);
  });

  it("thread_list applies the liveness rule to a stale peer", async () => {
    const c = await spawnClient("a");
    // A peer whose lastSeen is old must read as stopped regardless of status.
    const staleDir = join(dir, ".thread", "threads", "ghost");
    mkdirSync(staleDir, { recursive: true });
    const old = new Date(Date.now() - 120_000).toISOString();
    writeFileSync(
      join(staleDir, "state.json"),
      JSON.stringify({
        id: "ghost",
        status: "running",
        state: "open",
        role: null,
        parent: null,
        lastSeen: old,
        obligations: [],
        owed: [],
        barriers: [],
      }),
    );
    const res = await c.call("thread_list");
    assert.match(res.text, /ghost.*status=stopped/, "stale lastSeen overrides stored running");
  });

  it("thread_journal returns content, a no-journal marker, and an unknown-thread error", async () => {
    const c = await spawnClient("a");
    const none = await c.call("thread_journal", { id: "a" });
    assert.equal(none.text, "(no journal)");

    writeFileSync(join(dir, ".thread", "threads", "a", "journal.md"), "<!-- e --> hello\n");
    const some = await c.call("thread_journal", { id: "a" });
    assert.match(some.text, /hello/);

    const missing = await c.call("thread_journal", { id: "nope" });
    assert.ok(missing.isError);
    assert.match(missing.text, /unknown thread/);
  });

  it("thread_wait times out with a clear message when nothing is due", async () => {
    const c = await spawnClient("a");
    const res = await c.call("thread_wait", { timeoutSeconds: 1 });
    assert.equal(res.text, "(no messages after 1s)");
  });

  it("thread_wait drains a message that arrives mid-wait", async () => {
    const c = await spawnClient("a");
    const id = "b/01ABCDEFGHWAIT000000000001";
    const waiting = c.call("thread_wait", { timeoutSeconds: 10 });
    // Drop a message in after the wait has started polling.
    setTimeout(() => {
      enqueueRaw(dir, "a", {
        id,
        from: "b",
        to: "a",
        body: "woke you up",
        sentAt: new Date().toISOString(),
      });
    }, 300);
    const res = await waiting;
    assert.ok(res.text.includes("woke you up"));
    assert.ok(res.text.includes(id));
  });

  describe("interop with the extension's own local-fs adapter", () => {
    it("an adapter-enqueued envelope is drained by the MCP server", async () => {
      const c = await spawnClient("a");
      const adapter = createLocalFsAdapter();
      await adapter.configure(dir);
      const env: Envelope = {
        id: "b/01ADAPTERTOSERVER0000000001",
        from: "b",
        to: "a",
        body: "from the adapter",
        sentAt: new Date().toISOString(),
        expects: true,
      };
      await adapter.enqueueMessage(env);

      const res = await c.call("thread_inbox");
      assert.ok(res.text.includes("from the adapter"));
      assert.ok(res.text.includes(env.id));
      assert.equal(readState(dir, "a")!.owed[0].id, env.id);
    });

    it("an MCP-sent envelope is returned by adapter.drainInbox", async () => {
      const c = await spawnClient("a");
      await spawnClient("b");
      const sent = await c.call("thread_send", { to: "b", body: "from the server", expects: true });
      assert.ok(!sent.isError, sent.text);

      const adapter = createLocalFsAdapter();
      await adapter.configure(dir);
      const drained = await adapter.drainInbox("b");
      assert.equal(drained.length, 1);
      assert.equal(drained[0].body, "from the server");
      assert.ok(drained[0].id.startsWith("a/"));
      assert.equal(drained[0].expects, true);
    });
  });
});
