import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { spawn } from "node:child_process";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

type ThreadState =
  | "idle" | "thinking" | "working" | "open"
  | "in-sync" | "listening" | "on-hold" | "stopped" | "done";

type MessageType = "Brief" | "Note" | "Question" | "Answer" | "Update" | "Result" | "Blocker" | "Sync";

// Default delivery per THREAD-MODEL.md's Message Types table.
const DEFAULT_DELIVERY: Record<MessageType, "steer" | "follow-up"> = {
  Brief: "steer",
  Note: "steer",
  Question: "steer",
  Answer: "steer",
  Update: "follow-up",
  Result: "follow-up",
  Blocker: "steer",
  Sync: "steer",
};

// Obligation-creating types: the sender owes nothing further, but a reply is expected/tracked.
const OBLIGATION_TYPES: ReadonlySet<MessageType> = new Set(["Brief", "Question", "Sync"]);

const HEARTBEAT_MS = 20_000;
const STALE_MS = 60_000;

interface Obligation {
  requestId: string;
  type: "Brief" | "Question" | "Sync";
  to: string;
  summary: string;
  sentAt: string;
}

interface Subscription {
  eventId: string;
  message: string;
  delivery: "steer" | "follow-up";
}

interface StateFile {
  id: string;
  pid: number;
  cwd: string;
  parent: string | null;
  sessionFile: string | null;
  state: ThreadState;
  status: "running" | "stopped";
  lockEventId: string | null;
  lockPartner: string | null;
  subscriptions: Subscription[];
  obligations: Obligation[];
  startedAt: string;
  lastSeen: string;
  updatedAt: string;
}

interface InboxMessage {
  from: string;
  to: string;
  type: MessageType;
  body: string;
  requestId: string;
  delivery: "steer" | "follow-up";
  sentAt: string;
}

const JOURNAL_PROMPT = `You are this thread's journal keeper. Based on the conversation above, write a brief status update in exactly this format:

Working on: <the main task in one line>
Done: <what was completed this turn>
Doing: <what is in progress or will continue>
Next: <planned next step>
Blockers: <blockers or "none">

No preamble. No extra text. Just the five lines.`;

export default function (pi: ExtensionAPI) {
  pi.registerFlag("thread-id", {
    type: "string",
    description: "Stable id for this thread, used for cross-thread addressing (e.g. thread-b)",
  });
  pi.registerFlag("thread-parent", {
    type: "string",
    description: "Parent thread id, for Blocker escalation",
  });

  let threadId = "";
  let threadDir = "";
  let threadsRootDir = "";
  let parent: string | null = null;
  let startedAt = "";

  let state: ThreadState = "idle";
  let status: "running" | "stopped" = "running";
  let lockEventId: string | null = null;
  let lockPartner: string | null = null;
  let subscriptions: Subscription[] = [];
  let obligations: Obligation[] = [];

  let heartbeat: ReturnType<typeof setInterval> | null = null;
  let watcher: fs.FSWatcher | null = null;

  function inboxDirFor(id: string): string {
    return path.join(threadsRootDir, id, "inbox");
  }

  function writeFile() {
    if (!threadDir) return;
    const data: StateFile = {
      id: threadId, pid: process.pid, cwd: process.cwd(), parent, sessionFile: null,
      state, status, lockEventId, lockPartner, subscriptions, obligations,
      startedAt, lastSeen: new Date().toISOString(), updatedAt: new Date().toISOString(),
    };
    fs.writeFileSync(path.join(threadDir, "state.json"), JSON.stringify(data, null, 2));
  }

  function transition(next: ThreadState, ctx?: ExtensionContext) {
    state = next;
    writeFile();
    ctx?.ui.setStatus("thread", `[${threadId}:${state}]`);
  }

  function forkJournal(sessionFile: string) {
    const journalPath = path.join(threadDir, "journal.md");
    // --fork requires a session dir; use a temp dir and clean it up on close.
    const tmpSes = fs.mkdtempSync(path.join(os.tmpdir(), "pi-journal-"));
    let out = "";
    const proc = spawn("pi", [
      "--fork", sessionFile,
      "--session-dir", tmpSes,
      "--model", "deepseek/deepseek-chat",
      "--thinking", "off",
      "--print", JOURNAL_PROMPT,
    ], { stdio: ["ignore", "pipe", "ignore"] });
    proc.on("error", () => {
      fs.rmSync(tmpSes, { recursive: true, force: true });
    });
    proc.stdout.on("data", (d: Buffer) => { out += d.toString(); });
    proc.on("close", () => {
      fs.rmSync(tmpSes, { recursive: true, force: true });
      const entry = out.trim();
      if (!entry) return;
      const ts = new Date().toISOString().slice(0, 16).replace("T", " ");
      fs.appendFileSync(journalPath, `\n<!-- ${ts} -->\n${entry}\n`);
    });
  }

  function fireSubscribers(eventId: string): number {
    const fired = subscriptions.filter(s => s.eventId === eventId);
    // deliver before removing so a throw mid-loop doesn't silently drop un-delivered entries
    for (const sub of fired) {
      pi.sendUserMessage(sub.message, {
        deliverAs: sub.delivery === "steer" ? "steer" : "followUp",
      });
    }
    subscriptions = subscriptions.filter(s => s.eventId !== eventId);
    writeFile();
    return fired.length;
  }

  function isTargetLive(to: string): boolean {
    try {
      const f = path.join(threadsRootDir, to, "state.json");
      const s: StateFile = JSON.parse(fs.readFileSync(f, "utf8"));
      return s.status === "running" && Date.now() - new Date(s.lastSeen).getTime() < STALE_MS;
    } catch {
      return false;
    }
  }

  // Writes a message into another thread's inbox via write-temp-then-rename
  // (atomic on the same filesystem, so a concurrent fs.watch never observes a
  // partial write). Shared by thread_send and the sync tools.
  function sendCrossThread(
    to: string,
    type: MessageType,
    body: string,
    opts: { requestId?: string; delivery?: "steer" | "follow-up" } = {},
  ): { requestId: string; delivered: "queued" | "live" } {
    const requestId = opts.requestId ?? `${type.toLowerCase()}.${threadId}.${Date.now()}`;
    const delivery = opts.delivery ?? DEFAULT_DELIVERY[type];
    const msg: InboxMessage = { from: threadId, to, type, body, requestId, delivery, sentAt: new Date().toISOString() };

    const delivered = isTargetLive(to) ? "live" : "queued";
    const targetInbox = inboxDirFor(to);
    fs.mkdirSync(targetInbox, { recursive: true });
    const fname = `${Date.now()}-${crypto.randomUUID()}.json`;
    const tmp = path.join(targetInbox, `.tmp-${fname}`);
    const final = path.join(targetInbox, fname);
    fs.writeFileSync(tmp, JSON.stringify(msg, null, 2));
    fs.renameSync(tmp, final);

    if (OBLIGATION_TYPES.has(type)) {
      obligations.push({ requestId, type: type as "Brief" | "Question" | "Sync", to, summary: body.slice(0, 80), sentAt: msg.sentAt });
      writeFile();
    }
    return { requestId, delivered };
  }

  function deliver(msg: InboxMessage, ctx: ExtensionContext) {
    if (msg.type === "Answer" || msg.type === "Result") {
      obligations = obligations.filter(o => o.requestId !== msg.requestId);
      if (state === "listening" && lockEventId === msg.requestId) {
        lockEventId = null;
        transition("open", ctx);
      }
      fireSubscribers(msg.requestId);
    }

    if (msg.type === "Sync") {
      if (lockEventId) {
        // already in-sync with someone else — reject instead of silently dropping
        sendCrossThread(msg.from, "Note", `Rejected sync: already in-sync with ${lockPartner ?? "another thread"}.`, { requestId: msg.requestId });
        writeFile();
        return;
      }
      lockEventId = msg.requestId;
      lockPartner = msg.from;
      transition("in-sync", ctx);
    }

    pi.sendUserMessage(`[${msg.type} from ${msg.from}]: ${msg.body}`, {
      deliverAs: msg.delivery === "steer" ? "steer" : "followUp",
    });
    writeFile();
  }

  // fs.watch only triggers a drain — it never inspects which file changed.
  // This sidesteps fs.watch's known coalescing/duplicate-event unreliability,
  // since draining an already-empty/already-renamed inbox is a no-op.
  function drainInbox(ctx: ExtensionContext) {
    const inboxDir = path.join(threadDir, "inbox");
    const processedDir = path.join(inboxDir, "processed");
    let files: string[];
    try {
      files = fs.readdirSync(inboxDir).filter(f => f.endsWith(".json")).sort();
    } catch {
      return;
    }
    for (const f of files) {
      const full = path.join(inboxDir, f);
      let msg: InboxMessage;
      try {
        msg = JSON.parse(fs.readFileSync(full, "utf8"));
      } catch {
        continue; // being written concurrently or corrupt — retry next drain
      }
      // Rename before delivering: if deliver() throws mid-way, the message is
      // already out of the pending inbox and won't be redelivered. A duplicate
      // Brief/Question appearing twice in a conversation is worse than one that's
      // dropped but still inspectable in processed/.
      try {
        fs.renameSync(full, path.join(processedDir, f));
      } catch {
        continue; // already claimed — shouldn't happen (single reader) but defensive
      }
      deliver(msg, ctx);
    }
  }

  function listThreads(): Array<{ id: string; state: ThreadState; status: "running" | "stopped"; parent: string | null; lastSeen: string }> {
    if (!fs.existsSync(threadsRootDir)) return [];
    const ids = fs.readdirSync(threadsRootDir, { withFileTypes: true }).filter(d => d.isDirectory()).map(d => d.name);
    const out: Array<{ id: string; state: ThreadState; status: "running" | "stopped"; parent: string | null; lastSeen: string }> = [];
    for (const id of ids) {
      const f = path.join(threadsRootDir, id, "state.json");
      if (!fs.existsSync(f)) continue;
      try {
        const s: StateFile = JSON.parse(fs.readFileSync(f, "utf8"));
        const stale = Date.now() - new Date(s.lastSeen).getTime() > STALE_MS;
        out.push({ id: s.id, state: s.state, status: stale ? "stopped" : s.status, parent: s.parent, lastSeen: s.lastSeen });
      } catch {
        continue; // corrupt/partial — skip
      }
    }
    return out;
  }

  function THREAD_MODEL_PROMPT(): string {
    return `## Thread Communication Model

You are thread **${threadId}**${parent ? `, child of **${parent}**` : ""} in a multi-thread workspace. Other threads share this directory and communicate through you via the thread_* tools.

### Your State
- **Open** — between turns. This is the ONLY moment messages land. You exit Open the instant you start thinking or working.
- **Thinking** / **Working** — mid-turn. Messages queue until you return to Open.
- **Listening** — you sent a Question or Sync and are blocked until the reply arrives.
- **In Sync [LOCKED]** — rendezvous with another thread. Only one partner at a time. Close with thread_sync_close.
- **Idle** — startup, or cleared after Done.
- **Done** — work complete. Stay here unless re-triggered.
- **On Hold** — suspended gracefully. Resume with thread_resume.
- **Stopped** — terminated. Not resumable.

### Message Types
| Type | You owe | They owe | Default delivery |
|---|---|---|---|
| **Brief** | — | Must reply with Result | steer |
| **Note** | — | Nothing — guidance only | steer |
| **Question** | Enter Listening | Must reply with Answer | steer |
| **Answer** | — | Nothing — closes a Question | steer |
| **Update** | — | Nothing — broadcast | follow-up |
| **Result** | — | Nothing — closes a Brief | follow-up |
| **Blocker** | Enter Listening (you're stuck) | Parent must decide | steer |
| **Sync** | Enter In Sync [LOCKED] | Both enter In Sync | steer |

### Delivery
- **steer** — delivered at your next Open (after current tool call finishes). Use for anything needing a response.
- **follow-up** — delivered when you reach Done or Idle. Use for results, broadcasts, non-urgent updates.

### Obligations
Brief, Question, and Sync create obligations tracked in your state. They clear when the matching Answer or Result arrives. Use thread_status to see outstanding obligations.

### Lock Model
In Sync is mutually exclusive. If you request sync and the partner is already locked, you get back an eventId — subscribe to it and wait. Closing sync releases the lock and fires subscribers on both sides.

### Interaction Patterns
- **Delegate**: Brief → Result (re-triggers sender)
- **Supervise**: Note (no reply)
- **Query**: Question → Listening → Answer
- **Converse**: Sync → alternating turns → close
- **Broadcast**: Update to many (no obligation)
- **Escalate**: Blocker to parent → parent answers

### Key Rules
1. Messages only land at Open — finish your current tool call first, then drain
2. Never send to yourself — use thread_subscribe/thread_emit for intra-thread events
3. Check thread_list before sending — stale threads (lastSeen > 60s) are effectively dead
4. Journal is self-written after each turn_end — use thread_status to recover context after compaction`;
  }

  // --- lifecycle events ---

  pi.on("session_start", (event, ctx) => {
    const baseDir = path.join(ctx.cwd, ".thread");
    threadsRootDir = path.join(baseDir, "threads");
    fs.mkdirSync(threadsRootDir, { recursive: true });

    // Migrate old flat .thread/state.json layout, if present and not yet migrated.
    const oldStateFile = path.join(baseDir, "state.json");
    if (fs.existsSync(oldStateFile) && !fs.existsSync(threadsRootDir + path.sep + ".migrated")) {
      try {
        const old = JSON.parse(fs.readFileSync(oldStateFile, "utf8"));
        const migratedId = "thread-legacy";
        const migratedDir = path.join(threadsRootDir, migratedId);
        fs.mkdirSync(migratedDir, { recursive: true });
        if (!fs.existsSync(path.join(migratedDir, "state.json"))) {
          fs.writeFileSync(path.join(migratedDir, "state.json"), JSON.stringify(old, null, 2));
        }
        const oldJournal = path.join(baseDir, "journal.md");
        if (fs.existsSync(oldJournal) && !fs.existsSync(path.join(migratedDir, "journal.md"))) {
          fs.copyFileSync(oldJournal, path.join(migratedDir, "journal.md"));
        }
        fs.writeFileSync(path.join(threadsRootDir, ".migrated"), new Date().toISOString());
      } catch (err) {
        console.error("[thread] Failed to migrate legacy state.json:", err);
      }
    }

    // Resolve thread identity.
    const flagId = pi.getFlag("thread-id");
    if (typeof flagId === "string" && flagId) {
      threadId = flagId;
    } else {
      let existingId: string | undefined;
      try {
        const entries = ctx.sessionManager.getEntries();
        for (const e of entries) {
          if (e.type === "custom" && e.customType === "thread-identity") {
            const data = (e as { data?: { id?: string } }).data;
            if (data?.id) existingId = data.id;
          }
        }
      } catch {
        // --no-session or unreadable session — fall through to generating an id
      }
      threadId = existingId ?? `thread-${crypto.randomUUID().slice(0, 8)}`;
      if (!existingId) pi.appendEntry("thread-identity", { id: threadId });
    }

    const flagParent = pi.getFlag("thread-parent");
    parent = typeof flagParent === "string" && flagParent ? flagParent : null;

    threadDir = path.join(threadsRootDir, threadId);
    fs.mkdirSync(path.join(threadDir, "inbox", "processed"), { recursive: true });

    const stateFile = path.join(threadDir, "state.json");
    if (fs.existsSync(stateFile)) {
      try {
        const s: StateFile = JSON.parse(fs.readFileSync(stateFile, "utf8"));
        state = s.state === "done" ? "idle" : s.state;
        lockEventId = null; // locks don't survive restarts — sync must be re-established
        lockPartner = null;
        const stale = s.lockEventId;
        subscriptions = (s.subscriptions ?? []).filter(sub => sub.eventId !== stale);
        obligations = (s.obligations ?? []).filter(ob => ob.requestId !== stale);
        parent = parent ?? s.parent ?? null;
      } catch (err) {
        console.error("[thread] Failed to restore state.json:", err);
      }
    }

    startedAt = new Date().toISOString();
    status = "running";
    writeFile();

    // Calling pi.sendUserMessage synchronously from inside session_start
    // deadlocks pi's own turn scheduling (confirmed empirically — a --print run
    // never produces output if delivery happens inline here). Defer the initial
    // drain to the next tick, after session_start has returned control to pi,
    // while still registering the watcher now so nothing arriving in between
    // is missed.
    try {
      watcher = fs.watch(path.join(threadDir, "inbox"), () => drainInbox(ctx));
    } catch (err) {
      console.error("[thread] Failed to watch inbox:", err);
    }
    setImmediate(() => drainInbox(ctx));

    heartbeat = setInterval(() => { writeFile(); }, HEARTBEAT_MS);

    ctx.ui.setStatus("thread", `[${threadId}:${state}]`);
  });

  pi.on("session_shutdown", (event) => {
    if (heartbeat) clearInterval(heartbeat);
    if (watcher) watcher.close();
    if (event.reason === "quit" && state !== "done") {
      state = "stopped";
      status = "stopped";
      writeFile();
    }
  });

  pi.on("turn_start", (_event, ctx) => transition("thinking", ctx));

  pi.on("tool_execution_start", (_event, ctx) => transition("working", ctx));

  pi.on("turn_end", (_event, ctx) => {
    transition("open", ctx);
    const sf = ctx.sessionManager.getSessionFile();
    if (sf) forkJournal(sf);
  });

  pi.on("agent_end", (_event, ctx) => {
    transition("done", ctx);
    // no fork here — turn_end already journaled the final turn
  });

  pi.on("before_agent_start", async (event, ctx) => {
    return {
      systemPrompt: event.systemPrompt + "\n\n" + THREAD_MODEL_PROMPT(),
    };
  });

  // --- tools ---

  pi.registerTool({
    name: "thread_status",
    label: "Thread Status",
    description: "Read this thread's own state and journal. Use this to understand what you were doing before a compaction.",
    parameters: Type.Object({}),
    async execute() {
      const journalPath = path.join(threadDir, "journal.md");
      const journal = fs.existsSync(journalPath)
        ? fs.readFileSync(journalPath, "utf8").trim()
        : "(no journal yet — this is the first turn)";
      return {
        content: [{
          type: "text" as const,
          text: `Id: ${threadId}\nState: ${state}\nStatus: ${status}\nLock: ${lockEventId ?? "none"}${lockPartner ? ` (with ${lockPartner})` : ""}\nSubscriptions: ${subscriptions.length}\nObligations: ${obligations.length}\n\n${journal}`,
        }],
        details: { id: threadId, state, status, lockEventId, lockPartner, subscriptions, obligations },
      };
    },
  });

  pi.registerTool({
    name: "thread_list",
    label: "Thread List",
    description: "List all known threads sharing this workspace and their last known state. Use this to find a valid `to` id before calling thread_send or thread_sync_request.",
    parameters: Type.Object({}),
    async execute() {
      const threads = listThreads();
      const lines = threads.map(t =>
        `${t.id.padEnd(16)} [${t.state}]  ${t.status}  parent=${t.parent ?? "-"}  lastSeen=${t.lastSeen}`
      );
      return {
        content: [{ type: "text" as const, text: lines.length ? lines.join("\n") : "(no other threads found)" }],
        details: { threads },
      };
    },
  });

  pi.registerTool({
    name: "thread_send",
    label: "Thread Send",
    description: "Send a typed message to another thread by id. See thread_list for valid ids. Question makes this thread enter Listening until a matching Answer arrives; Brief/Question/Sync leave an obligation visible via thread_status until closed by a matching Answer/Result.",
    parameters: Type.Object({
      to: Type.String({ description: "Target thread id (see thread_list)" }),
      type: Type.Union([
        Type.Literal("Brief"), Type.Literal("Note"), Type.Literal("Question"), Type.Literal("Answer"),
        Type.Literal("Update"), Type.Literal("Result"), Type.Literal("Blocker"), Type.Literal("Sync"),
      ], { description: "Brief/Note/Question/Update/Result/Blocker: default delivery per THREAD-MODEL.md. Answer/Result require requestId." }),
      body: Type.String({ description: "Message content" }),
      requestId: Type.Optional(Type.String({ description: "Correlation id. Required for Answer/Result — must match the original Question/Brief's requestId. Auto-generated for Brief/Question/Sync if omitted." })),
      delivery: Type.Optional(Type.Union([Type.Literal("steer"), Type.Literal("follow-up")], { description: "Override the type's default delivery" })),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      if (params.to === threadId) {
        return {
          content: [{ type: "text" as const, text: "Cannot send to self — use thread_subscribe/thread_emit for intra-thread notifications." }],
          details: { ok: false },
        };
      }
      const type = params.type as MessageType;
      if ((type === "Answer" || type === "Result") && !params.requestId) {
        return {
          content: [{ type: "text" as const, text: `requestId is required for ${type} — it must match the original Question/Brief's requestId.` }],
          details: { ok: false },
        };
      }
      const { requestId, delivered } = sendCrossThread(params.to, type, params.body, {
        requestId: params.requestId,
        delivery: params.delivery as "steer" | "follow-up" | undefined,
      });
      if (type === "Question") {
        lockEventId = requestId;
        transition("listening", ctx);
      }
      return {
        content: [{ type: "text" as const, text: `${type} sent to ${params.to}. requestId=${requestId} (${delivered}).` }],
        details: { ok: true, requestId, delivered },
      };
    },
  });

  pi.registerTool({
    name: "thread_subscribe",
    label: "Thread Subscribe",
    description: "Subscribe a message to a named event in THIS thread. When that event fires (locally, or via a matching cross-thread Answer/Result), the message is injected into this thread.",
    parameters: Type.Object({
      eventId: Type.String({ description: "Event name (or requestId) to subscribe to" }),
      message: Type.String({ description: "Message to inject when the event fires" }),
      delivery: Type.Union(
        [Type.Literal("steer"), Type.Literal("follow-up")],
        { description: "steer = at next Open (urgent), follow-up = when done (deferred)" }
      ),
    }),
    async execute(_id, params) {
      subscriptions.push({
        eventId: params.eventId,
        message: params.message,
        delivery: params.delivery as "steer" | "follow-up",
      });
      writeFile();
      return {
        content: [{ type: "text" as const, text: `Subscribed to "${params.eventId}". Message will arrive as ${params.delivery}.` }],
        details: { ok: true, eventId: params.eventId },
      };
    },
  });

  pi.registerTool({
    name: "thread_emit",
    label: "Thread Emit",
    description: "Emit a named event in THIS thread, delivering queued messages to all local subscribers of that event.",
    parameters: Type.Object({
      eventId: Type.String({ description: "Event name to emit" }),
    }),
    async execute(_id, params) {
      const n = fireSubscribers(params.eventId);
      return {
        content: [{ type: "text" as const, text: `Event "${params.eventId}" fired. ${n} subscriber(s) notified.` }],
        details: { eventId: params.eventId, notified: n },
      };
    },
  });

  pi.registerTool({
    name: "thread_sync_request",
    label: "Thread Sync Request",
    description: "Enter In Sync (rendezvous) with another thread by id. Returns ok with a lockEventId if unlocked, or locked with an eventId if this thread is already in sync with someone else.",
    parameters: Type.Object({
      partner: Type.String({ description: "Target thread id to rendezvous with (see thread_list)" }),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      if (lockEventId) {
        return {
          content: [{ type: "text" as const, text: `Thread is locked (in sync). EventId to wait on: ${lockEventId}` }],
          details: { locked: true, eventId: lockEventId },
        };
      }
      if (params.partner === threadId) {
        return {
          content: [{ type: "text" as const, text: "Cannot sync with self." }],
          details: { ok: false },
        };
      }
      lockEventId = `sync.${params.partner}.${Date.now()}`;
      lockPartner = params.partner;
      transition("in-sync", ctx);
      sendCrossThread(params.partner, "Sync", `Sync requested by ${threadId}`, { requestId: lockEventId });
      return {
        content: [{ type: "text" as const, text: `Sync acquired with ${params.partner}. EventId: ${lockEventId}` }],
        details: { ok: true, eventId: lockEventId },
      };
    },
  });

  pi.registerTool({
    name: "thread_sync_close",
    label: "Thread Sync Close",
    description: "End the current In Sync session. Releases the lock, fires local subscribers, and notifies the sync partner so its side unwinds too.",
    parameters: Type.Object({}),
    async execute(_id, _params, _signal, _onUpdate, ctx) {
      if (!lockEventId) {
        return {
          content: [{ type: "text" as const, text: "Not currently in sync — nothing to close." }],
          details: { ok: false },
        };
      }
      const released = lockEventId;
      const partner = lockPartner;
      lockEventId = null;
      lockPartner = null;
      transition("open", ctx);
      const n = fireSubscribers(released);
      if (partner) {
        sendCrossThread(partner, "Answer", "sync closed", { requestId: released });
      }
      return {
        content: [{ type: "text" as const, text: `Sync closed. Released "${released}". ${n} local waiter(s) notified.${partner ? ` Notified partner ${partner}.` : ""}` }],
        details: { ok: true, released, waitersNotified: n },
      };
    },
  });

  pi.registerTool({
    name: "thread_suspend",
    label: "Thread Suspend",
    description: "Mark this thread On Hold. Cooperative — does not stop the process, just records suspended state for a human/harness to act on.",
    parameters: Type.Object({
      reason: Type.Optional(Type.String()),
    }),
    async execute(_id, _params, _signal, _onUpdate, ctx) {
      transition("on-hold", ctx);
      return {
        content: [{ type: "text" as const, text: "Thread suspended (On Hold)." }],
        details: { ok: true },
      };
    },
  });

  pi.registerTool({
    name: "thread_resume",
    label: "Thread Resume",
    description: "Resume this thread from On Hold back to Open.",
    parameters: Type.Object({}),
    async execute(_id, _params, _signal, _onUpdate, ctx) {
      if (state !== "on-hold") {
        return {
          content: [{ type: "text" as const, text: `Not on hold (state is ${state}) — nothing to resume.` }],
          details: { ok: false },
        };
      }
      transition("open", ctx);
      return {
        content: [{ type: "text" as const, text: "Thread resumed (Open)." }],
        details: { ok: true },
      };
    },
  });

  // --- slash commands ---

  pi.registerCommand("/thread-status", {
    description: "Show this thread's own state and latest journal entry",
    async handler(_args, ctx) {
      await ctx.waitForIdle();
      const journalPath = path.join(threadDir, "journal.md");
      const lines = fs.existsSync(journalPath)
        ? fs.readFileSync(journalPath, "utf8").trim().split("\n").slice(-12).join("\n")
        : "(no journal yet)";
      ctx.ui.notify(
        `Id: ${threadId} | State: ${state} | Status: ${status} | Lock: ${lockEventId ?? "none"}${lockPartner ? ` (with ${lockPartner})` : ""} | Subs: ${subscriptions.length} | Obligations: ${obligations.length}\n\n${lines}`,
        "info"
      );
    },
  });

  pi.registerCommand("/thread-emit", {
    description: "Emit a named event: /thread-emit <eventId>",
    async handler(args, ctx) {
      const eventId = args.trim();
      if (!eventId) {
        ctx.ui.notify("Usage: /thread-emit <eventId>", "warning");
        return;
      }
      const n = fireSubscribers(eventId);
      ctx.ui.notify(`Event "${eventId}" fired. ${n} subscriber(s) notified.`, "info");
    },
  });

  pi.registerCommand("/thread-list", {
    description: "List all known threads sharing this workspace",
    async handler(_args, ctx) {
      const threads = listThreads();
      if (!threads.length) {
        ctx.ui.notify("(no other threads found)", "info");
        return;
      }
      const lines = threads.map(t =>
        `${t.id.padEnd(16)} [${t.state}]  ${t.status}  parent=${t.parent ?? "-"}  lastSeen=${t.lastSeen}`
      );
      ctx.ui.notify(lines.join("\n"), "info");
    },
  });

  pi.registerCommand("/thread-send", {
    description: "Send a message to another thread: /thread-send <to> <type> <body...>",
    async handler(args, ctx) {
      const parts = args.trim().split(/\s+/);
      const [to, type, ...bodyParts] = parts;
      const body = bodyParts.join(" ");
      const validTypes: MessageType[] = ["Brief", "Note", "Question", "Answer", "Update", "Result", "Blocker", "Sync"];
      if (!to || !type || !body || !validTypes.includes(type as MessageType)) {
        ctx.ui.notify(`Usage: /thread-send <to> <${validTypes.join("|")}> <body...>`, "warning");
        return;
      }
      if (to === threadId) {
        ctx.ui.notify("Cannot send to self.", "warning");
        return;
      }
      const { requestId, delivered } = sendCrossThread(to, type as MessageType, body);
      ctx.ui.notify(`${type} sent to ${to}. requestId=${requestId} (${delivered}).`, "info");
    },
  });

  pi.registerCommand("/thread-suspend", {
    description: "Mark this thread On Hold: /thread-suspend [reason]",
    async handler(_args, ctx) {
      transition("on-hold", ctx);
      ctx.ui.notify("Thread suspended (On Hold).", "info");
    },
  });

  pi.registerCommand("/thread-resume", {
    description: "Resume this thread from On Hold back to Open",
    async handler(_args, ctx) {
      if (state !== "on-hold") {
        ctx.ui.notify(`Not on hold (state is ${state}).`, "warning");
        return;
      }
      transition("open", ctx);
      ctx.ui.notify("Thread resumed (Open).", "info");
    },
  });
}
