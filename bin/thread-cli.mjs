#!/usr/bin/env node
// thread-cli.mjs — zero-dependency CLI to monitor and steer a multi-agent thread system.
// A C1 postbox actor (PROTOCOL-FORMALISM.md §2.2): speaks the local-fs
// binding (Appendix B) directly — no extension required on either side.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import process from "node:process";
import { setTimeout } from "node:timers";

const STALE_MS = 60000;

function usage() {
  return `thread-cli.mjs — monitor and steer a multi-agent thread system

Usage:
  thread-cli.mjs <command> [args] [--dir <path>]

Commands:
  list                       Show a table of all threads in the workspace
    --json                     Print raw JSON array instead of a table

  status <id>                Full coordination state of one thread: obligations,
                             owed replies, barriers, pending inbox, last journal entry
    --json                     Print raw state.json + pending inbox as JSON

  send <to> <body...>        Send an envelope into a thread's inbox
    --from <id>                 Sender id (default: "user")
    --re <envelopeId>           Reply correlation: settles the debt on that id
    --expects                   Ask for a reply (the receiver records an owed reply)
    --urgency <high|low>        Delivery priority (default: high — operator sends
                                should be seen at the target's next opening)
    --deliver-after <seconds>   Hold the envelope for N seconds before delivery
    --expires-in <seconds>      Discard undelivered after N seconds (time-sensitive notes)
    Use "<to>" = "*" to fan out to every thread except --from.

  inbox <id>                 Show pending and recent processed messages for a thread

  tail <id>                  Follow a thread's state/journal/inbox changes live (Ctrl-C to stop)

  watch                      Live coordination board: thread table, obligations,
                             owed replies, barriers, queued inbox (Ctrl-C to stop)

  delete <id...>             Delete one or more threads (removes .thread/threads/<id>)
    --all                       Delete every thread (requires --yes)
    --stale                     Delete only threads reported stopped/stale
    --force                     Also delete threads that look live (status=running)
    --yes                       Required to confirm deleting more than one thread

Global flags:
  --dir <path>               Workspace root (default: current directory)
  --help, -h                 Show this help

Examples:
  thread-cli.mjs list --dir /path/to/workspace
  thread-cli.mjs status link
  thread-cli.mjs send link "please pause" --from user
  thread-cli.mjs send link "what's your ETA?" --expects
  thread-cli.mjs send link "here you go" --re link/01ABC...
  thread-cli.mjs inbox link
  thread-cli.mjs tail link
  thread-cli.mjs watch
  thread-cli.mjs delete link
  thread-cli.mjs delete --stale --yes
`;
}

function parseArgs(argv) {
  const args = { _: [], dir: process.cwd(), json: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--dir") {
      args.dir = argv[++i];
    } else if (a === "--json") {
      args.json = true;
    } else if (a === "--from") {
      args.from = argv[++i];
    } else if (a === "--re") {
      args.re = argv[++i];
    } else if (a === "--expects") {
      args.expects = true;
    } else if (a === "--urgency") {
      args.urgency = argv[++i];
    } else if (a === "--deliver-after") {
      args.deliverAfter = Number(argv[++i]);
    } else if (a === "--expires-in") {
      args.expiresIn = Number(argv[++i]);
    } else if (a === "--help" || a === "-h") {
      args.help = true;
    } else if (a === "--all") {
      args.all = true;
    } else if (a === "--stale") {
      args.stale = true;
    } else if (a === "--force") {
      args.force = true;
    } else if (a === "--yes") {
      args.yes = true;
    } else {
      args._.push(a);
    }
  }
  return args;
}

function threadsDir(dir) {
  return path.join(dir, ".thread", "threads");
}

function warn(msg) {
  process.stderr.write(`warning: ${msg}\n`);
}

function readJsonSafe(file) {
  try {
    const raw = fs.readFileSync(file, "utf8");
    return JSON.parse(raw);
  } catch (err) {
    if (err.code === "ENOENT") return undefined;
    warn(`could not parse ${file}: ${err.message}`);
    return null;
  }
}

function listThreadIds(dir) {
  const base = threadsDir(dir);
  let entries;
  try {
    entries = fs.readdirSync(base, { withFileTypes: true });
  } catch (err) {
    if (err.code === "ENOENT") return [];
    throw err;
  }
  return entries
    .filter(e => e.isDirectory())
    .map(e => e.name)
    .sort();
}

function loadThreadState(dir, id) {
  const stateFile = path.join(threadsDir(dir), id, "state.json");
  const state = readJsonSafe(stateFile);
  if (state === undefined) return null;
  if (state === null) return null;
  return state;
}

function countInboxPending(dir, id) {
  const inboxDir = path.join(threadsDir(dir), id, "inbox");
  try {
    return fs.readdirSync(inboxDir).filter(f => f.endsWith(".json")).length;
  } catch {
    return 0;
  }
}

function effectiveStatus(state) {
  const stale = state.lastSeen && Date.now() - Date.parse(state.lastSeen) > STALE_MS;
  if (stale && state.status !== "stopped") return "stopped*";
  return state.status || "unknown";
}

function relTime(iso) {
  if (!iso) return "-";
  const ms = Date.now() - Date.parse(iso);
  if (Number.isNaN(ms)) return "-";
  if (ms < 0) return "0s ago";
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return `${d}d ago`;
}

/** For deadlines/deliverAfter: "in 30s" while pending, "5m overdue" once passed. */
function dueIn(iso) {
  if (!iso) return "-";
  const ms = Date.parse(iso) - Date.now();
  if (Number.isNaN(ms)) return "-";
  const s = Math.floor(Math.abs(ms) / 1000);
  const span = s < 60 ? `${s}s` : s < 3600 ? `${Math.floor(s / 60)}m` : `${Math.floor(s / 3600)}h`;
  return ms >= 0 ? `in ${span}` : `${span} overdue`;
}

function truncate(str, n) {
  if (!str) return "";
  return str.length > n ? str.slice(0, n) : str;
}

function collectThreads(dir) {
  const ids = listThreadIds(dir);
  const rows = [];
  for (const id of ids) {
    const state = loadThreadState(dir, id);
    if (!state) {
      warn(`skipping thread "${id}": missing or corrupt state.json`);
      continue;
    }
    rows.push({
      id,
      state: state.state ?? "unknown",
      status: effectiveStatus(state),
      role: state.role ?? "-",
      parent: state.parent ?? "-",
      obligations: Array.isArray(state.obligations) ? state.obligations.length : 0,
      owed: Array.isArray(state.owed) ? state.owed.length : 0,
      barriers: Array.isArray(state.barriers) ? state.barriers.length : 0,
      inbox: countInboxPending(dir, id),
      lastSeen: state.lastSeen ?? null,
      raw: state,
    });
  }
  return rows;
}

function padCol(str, width) {
  str = String(str);
  return str.length >= width ? str : str + " ".repeat(width - str.length);
}

function renderTable(rows) {
  const headers = [
    "ID",
    "STATE",
    "STATUS",
    "ROLE",
    "PARENT",
    "OBLG",
    "OWED",
    "BARR",
    "INBOX",
    "LAST SEEN",
  ];
  const data = rows.map(r => [
    r.id,
    r.state,
    r.status,
    r.role,
    r.parent,
    String(r.obligations),
    String(r.owed),
    String(r.barriers),
    String(r.inbox),
    relTime(r.lastSeen),
  ]);
  const widths = headers.map(
    (h, i) => Math.max(h.length, ...data.map(row => row[i].length), 0) + 2,
  );
  let out = headers.map((h, i) => padCol(h, widths[i])).join("") + "\n";
  for (const row of data) {
    out += row.map((c, i) => padCol(c, widths[i])).join("") + "\n";
  }
  return out;
}

function cmdList(args) {
  const rows = collectThreads(args.dir);
  if (args.json) {
    process.stdout.write(
      JSON.stringify(
        rows.map(r => r.raw && { id: r.id, ...r.raw }),
        null,
        2,
      ) + "\n",
    );
    return 0;
  }
  if (rows.length === 0) {
    process.stdout.write("No threads found.\n");
    return 0;
  }
  process.stdout.write(renderTable(rows));
  return 0;
}

function cmdStatus(args) {
  const [id] = args._;
  if (!id) {
    process.stderr.write("usage: thread-cli.mjs status <id>\n");
    return 1;
  }
  const state = loadThreadState(args.dir, id);
  if (!state) {
    process.stderr.write(`error: thread "${id}" not found\n`);
    return 2;
  }
  const pending = readInboxMessages(path.join(threadsDir(args.dir), id, "inbox"));
  if (args.json) {
    process.stdout.write(JSON.stringify({ ...state, inboxPending: pending }, null, 2) + "\n");
    return 0;
  }

  const lines = [];
  lines.push(
    `Id: ${id}  State: ${state.state ?? "unknown"}  Status: ${effectiveStatus(state)}  Role: ${state.role ?? "-"}  Parent: ${state.parent ?? "-"}`,
  );
  lines.push(
    `Hold: ${state.holdReason ?? "-"}  Last seen: ${relTime(state.lastSeen)}  Started: ${relTime(state.startedAt)}  PID: ${state.pid ?? "-"}`,
  );

  const section = (title, items, render) => {
    lines.push("", `${title} (${items.length}):`);
    if (items.length === 0) lines.push("  (none)");
    for (const it of items) lines.push("  " + render(it));
  };
  section(
    "Obligations (replies owed TO this thread)",
    state.obligations ?? [],
    o =>
      `request to ${o.to} #${o.id} "${o.summary ?? ""}" (${relTime(o.sentAt)}${o.deadline ? `, due ${dueIn(o.deadline)}` : ""}${o.nudged ? ", reminded" : ""})`,
  );
  section(
    "Owed replies (this thread OWES)",
    state.owed ?? [],
    o => `reply to ${o.from} for #${o.id} "${o.summary ?? ""}" (${relTime(o.receivedAt)})`,
  );
  section(
    "Barriers",
    state.barriers ?? [],
    b =>
      `${b.id} (${b.mode}) pending: ${(b.pending ?? []).join(", ")} (${relTime(b.createdAt)}${b.deadline ? `, due ${dueIn(b.deadline)}` : ""})`,
  );
  section("Inbox pending", pending, m => formatMsgLine(m, 80));

  try {
    const journal = fs
      .readFileSync(path.join(threadsDir(args.dir), id, "journal.md"), "utf8")
      .trim();
    const entries = journal.split(/\n(?=<!--)/).filter(Boolean);
    const last = entries[entries.length - 1];
    if (last) {
      lines.push("", "Last journal entry:");
      for (const l of last.trim().split("\n")) lines.push("  " + l);
    }
  } catch {
    // no journal yet
  }
  process.stdout.write(lines.join("\n") + "\n");
  return 0;
}

// --- ULID (Appendix B: envelope filenames sort into FIFO order) ------------
const B32 = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
function ulid(now = Date.now()) {
  let t = "";
  let ms = now;
  for (let i = 0; i < 10; i++) {
    t = B32[ms % 32] + t;
    ms = Math.floor(ms / 32);
  }
  const rand = Array.from(crypto.randomBytes(16))
    .map(b => B32[b & 31])
    .join("");
  return t + rand;
}

/** Appendix B enqueue: write to inbox.tmp/ staging, rename into inbox/ —
 *  atomic on POSIX, so a reader never sees a partial envelope. */
function writeMessageAtomic(threadDir, message) {
  const inboxDir = path.join(threadDir, "inbox");
  const staging = path.join(threadDir, "inbox.tmp");
  fs.mkdirSync(inboxDir, { recursive: true });
  fs.mkdirSync(staging, { recursive: true });
  const tail = message.id.includes("/")
    ? message.id.slice(message.id.lastIndexOf("/") + 1)
    : message.id;
  const name = `${tail.replace(/[^A-Za-z0-9._-]/g, "_")}.json`;
  const tmp = path.join(staging, name);
  const final = path.join(inboxDir, name);
  fs.writeFileSync(tmp, JSON.stringify(message, null, 2));
  fs.renameSync(tmp, final);
  return final;
}

function cmdSend(args) {
  const [to, ...bodyParts] = args._;
  if (!to || bodyParts.length === 0) {
    process.stderr.write("usage: thread-cli.mjs send <to> <body...>\n");
    return 1;
  }
  if (args.urgency && args.urgency !== "high" && args.urgency !== "low") {
    process.stderr.write(`error: unknown urgency "${args.urgency}". Valid: high, low\n`);
    return 1;
  }
  const from = args.from ?? "user";
  const body = bodyParts.join(" ");
  const sentAt = new Date().toISOString();
  // Operator sends default to high urgency: a human steering a thread wants
  // it seen at the target's next opening, not when it goes idle.
  const urgency = args.urgency ?? "high";
  const deliverAfter =
    Number.isFinite(args.deliverAfter) && args.deliverAfter > 0
      ? new Date(Date.now() + args.deliverAfter * 1000).toISOString()
      : undefined;
  const expiresAt =
    Number.isFinite(args.expiresIn) && args.expiresIn > 0
      ? new Date(Date.now() + args.expiresIn * 1000).toISOString()
      : undefined;

  const base = threadsDir(args.dir);
  let targets;
  if (to === "*") {
    let entries;
    try {
      entries = fs
        .readdirSync(base, { withFileTypes: true })
        .filter(e => e.isDirectory())
        .map(e => e.name);
    } catch {
      entries = [];
    }
    targets = entries.filter(id => id !== from);
    if (targets.length === 0) {
      process.stdout.write("No target threads found for fan-out.\n");
      return 0;
    }
  } else {
    targets = [to];
  }

  for (const targetId of targets) {
    const threadDir = path.join(base, targetId);
    const stateFile = path.join(threadDir, "state.json");
    if (!fs.existsSync(stateFile)) {
      warn(`thread "${targetId}" has no state.json (unknown thread), sending anyway`);
    }
    const message = {
      id: `${from}/${ulid()}`,
      from,
      to: targetId,
      body,
      sentAt,
      ...(args.re ? { re: args.re } : {}),
      ...(args.expects ? { expects: true } : {}),
      ...(urgency === "high" ? { urgency } : {}),
      ...(deliverAfter ? { deliverAfter } : {}),
      ...(expiresAt ? { expiresAt } : {}),
    };
    const file = writeMessageAtomic(threadDir, message);
    process.stdout.write(
      `sent from ${from} to ${targetId} [#${message.id}]${args.re ? ` re #${args.re}` : ""}${args.expects ? " (expects reply)" : ""}${deliverAfter ? ` (holds until ${deliverAfter})` : ""} -> ${file}\n`,
    );
  }
  return 0;
}

function readInboxMessages(inboxDir) {
  let files;
  try {
    files = fs.readdirSync(inboxDir).filter(f => f.endsWith(".json"));
  } catch {
    return [];
  }
  const msgs = [];
  for (const f of files) {
    const m = readJsonSafe(path.join(inboxDir, f));
    if (m && typeof m === "object") msgs.push({ file: f, ...m });
  }
  msgs.sort((a, b) => a.file.localeCompare(b.file));
  return msgs;
}

function formatMsgLine(m, bodyLen) {
  // One message per line: multi-line bodies collapse to single-spaced text.
  const flat = (m.body ?? "").replace(/\s+/g, " ").trim();
  const body = bodyLen ? truncate(flat, bodyLen) : flat;
  const kind =
    m.expects && m.re ? "reply+request" : m.expects ? "request" : m.re ? "reply" : "note";
  return `[${kind} ${m.from}→${m.to} #${m.id}${m.re ? ` re #${m.re}` : ""}] ${body} (${m.sentAt ?? "?"})`;
}

function cmdInbox(args) {
  const [id] = args._;
  if (!id) {
    process.stderr.write("usage: thread-cli.mjs inbox <id>\n");
    return 1;
  }
  const threadDir = path.join(threadsDir(args.dir), id);
  if (!fs.existsSync(threadDir)) {
    process.stderr.write(`error: thread "${id}" not found\n`);
    return 2;
  }
  const pending = readInboxMessages(path.join(threadDir, "inbox"));
  const processed = readInboxMessages(path.join(threadDir, "inbox", "processed"));

  process.stdout.write(`Pending (${pending.length}):\n`);
  if (pending.length === 0) process.stdout.write("  (none)\n");
  for (const m of pending) process.stdout.write("  " + formatMsgLine(m, null) + "\n");

  const recent = processed.slice(-10).reverse();
  process.stdout.write(`\nRecent processed (${recent.length} of ${processed.length}):\n`);
  if (recent.length === 0) process.stdout.write("  (none)\n");
  for (const m of recent) process.stdout.write("  " + formatMsgLine(m, 80) + "\n");
  return 0;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function setupSigintExit() {
  process.on("SIGINT", () => {
    process.stdout.write("\n");
    process.exit(0);
  });
}

async function cmdTail(args) {
  const [id] = args._;
  if (!id) {
    process.stderr.write("usage: thread-cli.mjs tail <id>\n");
    return 1;
  }
  setupSigintExit();
  const threadDir = path.join(threadsDir(args.dir), id);
  const journalFile = path.join(threadDir, "journal.md");
  let lastState = null;
  let lastJournalLen = -1;
  let seenInbox = new Set();
  let seenProcessed = new Set();
  let notedMissing = false;

  for (;;) {
    if (!fs.existsSync(threadDir)) {
      if (!notedMissing) {
        process.stdout.write(`waiting for thread "${id}" to appear...\n`);
        notedMissing = true;
      }
      await sleep(1000);
      continue;
    }
    notedMissing = false;

    const state = loadThreadState(args.dir, id);
    if (state) {
      if (lastState) {
        if (state.state !== lastState.state) {
          process.stdout.write(`state: ${lastState.state} → ${state.state}\n`);
        }
        if (state.status !== lastState.status) {
          process.stdout.write(`status: ${lastState.status} → ${state.status}\n`);
        }
        const diffIds = (label, prev, next, idOf) => {
          const p = new Set((prev ?? []).map(idOf));
          const n = new Set((next ?? []).map(idOf));
          const changes = [
            ...[...n].filter(x => !p.has(x)).map(x => `+${x}`),
            ...[...p].filter(x => !n.has(x)).map(x => `-${x}`),
          ];
          if (changes.length) process.stdout.write(`${label}: ${changes.join(" ")}\n`);
        };
        diffIds("obligations", lastState.obligations, state.obligations, o => o.id);
        diffIds("owed", lastState.owed, state.owed, o => o.id);
        diffIds("barriers", lastState.barriers, state.barriers, b => b.id);
      }
      lastState = state;
    }

    try {
      const content = fs.readFileSync(journalFile, "utf8");
      if (lastJournalLen === -1) {
        lastJournalLen = content.length;
      } else if (content.length > lastJournalLen) {
        process.stdout.write(content.slice(lastJournalLen));
        lastJournalLen = content.length;
      }
    } catch {
      // journal not present yet
    }

    for (const sub of ["inbox", path.join("inbox", "processed")]) {
      const dirPath = path.join(threadDir, sub);
      let files;
      try {
        files = fs.readdirSync(dirPath).filter(f => f.endsWith(".json"));
      } catch {
        continue;
      }
      const seen = sub === "inbox" ? seenInbox : seenProcessed;
      for (const f of files) {
        if (seen.has(f)) continue;
        seen.add(f);
        if (seen.size === files.length && lastJournalLen === -1) continue;
        const m = readJsonSafe(path.join(dirPath, f));
        if (m) process.stdout.write(`${sub}: ` + formatMsgLine(m, 80) + "\n");
      }
    }

    await sleep(1000);
  }
}

function collectObligations(dir) {
  const rows = collectThreads(dir);
  const obligations = [];
  for (const r of rows) {
    const obs = Array.isArray(r.raw.obligations) ? r.raw.obligations : [];
    for (const o of obs) {
      obligations.push({ owner: r.id, ...o });
    }
  }
  return obligations;
}

async function cmdWatch(args) {
  setupSigintExit();
  for (;;) {
    const rows = collectThreads(args.dir);
    let out = "\x1b[2J\x1b[H";
    out += rows.length ? renderTable(rows) : "No threads found.\n";

    const owed = [];
    const barriers = [];
    const queued = [];
    for (const r of rows) {
      for (const o of r.raw.owed ?? []) owed.push({ owner: r.id, ...o });
      for (const b of r.raw.barriers ?? []) barriers.push({ owner: r.id, ...b });
      if (r.inbox > 0) {
        for (const m of readInboxMessages(path.join(threadsDir(args.dir), r.id, "inbox"))) {
          queued.push(m);
        }
      }
    }

    out += "\nOpen obligations:\n";
    const obligations = collectObligations(args.dir);
    if (obligations.length === 0) {
      out += "  (none)\n";
    } else {
      for (const o of obligations) {
        out += `  ${o.owner} → ${o.to} : #${o.id} "${o.summary ?? ""}" (${relTime(o.sentAt)}${o.deadline ? `, due ${dueIn(o.deadline)}` : ""})\n`;
      }
    }
    if (owed.length) {
      out += "Owed replies:\n";
      for (const o of owed) {
        out += `  ${o.owner} owes ${o.from} : reply for #${o.id} "${o.summary ?? ""}" (${relTime(o.receivedAt)})\n`;
      }
    }
    if (barriers.length) {
      out += "Barriers:\n";
      for (const b of barriers) {
        out += `  ${b.owner} waits (${b.mode}) on: ${(b.pending ?? []).join(", ")} (${relTime(b.createdAt)}${b.deadline ? `, due ${dueIn(b.deadline)}` : ""})\n`;
      }
    }
    if (queued.length) {
      out += "Queued inbox:\n";
      for (const m of queued) {
        out += `  ${formatMsgLine(m, 60)}\n`;
      }
    }
    process.stdout.write(out);
    await sleep(2000);
  }
}

function cmdDelete(args) {
  const ids = args._;
  if (!args.all && !args.stale && ids.length === 0) {
    process.stderr.write("usage: thread-cli.mjs delete <id...> | --all | --stale\n");
    return 1;
  }
  const rows = collectThreads(args.dir);
  let targets;
  if (args.all) {
    targets = rows.map(r => r.id);
  } else if (args.stale) {
    targets = rows.filter(r => r.status.startsWith("stopped")).map(r => r.id);
  } else {
    const known = new Set(rows.map(r => r.id));
    targets = ids.filter(id => {
      if (known.has(id)) return true;
      warn(`skipping "${id}": no such thread`);
      return false;
    });
  }
  if (targets.length === 0) {
    process.stdout.write("No matching threads to delete.\n");
    return 0;
  }
  if ((args.all || targets.length > 1) && !args.yes) {
    process.stderr.write(
      `refusing to delete ${targets.length} thread(s) without --yes: ${targets.join(", ")}\n`,
    );
    return 1;
  }
  let deleted = 0;
  for (const id of targets) {
    const row = rows.find(r => r.id === id);
    const live = row && row.status === "running";
    if (live && !args.force) {
      warn(
        `skipping "${id}": appears to be running (last seen ${relTime(row.lastSeen)}). Use --force to delete anyway.`,
      );
      continue;
    }
    fs.rmSync(path.join(threadsDir(args.dir), id), { recursive: true, force: true });
    process.stdout.write(`deleted ${id}\n`);
    deleted++;
  }
  return deleted > 0 ? 0 : 1;
}

async function main() {
  const argv = process.argv.slice(2);
  if (argv.length === 0 || argv.includes("--help") || argv.includes("-h")) {
    process.stdout.write(usage());
    return argv.length === 0 ? 1 : 0;
  }
  const [command, ...rest] = argv;
  const args = parseArgs(rest);
  args.dir = path.resolve(args.dir);

  if (args.help) {
    process.stdout.write(usage());
    return 0;
  }

  switch (command) {
    case "list":
      return cmdList(args);
    case "status":
      return cmdStatus(args);
    case "send":
      return cmdSend(args);
    case "inbox":
      return cmdInbox(args);
    case "tail":
      return await cmdTail(args);
    case "watch":
      return await cmdWatch(args);
    case "delete":
      return cmdDelete(args);
    default:
      process.stderr.write(`error: unknown command "${command}"\n\n`);
      process.stderr.write(usage());
      return 1;
  }
}

main()
  .then(code => process.exit(code ?? 0))
  .catch(err => {
    process.stderr.write(`fatal: ${err.stack ?? err.message}\n`);
    process.exit(2);
  });
