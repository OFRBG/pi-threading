import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import type { ThreadStore, MessageType, InboxMessage } from "./core/types";
import { DEFAULT_DELIVERY, OBLIGATION_TYPES, STALE_MS } from "./core/types";

export interface Inbox {
  sendCrossThread(
    to: string,
    type: MessageType,
    body: string,
    opts?: { requestId?: string; delivery?: "steer" | "follow-up" },
  ): { requestId: string; delivered: "queued" | "live" };
  deliver(msg: InboxMessage, ctx: ExtensionContext): void;
  drainInbox(ctx: ExtensionContext): void;
  isTargetLive(to: string): boolean;
  fireSubscribers(eventId: string): number;
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

  function sendCrossThread(
    to: string,
    type: MessageType,
    body: string,
    opts: { requestId?: string; delivery?: "steer" | "follow-up" } = {},
  ): { requestId: string; delivered: "queued" | "live" } {
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

    if (OBLIGATION_TYPES.has(type)) {
      store.obligations.push({
        requestId,
        type: type as "Brief" | "Question" | "Sync",
        to,
        summary: body.slice(0, 80),
        sentAt: msg.sentAt,
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

  function deliver(msg: InboxMessage, ctx: ExtensionContext) {
    if (msg.type === "Answer" || msg.type === "Result") {
      store.obligations = store.obligations.filter(o => o.requestId !== msg.requestId);
      if (store.state === "listening" && store.lockEventId === msg.requestId) {
        store.lockEventId = null;
        store.transition("open", ctx);
      }
      fireSubscribers(msg.requestId);
    }

    if (msg.type === "Sync") {
      if (store.lockEventId) {
        // Already in-sync — reject instead of silently dropping.
        sendCrossThread(
          msg.from,
          "Note",
          `Rejected sync: already in-sync with ${store.lockPartner ?? "another thread"}.`,
          { requestId: msg.requestId },
        );
        store.writeFile();
        return;
      }
      store.lockEventId = msg.requestId;
      store.lockPartner = msg.from;
      store.transition("in-sync", ctx);
    }

    pi.sendUserMessage(`[${msg.type} from ${msg.from}]: ${msg.body}`, {
      deliverAs: msg.delivery === "steer" ? "steer" : "followUp",
    });
    store.writeFile();
  }

  function drainInbox(ctx: ExtensionContext) {
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

  return { sendCrossThread, deliver, drainInbox, isTargetLive, fireSubscribers };
}
