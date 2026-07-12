import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { ThreadStore, Envelope, Urgency } from "./core/types";
import { DEFAULT_OBLIGATION_DEADLINE_MS, STALE_MS } from "./core/types";
import { mintEnvelopeId } from "./core/ids";
import { nowIso } from "./core/time";

/** The messaging engine (PROTOCOL-FORMALISM.md §§6–9): envelope sends and
 *  their bookkeeping (obligations, owed replies), delivery of incoming
 *  envelopes with barrier resolution, and the heartbeat's deadline checks. */

/** How long after an idle-time injection we assume pi's prompt preflight is
 *  still running (it ends at turn_start, which clears the hold early). */
export const INJECTION_GRACE_MS = 3_000;
/** How long a compaction may hold the inbox shut before we assume its end
 *  event was swallowed (compaction failures emit no extension event). */
export const COMPACTION_HOLD_MAX_MS = 180_000;

/** One unit of text bound for this thread's own session. */
export interface Injection {
  text: string;
  urgency: Urgency;
}

export interface SendResult {
  id: string;
  delivered: "queued" | "live";
}

export interface SendOptions {
  /** Reply correlation: discharges the debt on this envelope id (§9.1). */
  re?: string;
  /** Track a debt: the receiver owes a reply with re = this send's id. */
  expects?: boolean;
  urgency?: Urgency;
  /** Not deliverable before this instant — a self-addressed deliverAfter
   *  envelope is the protocol's scheduled wake (§12.2). */
  deliverAfter?: string;
  /** Obligation deadline; defaults per §9.2 when expects is set. */
  deadline?: string;
}

export interface Inbox {
  sendEnvelope(to: string, body: string, opts?: SendOptions): Promise<SendResult>;
  /** sendEnvelope over a resolved target list, collecting per-target results.
   *  Each target gets its own minted id, so fan-out replies stay
   *  individually correlatable. */
  sendToMany(
    targets: string[],
    body: string,
    opts?: SendOptions,
  ): Promise<(SendResult & { to: string })[]>;
  /** Expand a `to` spec — "*", "role:<role>", or comma-separated ids — into thread ids. */
  resolveTargets(to: string): Promise<string[]>;
  /** Which of these ids have never run in this workspace (likely typos). */
  findMissingTargets(targets: string[]): Promise<string[]>;
  /** Bookkeeping for one envelope (debts, barriers) — returns the
   *  injection parts; the caller batches them into one inject(). */
  deliver(msg: Envelope, ctx: ExtensionContext): Promise<Injection[]>;
  /** Drain queued envelopes. Standalone (no `collect`) it injects its own
   *  batch; when the heartbeat passes a shared `collect` array it pushes its
   *  parts there instead, so both heartbeat sources ship in one inject(). */
  drainInbox(ctx: ExtensionContext, collect?: Injection[]): Promise<void>;
  isTargetLive(to: string): Promise<boolean>;
  /** Called from the heartbeat: a one-time reminder per overdue obligation
   *  or barrier. With `collect`, pushes parts into the shared batch. */
  checkDeadlines(ctx: ExtensionContext, collect?: Injection[]): Promise<void>;
  /** Push parts into this session as ONE user message (steer if any part is
   *  urgency=high). */
  inject(parts: Injection[], ctx: ExtensionContext): void;
  /** False while an idle-time injection is in preflight or a compaction is
   *  running — drains and nudges wait (messages stay durable on disk). This
   *  is the §7.7 declare-and-shrink gate: we only claim envelopes when we
   *  can deliver them in the same tick. */
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
    // One coalesced message per batch (§7.5): a high-urgency part anywhere
    // makes the whole batch steer; low parts just arrive a little earlier
    // than they had to, which is harmless.
    const steer = parts.some(p => p.urgency === "high");
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

  async function sendEnvelope(
    to: string,
    body: string,
    opts: SendOptions = {},
  ): Promise<SendResult> {
    if (!store.threadId || !store.threadsRootDir) {
      // Without an identity the message would land at a cwd-relative path
      // nothing ever drains (observed in the wild as <cwd>/<to>/inbox/).
      throw new Error("Thread system not initialized yet — cannot send.");
    }
    const id = mintEnvelopeId(store.threadId);
    const msg: Envelope = {
      id,
      from: store.threadId,
      to,
      body,
      sentAt: nowIso(),
      ...(opts.re ? { re: opts.re } : {}),
      ...(opts.expects ? { expects: true as const } : {}),
      // Absence means "low" on the wire (§6) — only high is written.
      ...(opts.urgency === "high" ? { urgency: "high" as const } : {}),
      ...(opts.deliverAfter ? { deliverAfter: opts.deliverAfter } : {}),
    };

    const delivered = (await isTargetLive(to)) ? "live" : "queued";
    await store.adapter.enqueueMessage(msg);

    if (opts.re) {
      // Sending the reply settles the durable owed-reply record made when the
      // expects envelope was delivered (see deliver()) — but ONLY when it
      // actually reaches the thread the debt is owed to (§9.1, Errata 1). A
      // misdirected or stale reply whose `re` merely collides with an
      // unrelated owed entry must not discharge it: the owed record stays put
      // so thread_status and the owed-reply nudge keep surfacing it.
      // (thread_send layers a soft warning on top; this is the real gate.)
      const owedMatch = store.owed.find(o => o.id === opts.re);
      if (owedMatch && owedMatch.from === to) {
        store.owed = store.owed.filter(o => o.id !== opts.re);
        await store.persist();
      }
    }

    if (opts.expects) {
      // Every expects send SHOULD carry a deadline; when the caller omits
      // one the client MUST apply the fallback (§9.2) — without it,
      // checkDeadlines never fires and a silent counterparty means zero
      // automatic recovery.
      const deadline =
        opts.deadline ?? new Date(Date.now() + DEFAULT_OBLIGATION_DEADLINE_MS).toISOString();
      store.obligations.push({
        id,
        to,
        summary: body.slice(0, 80),
        sentAt: msg.sentAt,
        deadline,
      });
      await store.persist();
    }
    return { id, delivered };
  }

  async function sendToMany(
    targets: string[],
    body: string,
    opts: SendOptions = {},
  ): Promise<(SendResult & { to: string })[]> {
    const sent: (SendResult & { to: string })[] = [];
    for (const to of targets) {
      sent.push({ to, ...(await sendEnvelope(to, body, opts)) });
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

  /** Resolve any barriers waiting on this envelope id. Returns "resolved"
   *  notices (and any barrier payload messages, §12.1) to fold into the same
   *  wake-up as the envelope, rather than firing separate injections. */
  function resolveBarriers(re: string): { notes: string[]; payloads: Injection[] } {
    const remaining: typeof store.barriers = [];
    const notes: string[] = [];
    const payloads: Injection[] = [];
    for (const b of store.barriers) {
      if (!b.pending.includes(re)) {
        remaining.push(b);
        continue;
      }
      const pending = b.pending.filter(id => id !== re);
      const done = b.mode === "any" || pending.length === 0;
      if (done) {
        notes.push(
          `[barrier "${b.id}" resolved]: ${b.mode === "any" ? `first reply arrived (${re})` : "all awaited replies have arrived"}.`,
        );
        if (b.message) payloads.push({ text: b.message, urgency: "high" });
      } else {
        remaining.push({ ...b, pending });
      }
    }
    store.barriers = remaining;
    return { notes, payloads };
  }

  /** How the receiving agent sees an envelope. The id and the reply
   *  affordance must travel with the message — the model has no other way
   *  to learn the correlation id it must echo back. Kind is derived from
   *  field presence (§6.1), never a tag. */
  function renderEnvelope(msg: Envelope): string {
    const kind =
      msg.expects && msg.re ? "reply+request" : msg.expects ? "request" : msg.re ? "reply" : "note";
    const reTag = msg.re ? ` re #${msg.re}` : "";
    const header = `[${kind} from ${msg.from} #${msg.id}${reTag}]`;
    const hint = msg.expects
      ? `\n(this expects a reply — send it with: thread_send to="${msg.from}" re="${msg.id}")`
      : "";
    return `${header}\n${msg.body}${hint}`;
  }

  async function deliver(msg: Envelope, _ctx: ExtensionContext): Promise<Injection[]> {
    const parts: Injection[] = [];
    let barrierNotes: string[] = [];

    if (msg.re) {
      // A reply discharges the sender-side debt keyed by `re` (§9)...
      store.obligations = store.obligations.filter(o => o.id !== msg.re);
      // ...and resolves any barriers armed over it (§12.1).
      const resolved = resolveBarriers(msg.re);
      barrierNotes = resolved.notes;
      parts.push(...resolved.payloads);
    }

    if (msg.expects) {
      // Record the reply this thread now owes, durably: the envelope (and
      // its id, which the eventual reply must echo) exists only in the
      // receiving session's context — without this record, a thread revived
      // after a restart has no protocol-level way to recover the id.
      if (!store.owed.some(o => o.id === msg.id)) {
        store.owed.push({
          id: msg.id,
          from: msg.from,
          summary: msg.body.slice(0, 80),
          receivedAt: msg.sentAt,
        });
      }
    }

    const extra = barrierNotes.length ? "\n\n" + barrierNotes.join("\n") : "";
    parts.push({ text: renderEnvelope(msg) + extra, urgency: msg.urgency ?? "low" });
    await store.persist();
    return parts;
  }

  /** Ship a gathered batch: push into the heartbeat's shared array when one is
   *  given (so all sources coalesce into a single inject() per tick, §7.5),
   *  otherwise inject it now (the standalone watcher/turn/command call sites). */
  function emit(parts: Injection[], ctx: ExtensionContext, collect?: Injection[]): void {
    if (collect) collect.push(...parts);
    else inject(parts, ctx);
  }

  async function drainInbox(ctx: ExtensionContext, collect?: Injection[]): Promise<void> {
    // On Hold means "don't wake me": messages stay queued until resume.
    if (store.state === "on-hold") return;
    // §7.7 declare-and-shrink: never claim an envelope we can't deliver in
    // this same tick — while the gate is closed everything stays durable on
    // disk; watcher/turn-end/heartbeat retry.
    if (!canInject()) return;
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
        text: `[obligation overdue #${ob.id}]: your request to ${ob.to} ("${ob.summary}") passed its deadline with no reply. Follow up with ${ob.to}${store.parent ? `, or escalate to ${store.parent}` : ""}.`,
        urgency: "high",
      });
    }
    for (const b of store.barriers) {
      if (!b.deadline || b.nudged || new Date(b.deadline).getTime() > now) continue;
      b.nudged = true;
      parts.push({
        text: `[barrier overdue "${b.id}"]: still waiting on ${b.mode} of ${b.pending.length} repl${b.pending.length === 1 ? "y" : "ies"} (${b.pending.join(", ")}) — none arrived by the deadline. Check in with the target thread(s), or the barrier will keep waiting silently.`,
        urgency: "high",
      });
    }
    if (parts.length === 0) return;
    await store.persist();
    emit(parts, ctx, collect);
  }

  return {
    sendEnvelope,
    sendToMany,
    resolveTargets,
    findMissingTargets,
    deliver,
    drainInbox,
    isTargetLive,
    checkDeadlines,
    inject,
    canInject,
    noteCompactionStart,
    noteCompactionEnd,
    noteRunStarted,
  };
}
