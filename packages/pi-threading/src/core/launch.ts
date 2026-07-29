import * as fs from "node:fs";
import * as path from "node:path";
import { spawn, spawnSync, execFileSync } from "node:child_process";
import type { ThreadStore } from "./types";
import { STALE_MS } from "./types";

export type LaunchMode = "tmux" | "background";

export interface TeamThreadConfig {
  id: string;
  role?: string;
  parent?: string;
  model?: string;
  provider?: string;
  journalModel?: string;
  teammates?: string[];
  systemPrompt?: string[];
}

export interface TeamDefaults {
  role?: string;
  parent?: string;
  model?: string;
  provider?: string;
  journalModel?: string;
}

export interface TeamConfig {
  mode?: LaunchMode;
  session?: string;
  defaults?: TeamDefaults;
  threads: TeamThreadConfig[];
}

export interface ResolvedThread {
  id: string;
  role?: string;
  parent?: string;
  model?: string;
  provider?: string;
  journalModel?: string;
  teammates: string[];
  prompts: string[];
}

/** Read and parse a team config. Throws on anything that would make
 *  launching meaningless: missing/unreadable file, invalid JSON, no
 *  threads, or duplicate/empty ids. Dangling `parent` references are not
 *  fatal here — see `validateTeamConfig` — since `parent` may legitimately
 *  point at a thread outside the config (a human-run coordinator). */
export function loadTeamConfig(configPath: string): TeamConfig {
  let raw: string;
  try {
    raw = fs.readFileSync(configPath, "utf8");
  } catch {
    throw new Error(`Could not read team config at "${configPath}".`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new Error(
      `Invalid JSON in team config "${configPath}": ${e instanceof Error ? e.message : String(e)}`,
    );
  }

  const config = parsed as TeamConfig;
  if (!config || !Array.isArray(config.threads) || config.threads.length === 0) {
    throw new Error(`Team config "${configPath}" has no "threads" array.`);
  }

  const seen = new Set<string>();
  for (const thread of config.threads) {
    if (!thread.id || typeof thread.id !== "string") {
      throw new Error(`Every thread in "${configPath}" needs a non-empty "id".`);
    }
    if (seen.has(thread.id)) {
      throw new Error(`Duplicate thread id "${thread.id}" in "${configPath}".`);
    }
    seen.add(thread.id);
  }

  return config;
}

/** Non-fatal warnings about a loaded config — currently just dangling
 *  `parent` references (a thread whose parent isn't itself in the config
 *  and isn't obviously a placeholder like the coordinator). */
export function validateTeamConfig(config: TeamConfig): string[] {
  const ids = new Set(config.threads.map(t => t.id));
  const warnings: string[] = [];

  for (const thread of config.threads) {
    const parent = thread.parent ?? config.defaults?.parent;
    if (parent && !ids.has(parent)) {
      warnings.push(
        `Thread "${thread.id}" has parent "${parent}", which isn't in this config (assuming it runs elsewhere).`,
      );
    }
  }

  return warnings;
}

const PLACEHOLDER_RE = /\$\{(\w+)\}/g;

function substitute(text: string, values: Record<string, string>): string {
  return text.replace(PLACEHOLDER_RE, (match, key: string) =>
    Object.prototype.hasOwnProperty.call(values, key) ? values[key] : match,
  );
}

/** Merge `defaults` under a thread's own fields, compute its teammates
 *  (explicit override, else every other thread in the config sharing this
 *  thread's resolved parent), and render its system-prompt pieces: each
 *  entry is read from disk (resolved relative to `configDir`) when it names
 *  an existing file, else treated as a literal string — either way it goes
 *  through `${id}`/`${role}`/`${parent}`/`${teammates}` substitution. */
export function renderThread(
  thread: TeamThreadConfig,
  config: TeamConfig,
  configDir: string,
): ResolvedThread {
  const defaults = config.defaults ?? {};
  const role = thread.role ?? defaults.role;
  const parent = thread.parent ?? defaults.parent;
  const model = thread.model ?? defaults.model;
  const provider = thread.provider ?? defaults.provider;
  const journalModel = thread.journalModel ?? defaults.journalModel;

  const teammates =
    thread.teammates ??
    config.threads
      .filter(t => t.id !== thread.id && (t.parent ?? defaults.parent) === parent)
      .map(t => t.id);

  const values: Record<string, string> = {
    id: thread.id,
    role: role ?? "",
    parent: parent ?? "",
    teammates: teammates.join(", "),
  };

  const prompts = (thread.systemPrompt ?? []).map(piece => {
    const candidate = path.resolve(configDir, piece);
    const content = fs.existsSync(candidate) ? fs.readFileSync(candidate, "utf8") : piece;
    return substitute(content, values).trim();
  });

  return { id: thread.id, role, parent, model, provider, journalModel, teammates, prompts };
}

const THREAD_SPECIFIC_FLAGS = new Set([
  "--thread-id",
  "--thread-role",
  "--thread-parent",
  "--append-system-prompt",
]);

/** Strip a set of `--flag value` / `--flag=value` pairs from an argv,
 *  leaving everything else (extension loading, storage backend flags,
 *  shared model/provider defaults not overridden per-thread, etc.) intact. */
function stripFlags(argv: string[], flags: Set<string>): string[] {
  const out: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const eq = arg.indexOf("=");
    const name = eq === -1 ? arg : arg.slice(0, eq);
    if (flags.has(name)) {
      if (eq === -1) {
        i++; // also skip the separate value token
      }
      continue;
    }
    out.push(arg);
  }
  return out;
}

/** Build the argv for a launched thread by reusing the coordinator's own
 *  `process.argv` (it already carries however this extension is loaded plus
 *  any shared flags) with the always-thread-specific flags stripped and the
 *  resolved thread's own identity/model/prompts appended. */
export function buildChildArgv(resolved: ResolvedThread, baseArgv: string[]): string[] {
  const toStrip = new Set(THREAD_SPECIFIC_FLAGS);
  if (resolved.model) {
    toStrip.add("--model");
  }
  if (resolved.provider) {
    toStrip.add("--provider");
  }
  if (resolved.journalModel) {
    toStrip.add("--thread-journal-model");
  }

  const argv = stripFlags(baseArgv, toStrip);

  argv.push("--thread-id", resolved.id);
  if (resolved.role) {
    argv.push("--thread-role", resolved.role);
  }
  if (resolved.parent) {
    argv.push("--thread-parent", resolved.parent);
  }
  if (resolved.model) {
    argv.push("--model", resolved.model);
  }
  if (resolved.provider) {
    argv.push("--provider", resolved.provider);
  }
  if (resolved.journalModel) {
    argv.push("--thread-journal-model", resolved.journalModel);
  }
  for (const prompt of resolved.prompts) {
    argv.push("--append-system-prompt", prompt);
  }

  return argv;
}

export function isTmuxAvailable(): boolean {
  try {
    return spawnSync("tmux", ["-V"]).status === 0;
  } catch {
    return false;
  }
}

export function ensureTmuxSession(session: string, cwd: string): void {
  const has = spawnSync("tmux", ["has-session", "-t", session]);
  if (has.status !== 0) {
    execFileSync("tmux", ["new-session", "-d", "-s", session, "-c", cwd]);
  }
}

export function spawnTmuxWindow(session: string, id: string, cwd: string, argv: string[]): void {
  execFileSync("tmux", ["new-window", "-t", session, "-n", id, "-c", cwd, "--", "pi", ...argv]);
}

/** Directory where a thread's own launch log lives — separate from
 *  `state.json`/`journal.md`/`inbox/` written by `adapter/local-fs.ts`, but
 *  in the same `.thread/threads/<id>/` layout regardless of which storage
 *  backend the team actually coordinates through. */
export function threadLaunchLogPath(cwd: string, id: string): string {
  return path.join(cwd, ".thread", "threads", id, "launch.log");
}

export function spawnBackground(resolved: ResolvedThread, argv: string[], cwd: string): void {
  const logPath = threadLaunchLogPath(cwd, resolved.id);
  fs.mkdirSync(path.dirname(logPath), { recursive: true });
  const fd = fs.openSync(logPath, "a");
  try {
    const child = spawn("pi", argv, { cwd, detached: true, stdio: ["ignore", fd, fd] });
    child.unref();
  } finally {
    fs.closeSync(fd);
  }
}

export interface LaunchOutcome {
  id: string;
  ok: boolean;
  message: string;
}

export interface LaunchReport {
  mode: LaunchMode;
  warnings: string[];
  outcomes: LaunchOutcome[];
}

interface LaunchDeps {
  isTmuxAvailable: typeof isTmuxAvailable;
  ensureTmuxSession: typeof ensureTmuxSession;
  spawnTmuxWindow: typeof spawnTmuxWindow;
  spawnBackground: typeof spawnBackground;
}

const defaultLaunchDeps: LaunchDeps = {
  isTmuxAvailable,
  ensureTmuxSession,
  spawnTmuxWindow,
  spawnBackground,
};

/** Resolve a requested launch mode against actual tmux availability,
 *  falling back to "background" (with an explanatory warning) rather than
 *  failing outright when tmux was requested (explicitly or by default) but
 *  isn't on `PATH`. */
function resolveLaunchMode(
  requested: LaunchMode,
  deps: LaunchDeps,
): { mode: LaunchMode; warning?: string } {
  if (requested === "tmux" && !deps.isTmuxAvailable()) {
    return {
      mode: "background",
      warning: 'tmux not found on PATH — falling back to "background" mode.',
    };
  }
  return { mode: requested };
}

/** Spawn one already-resolved thread and turn a thrown spawn error into an
 *  outcome rather than aborting whatever loop called this — shared by
 *  `launchTeam` (spawning many) and `spawnThread` (spawning one ad hoc). */
function spawnResolvedThread(
  resolved: ResolvedThread,
  mode: LaunchMode,
  session: string,
  cwd: string,
  argv: string[],
  deps: LaunchDeps,
): LaunchOutcome {
  try {
    if (mode === "tmux") {
      deps.spawnTmuxWindow(session, resolved.id, cwd, argv);
    } else {
      deps.spawnBackground(resolved, argv, cwd);
    }
    return { id: resolved.id, ok: true, message: `launched (${mode}).` };
  } catch (e) {
    return {
      id: resolved.id,
      ok: false,
      message: `failed to launch: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
}

/** Load a team config and spawn every thread it lists, skipping this thread
 *  itself and any id that already exists. Shared by the `/thread-launch`
 *  command (human-triggered) and the `thread_launch` tool (agent-triggered)
 *  so both report the exact same outcomes. Throws only for config-load
 *  failure or a tmux session that can't be created — both fatal, nothing to
 *  report per-thread yet at that point. `deps` is overridable for tests,
 *  so the orchestration logic (skip rules, mode fallback, aggregation) can
 *  be exercised without actually spawning tmux/background processes. */
export async function launchTeam(
  store: ThreadStore,
  configPath: string,
  deps: LaunchDeps = defaultLaunchDeps,
): Promise<LaunchReport> {
  const config = loadTeamConfig(configPath);
  const warnings = validateTeamConfig(config);

  const { mode, warning } = resolveLaunchMode(config.mode ?? "tmux", deps);
  if (warning) {
    warnings.push(warning);
  }

  const cwd = process.cwd();
  const configDir = path.dirname(configPath);
  const baseArgv = process.argv.slice(2);
  const session = config.session ?? `pi-team-${store.threadId}`;

  if (mode === "tmux") {
    deps.ensureTmuxSession(session, cwd);
  }

  const outcomes: LaunchOutcome[] = [];
  for (const thread of config.threads) {
    if (thread.id === store.threadId) {
      outcomes.push({ id: thread.id, ok: false, message: "skipped: that's this thread." });
      continue;
    }

    if (await store.threadExists(thread.id)) {
      outcomes.push({
        id: thread.id,
        ok: false,
        message: "skipped: a thread with that id already exists.",
      });
      continue;
    }

    const resolved = renderThread(thread, config, configDir);
    const argv = buildChildArgv(resolved, baseArgv);
    outcomes.push(spawnResolvedThread(resolved, mode, session, cwd, argv, deps));
  }

  return { mode, warnings, outcomes };
}

export interface SpawnThreadOptions {
  id: string;
  role?: string;
  parent?: string;
  model?: string;
  provider?: string;
  journalModel?: string;
  /** A single system-prompt piece — inline text, or a path resolved
   *  relative to the current working directory (same file-or-literal rule
   *  as a team config's `systemPrompt` entries). */
  prompt?: string;
  mode?: LaunchMode;
  session?: string;
}

/** Spin up a single thread ad hoc — no `team.json` needed, "just like a
 *  subagent": its parent defaults to the calling thread, so escalations
 *  come back to whoever spawned it. Built on the exact same
 *  render/build/spawn machinery as `launchTeam` (a one-thread, in-memory
 *  `TeamConfig`), so a single ad hoc spawn and a team-of-one config behave
 *  identically. */
export async function spawnThread(
  store: ThreadStore,
  opts: SpawnThreadOptions,
  deps: LaunchDeps = defaultLaunchDeps,
): Promise<LaunchOutcome> {
  if (opts.id === store.threadId) {
    return { id: opts.id, ok: false, message: "skipped: that's this thread." };
  }

  if (await store.threadExists(opts.id)) {
    return { id: opts.id, ok: false, message: "skipped: a thread with that id already exists." };
  }

  const thread: TeamThreadConfig = {
    id: opts.id,
    role: opts.role,
    parent: opts.parent ?? store.threadId,
    model: opts.model,
    provider: opts.provider,
    journalModel: opts.journalModel,
    systemPrompt: opts.prompt ? [opts.prompt] : undefined,
  };
  const config: TeamConfig = { threads: [thread] };
  const cwd = process.cwd();

  const resolved = renderThread(thread, config, cwd);
  const argv = buildChildArgv(resolved, process.argv.slice(2));

  const { mode } = resolveLaunchMode(opts.mode ?? "tmux", deps);
  const session = opts.session ?? `pi-team-${store.threadId}`;
  if (mode === "tmux") {
    deps.ensureTmuxSession(session, cwd);
  }

  return spawnResolvedThread(resolved, mode, session, cwd, argv, deps);
}

export interface ShutdownOutcome {
  id: string;
  ok: boolean;
  message: string;
}

export interface ShutdownOptions {
  force?: boolean;
}

interface ShutdownDeps {
  kill: (pid: number, signal: NodeJS.Signals) => void;
}

const defaultShutdownDeps: ShutdownDeps = {
  kill: (pid, signal) => process.kill(pid, signal),
};

/** Signal a single thread's recorded process to stop — the counterpart to
 *  `launchTeam`. Reads `pid`/`status`/`lastSeen` from the same `state.json`
 *  the extension itself maintains (`state.ts`'s `persist()`), so it works
 *  regardless of whether the thread was started by `/thread-launch` or by
 *  hand: default signal is SIGTERM (graceful — the process still gets its
 *  `session_shutdown` hook), `force` sends SIGKILL instead. Shared by the
 *  `/thread-shutdown` command and the `thread_shutdown` tool. */
export async function shutdownThread(
  store: ThreadStore,
  id: string,
  opts: ShutdownOptions = {},
  deps: ShutdownDeps = defaultShutdownDeps,
): Promise<ShutdownOutcome> {
  if (id === store.threadId) {
    return {
      id,
      ok: false,
      message: "skipped: that's this thread (use thread_suspend on yourself).",
    };
  }

  const state = await store.adapter.loadState(id);
  if (!state) {
    return { id, ok: false, message: "skipped: no recorded state for this id." };
  }

  const stale = Date.now() - new Date(state.lastSeen).getTime() > STALE_MS;
  if (state.status !== "running" || stale) {
    return {
      id,
      ok: false,
      message: `skipped: not running (status ${state.status}${stale ? ", stale" : ""}) — nothing to signal.`,
    };
  }

  const signal: NodeJS.Signals = opts.force ? "SIGKILL" : "SIGTERM";
  try {
    deps.kill(state.pid, signal);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ESRCH") {
      return {
        id,
        ok: false,
        message: `skipped: recorded pid ${state.pid} is not running (stale state).`,
      };
    }
    throw e;
  }

  return { id, ok: true, message: `sent ${signal} to pid ${state.pid}.` };
}
