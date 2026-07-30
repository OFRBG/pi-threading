// Right panel: shows detailed information for the selected thread.

import blessed from "blessed";
import type { Widgets } from "blessed";
import type { ThreadDetail, ThreadSummary } from "../types.js";
import { STATE_COLORS, STATE_DOTS, STALE_MS } from "../types.js";

export class DetailPanel {
  private box: Widgets.BoxElement;
  private content: Widgets.BoxElement;
  private currentId: string | null = null;

  constructor(parent: Widgets.Screen) {
    this.box = blessed.box({
      parent,
      label: " Detail ",
      top: 1,
      right: 0,
      width: "60%",
      bottom: 1,
      border: { type: "line" },
      style: {
        border: { fg: "cyan" },
      },
      scrollable: true,
      keys: true,
      vi: true,
      tags: true,
      scrollbar: {
        ch: "│",
        style: { fg: "bright-black" },
      },
    });

    this.content = blessed.box({
      parent: this.box,
      top: 0,
      left: 1,
      width: "100%-2",
      height: "100%-2",
      content: "Select a thread to inspect\n\n↑↓ navigate\nEnter to select",
      tags: true,
    });
  }

  /** Render the detail view for a thread. */
  show(summary: ThreadSummary | null, detail: ThreadDetail | null): void {
    this.currentId = detail?.summary.id ?? null;

    if (!summary && !detail) {
      this.content.setContent("Select a thread to inspect\n\n↑↓ navigate\nEnter to select");
      this.box.screen.render();
      return;
    }

    const s = detail ?? summary;
    if (!s) {
      this.content.setContent("No data available");
      this.box.screen.render();
      return;
    }

    const lines: string[] = [];

    // Discriminate: if it has a 'summary' field, it's a ThreadDetail
    const isDetail = "summary" in s;
    const ts: ThreadSummary = isDetail ? (s as ThreadDetail).summary : (s as ThreadSummary);

    const id = ts.id;
    const state = ts.state;
    const status = ts.status;
    const role = ts.role;
    const parent = ts.parent;
    const lastSeen = ts.lastSeen;

    const color = STATE_COLORS[state] ?? "white";
    const dot = STATE_DOTS[state] ?? "?";
    const stale = status === "running" && Date.now() - new Date(lastSeen).getTime() > STALE_MS;
    const statusStr = stale ? `${status} (stale ⚠)` : status;

    // Header
    lines.push(`{bold}${dot} {${color}-fg}${id}{/${color}-fg}{/bold}`);
    lines.push("");

    // Status block
    lines.push(`{bold}State:{/bold}     ${state}  (${statusStr})`);
    lines.push(`{bold}Role:{/bold}      ${role ?? "—"}`);
    lines.push(`{bold}Parent:{/bold}    ${parent ?? "—"}`);

    if ("holdReason" in s && s.holdReason) {
      lines.push(`{bold}Hold:{/bold}      ${s.holdReason}`);
    }
    lines.push(`{bold}Last Seen:{/bold}  ${this.relativeTime(lastSeen)}`);

    if ("pid" in s && s.pid) {
      lines.push(`{bold}PID:{/bold}        ${s.pid}`);
    }
    if ("startedAt" in s && s.startedAt) {
      lines.push(`{bold}Started:{/bold}    ${this.relativeTime(s.startedAt)}`);
    }

    // Only show rich detail when we have a ThreadDetail (not just a summary)
    if (isDetail) {
      const d = s as ThreadDetail;

      // Obligations
      lines.push("");
      lines.push(`{bold}{yellow-fg}Obligations{/yellow-fg} (${d.obligations.length}):{/bold}`);
      if (d.obligations.length === 0) {
        lines.push("  {bright-black-fg}(none){/bright-black-fg}");
      } else {
        for (const o of d.obligations) {
          const due = o.deadline ? ` — due ${this.dueIn(o.deadline)}` : "";
          lines.push(
            `  → {cyan-fg}${o.to}{/cyan-fg}: "${this.truncate(o.summary ?? "", 50)}"${due}`,
          );
        }
      }

      // Owed replies
      lines.push("");
      lines.push(`{bold}{red-fg}Owed Replies{/red-fg} (${d.owed.length}):{/bold}`);
      if (d.owed.length === 0) {
        lines.push("  {bright-black-fg}(none){/bright-black-fg}");
      } else {
        for (const o of d.owed) {
          lines.push(
            `  ← {magenta-fg}${o.from}{/magenta-fg}: "${this.truncate(o.summary ?? "", 50)}"`,
          );
        }
      }

      // Barriers
      lines.push("");
      lines.push(`{bold}{cyan-fg}Barriers{/cyan-fg} (${d.barriers.length}):{/bold}`);
      if (d.barriers.length === 0) {
        lines.push("  {bright-black-fg}(none){/bright-black-fg}");
      } else {
        for (const b of d.barriers) {
          const due = b.deadline ? ` — due ${this.dueIn(b.deadline)}` : "";
          lines.push(`  ${b.id} (${b.mode}): ${(b.pending ?? []).join(", ")}${due}`);
        }
      }

      // Journal
      lines.push("");
      lines.push(`{bold}{green-fg}Journal{/green-fg}:{/bold}`);
      if (d.journal) {
        const entries = d.journal.split(/\n(?=<!--)/).filter(Boolean);
        const lastFew = entries.slice(-5);
        for (const entry of lastFew) {
          for (const line of entry.trim().split("\n").slice(0, 3)) {
            lines.push(`  ${this.truncate(line, 70)}`);
          }
          lines.push("  {bright-black-fg}───{/bright-black-fg}");
        }
      } else {
        lines.push("  {bright-black-fg}(no journal entries){/bright-black-fg}");
      }
    }

    this.content.setContent(lines.join("\n"));
    this.box.setScrollPerc(0);
    this.box.screen.render();
  }

  getCurrentId(): string | null {
    return this.currentId;
  }

  focus(): void {
    this.box.focus();
  }

  private relativeTime(iso: string): string {
    if (!iso) {
      return "-";
    }
    const ms = Date.now() - new Date(iso).getTime();
    if (Number.isNaN(ms)) {
      return "-";
    }
    if (ms < 0) {
      return "0s ago";
    }
    const s = Math.floor(ms / 1000);
    if (s < 60) {
      return `${s}s ago`;
    }
    const m = Math.floor(s / 60);
    if (m < 60) {
      return `${m}m ago`;
    }
    const h = Math.floor(m / 60);
    return `${h}h ago`;
  }

  private dueIn(iso: string): string {
    if (!iso) {
      return "-";
    }
    const ms = Date.parse(iso) - Date.now();
    if (Number.isNaN(ms)) {
      return "-";
    }
    const abs = Math.abs(ms);
    const s = Math.floor(abs / 1000);
    const span =
      s < 60 ? `${s}s` : s < 3600 ? `${Math.floor(s / 60)}m` : `${Math.floor(s / 3600)}h`;
    return ms >= 0 ? `in ${span}` : `${span} overdue`;
  }

  private truncate(str: string, n: number): string {
    if (!str) {
      return "";
    }
    return str.length > n ? str.slice(0, n) + "…" : str;
  }
}
