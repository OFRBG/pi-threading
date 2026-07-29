import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  SessionManager,
  DefaultResourceLoader,
  SettingsManager,
  createAgentSession,
  getAgentDir,
} from "@earendil-works/pi-coding-agent";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ThreadStore } from "./core/types";

/** Everything journal: the fork prompt, entry parsing, duplicate detection,
 *  and the cadence policy deciding which moments deserve a forked entry. */

const JOURNAL_PROMPT = `
You are this thread's journal keeper. Based on the conversation above, write a brief status update in exactly this format:

Working on: <the main task>
Done: <what was completed this turn>
Doing: <what is in progress or will continue>
Next: <planned next step>
Blockers: <blockers or "none">

No preamble. No extra text. Just the five lines, one line per entry.
`.trim();

/** The fork prints this token alone when the turn added nothing worth
 *  recording (a pure "still waiting" restatement of the previous entry). The
 *  close handler recognizes it and appends nothing — a skip the model itself
 *  decides, ahead of the fingerprint dedup that only catches exact repeats. */
const JOURNAL_SKIP = "SKIP";

/** True when the fork chose to skip: its whole output is just the sentinel
 *  (case-insensitive, tolerating a trailing period). */
function isSkip(entry: string): boolean {
  return new RegExp(`^${JOURNAL_SKIP}\\.?$`, "i").test(entry.trim());
}

/** Append the prior entry so the fork writes a *continuation* — reporting
 *  what changed since, not re-describing the whole session cold — and so it
 *  can carry forward a still-accurate "Doing/Next" instead of inventing fresh
 *  phrasing for the same state (which would also dodge duplicate detection). */
function buildJournalPrompt(previousEntry?: string): string {
  if (!previousEntry) {
    return JOURNAL_PROMPT;
  }

  return `
${JOURNAL_PROMPT}

This is the previous journal entry. If the turn added nothing worth recording — the same task, still waiting, no real progress — do NOT write a new entry: output the single word ${JOURNAL_SKIP} and nothing else. Otherwise write the five lines as usual, reporting what changed relative to it.

<previous>
${previousEntry}
</previous>
`.trim();
}

export const JOURNAL_MIN_INTERVAL_MS = 120_000;

/** Entries are separated by their `<!-- timestamp -->` headers. */
export function splitJournalEntries(content: string): string[] {
  return content.split(/\n(?=<!--)/).filter(Boolean);
}

/** "Working on"/"Done" carry the actual news; "Doing"/"Next"/"Blockers" are
 *  restated every idle turn even when nothing happened, so they're excluded
 *  from the comparison — otherwise a re-forked entry with fresh phrasing of
 *  the same wait would never match and noise would keep accumulating. */
function journalFingerprint(entry: string): string {
  return entry
    .split("\n")
    .filter(l => /^(Working on|Done):/i.test(l.trim()))
    .join("\n")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

/** The most recent entry's body (its `<!-- timestamp -->` header stripped),
 *  or `undefined` when the journal is empty. Fed to the fork as continuity
 *  context. */
function lastJournalEntry(journalContent: string | undefined): string | undefined {
  const content = journalContent?.trim();
  if (!content) {
    return undefined;
  }
  const entries = splitJournalEntries(content);
  const last = entries[entries.length - 1];
  if (!last) {
    return undefined;
  }
  return last.replace(/^<!--.*?-->\s*/s, "").trim() || undefined;
}

/** Pure comparison against the last entry in an existing journal's content
 *  (or `undefined` when no journal exists yet). */
function isDuplicateOfLastEntry(journalContent: string | undefined, entry: string): boolean {
  const content = journalContent?.trim();
  if (!content) {
    return false;
  }
  const entries = splitJournalEntries(content);
  const last = entries[entries.length - 1];
  if (!last) {
    return false;
  }
  return journalFingerprint(last) === journalFingerprint(entry);
}

export function journalMode(pi: ExtensionAPI): "turn" | "done" | "off" {
  const mode = pi.getFlag("thread-journal");
  return mode === "done" || mode === "off" ? mode : "turn";
}

/** Fingerprint of everything a journal entry could newly report. Unchanged
 *  since the last journal write + no tool call this turn means the turn was
 *  a pure "still waiting" restatement — not worth a forked LLM call. */
export function journalSignature(store: ThreadStore): string {
  return [
    store.state,
    store.obligations
      .map(o => o.id)
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

  switch (phase) {
    case "run-end":
      write = store.journalDebt;
      break;

    case "done":
      write = changed || toolUsedThisTurn;
      break;

    default:
      if (!changed && !toolUsedThisTurn) {
        return false;
      }
      write = changed || Date.now() - store.lastJournalAt >= JOURNAL_MIN_INTERVAL_MS;

      if (!write) {
        store.journalDebt = true;
      }
      break;
  }

  if (write) {
    store.lastJournalSignature = sig;
    store.lastJournalAt = Date.now();
    store.journalDebt = false;
  }

  return write;
}

/** Resolve the `thread-journal-model` flag (if set) to a concrete model, else
 *  fall back to the session's current model. Parity with the old subprocess
 *  fork, which inherited the forked session's model when no override was set —
 *  a model that resolves on this machine by construction. */
function resolveJournalModel(ctx: ExtensionContext, flag?: string): ExtensionContext["model"] {
  if (!flag) {
    return ctx.model;
  }
  const found = ctx.modelRegistry
    .getAll()
    .find(m => m.id === flag || `${m.provider}/${m.id}` === flag);
  if (!found) {
    console.error(`[thread] journal model "${flag}" not found — using the session model instead.`);
    return ctx.model;
  }
  return found;
}

/** Run one headless completion over a throwaway fork of the session,
 *  in-process — no subprocess, so no executable discovery.
 *
 *  `SessionManager.forkFrom` copies the full history into a temp session dir
 *  (removed immediately after), so the completion never touches the live
 *  session tree. `noExtensions` is the in-process equivalent of the old
 *  `--no-extensions`: it stops the fork from re-loading pi-threading, which
 *  would otherwise mint a ghost thread and recursively fork its own journal.
 *  `noTools: "all"` leaves the model with nothing but the conversation — a
 *  summarizer, not an agent. */
async function runJournalCompletion(
  sessionFile: string,
  prompt: string,
  ctx: ExtensionContext,
  model: ExtensionContext["model"],
): Promise<string> {
  const tmpSes = fs.mkdtempSync(path.join(os.tmpdir(), "pi-journal-"));
  try {
    const agentDir = getAgentDir();
    const settingsManager = SettingsManager.create(ctx.cwd, agentDir);
    const resourceLoader = new DefaultResourceLoader({
      cwd: ctx.cwd,
      agentDir,
      settingsManager,
      noExtensions: true,
      noSkills: true,
      noPromptTemplates: true,
      noContextFiles: true,
    });
    await resourceLoader.reload();

    const sessionManager = SessionManager.forkFrom(sessionFile, ctx.cwd, tmpSes);

    const { session } = await createAgentSession({
      cwd: ctx.cwd,
      sessionManager,
      settingsManager,
      resourceLoader,
      model,
      thinkingLevel: "off",
      noTools: "all",
    });

    try {
      await session.prompt(prompt);
      return session.getLastAssistantText()?.trim() ?? "";
    } finally {
      session.dispose();
    }
  } finally {
    fs.rmSync(tmpSes, { recursive: true, force: true });
  }
}

/** Fork the session into a throwaway in-process run that writes one journal
 *  entry. Fire-and-forget: kicked off after turn_end/agent_end, the main
 *  thread never awaits it — so all failures are caught and logged here rather
 *  than surfacing as an unhandled rejection in the host. */
export async function forkJournalEntry(
  store: ThreadStore,
  sessionFile: string,
  ctx: ExtensionContext,
  modelFlag?: string,
): Promise<void> {
  if (!store.adapter.appendJournal) {
    return;
  }

  try {
    // Read the prior entry up front so the fork can continue the narrative
    // rather than summarize the session cold.
    const previousEntry = lastJournalEntry(await store.adapter.readJournal?.(store.threadId));
    const model = resolveJournalModel(ctx, modelFlag);

    const entry = await runJournalCompletion(
      sessionFile,
      buildJournalPrompt(previousEntry),
      ctx,
      model,
    );

    if (!entry) {
      // An empty completion must not fail silently — this is exactly how a
      // misconfigured journal model reads as "journal.md just never appears".
      console.error("[thread] journal fork produced no entry (empty completion).");
      return;
    }

    // The fork judged the turn had nothing new to record and asked to skip —
    // a deliberate no-op, distinct from the empty-output error above.
    if (isSkip(entry)) {
      return;
    }

    // Re-read at write time (not the up-front read): a concurrent fork may have
    // appended since, and dedup must compare against the freshest last entry.
    const existing = await store.adapter.readJournal?.(store.threadId);
    if (isDuplicateOfLastEntry(existing, entry)) {
      return;
    }

    const ts = new Date().toISOString().slice(0, 16).replace("T", " ");
    await store.adapter.appendJournal?.(store.threadId, `\n<!-- ${ts} -->\n${entry}\n`);
  } catch (err) {
    console.error("[thread] journal fork failed:", err instanceof Error ? err.message : err);
  }
}
