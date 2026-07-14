#!/usr/bin/env node
// postbox-hook.mjs — Claude Code hook that gives a session push-style
// Postbox delivery over the local-fs binding (Appendix B). One script,
// registered on four hook events; the event decides the delivery gate:
//
//   SessionStart      cold-start drain (all due mail)         → additionalContext
//   UserPromptSubmit  turn-start drain (all due mail)         → additionalContext
//   PostToolUse       next-opening push (urgency=high only)   → additionalContext
//   Stop              turn-end drain; mail blocks the stop    → decision:block
//
// Identity comes from POSTBOX_THREAD_ID (required — without it the hook is
// a silent no-op, mirroring the extension's opt-in gate). POSTBOX_DIR
// overrides the workspace root (default: the hook's cwd). Claims are
// exclusive with any concurrently running postbox-mcp server for the same
// thread: both claim by rename into processed/, and rename wins only once.
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { setTimeout as sleep } from "node:timers/promises";

const THREAD_ID = process.env.POSTBOX_THREAD_ID;
if (!THREAD_ID) process.exit(0);

const input = await readStdinJson();
const event = input.hook_event_name;
const WORKSPACE = process.env.POSTBOX_DIR
  ? path.resolve(process.env.POSTBOX_DIR)
  : (input.cwd ?? process.cwd());
const THREAD_DIR = path.join(WORKSPACE, ".thread", "threads", THREAD_ID);
const INBOX = path.join(THREAD_DIR, "inbox");
const PROCESSED = path.join(INBOX, "processed");
const STATE = path.join(THREAD_DIR, "state.json");

function readStdinJson() {
  return new Promise(resolve => {
    let buf = "";
    process.stdin.on("data", d => (buf += d));
    process.stdin.on("end", () => {
      try {
        resolve(JSON.parse(buf));
      } catch {
        resolve({});
      }
    });
  });
}

function readJsonSafe(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return undefined;
  }
}

function isDue(msg, now) {
  return !msg.deliverAfter || Date.parse(msg.deliverAfter) <= now;
}

/** Claim-and-remove the due mail this gate is allowed to deliver.
 *  highOnly implements §7 urgency: mid-turn openings deliver only
 *  urgency=high; everything else waits for a turn boundary. */
function drain({ highOnly = false } = {}) {
  let files;
  try {
    files = fs
      .readdirSync(INBOX)
      .filter(f => f.endsWith(".json"))
      .sort();
  } catch {
    return [];
  }
  const now = Date.now();
  const claimed = [];
  for (const f of files) {
    const msg = readJsonSafe(path.join(INBOX, f));
    if (!msg || typeof msg !== "object" || !msg.id) continue; // malformed: left in place
    if (!isDue(msg, now)) continue;
    if (highOnly && msg.urgency !== "high") continue;
    fs.mkdirSync(PROCESSED, { recursive: true });
    try {
      fs.renameSync(path.join(INBOX, f), path.join(PROCESSED, f));
    } catch {
      continue; // lost the claim race to another actor — theirs now
    }
    claimed.push(msg);
  }
  if (claimed.length > 0) updateLedger(claimed);
  return claimed;
}

/** Mirror the C2 ledger rules (§9): a reply discharges the matching
 *  obligation; an expects records an owed reply. Also refresh presence. */
function updateLedger(messages) {
  const state = readJsonSafe(STATE) ?? {
    id: THREAD_ID,
    cwd: WORKSPACE,
    parent: process.env.POSTBOX_PARENT ?? null,
    role: process.env.POSTBOX_ROLE ?? null,
    state: "open",
    status: "running",
    obligations: [],
    owed: [],
    barriers: [],
    startedAt: new Date().toISOString(),
  };
  state.obligations ??= [];
  state.owed ??= [];
  for (const msg of messages) {
    if (msg.re) {
      // Errata 1 gate, obligation side: only a reply from the thread the
      // debt was recorded against clears it.
      const obMatch = state.obligations.find(o => o.id === msg.re);
      if (obMatch && obMatch.to === msg.from) {
        state.obligations = state.obligations.filter(o => o.id !== msg.re);
      }
    }
    if (msg.expects && !state.owed.some(o => o.id === msg.id)) {
      state.owed.push({
        id: msg.id,
        from: msg.from,
        summary: String(msg.body ?? "").slice(0, 80),
        receivedAt: msg.sentAt,
      });
    }
  }
  state.lastSeen = new Date().toISOString();
  state.updatedAt = state.lastSeen;
  fs.mkdirSync(THREAD_DIR, { recursive: true });
  const tmp = STATE + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
  fs.renameSync(tmp, STATE);
}

function renderEnvelope(msg) {
  const kind =
    msg.expects && msg.re ? "reply+request" : msg.expects ? "request" : msg.re ? "reply" : "note";
  const reTag = msg.re ? ` re #${msg.re}` : "";
  const hint = msg.expects ? `\nreply with thread_send re=${msg.id}` : "";
  return `[${kind} from ${msg.from} #${msg.id}${reTag}]\n${msg.body}${hint}`;
}

function render(messages) {
  return (
    `Postbox mail for ${THREAD_ID} (${messages.length}):\n\n` +
    messages.map(renderEnvelope).join("\n\n")
  );
}

function emitContext(messages) {
  if (messages.length === 0) return;
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: { hookEventName: event, additionalContext: render(messages) },
    }),
  );
}

switch (event) {
  case "SessionStart":
  case "UserPromptSubmit": {
    emitContext(drain());
    break;
  }
  case "PostToolUse": {
    emitContext(drain({ highOnly: true }));
    break;
  }
  case "Stop": {
    // Optional grace window: linger up to POSTBOX_STOP_WAIT_SECONDS for
    // mail before letting the session stop (keeps a quiet worker
    // addressable without a waker). Default 0 — check once.
    const waitMs = Number(process.env.POSTBOX_STOP_WAIT_SECONDS ?? 0) * 1000;
    const deadline = Date.now() + waitMs;
    let messages = drain();
    while (messages.length === 0 && Date.now() < deadline) {
      await sleep(500);
      messages = drain();
    }
    if (messages.length > 0) {
      process.stdout.write(
        JSON.stringify({
          decision: "block",
          reason:
            render(messages) +
            "\n\nHandle these messages before finishing: settle any reply debts " +
            "(thread_send with re=<id>), then stop when nothing is owed.",
        }),
      );
    }
    break;
  }
  default:
    break;
}
