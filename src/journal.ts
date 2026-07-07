import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawn } from "node:child_process";
import type { ThreadStore } from "./core/types";

/** Everything journal: the fork prompt, entry parsing, duplicate detection,
 *  and the cadence policy deciding which moments deserve a forked entry. */

const JOURNAL_PROMPT = `You are this thread's journal keeper. Based on the conversation above, write a brief status update in exactly this format:

Working on: <the main task in one line>
Done: <what was completed this turn>
Doing: <what is in progress or will continue>
Next: <planned next step>
Blockers: <blockers or "none">

No preamble. No extra text. Just the five lines.`;

/** Minimum spacing between per-turn journal forks. Structural changes (new
 *  obligation, lock, barrier — the things teammates key off) still journal
 *  immediately; this only rate-limits the "another tool turn on the same
 *  task" entries that used to land once per turn, ~17 near-duplicates per
 *  work session. */
export const JOURNAL_MIN_INTERVAL_MS = 120_000;

/** Entries are separated by their `<!-- timestamp -->` headers. */
export function splitJournalEntries(content: string): string[] {
  return content.split(/\n(?=<!--)/).filter(Boolean);
}

/** "Working on"/"Done" carry the actual news; "Doing"/"Next"/"Blockers" are
 *  restated every idle turn even when nothing happened, so they're excluded
 *  from the comparison — otherwise a re-forked entry with fresh phrasing of
 *  the same wait would never match and noise would keep accumulating. */
export function journalFingerprint(entry: string): string {
  return entry
    .split("\n")
    .filter(l => /^(Working on|Done):/i.test(l.trim()))
    .join("\n")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

/** Pure comparison against the last entry in an existing journal's content
 *  (or `undefined` when no journal exists yet). */
export function isDuplicateOfLastEntry(journalContent: string | undefined, entry: string): boolean {
  const content = journalContent?.trim();
  if (!content) return false;
  const entries = splitJournalEntries(content);
  const last = entries[entries.length - 1];
  if (!last) return false;
  return journalFingerprint(last) === journalFingerprint(entry);
}

export function journalMode(pi: ExtensionAPI): "turn" | "done" | "off" {
  const v = pi.getFlag("thread-journal");
  return v === "done" || v === "off" ? v : "turn";
}

/** Fingerprint of everything a journal entry could newly report. Unchanged
 *  since the last journal write + no tool call this turn means the turn was
 *  a pure "still waiting" restatement — not worth a forked LLM call. */
export function journalSignature(store: ThreadStore): string {
  return [
    store.state,
    store.lockEventId ?? "",
    store.obligations
      .map(o => o.requestId)
      .sort()
      .join(","),
    store.barriers
      .map(b => b.id)
      .sort()
      .join(","),
  ].join("|");
}

/** Decide whether this moment deserves a forked journal entry.
 *
 *  - "turn"    — turn_end in per-turn mode: journal on structural change, or
 *                on tool-using turns at most every JOURNAL_MIN_INTERVAL_MS;
 *                a rate-limited turn records a debt instead.
 *  - "run-end" — agent_end in per-turn mode: journal only if a debt is
 *                outstanding, so the run's final state is always captured
 *                exactly once (the state flip to done/open on agent_end
 *                itself is not news — the last turn already covered it).
 *  - "done"    — agent_end in journal-mode "done": one entry per run when
 *                anything happened.
 */
export function shouldJournal(
  store: ThreadStore,
  toolUsedThisTurn: boolean,
  phase: "turn" | "run-end" | "done" = "turn",
): boolean {
  const sig = journalSignature(store);
  const changed = sig !== store.lastJournalSignature;
  let write: boolean;
  if (phase === "run-end") {
    write = store.journalDebt;
  } else if (phase === "done") {
    write = changed || toolUsedThisTurn;
  } else {
    if (!changed && !toolUsedThisTurn) return false;
    write = changed || Date.now() - store.lastJournalAt >= JOURNAL_MIN_INTERVAL_MS;
    if (!write) store.journalDebt = true;
  }
  if (write) {
    store.lastJournalSignature = sig;
    store.lastJournalAt = Date.now();
    store.journalDebt = false;
  }
  return write;
}

/** Spawn args for the journal fork. `--no-extensions` is load-bearing: when
 *  pi-threading is installed via extension discovery, a fork without it
 *  loads the extension too — and having no --thread-id, it mints a fresh
 *  identity, writes a ghost .thread/threads/thread-<uuid>/ into the shared
 *  workspace, and at its own turn_end forks yet another journal pi,
 *  chaining forever. The fork's only job is to summarize the session it was
 *  forked from; it must never become a thread. */
export function journalForkArgs(sessionFile: string, sessionDir: string): string[] {
  return [
    "--fork",
    sessionFile,
    "--session-dir",
    sessionDir,
    "--no-extensions",
    "--model",
    "deepseek/deepseek-chat",
    "--thinking",
    "off",
    "--print",
    JOURNAL_PROMPT,
  ];
}

/** Fork the session into a throwaway cheap-model run that writes one journal
 *  entry. Fire-and-forget: runs in the background after turn_end/agent_end,
 *  the main thread never pauses on it. */
export function forkJournalEntry(store: ThreadStore, sessionFile: string): void {
  const tmpSes = fs.mkdtempSync(path.join(os.tmpdir(), "pi-journal-"));
  let out = "";
  const proc = spawn("pi", journalForkArgs(sessionFile, tmpSes), {
    stdio: ["ignore", "pipe", "ignore"],
  });
  proc.on("error", () => {
    fs.rmSync(tmpSes, { recursive: true, force: true });
  });
  proc.stdout!.on("data", (d: Buffer) => {
    out += d.toString();
  });
  proc.on("close", () => {
    void (async () => {
      fs.rmSync(tmpSes, { recursive: true, force: true });
      const entry = out.trim();
      if (!entry) return;
      const existing = await store.adapter.readJournal(store.threadId);
      if (isDuplicateOfLastEntry(existing, entry)) return;
      const ts = new Date().toISOString().slice(0, 16).replace("T", " ");
      await store.adapter.appendJournal(store.threadId, `\n<!-- ${ts} -->\n${entry}\n`);
    })();
  });
}
