// Right panel: shows detailed information for the selected thread.

import blessed from "blessed";
import type { Widgets } from "blessed";
import type { ThreadDetail, ThreadSummary } from "../types";
import { STATE_COLORS, STATE_DOTS, STALE_MS } from "../types";

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
    this.currentId = detail?.raw.id ?? null;

    if (!summary && !detail) {
      this.content.setContent("Select a thread to inspect\n\n↑↓ navigate\nEnter to select");
      this.box.screen.render();
      return;
    }

    const s = detail?.raw ?? summary;
    if (!s) {
      this.content.setContent("No data available");
      this.box.screen.render();
      return;
    }

    const lines: string[] = [];
    const color = STATE_COLORS[s.state] ?? "white";
    const dot = STATE_DOTS[s.state] ?? "?";

    // Header
    lines.push(`{bold}${dot} {#${color}-fg}${s.id}{/${color}-fg}{/bold}`);
    lines.push("");

    // Status block
    const stale =
      s.status === "running" &&
      Date.now() - new Date(s.lastSeen).getTime() > STALE_MS;
    const statusStr = stale ? `${s.status} (stale ⚠)` : s.status;

    lines.push(`{bold}State:{/bold}     ${s.state}  (${statusStr})`);
    lines.push(`{bold}Role:{/bold}      ${s.role ?? "—"}`);
    lines.push(`{bold}Parent:{/bold}    ${s.parent ?? "—"}`);
    if ("holdReason" in s && s.holdReason) {
      lines.push(`{bold}Hold:{/bold}      ${s.holdReason}`);
    }
    lines.push(`{bold}Last Seen:{/bold}  ${this.relativeTime(s.lastSeen)}`);
    lines.push(`{bold}Started:{/bold}    ${this.relativeTime(s.startedAt)}`);
    lines.push(`{bold}PID:{/bold}        ${"pid" in s ? s.pid : "—"}`);

    // Obligations
    lines.push("");
    lines.push(`{bold}{yellow-fg}Obligations{/yellow-fg} (${(s.obligations ?? []).length}):{/bold}`);
    const obligations: Array<{ to: string; summary: string; deadline?: string; sentAt: string }> =
      (s as any).obligations ?? [];
    if (obligations.length === 0) {
      lines.push("  {gray}(none){/gray}");
    } else {
      for (const o of obligations) {
        const due = o.deadline ? ` — due ${this.dueIn(o.deadline)}` : "";
        lines.push(
          `  → {cyan-fg}${o.to}{/cyan-fg}: "${this.truncate(o.summary ?? "", 50)}"${due}`,
        );
      }
    }

    // Owed replies
    lines.push("");
    lines.push(`{bold}{red-fg}Owed Replies{/red-fg} (${(s.owed ?? []).length}):{/bold}`);
    const owed: Array<{ from: string; summary: string; receivedAt: string }> = (s as any).owed ?? [];
    if (owed.length === 0) {
      lines.push("  {gray}(none){/gray}");
    } else {
      for (const o of owed) {
        lines.push(
          `  ← {magenta-fg}${o.from}{/magenta-fg}: "${this.truncate(o.summary ?? "", 50)}"`,
        );
      }
    }

    // Barriers
    lines.push("");
    lines.push(`{bold}{cyan-fg}Barriers{/cyan-fg} (${(s.barriers ?? []).length}):{/bold}`);
    const barriers: Array<{ id: string; mode: string; pending: string[]; deadline?: string }> =
      (s as any).barriers ?? [];
    if (barriers.length === 0) {
      lines.push("  {gray}(none){/gray}");
    } else {
      for (const b of barriers) {
        const due = b.deadline ? ` — due ${this.dueIn(b.deadline)}` : "";
        lines.push(`  ${b.id} (${b.mode}): ${(b.pending ?? []).join(", ")}${due}`);
      }
    }

    // Journal
    const journal = detail?.journal;
    lines.push("");
    lines.push(`{bold}{green-fg}Journal{/green-fg}:{/bold}`);
    if (journal) {
      const entries = journal.split(/\n(?=<!--)/).filter(Boolean);
      const lastFew = entries.slice(-5);
      for (const entry of lastFew) {
        for (const line of entry.trim().split("\n").slice(0, 3)) {
          lines.push(`  ${this.truncate(line, 70)}`);
        }
        lines.push("  {gray}───{/gray}");
      }
    } else {
      lines.push("  {gray}(no journal entries){/gray}");
    }

    this.content.setContent(lines.join("\n"));
    this.content.setScrollPerc(0);
    this.box.screen.render();
  }

  getCurrentId(): string | null {
    return this.currentId;
  }

  focus(): void {
    this.box.focus();
  }

  private relativeTime(iso: string): string {
    if (!iso) return "-";
    const ms = Date.now() - new Date(iso).getTime();
    if (Number.isNaN(ms)) return "-";
    if (ms < 0) return "0s ago";
    const s = Math.floor(ms / 1000);
    if (s < 60) return `${s}s ago`;
    const m = Math.floor(s / 60);
    if (m < 60) return `${m}m ago`;
    const h = Math.floor(m / 60);
    return `${h}h ago`;
  }

  private dueIn(iso: string): string {
    if (!iso) return "-";
    const ms = Date.parse(iso) - Date.now();
    if (Number.isNaN(ms)) return "-";
    const abs = Math.abs(ms);
    const s = Math.floor(abs / 1000);
    const span =
      s < 60 ? `${s}s` : s < 3600 ? `${Math.floor(s / 60)}m` : `${Math.floor(s / 3600)}h`;
    return ms >= 0 ? `in ${span}` : `${span} overdue`;
  }

  private truncate(str: string, n: number): string {
    if (!str) return "";
    return str.length > n ? str.slice(0, n) + "…" : str;
  }
}