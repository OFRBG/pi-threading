/**
 * Deterministic, no-subprocess tests for the config-driven team launcher
 * (`src/core/launch.ts`): config loading/validation, templating, and argv
 * construction. Actually spawning tmux/background processes is exercised
 * manually (see the plan's verification section), not here.
 *
 * Run: npm run test:unit
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  loadTeamConfig,
  validateTeamConfig,
  renderThread,
  buildChildArgv,
  launchTeam,
  shutdownThread,
  spawnThread,
  type TeamConfig,
  type ResolvedThread,
} from "../src/core/launch";
import type { ThreadStore } from "../src/core/types";

describe("core/launch", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "pi-thread-launch-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function writeConfig(config: unknown): string {
    const file = join(dir, "team.json");
    writeFileSync(file, JSON.stringify(config));
    return file;
  }

  describe("loadTeamConfig", () => {
    it("throws on a missing file", () => {
      assert.throws(() => loadTeamConfig(join(dir, "nope.json")), /Could not read/);
    });

    it("throws on invalid JSON", () => {
      const file = join(dir, "team.json");
      writeFileSync(file, "{not json");
      assert.throws(() => loadTeamConfig(file), /Invalid JSON/);
    });

    it("throws when threads is missing or empty", () => {
      assert.throws(() => loadTeamConfig(writeConfig({})), /no "threads" array/);
      assert.throws(() => loadTeamConfig(writeConfig({ threads: [] })), /no "threads" array/);
    });

    it("throws on a thread with no id", () => {
      const file = writeConfig({ threads: [{ role: "lead" }] });
      assert.throws(() => loadTeamConfig(file), /non-empty "id"/);
    });

    it("throws on duplicate ids", () => {
      const file = writeConfig({ threads: [{ id: "a" }, { id: "a" }] });
      assert.throws(() => loadTeamConfig(file), /Duplicate thread id "a"/);
    });

    it("loads a well-formed config", () => {
      const file = writeConfig({
        threads: [{ id: "a-lead" }, { id: "a-dev-1", parent: "a-lead" }],
      });
      const config = loadTeamConfig(file);
      assert.equal(config.threads.length, 2);
    });
  });

  describe("validateTeamConfig", () => {
    it("warns about a parent not present in the config", () => {
      const config: TeamConfig = { threads: [{ id: "a-lead", parent: "hq" }] };
      const warnings = validateTeamConfig(config);
      assert.equal(warnings.length, 1);
      assert.match(warnings[0], /"a-lead" has parent "hq"/);
    });

    it("does not warn when every parent is in the config", () => {
      const config: TeamConfig = {
        threads: [{ id: "a-lead" }, { id: "a-dev-1", parent: "a-lead" }],
      };
      assert.deepEqual(validateTeamConfig(config), []);
    });
  });

  describe("renderThread", () => {
    it("merges defaults under thread-level fields", () => {
      const config: TeamConfig = {
        defaults: { model: "default-model", provider: "openrouter" },
        threads: [{ id: "a-dev-1", model: "override-model" }],
      };
      const resolved = renderThread(config.threads[0], config, dir);
      assert.equal(resolved.model, "override-model");
      assert.equal(resolved.provider, "openrouter");
    });

    it("derives teammates from siblings sharing the same parent", () => {
      const config: TeamConfig = {
        threads: [
          { id: "a-lead" },
          { id: "a-dev-1", parent: "a-lead" },
          { id: "a-dev-2", parent: "a-lead" },
          { id: "b-dev-1", parent: "b-lead" },
        ],
      };
      const resolved = renderThread(config.threads[1], config, dir);
      assert.deepEqual(resolved.teammates, ["a-dev-2"]);
    });

    it("lets a thread override its computed teammates", () => {
      const config: TeamConfig = {
        threads: [
          { id: "a-dev-1", parent: "a-lead", teammates: ["explicit-mate"] },
          { id: "a-dev-2", parent: "a-lead" },
        ],
      };
      const resolved = renderThread(config.threads[0], config, dir);
      assert.deepEqual(resolved.teammates, ["explicit-mate"]);
    });

    it("substitutes placeholders in an inline prompt string", () => {
      const config: TeamConfig = {
        threads: [
          { id: "a-lead", role: "lead", parent: "hq" },
          { id: "a-dev-1", parent: "a-lead", systemPrompt: ["You report to ${parent}, id ${id}."] },
        ],
      };
      const resolved = renderThread(config.threads[1], config, dir);
      assert.deepEqual(resolved.prompts, ["You report to a-lead, id a-dev-1."]);
    });

    it("reads a prompt piece from a file relative to the config directory", () => {
      mkdirSync(join(dir, "briefs"), { recursive: true });
      writeFileSync(join(dir, "briefs", "dev.md"), "Teammates: ${teammates}");
      const config: TeamConfig = {
        threads: [
          { id: "a-dev-1", parent: "a-lead", systemPrompt: ["briefs/dev.md"] },
          { id: "a-dev-2", parent: "a-lead" },
        ],
      };
      const resolved = renderThread(config.threads[0], config, dir);
      assert.deepEqual(resolved.prompts, ["Teammates: a-dev-2"]);
    });

    it("leaves unknown placeholders untouched", () => {
      const config: TeamConfig = {
        threads: [{ id: "a-dev-1", systemPrompt: ["Unknown: ${nope}"] }],
      };
      const resolved = renderThread(config.threads[0], config, dir);
      assert.deepEqual(resolved.prompts, ["Unknown: ${nope}"]);
    });

    it("treats a prompt piece that names an existing directory as a literal string, not a read target", () => {
      mkdirSync(join(dir, "briefs"), { recursive: true });
      const config: TeamConfig = {
        threads: [{ id: "a-dev-1", systemPrompt: ["briefs"] }],
      };
      // Must not throw (EISDIR) — "briefs" resolves to a real directory
      // relative to `dir`, but isn't a file, so it's kept as literal text.
      const resolved = renderThread(config.threads[0], config, dir);
      assert.deepEqual(resolved.prompts, ["briefs"]);
    });
  });

  describe("buildChildArgv", () => {
    it("strips thread-specific flags from the base argv and appends the resolved ones", () => {
      const baseArgv = [
        "--extension",
        "src/index.ts",
        "--thread-id",
        "coordinator",
        "--thread-role",
        "lead",
        "--append-system-prompt",
        "old brief",
        "--thread-storage",
        "local",
      ];
      const resolved = {
        id: "a-dev-1",
        role: "a-support",
        parent: "a-lead",
        teammates: [],
        prompts: ["brief one", "brief two"],
      };
      const argv = buildChildArgv(resolved, baseArgv);

      assert.deepEqual(argv, [
        "--extension",
        "src/index.ts",
        "--thread-storage",
        "local",
        "--thread-id",
        "a-dev-1",
        "--thread-role",
        "a-support",
        "--thread-parent",
        "a-lead",
        "--append-system-prompt",
        "brief one",
        "--append-system-prompt",
        "brief two",
      ]);
    });

    it("strips and replaces --model/--provider/--thread-journal-model only when the thread overrides them", () => {
      const baseArgv = ["--model", "base-model", "--provider", "base-provider", "--thread-id", "x"];
      const resolved = {
        id: "a-dev-1",
        teammates: [],
        prompts: [],
        model: "override-model",
      };
      const argv = buildChildArgv(resolved, baseArgv);

      // --provider isn't overridden, so the base flag survives untouched.
      assert.deepEqual(argv, [
        "--provider",
        "base-provider",
        "--thread-id",
        "a-dev-1",
        "--model",
        "override-model",
      ]);
    });

    it("handles --flag=value form when stripping", () => {
      const baseArgv = ["--model=base-model", "--thread-id=coordinator"];
      const resolved = { id: "a-dev-1", teammates: [], prompts: [], model: "override" };
      const argv = buildChildArgv(resolved, baseArgv);
      assert.deepEqual(argv, ["--thread-id", "a-dev-1", "--model", "override"]);
    });
  });

  describe("launchTeam", () => {
    function fakeStore(threadId: string, existing: Set<string> = new Set()): ThreadStore {
      return {
        threadId,
        threadExists: async (id: string) => existing.has(id),
      } as unknown as ThreadStore;
    }

    function fakeDeps(
      overrides: {
        tmux?: boolean;
        onSpawnTmux?: (session: string, id: string) => void;
        onSpawnBackground?: (resolved: ResolvedThread) => void;
        onEnsureSession?: (session: string) => void;
      } = {},
    ) {
      return {
        isTmuxAvailable: () => overrides.tmux ?? false,
        ensureTmuxSession: (session: string) => overrides.onEnsureSession?.(session),
        spawnTmuxWindow: (session: string, id: string) => overrides.onSpawnTmux?.(session, id),
        spawnBackground: (resolved: ResolvedThread) => overrides.onSpawnBackground?.(resolved),
      };
    }

    it("skips this thread's own id without spawning it", async () => {
      const file = writeConfig({ threads: [{ id: "coordinator" }, { id: "a-dev-1" }] });
      const spawned: string[] = [];
      const report = await launchTeam(
        fakeStore("coordinator"),
        file,
        fakeDeps({ onSpawnBackground: r => spawned.push(r.id) }),
      );
      assert.deepEqual(spawned, ["a-dev-1"]);
      const own = report.outcomes.find(o => o.id === "coordinator")!;
      assert.equal(own.ok, false);
      assert.match(own.message, /that's this thread/);
    });

    it("skips an id that already has a recorded thread", async () => {
      const file = writeConfig({ threads: [{ id: "a-dev-1" }] });
      const spawned: string[] = [];
      const report = await launchTeam(
        fakeStore("coordinator", new Set(["a-dev-1"])),
        file,
        fakeDeps({ onSpawnBackground: r => spawned.push(r.id) }),
      );
      assert.deepEqual(spawned, []);
      assert.match(report.outcomes[0].message, /already exists/);
    });

    it("falls back to background with a warning when tmux is requested but unavailable", async () => {
      const file = writeConfig({ mode: "tmux", threads: [{ id: "a-dev-1" }] });
      const spawned: string[] = [];
      const tmuxCalls: string[] = [];
      const report = await launchTeam(
        fakeStore("coordinator"),
        file,
        fakeDeps({
          tmux: false,
          onSpawnBackground: r => spawned.push(r.id),
          onSpawnTmux: (_s, id) => tmuxCalls.push(id),
        }),
      );
      assert.equal(report.mode, "background");
      assert.match(report.warnings[0], /falling back to "background"/);
      assert.deepEqual(spawned, ["a-dev-1"]);
      assert.deepEqual(tmuxCalls, []);
    });

    it("uses tmux when available, creating the session once for the whole team", async () => {
      const file = writeConfig({
        mode: "tmux",
        session: "teams",
        threads: [{ id: "a-dev-1" }, { id: "a-dev-2" }],
      });
      const ensured: string[] = [];
      const windows: string[] = [];
      const report = await launchTeam(
        fakeStore("coordinator"),
        file,
        fakeDeps({
          tmux: true,
          onEnsureSession: s => ensured.push(s),
          onSpawnTmux: (_s, id) => windows.push(id),
        }),
      );
      assert.equal(report.mode, "tmux");
      assert.deepEqual(ensured, ["teams"]);
      assert.deepEqual(windows, ["a-dev-1", "a-dev-2"]);
    });

    it("records a per-thread spawn failure without aborting the rest of the team", async () => {
      const file = writeConfig({ threads: [{ id: "a-dev-1" }, { id: "a-dev-2" }] });
      const report = await launchTeam(
        fakeStore("coordinator"),
        file,
        fakeDeps({
          onSpawnBackground: r => {
            if (r.id === "a-dev-1") {
              throw new Error("boom");
            }
          },
        }),
      );
      assert.equal(report.outcomes[0].ok, false);
      assert.match(report.outcomes[0].message, /failed to launch: boom/);
      assert.equal(report.outcomes[1].ok, true);
    });
  });

  describe("spawnThread", () => {
    function fakeStore(threadId: string, existing: Set<string> = new Set()): ThreadStore {
      return {
        threadId,
        threadExists: async (id: string) => existing.has(id),
      } as unknown as ThreadStore;
    }

    function fakeDeps(
      overrides: {
        tmux?: boolean;
        onSpawnTmux?: (session: string, id: string) => void;
        onSpawnBackground?: (resolved: ResolvedThread) => void;
        onEnsureSession?: (session: string) => void;
      } = {},
    ) {
      return {
        isTmuxAvailable: () => overrides.tmux ?? false,
        ensureTmuxSession: (session: string) => overrides.onEnsureSession?.(session),
        spawnTmuxWindow: (session: string, id: string) => overrides.onSpawnTmux?.(session, id),
        spawnBackground: (resolved: ResolvedThread) => overrides.onSpawnBackground?.(resolved),
      };
    }

    it("refuses to spawn itself", async () => {
      const outcome = await spawnThread(fakeStore("coordinator"), { id: "coordinator" });
      assert.equal(outcome.ok, false);
      assert.match(outcome.message, /that's this thread/);
    });

    it("skips an id that already has a recorded thread", async () => {
      const spawned: string[] = [];
      const outcome = await spawnThread(
        fakeStore("coordinator", new Set(["a-dev-1"])),
        { id: "a-dev-1" },
        fakeDeps({ onSpawnBackground: r => spawned.push(r.id) }),
      );
      assert.equal(outcome.ok, false);
      assert.match(outcome.message, /already exists/);
      assert.deepEqual(spawned, []);
    });

    it("defaults the new thread's parent to the spawning thread", async () => {
      const spawned: ResolvedThread[] = [];
      await spawnThread(
        fakeStore("coordinator"),
        { id: "a-dev-1" },
        fakeDeps({ onSpawnBackground: r => spawned.push(r) }),
      );
      assert.equal(spawned[0].parent, "coordinator");
    });

    it("honors an explicit parent override", async () => {
      const spawned: ResolvedThread[] = [];
      await spawnThread(
        fakeStore("coordinator"),
        { id: "a-dev-1", parent: "a-lead" },
        fakeDeps({ onSpawnBackground: r => spawned.push(r) }),
      );
      assert.equal(spawned[0].parent, "a-lead");
    });

    it("turns a prompt string into the thread's system prompt", async () => {
      const spawned: ResolvedThread[] = [];
      await spawnThread(
        fakeStore("coordinator"),
        { id: "a-dev-1", prompt: "Investigate the mobile login timeout." },
        fakeDeps({ onSpawnBackground: r => spawned.push(r) }),
      );
      assert.deepEqual(spawned[0].prompts, ["Investigate the mobile login timeout."]);
    });

    it("doesn't crash when a one-word prompt happens to name a real directory in cwd", async () => {
      mkdirSync(join(dir, "src"), { recursive: true });
      const cwdBefore = process.cwd();
      process.chdir(dir);
      try {
        const spawned: ResolvedThread[] = [];
        const outcome = await spawnThread(
          fakeStore("coordinator"),
          { id: "a-dev-1", prompt: "src" },
          fakeDeps({ onSpawnBackground: r => spawned.push(r) }),
        );
        assert.equal(outcome.ok, true);
        assert.deepEqual(spawned[0].prompts, ["src"]);
      } finally {
        process.chdir(cwdBefore);
      }
    });

    it("falls back to background when tmux mode is requested but unavailable", async () => {
      const spawned: string[] = [];
      const tmuxCalls: string[] = [];
      const outcome = await spawnThread(
        fakeStore("coordinator"),
        { id: "a-dev-1", mode: "tmux" },
        fakeDeps({
          tmux: false,
          onSpawnBackground: r => spawned.push(r.id),
          onSpawnTmux: (_s, id) => tmuxCalls.push(id),
        }),
      );
      assert.equal(outcome.ok, true);
      assert.match(outcome.message, /launched \(background\)/);
      assert.deepEqual(spawned, ["a-dev-1"]);
      assert.deepEqual(tmuxCalls, []);
    });

    it("uses tmux when explicitly requested and available", async () => {
      const windows: string[] = [];
      const ensured: string[] = [];
      const outcome = await spawnThread(
        fakeStore("coordinator"),
        { id: "a-dev-1", mode: "tmux", session: "teams" },
        fakeDeps({
          tmux: true,
          onEnsureSession: s => ensured.push(s),
          onSpawnTmux: (_s, id) => windows.push(id),
        }),
      );
      assert.equal(outcome.ok, true);
      assert.deepEqual(ensured, ["teams"]);
      assert.deepEqual(windows, ["a-dev-1"]);
    });
  });

  describe("shutdownThread", () => {
    function fakeStore(
      threadId: string,
      states: Record<string, Record<string, unknown>>,
    ): ThreadStore {
      return {
        threadId,
        adapter: {
          loadState: async (id: string) =>
            states[id]
              ? { pid: 1, status: "running", lastSeen: new Date().toISOString(), ...states[id] }
              : undefined,
        },
      } as unknown as ThreadStore;
    }

    it("refuses to target itself", async () => {
      const outcome = await shutdownThread(fakeStore("t1", {}), "t1");
      assert.equal(outcome.ok, false);
      assert.match(outcome.message, /that's this thread/);
    });

    it("skips an id with no recorded state", async () => {
      const outcome = await shutdownThread(fakeStore("t1", {}), "ghost");
      assert.equal(outcome.ok, false);
      assert.match(outcome.message, /no recorded state/);
    });

    it("skips a thread that's already stopped", async () => {
      const store = fakeStore("t1", { a: { status: "stopped" } });
      const outcome = await shutdownThread(store, "a");
      assert.equal(outcome.ok, false);
      assert.match(outcome.message, /not running/);
    });

    it("skips a thread whose lastSeen is stale even if status says running", async () => {
      const store = fakeStore("t1", {
        a: { status: "running", lastSeen: new Date(Date.now() - 120_000).toISOString() },
      });
      const outcome = await shutdownThread(store, "a");
      assert.equal(outcome.ok, false);
      assert.match(outcome.message, /stale/);
    });

    it("sends SIGTERM by default to a live thread's recorded pid", async () => {
      const store = fakeStore("t1", { a: { pid: 4242 } });
      const calls: [number, string][] = [];
      const outcome = await shutdownThread(
        store,
        "a",
        {},
        { kill: (pid, signal) => calls.push([pid, signal]) },
      );
      assert.equal(outcome.ok, true);
      assert.deepEqual(calls, [[4242, "SIGTERM"]]);
    });

    it("sends SIGKILL when force is set", async () => {
      const store = fakeStore("t1", { a: { pid: 4242 } });
      const calls: [number, string][] = [];
      await shutdownThread(
        store,
        "a",
        { force: true },
        { kill: (pid, signal) => calls.push([pid, signal]) },
      );
      assert.deepEqual(calls, [[4242, "SIGKILL"]]);
    });

    it("reports an already-dead pid (ESRCH) as skipped, not a crash", async () => {
      const store = fakeStore("t1", { a: { pid: 4242 } });
      const kill = () => {
        const e = new Error("no such process") as NodeJS.ErrnoException;
        e.code = "ESRCH";
        throw e;
      };
      const outcome = await shutdownThread(store, "a", {}, { kill });
      assert.equal(outcome.ok, false);
      assert.match(outcome.message, /is not running/);
    });
  });
});
