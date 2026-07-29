import type { Barrier, Obligation, OwedReply, ThreadSummary } from "./types";

/** One thread per line — shared by thread_list and /thread-list. Coordination
 *  counts appear only when non-zero, so idle threads stay one short line. */
export function formatThreadLine(t: ThreadSummary): string {
  const load = [
    t.obligations ? `obligations=${t.obligations}` : "",
    t.owed ? `owed=${t.owed}` : "",
    t.barriers ? `barriers=${t.barriers}` : "",
  ]
    .filter(Boolean)
    .join(" ");
  return `${t.id.padEnd(16)} [${t.state}]  ${t.status}  role=${t.role ?? "-"}  parent=${t.parent ?? "-"}${load ? `  ${load}` : ""}  lastSeen=${t.lastSeen}`;
}

/** Status-section list: indented bullets, or " none" inline when empty. */
function itemize<T>(items: T[], render: (item: T) => string): string {
  return items.length ? "\n" + items.map(i => `  - ${render(i)}`).join("\n") : " none";
}

export function obligationLines(obligations: Obligation[]): string {
  return itemize(
    obligations,
    o =>
      `request to ${o.to} #${o.id} "${o.summary}"${o.deadline ? ` (deadline ${o.deadline})` : ""}`,
  );
}

export function barrierLines(barriers: Barrier[]): string {
  return itemize(
    barriers,
    b =>
      `${b.id} (${b.mode}) pending: ${b.pending.join(", ")}${b.deadline ? ` (deadline ${b.deadline})` : ""}`,
  );
}

export function owedLines(owed: OwedReply[]): string {
  return itemize(
    owed,
    o =>
      `you owe a reply to ${o.from} for their request #${o.id} "${o.summary}" — reply with re="${o.id}"`,
  );
}
