import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { ThreadStore, MessageType, InboxMessage, Delivery } from "./core/types";
import { DEFAULT_DELIVERY, isObligationType, STALE_MS } from "./core/types";
import { mintId } from "./core/ids";
import { nowIso } from "./core/time";
import { acquireLock, releaseLock } from "./core/thread-ops";

/** The messaging engine: typed cross-thread sends and their bookkeeping
 *  (obligations, owed replies), delivery of incoming envelopes with barrier
 *  and lock resolution, and the heartbeat's deadline/schedule checks. */

/** How long after an idle-time injection we assume pi's prompt preflight is
 *  still running (it ends at turn_start, which clears the hold early). */
export const INJECTION_GRACE_MS = 3_000;
/** How long a compaction may hold the inbox shut before we assume its end
 *  event was swallowed (compaction failures emit no extension event). */
export const COMPACTION_HOLD_MAX_MS = 180_000;

/** One unit of text bound for this thread's own session. */
export interface Injection {
  text: string;
  delivery: Delivery;
}

export interface SendResult {
  requestId: string;
  delivered: "queued" | "live";
}

export interface SendOptions {
  requestId?: string;
  delivery?: Delivery;
  deadline?: string;
}

export interface Inbox {
  sendCrossThread(
    to: string,
    type: MessageType,
    body: string,
    opts?: SendOptions,
  ): Promise<SendResult>;
  /** sendCrossThread over a resolved target list, collecting per-target results. */
  sendToMany(
    targets: string[],
    type: MessageType,
    body: string,
    opts?: SendOptions,
  ): Promise<(SendResult & { to: string })[]>;
  /** Expand a `to` spec — "*", "role:<role>", or comma-separated ids — into thread ids. */
  resolveTargets(to: string): Promise<string[]>;
  /** Which of these ids have never run in this workspace (likely typos). */
  findMissingTargets(targets: string[]): Promise<string[]>;
  /** Bookkeeping for one envelope (locks, owed, barriers) — returns the
   *  injection parts; the caller batches them into one inject(). */
  deliver(msg: InboxMessage, ctx: ExtensionContext): Promise<Injection[]>;
  /** Drain queued envelopes. Standalone (no `collect`) it injects its own
   *  batch; when the heartbeat passes a shared `collect` array it pushes its
   *  parts there instead, so all three heartbeat sources ship in one inject(). */
  drainInbox(ctx: ExtensionContext, collect?: Injection[]): Promise<void>;
  isTargetLive(to: string): Promise<boolean>;
  fireSubscribers(eventId: string): Promise<{ notified: number; parts: Injection[] }>;
  /** Called from the heartbeat: a one-time reminder per overdue obligation.
   *  With `collect`, pushes parts into the shared batch instead of injecting. */
  checkDeadlines(ctx: ExtensionContext, collect?: Injection[]): Promise<void>;
  /** Called from the heartbeat: fires any scheduled wake whose time has come.
   *  Local-fs backend only — the Restate backend fires independently via
   *  the companion service's own durable timer + runner. With `collect`,
   *  pushes parts into the shared batch instead of injecting. */
  checkSchedules(ctx: ExtensionContext, collect?: Injection[]): Promise<void>;
  /** Push parts into this session as ONE user message (steer if any part is). */
  inject(parts: Injection[], ctx: ExtensionContext): void;
  /** False while an idle-time injection is in preflight or a compaction is
   *  running — drains and nudges wait (messages stay durable on disk). */
  canInject(): boolean;
  noteCompactionStart(): void;
  noteCompactionEnd(): void;
  /** A turn started: pi is streaming, so injections queue safely again. */
  noteRunStarted(): void;
}

export function createInbox(store: ThreadStore, pi: ExtensionAPI): Inbox {
  // --- injection gate ----------------------------------------------------
  // pi.sendUserMessage during a run queues safely (pi drains its queues at
  // turn boundaries and after agent_end handlers). While idle it starts a
  // new run after an async preflight, and two of those in flight race — the
  // loser throws "Agent is already processing" and its message is dropped.
  // Worse, during auto-compaction the agent *looks* idle, so an injection
  // starts a run that races the compaction's context rewrite. The gate
  // serializes idle injections and holds the drain shut during compaction;
  // gated messages stay durable on disk and are retried from the watcher,
  // turn boundaries, and the heartbeat.
  let inFlightSince: number | null = null;
  let compactingSince: number | null = null;

  function canInject(): boolean {
    const now = Date.now();
    if (compactingSince !== null && now - compactingSince < COMPACTION_HOLD_MAX_MS) return false;
    if (inFlightSince !== null && now - inFlightSince < INJECTION_GRACE_MS) return false;
    return true;
  }

  function inject(parts: Injection[], ctx: ExtensionContext): void {
    if (parts.length === 0) return;
    // One coalesced message per batch: a steer anywhere makes the whole
    // batch urgent; follow-up parts just arrive a little earlier than they
    // had to, which is harmless.
    const steer = parts.some(p => p.delivery === "steer");
    if (ctx.isIdle?.() ?? false) inFlightSince = Date.now();
    pi.sendUserMessage(parts.map(p => p.text).join("\n\n"), {
      deliverAs: steer ? "steer" : "followUp",
    });
  }

  function noteCompactionStart(): void {
    compactingSince = Date.now();
  }

  function noteCompactionEnd(): void {
    compactingSince = null;
  }

  function noteRunStarted(): void {
    inFlightSince = null;
    compactingSince = null;
  }

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
    opts: SendOptions = {},
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
      sentAt: nowIso(),
    };

    const delivered = (await isTargetLive(to)) ? "live" : "queued";
    await store.adapter.enqueueMessage(to, msg);

    if (to === store.lockPartner) {
      store.sentToPartnerThisTurn = true;
      store.nudgedSinceLastSend = false;
    }

    if (type === "Answer" || type === "Result") {
      // Sending the reply settles the durable owed-reply record made when the
      // Brief/Question/Blocker was delivered (see deliver()) — but ONLY when it
      // actually reaches the thread the debt is owed to. A misdirected or stale
      // reply whose requestId merely collides with an unrelated owed entry must
      // not discharge it: the conservation law (§2) would be violated — b's
      // ledger would say the debt is gone while a never received the reply. The
      // owed record stays put so thread_status and the owed-reply nudge keep
      // surfacing it. (thread_send layers a soft warning on top; this is the
      // real gate.) Sync is excluded from OwedType, so it never appears here.
      const owedMatch = store.owed.find(o => o.requestId === requestId);
      if (owedMatch && owedMatch.from === to) {
        store.owed = store.owed.filter(o => o.requestId !== requestId);
        await store.persist();
      }
    }

    if (isObligationType(type)) {
      store.obligations.push({
        requestId,
        type,
        to,
        summary: body.slice(0, 80),
        sentAt: msg.sentAt,
        ...(opts.deadline ? { deadline: opts.deadline } : {}),
      });
      await store.persist();
    }
    return { requestId, delivered };
  }

  async function sendToMany(
    targets: string[],
    type: MessageType,
    body: string,
    opts: SendOptions = {},
  ): Promise<(SendResult & { to: string })[]> {
    const sent: (SendResult & { to: string })[] = [];
    for (const to of targets) {
      sent.push({ to, ...(await sendCrossThread(to, type, body, opts)) });
    }
    return sent;
  }

  async function findMissingTargets(targets: string[]): Promise<string[]> {
    const missing: string[] = [];
    for (const t of targets) {
      if (!(await store.threadExists(t))) missing.push(t);
    }
    return missing;
  }

  async function fireSubscribers(
    eventId: string,
  ): Promise<{ notified: number; parts: Injection[] }> {
    const fired = store.subscriptions.filter(s => s.eventId === eventId);
    if (fired.length === 0) return { notified: 0, parts: [] };
    store.subscriptions = store.subscriptions.filter(s => s.eventId !== eventId);
    await store.persist();
    return {
      notified: fired.length,
      parts: fired.map(s => ({ text: s.message, delivery: s.delivery })),
    };
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

  async function deliver(msg: InboxMessage, ctx: ExtensionContext): Promise<Injection[]> {
    const parts: Injection[] = [];
    let barrierNotes: string[] = [];
    if (msg.type === "Answer" || msg.type === "Result") {
      store.obligations = store.obligations.filter(o => o.requestId !== msg.requestId);
      // A matching Answer releases the lock no matter which state we're in:
      // "listening" (Question/Blocker), "in-sync" (partner closed or rejected
      // the sync), or "open"/"done" (reply landed between turns).
      if (store.lockEventId === msg.requestId) {
        await releaseLock(store, ctx);
      }
      parts.push(...(await fireSubscribers(msg.requestId)).parts);
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
        await store.persist();
        return [];
      }
      await acquireLock(store, msg.requestId, msg.from, "sync", ctx);
    }

    const extra = barrierNotes.length ? "\n\n" + barrierNotes.join("\n") : "";
    parts.push({ text: renderEnvelope(msg) + extra, delivery: msg.delivery });
    await store.persist();
    return parts;
  }

  /** Ship a gathered batch: push into the heartbeat's shared array when one is
   *  given (so the three sources coalesce into a single inject() per tick),
   *  otherwise inject it now (the standalone watcher/turn/command call sites). */
  function emit(parts: Injection[], ctx: ExtensionContext, collect?: Injection[]): void {
    if (collect) collect.push(...parts);
    else inject(parts, ctx);
  }

  async function drainInbox(ctx: ExtensionContext, collect?: Injection[]): Promise<void> {
    // On Hold means "don't wake me": messages stay queued until resume.
    if (store.state === "on-hold") return;
    if (!canInject()) return; // stays on disk; watcher/turn-end/heartbeat retry
    const messages = await store.adapter.drainInbox(store.threadId);
    const parts: Injection[] = [];
    for (const msg of messages) {
      parts.push(...(await deliver(msg, ctx)));
    }
    emit(parts, ctx, collect);
  }

  async function checkDeadlines(ctx: ExtensionContext, collect?: Injection[]): Promise<void> {
    if (!canInject()) return; // nudges re-arm on a later heartbeat tick
    const now = Date.now();
    const parts: Injection[] = [];
    for (const ob of store.obligations) {
      if (!ob.deadline || ob.nudged || new Date(ob.deadline).getTime() > now) continue;
      ob.nudged = true;
      parts.push({
        text: `[obligation overdue #${ob.requestId}]: your ${ob.type} to ${ob.to} ("${ob.summary}") passed its deadline with no reply. Follow up with ${ob.to}${store.parent ? `, or escalate a Blocker to ${store.parent}` : ""}.`,
        delivery: "steer",
      });
    }
    for (const b of store.barriers) {
      if (!b.deadline || b.nudged || new Date(b.deadline).getTime() > now) continue;
      b.nudged = true;
      parts.push({
        text: `[barrier overdue "${b.id}"]: still waiting on ${b.mode} of ${b.pending.length} repl${b.pending.length === 1 ? "y" : "ies"} (${b.pending.join(", ")}) — none arrived by the deadline. Check in with the target thread(s), or the barrier will keep waiting silently.`,
        delivery: "steer",
      });
    }
    if (parts.length === 0) return;
    await store.persist();
    emit(parts, ctx, collect);
  }

  async function checkSchedules(ctx: ExtensionContext, collect?: Injection[]): Promise<void> {
    if (!canInject()) return; // wakes stay armed; next heartbeat retries
    const now = Date.now();
    // Fired wakes are pruned, not kept — otherwise thread_status accumulates
    // "(fired)" entries forever. Already-nudged entries (the Restate service
    // fired them while this process was down and it spawned us with the
    // reason as the prompt) are pruned too, without re-firing.
    const due = store.schedules.filter(w => !w.nudged && new Date(w.fireAt).getTime() <= now);
    const keep = store.schedules.filter(w => !w.nudged && new Date(w.fireAt).getTime() > now);
    if (keep.length === store.schedules.length) return;
    store.schedules = keep;
    await store.persist();
    emit(
      due.map(w => ({
        text: `[scheduled wake #${w.id}]: ${w.reason}`,
        delivery: "steer" as const,
      })),
      ctx,
      collect,
    );
  }

  return {
    sendCrossThread,
    sendToMany,
    resolveTargets,
    findMissingTargets,
    deliver,
    drainInbox,
    isTargetLive,
    fireSubscribers,
    checkDeadlines,
    checkSchedules,
    inject,
    canInject,
    noteCompactionStart,
    noteCompactionEnd,
    noteRunStarted,
  };
}
