import type { Barrier, Obligation, OwedReply, ScheduledWake, ThreadSummary } from "./types";

/** One thread per line — shared by thread_list and /thread-list. */
export function formatThreadLine(t: ThreadSummary): string {
  return `${t.id.padEnd(16)} [${t.state}]  ${t.status}  role=${t.role ?? "-"}  parent=${t.parent ?? "-"}  lastSeen=${t.lastSeen}`;
}

/** Status-section list: indented bullets, or " none" inline when empty. */
function itemize<T>(items: T[], render: (item: T) => string): string {
  return items.length ? "\n" + items.map(i => `  - ${render(i)}`).join("\n") : " none";
}

export function obligationLines(obligations: Obligation[]): string {
  return itemize(
    obligations,
    o =>
      `${o.type} to ${o.to} #${o.requestId} "${o.summary}"${o.deadline ? ` (deadline ${o.deadline})` : ""}`,
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
      `you owe ${o.type === "Brief" ? "a Result" : "an Answer"} to ${o.from} for their ${o.type} #${o.requestId} "${o.summary}" — echo that exact requestId`,
  );
}

export function scheduleLines(schedules: ScheduledWake[]): string {
  return itemize(
    schedules,
    w => `${w.id} at ${w.fireAt}: "${w.reason}"${w.nudged ? " (fired)" : ""}`,
  );
}
