#!/usr/bin/env node
// thread-cli.mjs — zero-dependency CLI to monitor and steer a multi-agent thread system.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import process from "node:process";
import { setTimeout } from "node:timers";

const STALE_MS = 60000;
const MSG_TYPES = ["Brief", "Note", "Question", "Answer", "Update", "Result", "Blocker", "Sync"];
const DELIVERIES = ["steer", "follow-up"];
const DEFAULT_DELIVERY = {
  Brief: "steer",
  Note: "steer",
  Question: "steer",
  Answer: "steer",
  Update: "follow-up",
  Result: "follow-up",
  Blocker: "steer",
  Sync: "steer",
};

function usage() {
  return `thread-cli.mjs — monitor and steer a multi-agent thread system

Usage:
  thread-cli.mjs <command> [args] [--dir <path>]

Commands:
  list                       Show a table of all threads in the workspace
    --json                     Print raw JSON array instead of a table

  send <to> <type> <body...>  Send a message into a thread's inbox
    --from <id>                 Sender id (default: "user")
    --request-id <id>            Request id (default: "<type>.<from>.<timestamp>")
    --delivery <steer|follow-up> Delivery mode (default depends on type)
    Use "<to>" = "*" to fan out to every thread except --from.

  inbox <id>                 Show pending and recent processed messages for a thread

  tail <id>                  Follow a thread's state/journal/inbox changes live (Ctrl-C to stop)

  watch                      Live-updating list view + open obligations (Ctrl-C to stop)

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
  thread-cli.mjs send link Note "please pause" --from user
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
    } else if (a === "--request-id") {
      args.requestId = argv[++i];
    } else if (a === "--delivery") {
      args.delivery = argv[++i];
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
    return fs.readdirSync(inboxDir).filter(f => f.endsWith(".json") && !f.startsWith(".tmp-"))
      .length;
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
    const lockStr = state.lockEventId
      ? `${truncate(state.lockEventId, 24)}${state.lockPartner ? "/" + state.lockPartner : ""}`
      : "-";
    rows.push({
      id,
      state: state.state ?? "unknown",
      status: effectiveStatus(state),
      role: state.role ?? "-",
      parent: state.parent ?? "-",
      lock: lockStr,
      obligations: Array.isArray(state.obligations) ? state.obligations.length : 0,
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
  const headers = ["ID", "STATE", "STATUS", "ROLE", "PARENT", "LOCK", "OBLG", "INBOX", "LAST SEEN"];
  const data = rows.map(r => [
    r.id,
    r.state,
    r.status,
    r.role,
    r.parent,
    r.lock,
    String(r.obligations),
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

function validateType(type) {
  return MSG_TYPES.includes(type);
}

function validateDelivery(delivery) {
  return DELIVERIES.includes(delivery);
}

function writeMessageAtomic(inboxDir, message) {
  fs.mkdirSync(inboxDir, { recursive: true });
  const name = `${Date.now()}-${crypto.randomUUID()}.json`;
  const tmp = path.join(inboxDir, `.tmp-${name}`);
  const final = path.join(inboxDir, name);
  fs.writeFileSync(tmp, JSON.stringify(message, null, 2));
  fs.renameSync(tmp, final);
  return final;
}

function cmdSend(args) {
  const [to, type, ...bodyParts] = args._;
  if (!to || !type || bodyParts.length === 0) {
    process.stderr.write("usage: thread-cli.mjs send <to> <type> <body...>\n");
    return 1;
  }
  if (!validateType(type)) {
    process.stderr.write(
      `error: unknown message type "${type}". Valid types: ${MSG_TYPES.join(", ")}\n`,
    );
    return 1;
  }
  const delivery = args.delivery ?? DEFAULT_DELIVERY[type];
  if (!validateDelivery(delivery)) {
    process.stderr.write(
      `error: unknown delivery "${delivery}". Valid delivery: ${DELIVERIES.join(", ")}\n`,
    );
    return 1;
  }
  const from = args.from ?? "user";
  const body = bodyParts.join(" ");
  const sentAt = new Date().toISOString();
  const baseRequestId = args.requestId ?? `${type.toLowerCase()}.${from}.${Date.now()}`;

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
    const requestId = to === "*" ? `${baseRequestId}.${targetId}` : baseRequestId;
    const message = { from, to: targetId, type, body, requestId, delivery, sentAt };
    const inboxDir = path.join(threadDir, "inbox");
    const file = writeMessageAtomic(inboxDir, message);
    process.stdout.write(
      `sent ${type} (${delivery}) from ${from} to ${targetId} [#${requestId}] -> ${file}\n`,
    );
  }
  return 0;
}

function readInboxMessages(inboxDir) {
  let files;
  try {
    files = fs.readdirSync(inboxDir).filter(f => f.endsWith(".json") && !f.startsWith(".tmp-"));
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
  const body = bodyLen ? truncate(m.body ?? "", bodyLen) : (m.body ?? "");
  return `[${m.type} ${m.from}→${m.to} #${m.requestId}] ${body} (${m.sentAt ?? "?"})`;
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
        if (
          state.lockEventId !== lastState.lockEventId ||
          state.lockPartner !== lastState.lockPartner
        ) {
          process.stdout.write(
            `lock: ${lastState.lockEventId ?? "-"} → ${state.lockEventId ?? "-"} (partner: ${state.lockPartner ?? "-"})\n`,
          );
        }
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
        files = fs.readdirSync(dirPath).filter(f => f.endsWith(".json") && !f.startsWith(".tmp-"));
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
    out += "\nOpen obligations:\n";
    const obligations = collectObligations(args.dir);
    if (obligations.length === 0) {
      out += "  (none)\n";
    } else {
      for (const o of obligations) {
        const age = relTime(o.sentAt);
        out += `  ${o.owner} → ${o.to} : ${o.type} "${o.summary ?? ""}" (${age})\n`;
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
