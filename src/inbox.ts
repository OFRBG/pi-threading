import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { ThreadStore, MessageType, InboxMessage } from "./core/types";
import { DEFAULT_DELIVERY, OBLIGATION_TYPES, STALE_MS } from "./core/types";
import { mintId } from "./core/ids";

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
  ): Promise<SendResult>;
  /** Expand a `to` spec — "*", "role:<role>", or comma-separated ids — into thread ids. */
  resolveTargets(to: string): Promise<string[]>;
  deliver(msg: InboxMessage, ctx: ExtensionContext): Promise<void>;
  drainInbox(ctx: ExtensionContext): Promise<void>;
  isTargetLive(to: string): Promise<boolean>;
  fireSubscribers(eventId: string): Promise<number>;
  /** Called from the heartbeat: injects a one-time reminder per overdue obligation. */
  checkDeadlines(): Promise<void>;
  /** Called from the heartbeat: fires any scheduled wake whose time has come.
   *  Local-fs backend only — the Restate backend fires independently via
   *  the companion service's own durable timer + runner. */
  checkSchedules(): Promise<void>;
}

export function createInbox(store: ThreadStore, pi: ExtensionAPI): Inbox {
  async function isTargetLive(to: string): Promise<boolean> {
    const s = await store.adapter.loadState(to);
    if (!s) return false;
    return s.status === "running" && Date.now() - new Date(s.lastSeen).getTime() < STALE_MS;
  }

  async function resolveTargets(to: string): Promise<string[]> {
    if (to !== "*" && !to.startsWith("role:") && !to.includes(",")) return [to];
    const all = (await store.listThreads()).filter(t => t.id !== store.threadId);
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

  async function sendCrossThread(
    to: string,
    type: MessageType,
    body: string,
    opts: { requestId?: string; delivery?: "steer" | "follow-up"; deadline?: string } = {},
  ): Promise<SendResult> {
    if (!store.threadId || !store.threadsRootDir) {
      // Without an identity the message would land at a cwd-relative path
      // nothing ever drains (observed in the wild as <cwd>/<to>/inbox/).
      throw new Error("Thread system not initialized yet — cannot send.");
    }
    const requestId = opts.requestId ?? mintId(`${type.toLowerCase()}.${store.threadId}`);
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

    const delivered = (await isTargetLive(to)) ? "live" : "queued";
    await store.adapter.enqueueMessage(to, msg);

    if (to === store.lockPartner) {
      store.sentToPartnerThisTurn = true;
      store.nudgedSinceLastSend = false;
    }

    if (type === "Answer" || type === "Result") {
      // Sending the reply settles the durable owed-reply record made when the
      // Brief/Question/Blocker was delivered (see deliver()).
      const before = store.owed.length;
      store.owed = store.owed.filter(o => o.requestId !== requestId);
      if (store.owed.length !== before) await store.writeFile();
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
      await store.writeFile();
    }
    return { requestId, delivered };
  }

  async function fireSubscribers(eventId: string): Promise<number> {
    const fired = store.subscriptions.filter(s => s.eventId === eventId);
    for (const sub of fired) {
      pi.sendUserMessage(sub.message, {
        deliverAs: sub.delivery === "steer" ? "steer" : "followUp",
      });
    }
    store.subscriptions = store.subscriptions.filter(s => s.eventId !== eventId);
    await store.writeFile();
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

  async function deliver(msg: InboxMessage, ctx: ExtensionContext): Promise<void> {
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
        await store.transition("open", ctx);
      }
      await fireSubscribers(msg.requestId);
      barrierNotes = resolveBarriers(msg.requestId);
    }

    if (msg.type === "Brief" || msg.type === "Question" || msg.type === "Blocker") {
      // Record the reply this thread now owes, durably: the envelope (and its
      // requestId, which the eventual Result/Answer must echo) exists only in
      // the receiving session's context — without this record, a thread
      // revived after a restart has no protocol-level way to recover the id.
      // Sync is excluded: its reply is produced by thread_sync_close via the
      // lock, and sync locks are deliberately not durable.
      if (!store.owed.some(o => o.requestId === msg.requestId)) {
        store.owed.push({
          requestId: msg.requestId,
          type: msg.type,
          from: msg.from,
          summary: msg.body.slice(0, 80),
          receivedAt: msg.sentAt,
        });
      }
    }

    if (msg.type === "Sync") {
      if (store.lockEventId) {
        // Already locked — reject as an Answer so the requester's own lock
        // (keyed to this requestId) unwinds instead of hanging forever.
        await sendCrossThread(
          msg.from,
          "Answer",
          `Rejected sync: ${store.threadId} is already in sync with ${store.lockPartner ?? "another thread"}. Try again later or subscribe to my current lock.`,
          { requestId: msg.requestId },
        );
        await store.writeFile();
        return;
      }
      store.lockEventId = msg.requestId;
      store.lockPartner = msg.from;
      store.lockType = "sync";
      await store.transition("in-sync", ctx);
    }

    const extra = barrierNotes.length ? "\n\n" + barrierNotes.join("\n") : "";
    pi.sendUserMessage(renderEnvelope(msg) + extra, {
      deliverAs: msg.delivery === "steer" ? "steer" : "followUp",
    });
    await store.writeFile();
  }

  async function drainInbox(ctx: ExtensionContext): Promise<void> {
    // On Hold means "don't wake me": messages stay queued until resume.
    if (store.state === "on-hold") return;
    const messages = await store.adapter.drainInbox(store.threadId);
    for (const msg of messages) {
      await deliver(msg, ctx);
    }
  }

  async function checkDeadlines(): Promise<void> {
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
    if (changed) await store.writeFile();
  }

  async function checkSchedules(): Promise<void> {
    const now = Date.now();
    // Fired wakes are pruned, not kept — otherwise thread_status accumulates
    // "(fired)" entries forever. Already-nudged entries (the Restate service
    // fired them while this process was down and it spawned us with the
    // reason as the prompt) are pruned too, without re-firing.
    const due = store.schedules.filter(w => !w.nudged && new Date(w.fireAt).getTime() <= now);
    const keep = store.schedules.filter(w => !w.nudged && new Date(w.fireAt).getTime() > now);
    if (keep.length === store.schedules.length) return;
    store.schedules = keep;
    for (const w of due) {
      pi.sendUserMessage(`[scheduled wake #${w.id}]: ${w.reason}`, { deliverAs: "steer" });
    }
    await store.writeFile();
  }

  return {
    sendCrossThread,
    resolveTargets,
    deliver,
    drainInbox,
    isTargetLive,
    fireSubscribers,
    checkDeadlines,
    checkSchedules,
  };
}
