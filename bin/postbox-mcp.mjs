#!/usr/bin/env node
// postbox-mcp.mjs — zero-dependency MCP stdio server: makes any MCP-capable
// coding agent (Claude Code, Codex CLI, ...) a citizen of Postbox
// (PROTOCOL-FORMALISM.md) by speaking the local-fs binding (Appendix B)
// directly — the same binding bin/thread-cli.mjs and
// src/adapter/local-fs.ts speak. This process is a C2 correlating client
// (§2.2): it tracks the obligation/owed ledger (§9), but runs no waits or
// state machine beyond "running"/"stopped" — that's C3, the pi extension's
// job. Envelopes and state.json on disk are the interop surface; nothing
// here is specific to any MCP client's internals.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import process from "node:process";
import readline from "node:readline";
import { setInterval, clearInterval } from "node:timers";
import { setTimeout as delay } from "node:timers/promises";

const STALE_MS = 60_000; // §8.2 liveness rule
const HEARTBEAT_MS = 20_000; // matches core/types.ts HEARTBEAT_MS
const DEFAULT_OBLIGATION_DEADLINE_MS = 15 * 60_000; // §9.2 fallback

const THREAD_ID = process.env.POSTBOX_THREAD_ID;
if (!THREAD_ID) {
  process.stderr.write(
    "postbox-mcp: POSTBOX_THREAD_ID is required — set it to this thread's identity (e.g. POSTBOX_THREAD_ID=cc-1)\n",
  );
  process.exit(1);
}
const WORKSPACE = process.env.POSTBOX_DIR ? path.resolve(process.env.POSTBOX_DIR) : process.cwd();
const ROLE = process.env.POSTBOX_ROLE || null;
const PARENT = process.env.POSTBOX_PARENT || null;

const THREADS_ROOT = path.join(WORKSPACE, ".thread", "threads");
const THREAD_DIR = path.join(THREADS_ROOT, THREAD_ID);

function nowIso() {
  return new Date().toISOString();
}

// --- ULID (Appendix B: filename = sortable id, sorted readdir is FIFO) ----
// Monotonic within this process, mirroring src/core/ids.ts: two ids minted
// in the same millisecond increment the random tail rather than re-rolling
// it, so same-tick sends still sort in send order.
const B32 = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
let lastMs = -1;
let lastRand = [];
function ulid(now = Date.now()) {
  if (now === lastMs) {
    for (let i = 15; i >= 0; i--) {
      if (lastRand[i] < 31) {
        lastRand[i]++;
        break;
      }
      lastRand[i] = 0;
    }
  } else {
    lastMs = now;
    lastRand = Array.from(crypto.randomBytes(16)).map(b => b & 31);
  }
  let t = "";
  let ms = now;
  for (let i = 0; i < 10; i++) {
    t = B32[ms % 32] + t;
    ms = Math.floor(ms / 32);
  }
  return t + lastRand.map(i => B32[i]).join("");
}

// --- fs helpers (Appendix B: state.json write-temp+rename, inbox.tmp
// staging, processed/ after claim) --------------------------------------
function threadDirOf(id) {
  return path.join(THREADS_ROOT, id);
}
function statePathOf(dir) {
  return path.join(dir, "state.json");
}
function inboxDir() {
  return path.join(THREAD_DIR, "inbox");
}
function processedDir() {
  return path.join(inboxDir(), "processed");
}

function readJsonSafe(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (err) {
    if (err.code === "ENOENT") return undefined;
    process.stderr.write(`postbox-mcp: could not parse ${file}: ${err.message}\n`);
    return null;
  }
}

function saveStateSync() {
  fs.mkdirSync(THREAD_DIR, { recursive: true });
  const tmp = statePathOf(THREAD_DIR) + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
  fs.renameSync(tmp, statePathOf(THREAD_DIR));
}

/** Enqueue: write to inbox.tmp/ staging, rename into inbox/ — atomic on
 *  POSIX, so a reader never sees a partial envelope (Appendix B). */
function writeMessageAtomic(targetId, message) {
  const targetDir = threadDirOf(targetId);
  const dir = path.join(targetDir, "inbox");
  const staging = path.join(targetDir, "inbox.tmp");
  fs.mkdirSync(dir, { recursive: true });
  fs.mkdirSync(staging, { recursive: true });
  const tail = message.id.includes("/")
    ? message.id.slice(message.id.lastIndexOf("/") + 1)
    : message.id;
  const name = `${tail.replace(/[^A-Za-z0-9._-]/g, "_")}.json`;
  const tmp = path.join(staging, name);
  const final = path.join(dir, name);
  fs.writeFileSync(tmp, JSON.stringify(message, null, 2));
  fs.renameSync(tmp, final);
  return final;
}

function effectiveStatus(s) {
  const stale = s.lastSeen && Date.now() - Date.parse(s.lastSeen) > STALE_MS;
  if (stale) return "stopped";
  return s.status || "unknown";
}

// --- own state.json: obligations/owed/barriers are durable (§13.2),
// restored from an existing file if this thread has run before ----------
fs.mkdirSync(THREAD_DIR, { recursive: true });
const existing = readJsonSafe(statePathOf(THREAD_DIR));
const state = {
  id: THREAD_ID,
  pid: process.pid,
  cwd: WORKSPACE,
  parent: PARENT,
  role: ROLE,
  sessionFile: null,
  state: "open",
  status: "running",
  holdReason: null,
  obligations: existing && Array.isArray(existing.obligations) ? existing.obligations : [],
  owed: existing && Array.isArray(existing.owed) ? existing.owed : [],
  barriers: existing && Array.isArray(existing.barriers) ? existing.barriers : [],
  startedAt: nowIso(),
  lastSeen: nowIso(),
  updatedAt: nowIso(),
};
saveStateSync();

const heartbeatTimer = setInterval(() => {
  state.lastSeen = nowIso();
  state.updatedAt = nowIso();
  saveStateSync();
}, HEARTBEAT_MS);
heartbeatTimer.unref?.();

let shuttingDown = false;
function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  clearInterval(heartbeatTimer);
  state.status = "stopped";
  state.state = "done";
  state.lastSeen = nowIso();
  state.updatedAt = nowIso();
  try {
    saveStateSync();
  } catch (err) {
    process.stderr.write(`postbox-mcp: failed to write final state: ${err.message}\n`);
  }
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

// --- envelope render (matches src/inbox.ts renderEnvelope, MCP-flavored
// reply hint since the receiver here has no thread_send affordance name
// baked into a system prompt) ---------------------------------------------
function renderEnvelope(msg) {
  const kind =
    msg.expects && msg.re ? "reply+request" : msg.expects ? "request" : msg.re ? "reply" : "note";
  const reTag = msg.re ? ` re #${msg.re}` : "";
  const header = `[${kind} from ${msg.from} #${msg.id}${reTag}]`;
  const hint = msg.expects ? `\nreply with thread_send re=${msg.id}` : "";
  return `${header}\n${msg.body}${hint}`;
}

function isDue(msg, now) {
  return !msg.deliverAfter || new Date(msg.deliverAfter).getTime() <= now;
}

/** True if the inbox has at least one envelope claimable right now — used
 *  by thread_wait's poll loop without actually claiming anything. */
function hasDueMessage() {
  let files;
  try {
    files = fs.readdirSync(inboxDir()).filter(f => f.endsWith(".json"));
  } catch {
    return false;
  }
  const now = Date.now();
  for (const f of files) {
    const m = readJsonSafe(path.join(inboxDir(), f));
    if (m && typeof m === "object" && isDue(m, now)) return true;
  }
  return false;
}

/** Shared drain-and-render used by thread_inbox and thread_wait (Appendix
 *  B: sorted readdir, skip malformed/not-yet-due, rename claimed into
 *  processed/, then update the ledger). */
function drainAndRender() {
  let files;
  try {
    files = fs
      .readdirSync(inboxDir())
      .filter(f => f.endsWith(".json"))
      .sort();
  } catch {
    files = [];
  }
  fs.mkdirSync(processedDir(), { recursive: true });
  const now = Date.now();
  const claimed = [];
  for (const f of files) {
    const full = path.join(inboxDir(), f);
    let msg;
    try {
      msg = JSON.parse(fs.readFileSync(full, "utf8"));
    } catch {
      continue; // malformed — left in place, retried every drain, never dropped
    }
    if (msg.deliverAfter && new Date(msg.deliverAfter).getTime() > now) continue;
    try {
      fs.renameSync(full, path.join(processedDir(), f));
    } catch {
      continue; // already claimed — shouldn't happen (single reader)
    }
    claimed.push(msg);
  }

  let stateChanged = false;
  const rendered = [];
  for (const msg of claimed) {
    if (msg.re) {
      // Errata 1 gate, obligation side: only a reply from the thread the
      // debt was recorded against clears it — a colliding `re` from anyone
      // else renders as a plain note and leaves the ledger untouched.
      const obMatch = state.obligations.find(o => o.id === msg.re);
      if (obMatch && obMatch.to === msg.from) {
        state.obligations = state.obligations.filter(o => o.id !== msg.re);
        stateChanged = true;
      }
    }
    if (msg.expects && !state.owed.some(o => o.id === msg.id)) {
      state.owed.push({
        id: msg.id,
        from: msg.from,
        summary: msg.body.slice(0, 80),
        receivedAt: msg.sentAt,
      });
      stateChanged = true;
    }
    rendered.push(renderEnvelope(msg));
  }
  if (stateChanged) {
    state.updatedAt = nowIso();
    saveStateSync();
  }
  return rendered;
}

function errorResult(text) {
  return { content: [{ type: "text", text }], isError: true };
}

function textResult(text) {
  return { content: [{ type: "text", text }] };
}

// --- tools ----------------------------------------------------------------

function toolThreadSend(params) {
  const { to, body, re, expects, urgency, deliverAfterSeconds } = params ?? {};
  if (!to || typeof to !== "string") {
    return errorResult('thread_send: "to" is required (a thread id, or "*" to fan out)');
  }
  if (!body || typeof body !== "string") {
    return errorResult('thread_send: "body" is required');
  }
  if (urgency !== undefined && urgency !== "high" && urgency !== "low") {
    return errorResult(`thread_send: unknown urgency "${urgency}" — use "high" or "low"`);
  }

  const sentAt = nowIso();
  const deliverAfter =
    Number.isFinite(deliverAfterSeconds) && deliverAfterSeconds > 0
      ? new Date(Date.now() + deliverAfterSeconds * 1000).toISOString()
      : undefined;

  let targets;
  if (to === "*") {
    let entries = [];
    try {
      entries = fs
        .readdirSync(THREADS_ROOT, { withFileTypes: true })
        .filter(e => e.isDirectory())
        .map(e => e.name);
    } catch {
      entries = [];
    }
    targets = entries.filter(id => id !== THREAD_ID);
    if (targets.length === 0) return textResult("No target threads found for fan-out.");
  } else {
    targets = [to];
  }

  const lines = [];
  const warnings = [];
  let stateChanged = false;
  for (const targetId of targets) {
    const id = `${THREAD_ID}/${ulid()}`;
    const message = {
      id,
      from: THREAD_ID,
      to: targetId,
      body,
      sentAt,
      ...(re ? { re } : {}),
      ...(expects ? { expects: true } : {}),
      ...(urgency === "high" ? { urgency } : {}),
      ...(deliverAfter ? { deliverAfter } : {}),
    };
    writeMessageAtomic(targetId, message);

    if (re) {
      // Discharge gate (§9.1, Errata 1): a reply only clears the owed
      // record it targets, never on id-match alone.
      const idx = state.owed.findIndex(o => o.id === re && o.from === targetId);
      if (idx >= 0) {
        state.owed.splice(idx, 1);
        stateChanged = true;
      } else if (state.owed.some(o => o.id === re)) {
        warnings.push(
          `warning: re="${re}" is owed to a different thread than "${targetId}" — owed record left untouched`,
        );
      } else {
        warnings.push(`warning: re="${re}" does not match any owed reply — nothing to settle`);
      }
    }
    if (expects) {
      state.obligations.push({
        id,
        to: targetId,
        summary: body.slice(0, 80),
        sentAt,
        deadline: new Date(Date.now() + DEFAULT_OBLIGATION_DEADLINE_MS).toISOString(),
      });
      stateChanged = true;
    }
    lines.push(
      `Sent to ${targetId}. id=${id}${re ? ` re=${re}` : ""}${expects ? " (expects reply)" : ""}${deliverAfter ? ` (holds until ${deliverAfter})` : ""}`,
    );
  }
  if (stateChanged) {
    state.updatedAt = nowIso();
    saveStateSync();
  }
  return textResult([...lines, ...warnings].join("\n"));
}

function toolThreadInbox() {
  const rendered = drainAndRender();
  if (rendered.length === 0) return textResult("(no messages)");
  return textResult(rendered.join("\n\n"));
}

async function toolThreadWait(params) {
  let timeoutSeconds = params?.timeoutSeconds;
  if (!Number.isFinite(timeoutSeconds)) timeoutSeconds = 60;
  timeoutSeconds = Math.min(Math.max(timeoutSeconds, 0), 300);
  const deadline = Date.now() + timeoutSeconds * 1000;
  for (;;) {
    if (hasDueMessage()) {
      const rendered = drainAndRender();
      if (rendered.length > 0) return textResult(rendered.join("\n\n"));
    }
    if (Date.now() >= deadline) break;
    await delay(1000);
  }
  return textResult(`(no messages after ${timeoutSeconds}s)`);
}

function toolThreadStatus() {
  const lines = [];
  lines.push(
    `Id: ${state.id}  Role: ${state.role ?? "-"}  Parent: ${state.parent ?? "-"}  State: ${state.state}  Status: ${effectiveStatus(state)}`,
  );
  lines.push("", `Obligations (${state.obligations.length}):`);
  if (state.obligations.length === 0) lines.push("  (none)");
  for (const o of state.obligations) {
    lines.push(`  request to ${o.to} #${o.id} "${o.summary}" (deadline ${o.deadline ?? "-"})`);
  }
  lines.push("", `Owed replies (${state.owed.length}):`);
  if (state.owed.length === 0) lines.push("  (none)");
  for (const o of state.owed) {
    lines.push(`  you owe a reply to ${o.from} for #${o.id} — reply with re="${o.id}"`);
  }
  try {
    const journal = fs.readFileSync(path.join(THREAD_DIR, "journal.md"), "utf8").trim();
    const entries = journal.split(/\n(?=<!--)/).filter(Boolean);
    const last = entries[entries.length - 1];
    if (last) {
      lines.push("", "Last journal entry:");
      for (const l of last.trim().split("\n")) lines.push("  " + l);
    }
  } catch {
    // no journal yet
  }
  return textResult(lines.join("\n"));
}

function toolThreadList() {
  let ids = [];
  try {
    ids = fs
      .readdirSync(THREADS_ROOT, { withFileTypes: true })
      .filter(e => e.isDirectory())
      .map(e => e.name)
      .sort();
  } catch {
    ids = [];
  }
  const lines = [];
  for (const id of ids) {
    const s = id === THREAD_ID ? state : readJsonSafe(statePathOf(threadDirOf(id)));
    if (!s || typeof s !== "object") continue;
    lines.push(
      `${id}  state=${s.state ?? "unknown"} status=${effectiveStatus(s)} role=${s.role ?? "-"} parent=${s.parent ?? "-"} obligations=${(s.obligations ?? []).length} owed=${(s.owed ?? []).length}`,
    );
  }
  if (lines.length === 0) return textResult("(no threads)");
  return textResult(lines.join("\n"));
}

function toolThreadJournal(params) {
  const id = params?.id;
  if (!id || typeof id !== "string") return errorResult('thread_journal: "id" is required');
  const dir = threadDirOf(id);
  if (!fs.existsSync(statePathOf(dir)))
    return errorResult(`thread_journal: unknown thread "${id}"`);
  let content = "";
  try {
    content = fs.readFileSync(path.join(dir, "journal.md"), "utf8").trim();
  } catch {
    content = "";
  }
  if (!content) return textResult("(no journal)");
  return textResult(content);
}

const TOOLS = [
  {
    name: "thread_send",
    description:
      'Send a message into another thread\'s mailbox (Postbox §6). Use to="*" to fan out to every ' +
      "other thread in the workspace. Set expects=true when you need a reply — this records a " +
      'tracked debt (visible via thread_status) that the recipient now owes you. Set re="<id>" ' +
      "when replying to a message you received — this settles the debt that message created (it " +
      "only discharges if addressed to the thread the debt is owed to; a mismatch is left alone " +
      "and a warning comes back). Setting both re and expects is a reply that also asks a follow-up.",
    inputSchema: {
      type: "object",
      properties: {
        to: {
          type: "string",
          description: 'Target thread id, or "*" to fan out to every other thread.',
        },
        body: { type: "string", description: "Message text." },
        re: {
          type: "string",
          description: "Id of the message this replies to — discharges the debt it created.",
        },
        expects: {
          type: "boolean",
          description: "Track a debt: the recipient owes a reply. Default deadline: 15 minutes.",
        },
        urgency: {
          type: "string",
          enum: ["high", "low"],
          description: 'Delivery priority hint for the recipient. Default "low".',
        },
        deliverAfterSeconds: {
          type: "number",
          description: "Hold the message for N seconds before it becomes drainable.",
        },
      },
      required: ["to", "body"],
    },
  },
  {
    name: "thread_inbox",
    description:
      "Drain this thread's pending mailbox (destructive claim-and-remove, Postbox §7.2) and return " +
      'every message due for delivery. A message rendered as "request" or "reply+request" ' +
      "expects a reply — the response includes the id to echo back as re in thread_send. Draining " +
      "such a message records that you now owe a reply (see thread_status).",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "thread_wait",
    description:
      "Block until at least one message becomes due, or timeoutSeconds elapses, then drain and " +
      "return exactly like thread_inbox. Use this instead of polling thread_inbox in a loop.",
    inputSchema: {
      type: "object",
      properties: {
        timeoutSeconds: {
          type: "number",
          description: "Max seconds to wait. Default 60, max 300.",
        },
      },
    },
  },
  {
    name: "thread_status",
    description:
      "This thread's own coordination state: obligations (messages you sent that expect a reply, " +
      "still open), owed replies (messages sent to you that expect a reply, not yet answered), and " +
      "the last journal entry if one exists.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "thread_list",
    description:
      "List every thread known in this workspace with its liveness (a thread whose heartbeat is " +
      "older than 60 seconds reads as stopped regardless of its stored status, Postbox §8.2) and " +
      "coordination-load counts.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "thread_journal",
    description:
      "Read a thread's journal — an append-only history stream it writes about itself. Works on " +
      "any thread id, including your own.",
    inputSchema: {
      type: "object",
      properties: { id: { type: "string", description: "Thread id whose journal to read." } },
      required: ["id"],
    },
  },
];

async function callTool(name, args) {
  switch (name) {
    case "thread_send":
      return toolThreadSend(args ?? {});
    case "thread_inbox":
      return toolThreadInbox();
    case "thread_wait":
      return await toolThreadWait(args ?? {});
    case "thread_status":
      return toolThreadStatus();
    case "thread_list":
      return toolThreadList();
    case "thread_journal":
      return toolThreadJournal(args ?? {});
    default:
      return errorResult(`unknown tool "${name}"`);
  }
}

// --- JSON-RPC 2.0 over stdin/stdout, newline-delimited. Never write
// anything but JSON-RPC to stdout — logs go to stderr. ---------------------
function reply(obj) {
  process.stdout.write(JSON.stringify(obj) + "\n");
}

async function handleRequest(req) {
  const { id, method, params } = req ?? {};
  const isNotification = id === undefined;
  try {
    if (method === "initialize") {
      const result = {
        protocolVersion: params?.protocolVersion ?? "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: "postbox-mcp", version: "0.1.0" },
      };
      if (!isNotification) reply({ jsonrpc: "2.0", id, result });
      return;
    }
    if (method === "notifications/initialized") return; // nothing to acknowledge
    if (method === "ping") {
      if (!isNotification) reply({ jsonrpc: "2.0", id, result: {} });
      return;
    }
    if (method === "tools/list") {
      if (!isNotification) reply({ jsonrpc: "2.0", id, result: { tools: TOOLS } });
      return;
    }
    if (method === "tools/call") {
      const result = await callTool(params?.name, params?.arguments);
      if (!isNotification) reply({ jsonrpc: "2.0", id, result });
      return;
    }
    if (!isNotification) {
      reply({
        jsonrpc: "2.0",
        id,
        error: { code: -32601, message: `Method not found: ${method}` },
      });
    }
  } catch (err) {
    if (!isNotification) {
      reply({ jsonrpc: "2.0", id, error: { code: -32603, message: err.message ?? String(err) } });
    } else {
      process.stderr.write(
        `postbox-mcp: error handling notification "${method}": ${err.stack ?? err}\n`,
      );
    }
  }
}

const rl = readline.createInterface({ input: process.stdin, terminal: false });
rl.on("line", line => {
  const trimmed = line.trim();
  if (!trimmed) return;
  let req;
  try {
    req = JSON.parse(trimmed);
  } catch {
    reply({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } });
    return;
  }
  void handleRequest(req);
});
rl.on("close", shutdown);
