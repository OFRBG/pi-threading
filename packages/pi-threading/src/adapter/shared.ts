import { ulid } from "../core/ids";

/** Helpers shared by every storage binding, so the observable semantics each
 *  one must reproduce (FIFO-by-tail ordering, enqueue idempotence, the
 *  deliverAfter/expiresAt gates) are defined once here rather than re-derived
 *  — subtly differently — in local-fs / redis / mongo / http. */

/** The envelope id's ULID tail: `<from>/<ulid>` → `<ulid>`. Stripping the
 *  sender prefix is what makes a lexical sort of tails a FIFO-by-send-time
 *  order *across* senders — ULIDs are fixed-width, time-sortable strings
 *  (§6.2) — rather than an order that groups by sender first. Every binding
 *  orders its inbox by this key. */
export function mailIdTail(id: string): string {
  return id.includes("/") ? id.slice(id.lastIndexOf("/") + 1) : id;
}

/** The tail reduced to a filesystem-/key-safe token (falls back to a fresh
 *  ULID if the id sanitizes away to nothing). Used where the tail becomes a
 *  storage key — local-fs's filename, redis's hash field — so a retried send
 *  with the same id lands on the same key: enqueue idempotence (§7.6). */
export function safeMailKey(id: string): string {
  const tail = mailIdTail(id).replace(/[^A-Za-z0-9._-]/g, "_");
  return tail || ulid();
}

// The gates only read the two timing fields, so they take a structural
// subset rather than a full `Mail` — this lets the mongo binding pass its
// stored `MailDoc` (which carries `_id`, not `id`) straight through.

/** Whether an envelope is due for delivery now (§6 deliverAfter): a future
 *  `deliverAfter` keeps it queued until the instant passes. `nowMs` is
 *  `Date.now()`-style epoch millis. */
export function isMailDue(mail: { deliverAfter?: string }, nowMs: number): boolean {
  return !mail.deliverAfter || new Date(mail.deliverAfter).getTime() <= nowMs;
}

/** Whether an envelope is past its expiry (Rev 10 §6 expiresAt): claimed for
 *  audit but never delivered. */
export function isMailExpired(mail: { expiresAt?: string }, nowMs: number): boolean {
  return Boolean(mail.expiresAt) && new Date(mail.expiresAt as string).getTime() <= nowMs;
}
