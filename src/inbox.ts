import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import type { ThreadStore, MessageType, InboxMessage } from "./core/types";
import { DEFAULT_DELIVERY, OBLIGATION_TYPES, STALE_MS } from "./core/types";

export interface SendResult {
  requestId: string;
  delivered: "queued" | "live";
}

export interface Inbox {
  sendCrossThread(
    to: string,
    type: MessageType,
    body: string,
    opts?: { requestId?: string; delivery?: "steer" | "follow-up"; deadline?: string },
  ): SendResult;
  /** Expand a `to` spec — "*", "role:<role>", or comma-separated ids — into thread ids. */
  resolveTargets(to: string): string[];
  deliver(msg: InboxMessage, ctx: ExtensionContext): void;
  drainInbox(ctx: ExtensionContext): void;
  isTargetLive(to: string): boolean;
  fireSubscribers(eventId: string): number;
  /** Called from the heartbeat: injects a one-time reminder per overdue obligation. */
  checkDeadlines(): void;
}

export function createInbox(store: ThreadStore, pi: ExtensionAPI): Inbox {
  function inboxDirFor(id: string): string {
    return path.join(store.threadsRootDir, id, "inbox");
  }

  function isTargetLive(to: string): boolean {
    try {
      const f = path.join(store.threadsRootDir, to, "state.json");
      const s = JSON.parse(fs.readFileSync(f, "utf8"));
      return s.status === "running" && Date.now() - new Date(s.lastSeen).getTime() < STALE_MS;
    } catch {
      return false;
    }
  }

  function resolveTargets(to: string): string[] {
    if (to !== "*" && !to.startsWith("role:") && !to.includes(",")) return [to];
    const all = store.listThreads().filter(t => t.id !== store.threadId);
    if (to === "*") return all.map(t => t.id);
    if (to.startsWith("role:")) {
      const role = to.slice(5);
      return all.filter(t => t.role === role).map(t => t.id);
    }
    return to
      .split(",")
      .map(s => s.trim())
      .filter(s => s && s !== store.threadId);
  }

  function sendCrossThread(
    to: string,
    type: MessageType,
    body: string,
    opts: { requestId?: string; delivery?: "steer" | "follow-up"; deadline?: string } = {},
  ): SendResult {
    if (!store.threadId || !store.threadsRootDir) {
      // Without an identity the message would land at a cwd-relative path
      // nothing ever drains (observed in the wild as <cwd>/<to>/inbox/).
      throw new Error("Thread system not initialized yet — cannot send.");
    }
    const requestId = opts.requestId ?? `${type.toLowerCase()}.${store.threadId}.${Date.now()}`;
    const delivery = opts.delivery ?? DEFAULT_DELIVERY[type];
    const msg: InboxMessage = {
      from: store.threadId,
      to,
      type,
      body,
      requestId,
      delivery,
      sentAt: new Date().toISOString(),
    };

    const delivered = isTargetLive(to) ? "live" : "queued";
    const targetInbox = inboxDirFor(to);
    fs.mkdirSync(targetInbox, { recursive: true });
    const fname = `${Date.now()}-${crypto.randomUUID()}.json`;
    const tmp = path.join(targetInbox, `.tmp-${fname}`);
    const final = path.join(targetInbox, fname);
    fs.writeFileSync(tmp, JSON.stringify(msg, null, 2));
    fs.renameSync(tmp, final);

    if (to === store.lockPartner) {
      store.sentToPartnerThisTurn = true;
      store.nudgedSinceLastSend = false;
    }

    if (OBLIGATION_TYPES.has(type)) {
      store.obligations.push({
        requestId,
        type: type as "Brief" | "Question" | "Sync" | "Blocker",
        to,
        summary: body.slice(0, 80),
        sentAt: msg.sentAt,
        ...(opts.deadline ? { deadline: opts.deadline } : {}),
      });
      store.writeFile();
    }
    return { requestId, delivered };
  }

  function fireSubscribers(eventId: string): number {
    const fired = store.subscriptions.filter(s => s.eventId === eventId);
    for (const sub of fired) {
      pi.sendUserMessage(sub.message, {
        deliverAs: sub.delivery === "steer" ? "steer" : "followUp",
      });
    }
    store.subscriptions = store.subscriptions.filter(s => s.eventId !== eventId);
    store.writeFile();
    return fired.length;
  }

  /** Resolve any barriers waiting on this requestId. Returns "resolved"
   *  notices to fold into the same wake-up message as the envelope, rather
   *  than firing separate pi.sendUserMessage calls for one event. */
  function resolveBarriers(requestId: string): string[] {
    const remaining: typeof store.barriers = [];
    const notes: string[] = [];
    for (const b of store.barriers) {
      if (!b.pending.includes(requestId)) {
        remaining.push(b);
        continue;
      }
      const pending = b.pending.filter(id => id !== requestId);
      const done = b.mode === "any" || pending.length === 0;
      if (done) {
        notes.push(
          `[barrier "${b.id}" resolved]: ${b.mode === "any" ? `first reply arrived (${requestId})` : "all awaited replies have arrived"}.`,
        );
      } else {
        remaining.push({ ...b, pending });
      }
    }
    store.barriers = remaining;
    return notes;
  }

  /** How the receiving agent sees a message. The requestId and the reply
   *  affordance must travel with the message — the model has no other way
   *  to learn the correlation id it must echo back. */
  function renderEnvelope(msg: InboxMessage): string {
    const header = `[${msg.type} from ${msg.from} #${msg.requestId}]`;
    let hint = "";
    if (msg.type === "Question" || msg.type === "Blocker") {
      hint = `\n(reply with: thread_send to="${msg.from}" type="Answer" requestId="${msg.requestId}")`;
    } else if (msg.type === "Brief") {
      hint = `\n(when done, close with: thread_send to="${msg.from}" type="Result" requestId="${msg.requestId}")`;
    } else if (msg.type === "Sync") {
      hint = `\n(you are now In Sync with ${msg.from} — converse via thread_send type="Note", end with thread_sync_close)`;
    }
    return `${header}\n${msg.body}${hint}`;
  }

  function deliver(msg: InboxMessage, ctx: ExtensionContext) {
    let barrierNotes: string[] = [];
    if (msg.type === "Answer" || msg.type === "Result") {
      store.obligations = store.obligations.filter(o => o.requestId !== msg.requestId);
      // A matching Answer releases the lock no matter which state we're in:
      // "listening" (Question/Blocker), "in-sync" (partner closed or rejected
      // the sync), or "open"/"done" (reply landed between turns).
      if (store.lockEventId === msg.requestId) {
        store.lockEventId = null;
        store.lockPartner = null;
        store.lockType = null;
        store.transition("open", ctx);
      }
      fireSubscribers(msg.requestId);
      barrierNotes = resolveBarriers(msg.requestId);
    }

    if (msg.type === "Sync") {
      if (store.lockEventId) {
        // Already locked — reject as an Answer so the requester's own lock
        // (keyed to this requestId) unwinds instead of hanging forever.
        sendCrossThread(
          msg.from,
          "Answer",
          `Rejected sync: ${store.threadId} is already in sync with ${store.lockPartner ?? "another thread"}. Try again later or subscribe to my current lock.`,
          { requestId: msg.requestId },
        );
        store.writeFile();
        return;
      }
      store.lockEventId = msg.requestId;
      store.lockPartner = msg.from;
      store.lockType = "sync";
      store.transition("in-sync", ctx);
    }

    const extra = barrierNotes.length ? "\n\n" + barrierNotes.join("\n") : "";
    pi.sendUserMessage(renderEnvelope(msg) + extra, {
      deliverAs: msg.delivery === "steer" ? "steer" : "followUp",
    });
    store.writeFile();
  }

  function drainInbox(ctx: ExtensionContext) {
    // On Hold means "don't wake me": messages stay queued until resume.
    if (store.state === "on-hold") return;
    const inboxDir = path.join(store.threadDir, "inbox");
    const processedDir = path.join(inboxDir, "processed");
    let files: string[];
    try {
      files = fs
        .readdirSync(inboxDir)
        .filter(f => f.endsWith(".json"))
        .sort();
    } catch {
      return;
    }
    for (const f of files) {
      const full = path.join(inboxDir, f);
      let msg: InboxMessage;
      try {
        msg = JSON.parse(fs.readFileSync(full, "utf8"));
      } catch {
        continue;
      }
      // Rename before delivering: if deliver() throws, message is already
      // moved and won't be redelivered.
      try {
        fs.renameSync(full, path.join(processedDir, f));
      } catch {
        continue; // already claimed — shouldn't happen (single reader)
      }
      deliver(msg, ctx);
    }
  }

  function checkDeadlines() {
    const now = Date.now();
    let changed = false;
    for (const ob of store.obligations) {
      if (!ob.deadline || ob.nudged || new Date(ob.deadline).getTime() > now) continue;
      ob.nudged = true;
      changed = true;
      pi.sendUserMessage(
        `[obligation overdue #${ob.requestId}]: your ${ob.type} to ${ob.to} ("${ob.summary}") passed its deadline with no reply. Follow up with ${ob.to}${store.parent ? `, or escalate a Blocker to ${store.parent}` : ""}.`,
        { deliverAs: "steer" },
      );
    }
    for (const b of store.barriers) {
      if (!b.deadline || b.nudged || new Date(b.deadline).getTime() > now) continue;
      b.nudged = true;
      changed = true;
      pi.sendUserMessage(
        `[barrier overdue "${b.id}"]: still waiting on ${b.mode} of ${b.pending.length} repl${b.pending.length === 1 ? "y" : "ies"} (${b.pending.join(", ")}) — none arrived by the deadline. Check in with the target thread(s), or the barrier will keep waiting silently.`,
        { deliverAs: "steer" },
      );
    }
    if (changed) store.writeFile();
  }

  return {
    sendCrossThread,
    resolveTargets,
    deliver,
    drainInbox,
    isTargetLive,
    fireSubscribers,
    checkDeadlines,
  };
}
