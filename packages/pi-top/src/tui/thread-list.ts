// Left panel: a selectable list of threads with colored state indicators.

import blessed from "blessed";
import type { Widgets } from "blessed";
import type { ThreadSummary } from "../types";
import { STATE_COLORS, STATE_DOTS, STALE_MS } from "../types";

export interface ThreadListCallbacks {
  onSelect: (id: string) => void;
}

export class ThreadList {
  private box: Widgets.BoxElement;
  private list: Widgets.ListElement;
  private items: ThreadSummary[] = [];
  private selectedIndex = 0;

  constructor(parent: Widgets.Screen, callbacks: ThreadListCallbacks) {
    this.box = blessed.box({
      parent,
      label: " Threads ",
      top: 1,
      left: 0,
      width: "40%",
      bottom: 1,
      border: { type: "line" },
      style: {
        border: { fg: "cyan" },
      },
      scrollable: true,
      keys: true,
      vi: true,
    });

    this.list = blessed.list({
      parent: this.box,
      top: 0,
      left: 0,
      width: "100%-2",
      height: "100%-2",
      keys: true,
      vi: true,
      mouse: true,
      scrollbar: {
        ch: "│",
        style: { fg: "bright-black" },
      },
      style: {
        selected: {
          bg: "blue",
          fg: "white",
        },
        item: {
          fg: "white",
        },
      },
      items: [],
    });

    // Navigation
    this.list.key(["j", "down"], () => {
      this.list.down(1);
      this.selectedIndex = Math.min(this.selectedIndex + 1, this.items.length - 1);
      this.highlightSelected();
    });

    this.list.key(["k", "up"], () => {
      this.list.up(1);
      this.selectedIndex = Math.max(this.selectedIndex - 1, 0);
      this.highlightSelected();
    });

    this.list.key(["g"], () => {
      this.selectedIndex = 0;
      this.list.select(0);
      this.highlightSelected();
    });

    this.list.key(["G"], () => {
      this.selectedIndex = this.items.length - 1;
      this.list.select(this.selectedIndex);
      this.highlightSelected();
    });

    this.list.key(["enter"], () => {
      const selected = this.items[this.selectedIndex];
      if (selected) {
        callbacks.onSelect(selected.id);
      }
    });
  }

  /** Format a single thread row with state dot, id, state label, and relative time. */
  private formatRow(t: ThreadSummary): string {
    const dot = STATE_DOTS[t.state] ?? "?";
    const color = STATE_COLORS[t.state] ?? "white";
    const stateLabel = t.state.padEnd(8);
    const relTime = this.relativeTime(t.lastSeen);

    const stale = t.status === "running" && Date.now() - new Date(t.lastSeen).getTime() > STALE_MS;

    const statusMark = stale ? " ⚠" : "";

    // Use ANSI color codes inline since Blessed List items are plain text
    const colorCodes: Record<string, string> = {
      green: "\x1b[32m",
      yellow: "\x1b[33m",
      red: "\x1b[31m",
      cyan: "\x1b[36m",
      gray: "\x1b[90m",
      "bright-black": "\x1b[90m",
      white: "\x1b[37m",
    };
    const reset = "\x1b[0m";
    const c = colorCodes[color] ?? "";

    return `${c}${dot}${reset} ${t.id.padEnd(16)} ${c}${stateLabel}${reset} ${relTime}${statusMark}`;
  }

  /** Update the list with new thread data. Preserves selection if possible. */
  update(threads: ThreadSummary[]): void {
    const prevId = this.items[this.selectedIndex]?.id;
    this.items = threads;

    const items = threads.map(t => this.formatRow(t));
    this.list.setItems(items);

    // Try to restore selection
    if (prevId) {
      const idx = threads.findIndex(t => t.id === prevId);
      if (idx >= 0) {
        this.selectedIndex = idx;
      } else {
        this.selectedIndex = Math.min(this.selectedIndex, threads.length - 1);
      }
    } else {
      this.selectedIndex = 0;
    }

    this.list.select(this.selectedIndex);
    this.highlightSelected();
    this.box.screen.render();
  }

  private highlightSelected(): void {
    if (this.items.length > 0) {
      this.list.select(this.selectedIndex);
    }
  }

  /** Get the currently selected thread id, or null if list is empty. */
  getSelectedId(): string | null {
    return this.items[this.selectedIndex]?.id ?? null;
  }

  getSelectedSummary(): ThreadSummary | null {
    return this.items[this.selectedIndex] ?? null;
  }

  focus(): void {
    this.list.focus();
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
      return "0s";
    }
    const s = Math.floor(ms / 1000);
    if (s < 60) {
      return `${s}s`;
    }
    const m = Math.floor(s / 60);
    if (m < 60) {
      return `${m}m`;
    }
    const h = Math.floor(m / 60);
    return `${h}h`;
  }
}
