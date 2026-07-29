/**
 * Pure CLI-behavior tests for thread-cli.mjs: usage/help output, argument
 * validation, and filesystem-only commands (delete's confirmation guards),
 * exercised directly against hand-written fixture files — no dependency on
 * the pi-threading extension package. Tests that verify the CLI's writes
 * are understood by the extension's own drain logic (interop, not just CLI
 * behavior) live in packages/pi-threading/test/unit.test.ts instead, since
 * they need that package's test harness.
 *
 * Run: npm test (or: node --test test/cli.test.mjs)
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const cli = join(import.meta.dirname, "..", "bin", "thread-cli.mjs");

function runCli(dir, ...args) {
  return execFileSync(process.execPath, [cli, ...args, "--dir", dir], { encoding: "utf8" });
}

function writeState(dir, id, overrides = {}) {
  const threadDir = join(dir, ".thread", "threads", id);
  mkdirSync(join(threadDir, "inbox", "processed"), { recursive: true });
  // Stopped and long-unseen by default, so a plain `delete` doesn't hit the
  // "appears to be running" guard — tests exercising that guard pass their
  // own status/lastSeen overrides.
  const longAgo = new Date(Date.now() - 10 * 60_000).toISOString();
  writeFileSync(
    join(threadDir, "state.json"),
    JSON.stringify({
      id,
      pid: 1,
      cwd: dir,
      parent: null,
      role: null,
      sessionFile: null,
      state: "idle",
      status: "stopped",
      holdReason: null,
      obligations: [],
      owed: [],
      barriers: [],
      startedAt: longAgo,
      lastSeen: longAgo,
      updatedAt: longAgo,
      ...overrides,
    }),
  );
}

describe("bin/thread-cli.mjs: usage and argument validation", () => {
  let dir;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "pi-threading-cli-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("prints usage and exits non-zero with no arguments", () => {
    assert.throws(
      () => execFileSync(process.execPath, [cli], { encoding: "utf8" }),
      /Command failed/,
    );
  });

  it("prints usage and exits zero for --help", () => {
    const out = execFileSync(process.execPath, [cli, "--help"], { encoding: "utf8" });
    assert.match(out, /monitor and steer a multi-agent thread system/);
  });

  it("errors on an unknown command", () => {
    assert.throws(() => runCli(dir, "bogus"), /unknown command "bogus"/);
  });

  it("list on an empty workspace prints an empty table, not an error", () => {
    const out = runCli(dir, "list");
    assert.doesNotMatch(out, /error/i);
  });
});

describe("bin/thread-cli.mjs: delete guards", () => {
  let dir;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "pi-threading-cli-"));
    writeState(dir, "a");
    writeState(dir, "b");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("refuses to delete more than one thread without --yes", () => {
    assert.throws(
      () => runCli(dir, "delete", "a", "b"),
      /refusing to delete 2 thread\(s\) without --yes/,
    );
  });

  it("deletes a single named thread without needing --yes", () => {
    const out = runCli(dir, "delete", "a");
    assert.match(out, /deleted a/);
  });

  it("deletes multiple threads once --yes is given", () => {
    const out = runCli(dir, "delete", "a", "b", "--yes");
    assert.match(out, /deleted a/);
    assert.match(out, /deleted b/);
  });

  it("skips a thread that looks live unless --force is given", () => {
    writeState(dir, "c", { status: "running", lastSeen: new Date().toISOString() });
    // Nothing ends up deleted (both threads it was asked about are either
    // live or already gone), so the CLI exits non-zero — execFileSync
    // throws with the process's stderr attached to the error.
    assert.throws(() => runCli(dir, "delete", "c"), /appears to be running/);
  });
});
