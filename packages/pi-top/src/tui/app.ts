// Main TUI application: sets up the Blessed screen, keyboard shortcuts,
// status bar, and wires the thread list + detail panel together.

import blessed from "blessed";
import type { Widgets } from "blessed";
import { ThreadList } from "./thread-list";
import { DetailPanel } from "./detail-panel";
import type { ThreadSummary, ThreadDetail } from "../types";

export interface DataProvider {
  getThreads(): ThreadSummary[];
  getThread(id: string): ThreadDetail | null;
  getJournal(id: string): string | null;
  onUpdate(cb: () => void): void;
}

export class App {
  private screen: Widgets.Screen;
  private header: Widgets.BoxElement;
  private footer: Widgets.BoxElement;
  private threadList: ThreadList;
  private detailPanel: DetailPanel;
  private dataProvider: DataProvider;
  private onQuit: (() => void) | null;
  private running = false;
  private helpVisible = false;
  private helpBox: Widgets.BoxElement | null = null;

  constructor(dataProvider: DataProvider, onQuit: (() => void) | null = null) {
    this.onQuit = onQuit;
    this.dataProvider = dataProvider;

    this.screen = blessed.screen({
      smartCSR: true,
      title: "pi-top — Thread Dashboard",
      cursor: {
        artificial: true,
        shape: "line",
        blink: true,
        color: "white",
      },
      dockBorders: true,
      fullUnicode: true,
      autoPadding: true,
    });

    // Header bar
    this.header = blessed.box({
      parent: this.screen,
      top: 0,
      left: 0,
      width: "100%",
      height: 1,
      content: " pi-top — Thread Dashboard ",
      style: {
        bg: "blue",
        fg: "white",
        bold: true,
      },
    });

    // Footer / status bar
    this.footer = blessed.box({
      parent: this.screen,
      bottom: 0,
      left: 0,
      width: "100%",
      height: 1,
      content: " ↑↓/j/k navigate  Enter inspect  ? help  q quit ",
      tags: true,
      style: {
        bg: "black",
        fg: "white",
      },
    });

    // Thread list (left panel)
    this.threadList = new ThreadList(this.screen, {
      onSelect: (id: string) => {
        this.showDetail(id);
      },
    });

    // Detail panel (right panel)
    this.detailPanel = new DetailPanel(this.screen);

    // Keyboard shortcuts
    this.screen.key(["q", "C-c"], () => {
      this.quit();
    });

    this.screen.key(["/"], () => {
      // Focus search — for now focus the list
      this.threadList.focus();
    });

    this.screen.key(["?", "h"], () => {
      this.toggleHelp();
    });

    this.screen.key(["r"], () => {
      this.refresh();
    });

    this.screen.key(["tab"], () => {
      // Toggle focus between panels (future: search bar)
      this.threadList.focus();
    });

    this.screen.key(["enter"], () => {
      const selected = this.threadList.getSelectedId();
      if (selected) {
        this.showDetail(selected);
      }
    });

    // Handle SIGWINCH (terminal resize)
    this.screen.on("resize", () => {
      this.screen.render();
    });

    // Register for data updates
    this.dataProvider.onUpdate(() => {
      this.refresh();
    });

    // Initial render
    this.refresh();
    this.threadList.focus();
    this.screen.render();
  }

  /** Start the TUI event loop. */
  start(): void {
    this.running = true;
    // Blessed renders in its own event loop — we just need to keep the
    // process alive. The DataProvider's onUpdate callback will trigger
    // re-renders.
  }

  /** Stop the TUI and clean up. */
  quit(): void {
    this.running = false;
    this.screen.destroy();
    this.onQuit?.();
  }

  /** Refresh all panels from the data provider. */
  refresh(): void {
    const threads = this.dataProvider.getThreads();
    this.threadList.update(threads);

    // Update detail panel if a thread is selected
    const selectedId = this.threadList.getSelectedId();
    if (selectedId) {
      this.showDetail(selectedId);
    } else if (threads.length > 0) {
      // Auto-select the first thread
      const first = threads[0];
      this.showDetail(first.id);
    }

    // Update footer with thread count
    const running = threads.filter(t => t.status === "running").length;
    this.footer.setContent(
      ` {bold}${threads.length}{/bold} threads (${running} running)  ↑↓/j/k navigate  Enter inspect  ? help  q quit `,
    );

    this.screen.render();
  }

  /** Show detail for a specific thread id. */
  private showDetail(id: string): void {
    const summary = this.dataProvider.getThreads().find(t => t.id === id) ?? null;
    const detail = this.dataProvider.getThread(id);
    // Attach journal if available from the data provider.
    if (detail) {
      const journal = this.dataProvider.getJournal(id);
      if (journal) {
        detail.journal = journal;
      }
    }
    this.detailPanel.show(summary, detail);
  }

  /** Toggle the help overlay. */
  private toggleHelp(): void {
    if (this.helpVisible) {
      this.helpBox?.destroy();
      this.helpBox = null;
      this.helpVisible = false;
      this.screen.render();
      return;
    }

    const helpContent = [
      "{bold}pi-top — Keyboard Shortcuts{/bold}",
      "",
      "  {bold}↑ / k{/bold}      Move up in thread list",
      "  {bold}↓ / j{/bold}      Move down in thread list",
      "  {bold}g{/bold}         Go to first thread",
      "  {bold}G{/bold}         Go to last thread",
      "  {bold}Enter{/bold}      Inspect selected thread",
      "  {bold}Tab{/bold}        Cycle focus",
      "  {bold}r{/bold}         Force refresh",
      "  {bold}? / h{/bold}      Toggle this help",
      "  {bold}q / Ctrl-C{/bold} Quit",
      "",
      "{bold}Legend:{/bold}",
      "  {green-fg}●{/green-fg} Open      {yellow-fg}◐{/yellow-fg} Working",
      "  {red-fg}◌{/red-fg} On Hold   {bright-black-fg}○{/bright-black-fg} Idle/Done",
      "  {cyan-fg}◐{/cyan-fg} Thinking",
      "",
      "Press {bold}?{/bold} again to close",
    ].join("\n");

    this.helpBox = blessed.box({
      parent: this.screen,
      top: "center",
      left: "center",
      width: 46,
      height: 22,
      content: helpContent,
      tags: true,
      border: { type: "line" },
      style: {
        border: { fg: "yellow" },
        bg: "black",
        fg: "white",
      },
      shadow: true,
    });

    this.helpVisible = true;
    this.screen.render();
  }
}

/**
 * Factory function: creates and returns a new pi-top App instance.
 * Used by the bootstrap in index.ts.
 */
export function createApp(dataProvider: DataProvider, onQuit?: () => void): App {
  return new App(dataProvider, onQuit ?? null);
}
