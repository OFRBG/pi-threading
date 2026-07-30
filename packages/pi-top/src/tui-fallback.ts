/**
 * tui-fallback.ts — minimal polling table fallback if the full Blessed TUI
 * isn't built yet. ANSI-clearing table, like pi-threading-cli watch.
 */

import type { DataProvider } from "./tui/app.js";
import { relTime } from "./types.js";

/** Spaced column pads. */
function padCol(str: string, w: number): string {
  return str.length >= w ? str : str + " ".repeat(w - str.length);
}

function render(store: DataProvider): string {
  const rows = store.getThreads();
  if (rows.length === 0) {
    return "\x1b[2J\x1b[HNo threads found.\n";
  }

  const headers = ["ID", "STATE", "STATUS", "ROLE", "PARENT", "OBLG", "OWED", "BARR", "LAST SEEN"];
  const data = rows.map(r => [
    r.id,
    r.state,
    r.status,
    r.role ?? "-",
    r.parent ?? "-",
    String(r.obligations),
    String(r.owed),
    String(r.barriers),
    relTime(r.lastSeen),
  ]);
  const widths = headers.map(
    (h, i) => Math.max(h.length, ...data.map(row => row[i].length), 0) + 2,
  );
  let out = "\x1b[2J\x1b[H"; // clear + home
  out += headers.map((h, i) => padCol(h, widths[i])).join("") + "\n";
  for (const row of data) {
    out += row.map((c, i) => padCol(c, widths[i])).join("") + "\n";
  }
  out += "\nCtrl-C to quit\n";
  return out;
}

export function startFallback(store: DataProvider, onExit: () => void): void {
  process.stdout.write(render(store));

  const timer = setInterval(() => {
    process.stdout.write(render(store));
  }, 2000);

  // SIGINT handler.
  process.once("SIGINT", () => {
    clearInterval(timer);
    process.stdout.write("\n");
    onExit();
  });
}
